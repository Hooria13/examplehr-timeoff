import { Module } from '@nestjs/common';
import { FaultService } from './fault/fault.service';
import { HcmController } from './hcm/hcm.controller';
import { HcmService } from './hcm/hcm.service';
import { HcmStore } from './hcm/hcm.store';
import { MockHcmController } from './mock-hcm.controller';
import { TestControlController } from './test-control/test-control.controller';

@Module({
  controllers: [MockHcmController, HcmController, TestControlController],
  providers: [HcmStore, HcmService, FaultService],
})
export class MockHcmModule {}
