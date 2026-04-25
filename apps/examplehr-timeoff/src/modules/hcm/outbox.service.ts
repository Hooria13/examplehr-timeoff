import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { CLOCK, type Clock } from '../../common/clock';
import { Balance } from '../balances/entities/balance.entity';
import {
  TimeOffRequest,
  TimeOffStatus,
} from '../time-off/entities/time-off-request.entity';
import { nextAttemptAt } from './backoff';
import {
  HcmOutbox,
  HcmOutboxOp,
  HcmOutboxStatus,
} from './entities/hcm-outbox.entity';
import { HcmBalanceSnapshot, HcmClient, HcmError } from './hcm.client';

const DEFAULT_MAX_ATTEMPTS = 10;
const BALANCE_EPSILON = 1e-4;

interface DeductPayload {
  employeeId: string;
  locationId: string;
  days: number;
  idempotencyKey: string;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly maxAttempts: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(HcmOutbox)
    private readonly outbox: Repository<HcmOutbox>,
    private readonly hcm: HcmClient,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.maxAttempts = Number(
      config.get<string>('OUTBOX_MAX_ATTEMPTS') ?? DEFAULT_MAX_ATTEMPTS,
    );
  }

  /**
   * Drain the outbox: pick up due PENDING and FAILED_RETRYABLE rows in
   * scheduled order, dispatch each to its HCM op, and persist the result.
   * Bounded by `limit` so a single tick can't lock the worker forever.
   */
  async processPendingBatch(limit = 20): Promise<{ processed: number }> {
    const now = this.clock();
    const due = await this.outbox.find({
      where: [
        {
          status: HcmOutboxStatus.PENDING,
          nextAttemptAt: LessThanOrEqual(now),
        },
        {
          status: HcmOutboxStatus.FAILED_RETRYABLE,
          nextAttemptAt: LessThanOrEqual(now),
        },
      ],
      order: { nextAttemptAt: 'ASC', createdAt: 'ASC' },
      take: limit,
    });

    let processed = 0;
    for (const row of due) {
      await this.processOne(row);
      processed += 1;
    }
    return { processed };
  }

  private async processOne(row: HcmOutbox): Promise<void> {
    const claimed = await this.outbox.update(
      { id: row.id, status: row.status, attempts: row.attempts },
      { status: HcmOutboxStatus.IN_FLIGHT, attempts: row.attempts + 1 },
    );
    if (claimed.affected !== 1) {
      this.logger.debug(`outbox row ${row.id} already claimed, skipping`);
      return;
    }
    row.attempts += 1;

    try {
      if (row.op === HcmOutboxOp.DEDUCT) {
        await this.processDeduct(row);
      } else if (row.op === HcmOutboxOp.REVERSE) {
        await this.processReverse(row);
      } else {
        await this.markTerminal(row, `unsupported op: ${row.op}`, {
          rollbackPending: false,
          transitionRequest: null,
        });
      }
    } catch (err) {
      this.logger.error(
        `unexpected error processing outbox ${row.id}: ${String(err)}`,
      );
      await this.scheduleRetry(row, String(err));
    }
  }

  /**
   * Trust-but-verify dispatch for DEDUCT.
   *
   * Flow: call HCM.deduct, then re-fetch the balance and check the anchor
   * actually moved by the requested days. Three outcomes:
   *
   *  - Balance moved as expected → CONFIRMED, request goes APPROVED.
   *  - Balance unchanged → silent-accept (the brief's §3.4 failure mode).
   *    Outbox FAILED_TERMINAL, pending_at_hcm rolled back, request
   *    REJECTED_BY_HCM.
   *  - Verify call itself failed → ambiguous. Outbox bumped back to
   *    FAILED_RETRYABLE, request flagged INDETERMINATE for the batch
   *    reconciliation to resolve from the authoritative corpus view.
   */
  private async processDeduct(row: HcmOutbox): Promise<void> {
    const payload = row.payload as unknown as DeductPayload;

    try {
      await this.hcm.deduct(payload);
    } catch (err) {
      if (err instanceof HcmError && err.isRetryable) {
        await this.scheduleRetry(row, err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await this.markTerminal(row, `deduct rejected: ${msg}`, {
        rollbackPending: true,
        transitionRequest: TimeOffStatus.REJECTED_BY_HCM,
      });
      return;
    }

    let verify: HcmBalanceSnapshot;
    try {
      verify = await this.hcm.getBalance(payload.employeeId, payload.locationId);
    } catch (err) {
      await this.markIndeterminate(row, err instanceof Error ? err.message : String(err));
      return;
    }

    const balance = await this.dataSource.getRepository(Balance).findOne({
      where: {
        employeeId: payload.employeeId,
        locationId: payload.locationId,
      },
    });
    if (!balance) {
      await this.markTerminal(row, 'local balance row missing', {
        rollbackPending: false,
        transitionRequest: null,
      });
      return;
    }

    const expected = balance.hcmBalance - payload.days;
    if (Math.abs(verify.balance - expected) < BALANCE_EPSILON) {
      await this.confirmDeduct(row, verify.balance, payload);
    } else {
      this.logger.warn(
        `silent-accept detected for ${payload.idempotencyKey}: ` +
          `expected=${expected}, got=${verify.balance}`,
      );
      await this.markTerminal(
        row,
        `silent-accept: verify mismatch (expected=${expected}, got=${verify.balance})`,
        {
          rollbackPending: true,
          transitionRequest: TimeOffStatus.REJECTED_BY_HCM,
        },
      );
    }
  }

  /**
   * REVERSE companion to processDeduct. On confirmed reverse, transitions a
   * CANCELLATION_REQUESTED request to CANCELLED and writes the authoritative
   * balance back from HCM.
   */
  private async processReverse(row: HcmOutbox): Promise<void> {
    const payload = row.payload as unknown as DeductPayload;

    try {
      await this.hcm.reverse(payload);
    } catch (err) {
      if (err instanceof HcmError && err.isRetryable) {
        await this.scheduleRetry(row, err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await this.markTerminal(row, `reverse rejected: ${msg}`, {
        rollbackPending: false,
        transitionRequest: null,
      });
      return;
    }

    let verify: HcmBalanceSnapshot;
    try {
      verify = await this.hcm.getBalance(payload.employeeId, payload.locationId);
    } catch (err) {
      await this.markIndeterminate(row, err instanceof Error ? err.message : String(err));
      return;
    }

    await this.dataSource.transaction(async (em) => {
      const bal = await em.findOne(Balance, {
        where: {
          employeeId: payload.employeeId,
          locationId: payload.locationId,
        },
      });
      if (bal) {
        bal.hcmBalance = verify.balance;
        bal.hcmSyncedAt = this.clock();
        await em.save(Balance, bal);
      }

      if (row.correlationId) {
        const req = await em.findOne(TimeOffRequest, {
          where: { id: row.correlationId },
        });
        if (req && req.status === TimeOffStatus.CANCELLATION_REQUESTED) {
          req.status = TimeOffStatus.CANCELLED;
          await em.save(TimeOffRequest, req);
        }
      }

      const fresh = await em.findOneOrFail(HcmOutbox, { where: { id: row.id } });
      fresh.status = HcmOutboxStatus.CONFIRMED;
      fresh.lastError = null;
      await em.save(HcmOutbox, fresh);
    });
  }

  private async confirmDeduct(
    row: HcmOutbox,
    authoritativeHcmBalance: number,
    payload: DeductPayload,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const bal = await em.findOneOrFail(Balance, {
        where: {
          employeeId: payload.employeeId,
          locationId: payload.locationId,
        },
      });
      bal.hcmBalance = authoritativeHcmBalance;
      bal.pendingAtHcm = Math.max(0, bal.pendingAtHcm - payload.days);
      bal.hcmSyncedAt = this.clock();
      await em.save(Balance, bal);

      if (row.correlationId) {
        const req = await em.findOne(TimeOffRequest, {
          where: { id: row.correlationId },
        });
        if (req && req.status === TimeOffStatus.APPROVING) {
          req.status = TimeOffStatus.APPROVED;
          await em.save(TimeOffRequest, req);
        }
      }

      const fresh = await em.findOneOrFail(HcmOutbox, { where: { id: row.id } });
      fresh.status = HcmOutboxStatus.CONFIRMED;
      fresh.lastError = null;
      await em.save(HcmOutbox, fresh);
    });
  }

  private async scheduleRetry(row: HcmOutbox, reason: string): Promise<void> {
    if (row.attempts >= this.maxAttempts) {
      await this.markTerminal(
        row,
        `max attempts reached (${row.attempts}): ${reason}`,
        {
          rollbackPending: row.op === HcmOutboxOp.DEDUCT,
          transitionRequest:
            row.op === HcmOutboxOp.DEDUCT ? TimeOffStatus.REJECTED_BY_HCM : null,
        },
      );
      return;
    }
    const nextAt = nextAttemptAt(this.clock(), row.attempts);
    await this.outbox.update(row.id, {
      status: HcmOutboxStatus.FAILED_RETRYABLE,
      nextAttemptAt: nextAt,
      lastError: reason.slice(0, 1000),
    });
  }

  private async markTerminal(
    row: HcmOutbox,
    reason: string,
    effects: {
      rollbackPending: boolean;
      transitionRequest: TimeOffStatus | null;
    },
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const fresh = await em.findOneOrFail(HcmOutbox, { where: { id: row.id } });
      fresh.status = HcmOutboxStatus.FAILED_TERMINAL;
      fresh.lastError = reason.slice(0, 1000);
      await em.save(HcmOutbox, fresh);

      if (effects.rollbackPending && row.op === HcmOutboxOp.DEDUCT) {
        const payload = row.payload as unknown as DeductPayload;
        const bal = await em.findOne(Balance, {
          where: {
            employeeId: payload.employeeId,
            locationId: payload.locationId,
          },
        });
        if (bal) {
          bal.pendingAtHcm = Math.max(0, bal.pendingAtHcm - payload.days);
          await em.save(Balance, bal);
        }
      }

      if (effects.transitionRequest && row.correlationId) {
        const req = await em.findOne(TimeOffRequest, {
          where: { id: row.correlationId },
        });
        if (req && req.status === TimeOffStatus.APPROVING) {
          req.status = effects.transitionRequest;
          req.decisionNotes = req.decisionNotes ?? reason.slice(0, 500);
          await em.save(TimeOffRequest, req);
        }
      }
    });
  }

  private async markIndeterminate(row: HcmOutbox, reason: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const fresh = await em.findOneOrFail(HcmOutbox, { where: { id: row.id } });
      fresh.status = HcmOutboxStatus.FAILED_RETRYABLE;
      fresh.nextAttemptAt = nextAttemptAt(this.clock(), fresh.attempts);
      fresh.lastError = `verify-ambiguous: ${reason.slice(0, 500)}`;
      await em.save(HcmOutbox, fresh);

      if (row.correlationId) {
        const req = await em.findOne(TimeOffRequest, {
          where: { id: row.correlationId },
        });
        if (
          req &&
          (req.status === TimeOffStatus.APPROVING ||
            req.status === TimeOffStatus.CANCELLATION_REQUESTED)
        ) {
          req.status = TimeOffStatus.INDETERMINATE;
          await em.save(TimeOffRequest, req);
        }
      }
    });
  }
}
