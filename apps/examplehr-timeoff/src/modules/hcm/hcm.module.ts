import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from '../balances/entities/balance.entity';
import { TimeOffRequest } from '../time-off/entities/time-off-request.entity';
import { HcmOutbox } from './entities/hcm-outbox.entity';
import { HcmSyncLog } from './entities/hcm-sync-log.entity';
import { HcmClient } from './hcm.client';
import { HcmWorkers } from './hcm.workers';
import { OutboxService } from './outbox.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([HcmOutbox, HcmSyncLog, Balance, TimeOffRequest]),
    HttpModule,
  ],
  providers: [HcmClient, OutboxService, ReconciliationService, HcmWorkers],
  exports: [
    TypeOrmModule,
    HcmClient,
    OutboxService,
    ReconciliationService,
  ],
})
export class HcmModule {}
