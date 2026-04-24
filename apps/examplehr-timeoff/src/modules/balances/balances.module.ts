import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmModule } from '../hcm/hcm.module';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';
import { Balance } from './entities/balance.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Balance]), HcmModule],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [TypeOrmModule, BalancesService],
})
export class BalancesModule {}
