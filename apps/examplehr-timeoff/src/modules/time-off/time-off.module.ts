import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalancesModule } from '../balances/balances.module';
import { HcmModule } from '../hcm/hcm.module';
import { ActorGuard } from './actor.guard';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';
import { TimeOffRequest } from './entities/time-off-request.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalancesModule,
    HcmModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService, ActorGuard],
  exports: [TypeOrmModule, TimeOffService],
})
export class TimeOffModule {}
