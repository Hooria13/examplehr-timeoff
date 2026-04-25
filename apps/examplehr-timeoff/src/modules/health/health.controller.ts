import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HcmClient, HcmError } from '../hcm/hcm.client';

@Controller()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly hcm: HcmClient,
  ) {}

  @Get('healthz')
  healthz(): { ok: true } {
    return { ok: true };
  }

  @Get('readyz')
  async readyz(): Promise<{
    ok: true;
    db: 'up';
    hcm: 'up' | 'degraded';
  }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      throw new ServiceUnavailableException(
        `db not reachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let hcm: 'up' | 'degraded' = 'up';
    try {
      await this.hcm.getBatch(0, 1);
    } catch (err) {
      // HCM downtime is degraded, not fatal — the app remains useful via the
      // local projection and outbox. We surface this as 'degraded' rather
      // than failing readyz entirely (TRD §8 — circuit-breaker stance).
      if (err instanceof HcmError) hcm = 'degraded';
      else throw err;
    }
    return { ok: true, db: 'up', hcm };
  }
}
