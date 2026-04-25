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

  /**
   * Readiness probe. Fails (503) if the local DB is unreachable, since
   * we can't serve any meaningful response without it. HCM being down
   * downgrades to `hcm: 'degraded'` rather than failing — the app stays
   * useful via the local projection and outbox per TRD §8.
   */
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
      if (err instanceof HcmError) hcm = 'degraded';
      else throw err;
    }
    return { ok: true, db: 'up', hcm };
  }
}
