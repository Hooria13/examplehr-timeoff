import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { BalancesModule } from './modules/balances/balances.module';
import { HcmModule } from './modules/hcm/hcm.module';
import { HealthModule } from './modules/health/health.module';
import { TimeOffModule } from './modules/time-off/time-off.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    DatabaseModule,
    BalancesModule,
    TimeOffModule,
    HcmModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
