import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmOutbox } from '../hcm/entities/hcm-outbox.entity';
import { HcmSyncLog } from '../hcm/entities/hcm-sync-log.entity';
import { HcmModule } from '../hcm/hcm.module';
import { TimeOffModule } from '../time-off/time-off.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([HcmOutbox, HcmSyncLog]),
    HcmModule,
    TimeOffModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
