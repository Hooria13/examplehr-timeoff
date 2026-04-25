import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { CLOCK, type Clock } from '../../common/clock';
import { Balance } from '../balances/entities/balance.entity';
import {
  TimeOffRequest,
  TimeOffStatus,
} from '../time-off/entities/time-off-request.entity';
import {
  HcmOutbox,
  HcmOutboxStatus,
} from './entities/hcm-outbox.entity';
import { HcmSyncLog, HcmSyncStatus } from './entities/hcm-sync-log.entity';
import { HcmClient } from './hcm.client';

const BATCH_PAGE_SIZE = 50;
const IN_FLIGHT_STATUSES: HcmOutboxStatus[] = [
  HcmOutboxStatus.PENDING,
  HcmOutboxStatus.IN_FLIGHT,
  HcmOutboxStatus.FAILED_RETRYABLE,
];

export interface SyncRunResult {
  id: string;
  recordsSeen: number;
  driftCount: number;
  skippedInFlight: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(HcmSyncLog)
    private readonly syncLog: Repository<HcmSyncLog>,
    @InjectRepository(HcmOutbox)
    private readonly outbox: Repository<HcmOutbox>,
    @InjectRepository(Balance)
    private readonly balances: Repository<Balance>,
    private readonly hcm: HcmClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Pull HCM's full balance corpus and reconcile it against the local
   * projection. Keys with an in-flight outbox op are deliberately skipped:
   * the outbox loop is mid-mutation for those, and overwriting their
   * hcmBalance here would clobber the pending_at_hcm accounting.
   *
   * Each run writes an HcmSyncLog row with drift counts and the list of
   * skipped keys for operator visibility.
   */
  async runSync(): Promise<SyncRunResult> {
    const log = await this.syncLog.save(
      this.syncLog.create({
        status: HcmSyncStatus.RUNNING,
        recordsSeen: 0,
        driftCount: 0,
      }),
    );

    let recordsSeen = 0;
    let driftCount = 0;
    let skippedInFlight = 0;
    const driftSummary: Array<Record<string, unknown>> = [];

    try {
      for (let page = 0; ; page += 1) {
        const chunk = await this.hcm.getBatch(page, BATCH_PAGE_SIZE);
        if (chunk.items.length === 0) break;

        const nonTerminalOps = await this.outbox.find({
          where: { status: In(IN_FLIGHT_STATUSES) },
        });

        for (const item of chunk.items) {
          recordsSeen += 1;
          const hasInFlight = nonTerminalOps.some((c) => {
            const p = c.payload as { employeeId?: string; locationId?: string };
            return (
              p.employeeId === item.employeeId &&
              p.locationId === item.locationId
            );
          });

          if (hasInFlight) {
            skippedInFlight += 1;
            driftSummary.push({
              employeeId: item.employeeId,
              locationId: item.locationId,
              reason: 'in-flight outbox op; deferring overwrite',
            });
            await this.balances.update(
              { employeeId: item.employeeId, locationId: item.locationId },
              { hcmSyncedAt: this.clock() },
            );
            continue;
          }

          const local = await this.balances.findOne({
            where: {
              employeeId: item.employeeId,
              locationId: item.locationId,
            },
          });
          if (!local) {
            const created = this.balances.create({
              employeeId: item.employeeId,
              locationId: item.locationId,
              hcmBalance: item.balance,
              pendingAtHcm: 0,
              localHolds: 0,
              hcmSyncedAt: this.clock(),
            });
            await this.balances.save(created);
            continue;
          }

          if (Math.abs(local.hcmBalance - item.balance) > 1e-4) {
            driftCount += 1;
            driftSummary.push({
              employeeId: item.employeeId,
              locationId: item.locationId,
              localHcmBalance: local.hcmBalance,
              upstreamHcmBalance: item.balance,
            });
            local.hcmBalance = item.balance;
          }
          local.hcmSyncedAt = this.clock();
          await this.balances.save(local);
        }

        if (
          chunk.items.length < BATCH_PAGE_SIZE ||
          recordsSeen >= chunk.total
        ) {
          break;
        }
      }

      await this.resolveIndeterminate();

      log.status = HcmSyncStatus.COMPLETED;
      log.finishedAt = this.clock();
      log.recordsSeen = recordsSeen;
      log.driftCount = driftCount;
      log.summary = { skippedInFlight, items: driftSummary };
      await this.syncLog.save(log);

      return { id: log.id, recordsSeen, driftCount, skippedInFlight };
    } catch (err) {
      log.status = HcmSyncStatus.FAILED;
      log.finishedAt = this.clock();
      log.error = err instanceof Error ? err.message : String(err);
      await this.syncLog.save(log);
      throw err;
    }
  }

  /**
   * Surface INDETERMINATE requests for operator inspection rather than
   * auto-resolving. Auto-resolution would require knowing whether the
   * earlier deduct landed or not, and the whole point of INDETERMINATE
   * is that we can't tell from this side.
   */
  private async resolveIndeterminate(): Promise<void> {
    const stuck = await this.dataSource
      .getRepository(TimeOffRequest)
      .find({ where: { status: TimeOffStatus.INDETERMINATE } });

    for (const req of stuck) {
      this.logger.warn(
        `INDETERMINATE request ${req.id} detected during reconciliation; ` +
          `manual inspection recommended`,
      );
    }
  }
}
