import { Controller, Get } from '@nestjs/common';

@Controller()
export class MockHcmController {
  @Get('healthz')
  healthz(): { ok: true } {
    return { ok: true };
  }
}
