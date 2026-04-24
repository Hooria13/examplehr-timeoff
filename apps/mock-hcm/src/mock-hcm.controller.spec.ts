import { Test, TestingModule } from '@nestjs/testing';
import { MockHcmController } from './mock-hcm.controller';

describe('MockHcmController', () => {
  let controller: MockHcmController;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MockHcmController],
    }).compile();
    controller = moduleRef.get(MockHcmController);
  });

  it('healthz returns ok', () => {
    expect(controller.healthz()).toEqual({ ok: true });
  });
});
