import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  HcmOutbox,
  HcmOutboxStatus,
} from '../hcm/entities/hcm-outbox.entity';
import { HcmSyncLog } from '../hcm/entities/hcm-sync-log.entity';
import { OutboxService } from '../hcm/outbox.service';
import {
  ReconciliationService,
  SyncRunResult,
} from '../hcm/reconciliation.service';
import { ActorGuard, RequireRole } from '../time-off/actor.guard';

/**
 * Operator-facing endpoints. Useful for dev, testing, and on-call inspection.
 * All routes require `admin` role (TRD §6.3).
 */
@Controller('admin')
@UseGuards(ActorGuard)
@RequireRole('admin')
export class AdminController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly outbox: OutboxService,
    @InjectRepository(HcmSyncLog)
    private readonly syncLogRepo: Repository<HcmSyncLog>,
    @InjectRepository(HcmOutbox)
    private readonly outboxRepo: Repository<HcmOutbox>,
  ) {}

  @Post('sync/run')
  @HttpCode(200)
  runSync(): Promise<SyncRunResult> {
    return this.reconciliation.runSync();
  }

  @Post('outbox/run')
  @HttpCode(200)
  runOutbox(): Promise<{ processed: number }> {
    return this.outbox.processPendingBatch();
  }

  @Get('sync/log')
  listSyncLogs(@Query('limit') limit = '20'): Promise<HcmSyncLog[]> {
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return this.syncLogRepo.find({
      order: { startedAt: 'DESC' },
      take,
    });
  }

  @Get('outbox')
  listOutbox(
    @Query('status') status?: string,
    @Query('limit') limit = '50',
  ): Promise<HcmOutbox[]> {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where =
      status && Object.values(HcmOutboxStatus).includes(status as HcmOutboxStatus)
        ? { status: status as HcmOutboxStatus }
        : {};
    return this.outboxRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take,
    });
  }
}
