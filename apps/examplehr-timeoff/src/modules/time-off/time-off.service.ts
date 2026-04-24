import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { CLOCK, type Clock } from '../../common/clock';
import { BalancesService } from '../balances/balances.service';
import { effectiveAvailable } from '../balances/balance-accounting';
import { Balance } from '../balances/entities/balance.entity';
import {
  HcmOutbox,
  HcmOutboxOp,
  HcmOutboxStatus,
} from '../hcm/entities/hcm-outbox.entity';
import { HcmClient, HcmError } from '../hcm/hcm.client';
import { calendarDaysInclusive, datesOverlap } from './days-calculator';
import {
  TimeOffRequest,
  TimeOffStatus,
} from './entities/time-off-request.entity';
import { SubmitRequestDto, TimeOffRequestDto } from './dto';

const ACTIVE_STATUSES: TimeOffStatus[] = [
  TimeOffStatus.SUBMITTED,
  TimeOffStatus.APPROVING,
  TimeOffStatus.APPROVED,
  TimeOffStatus.CANCELLATION_REQUESTED,
];

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(TimeOffRequest)
    private readonly requests: Repository<TimeOffRequest>,
    private readonly balances: BalancesService,
    private readonly hcm: HcmClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async submit(
    dto: SubmitRequestDto,
    actorId: string,
  ): Promise<TimeOffRequestDto> {
    let days: number;
    try {
      days = calendarDaysInclusive(dto.startDate, dto.endDate);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err),
      );
    }
    if (days <= 0) {
      throw new BadRequestException('request must span at least one day');
    }

    // Ensure a local balance anchor exists. Cold-fetches from HCM if needed.
    // Done outside the transaction because it performs an outbound HTTP call.
    await this.balances.refreshFromHcm(dto.employeeId, dto.locationId);

    await this.assertNoOverlap(
      dto.employeeId,
      dto.startDate,
      dto.endDate,
    );

    return this.dataSource.transaction(async (em) => {
      const balance = await em.findOne(Balance, {
        where: { employeeId: dto.employeeId, locationId: dto.locationId },
      });
      if (!balance) {
        // refreshFromHcm should have created it; if we get here something
        // raced; treat as a server error rather than silently 0-reserving.
        throw new ConflictException('balance anchor missing after refresh');
      }

      const avail = effectiveAvailable({
        hcmBalance: balance.hcmBalance,
        pendingAtHcm: balance.pendingAtHcm,
        localHolds: balance.localHolds,
      });
      if (avail < days) {
        throw new ConflictException(
          `insufficient balance: effective=${avail}, requested=${days}`,
        );
      }

      const request = em.create(TimeOffRequest, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        days,
        status: TimeOffStatus.SUBMITTED,
        submittedBy: actorId,
        reason: dto.reason ?? null,
      });
      await em.save(TimeOffRequest, request);

      balance.localHolds = balance.localHolds + days;
      await em.save(Balance, balance);

      return toDto(request);
    });
  }

  async approve(
    id: string,
    actorId: string,
    notes?: string,
  ): Promise<TimeOffRequestDto> {
    const request = await this.requireRequest(id);

    // Idempotency: if already past SUBMITTED, return current state.
    if (request.status !== TimeOffStatus.SUBMITTED) {
      return toDto(request);
    }

    // Write-path freshness: re-anchor from HCM before deciding.
    try {
      await this.balances.refreshFromHcm(
        request.employeeId,
        request.locationId,
      );
    } catch (err) {
      this.logger.warn(
        `approve: HCM refresh failed, proceeding in degraded mode: ${String(err)}`,
      );
      // Degraded mode per TRD §8 — proceed with the local anchor.
    }

    return this.dataSource.transaction(async (em) => {
      const fresh = await em.findOneOrFail(TimeOffRequest, { where: { id } });
      if (fresh.status !== TimeOffStatus.SUBMITTED) return toDto(fresh);

      const balance = await em.findOneOrFail(Balance, {
        where: {
          employeeId: fresh.employeeId,
          locationId: fresh.locationId,
        },
      });

      const avail = effectiveAvailable({
        hcmBalance: balance.hcmBalance,
        pendingAtHcm: balance.pendingAtHcm,
        localHolds: balance.localHolds,
      });

      // local_holds already includes this request's days, so the comparison
      // is: does the raw HCM anchor still cover everything including this one?
      // avail represents what's left AFTER reserving this request's days.
      if (avail < 0) {
        // HCM dropped the anchor below our reservations. Auto-reject THIS
        // request (the oldest-in-the-money simplification: we reject the one
        // being approved; cannot re-order).
        fresh.status = TimeOffStatus.REJECTED_BY_HCM;
        fresh.decidedBy = actorId;
        fresh.decisionNotes =
          notes ?? 'HCM balance insufficient at decision time';
        balance.localHolds = balance.localHolds - fresh.days;
        await em.save(TimeOffRequest, fresh);
        await em.save(Balance, balance);
        return toDto(fresh);
      }

      // Happy path: move from local_holds to pending_at_hcm, enqueue DEDUCT.
      balance.localHolds = balance.localHolds - fresh.days;
      balance.pendingAtHcm = balance.pendingAtHcm + fresh.days;

      fresh.status = TimeOffStatus.APPROVING;
      fresh.decidedBy = actorId;
      fresh.decisionNotes = notes ?? null;

      const outbox = em.create(HcmOutbox, {
        op: HcmOutboxOp.DEDUCT,
        payload: {
          employeeId: fresh.employeeId,
          locationId: fresh.locationId,
          days: fresh.days,
          idempotencyKey: fresh.id,
        },
        status: HcmOutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: this.clock(),
        correlationId: fresh.id,
      });

      await em.save(TimeOffRequest, fresh);
      await em.save(Balance, balance);
      await em.save(HcmOutbox, outbox);

      return toDto(fresh);
    });
  }

  async reject(
    id: string,
    actorId: string,
    notes?: string,
  ): Promise<TimeOffRequestDto> {
    const request = await this.requireRequest(id);
    if (request.status === TimeOffStatus.REJECTED) return toDto(request);
    if (request.status !== TimeOffStatus.SUBMITTED) {
      throw new ConflictException(
        `cannot reject request in status ${request.status}`,
      );
    }

    return this.dataSource.transaction(async (em) => {
      const fresh = await em.findOneOrFail(TimeOffRequest, { where: { id } });
      if (fresh.status !== TimeOffStatus.SUBMITTED) return toDto(fresh);

      const balance = await em.findOneOrFail(Balance, {
        where: {
          employeeId: fresh.employeeId,
          locationId: fresh.locationId,
        },
      });

      fresh.status = TimeOffStatus.REJECTED;
      fresh.decidedBy = actorId;
      fresh.decisionNotes = notes ?? null;
      balance.localHolds = balance.localHolds - fresh.days;

      await em.save(TimeOffRequest, fresh);
      await em.save(Balance, balance);
      return toDto(fresh);
    });
  }

  async cancel(id: string, actorId: string): Promise<TimeOffRequestDto> {
    const request = await this.requireRequest(id);

    if (request.status === TimeOffStatus.CANCELLED) return toDto(request);
    if (
      request.status === TimeOffStatus.REJECTED ||
      request.status === TimeOffStatus.REJECTED_BY_HCM ||
      request.status === TimeOffStatus.EXPIRED
    ) {
      throw new ConflictException(
        `cannot cancel a request in terminal status ${request.status}`,
      );
    }

    return this.dataSource.transaction(async (em) => {
      const fresh = await em.findOneOrFail(TimeOffRequest, { where: { id } });

      const balance = await em.findOneOrFail(Balance, {
        where: {
          employeeId: fresh.employeeId,
          locationId: fresh.locationId,
        },
      });

      if (fresh.status === TimeOffStatus.SUBMITTED) {
        // Pre-approval cancel: release holds, terminal.
        fresh.status = TimeOffStatus.CANCELLED;
        fresh.decidedBy = actorId;
        balance.localHolds = balance.localHolds - fresh.days;
        await em.save(TimeOffRequest, fresh);
        await em.save(Balance, balance);
        return toDto(fresh);
      }

      if (
        fresh.status === TimeOffStatus.APPROVING ||
        fresh.status === TimeOffStatus.APPROVED
      ) {
        // Post-approval cancel: enqueue REVERSE; keep pending_at_hcm until confirmed.
        fresh.status = TimeOffStatus.CANCELLATION_REQUESTED;
        fresh.decidedBy = actorId;

        const outbox = em.create(HcmOutbox, {
          op: HcmOutboxOp.REVERSE,
          payload: {
            employeeId: fresh.employeeId,
            locationId: fresh.locationId,
            days: fresh.days,
            idempotencyKey: `rev-${fresh.id}`,
          },
          status: HcmOutboxStatus.PENDING,
          attempts: 0,
          nextAttemptAt: this.clock(),
          correlationId: fresh.id,
        });

        await em.save(TimeOffRequest, fresh);
        await em.save(HcmOutbox, outbox);
        return toDto(fresh);
      }

      // CANCELLATION_REQUESTED or INDETERMINATE: idempotent no-op
      return toDto(fresh);
    });
  }

  async getById(id: string): Promise<TimeOffRequestDto> {
    return toDto(await this.requireRequest(id));
  }

  async listByEmployee(employeeId: string): Promise<TimeOffRequestDto[]> {
    const rows = await this.requests.find({
      where: { employeeId },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toDto);
  }

  private async requireRequest(id: string): Promise<TimeOffRequest> {
    const found = await this.requests.findOne({ where: { id } });
    if (!found) throw new NotFoundException(`request ${id} not found`);
    return found;
  }

  private async assertNoOverlap(
    employeeId: string,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    const active = await this.requests.find({
      where: { employeeId, status: In(ACTIVE_STATUSES) },
    });
    const clash = active.find((r) =>
      datesOverlap(startDate, endDate, r.startDate, r.endDate),
    );
    if (clash) {
      throw new ConflictException(
        `request overlaps with existing ${clash.status} request ${clash.id} (${clash.startDate}..${clash.endDate})`,
      );
    }
  }
}

function toDto(r: TimeOffRequest): TimeOffRequestDto {
  return {
    id: r.id,
    employeeId: r.employeeId,
    locationId: r.locationId,
    startDate: r.startDate,
    endDate: r.endDate,
    days: r.days,
    status: r.status,
    submittedBy: r.submittedBy,
    decidedBy: r.decidedBy,
    reason: r.reason,
    decisionNotes: r.decisionNotes,
    createdAt: r.createdAt?.toISOString?.() ?? String(r.createdAt),
    updatedAt: r.updatedAt?.toISOString?.() ?? String(r.updatedAt),
  };
}

// Silence unused-import warning from HcmError; kept imported for future use.
export type _HcmErrorForDoc = HcmError;
