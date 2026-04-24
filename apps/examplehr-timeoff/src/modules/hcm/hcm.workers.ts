import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Thin @Cron-decorated wrappers. All business logic lives in the services
 * so tests can drive them directly without timing mocks.
 */
@Injectable()
export class HcmWorkers {
  private readonly logger = new Logger(HcmWorkers.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'outbox-worker' })
  async runOutbox(): Promise<void> {
    try {
      const { processed } = await this.outbox.processPendingBatch();
      if (processed > 0) {
        this.logger.debug(`outbox tick processed ${processed} rows`);
      }
    } catch (err) {
      this.logger.error(`outbox tick failed: ${String(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'reconciliation-worker' })
  async runReconciliation(): Promise<void> {
    try {
      const result = await this.reconciliation.runSync();
      this.logger.log(
        `reconciliation sync id=${result.id} seen=${result.recordsSeen} drift=${result.driftCount} skipped=${result.skippedInFlight}`,
      );
    } catch (err) {
      this.logger.error(`reconciliation failed: ${String(err)}`);
    }
  }
}
