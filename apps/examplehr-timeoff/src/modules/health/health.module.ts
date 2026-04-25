import { Module } from '@nestjs/common';
import { HcmModule } from '../hcm/hcm.module';
import { HealthController } from './health.controller';

@Module({
  imports: [HcmModule],
  controllers: [HealthController],
})
export class HealthModule {}
