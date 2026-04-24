import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { BalancesModule } from './modules/balances/balances.module';
import { HcmModule } from './modules/hcm/hcm.module';
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
