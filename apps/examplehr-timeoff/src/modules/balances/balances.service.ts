import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CLOCK, type Clock } from '../../common/clock';
import { HcmClient, HcmError } from '../hcm/hcm.client';
import { effectiveAvailable } from './balance-accounting';
import { BalanceResponseDto } from './dto/balance-response.dto';
import { Balance } from './entities/balance.entity';

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);
  private readonly staleMs: number;

  constructor(
    @InjectRepository(Balance)
    private readonly repo: Repository<Balance>,
    private readonly hcm: HcmClient,
    config: ConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.staleMs = Number(
      config.get<string>('HCM_STALE_MS') ?? String(15 * 60 * 1000),
    );
  }

  async getEffective(
    employeeId: string,
    locationId: string,
  ): Promise<BalanceResponseDto> {
    let row = await this.repo.findOne({ where: { employeeId, locationId } });

    if (!row) {
      // Cold read: no local projection. Must fetch from HCM synchronously
      // — returning an unknown balance to the UI is worse than failing.
      try {
        row = await this.refreshFromHcm(employeeId, locationId);
      } catch (err) {
        if (err instanceof HcmError && err.status === 404) {
          // HCM has no record either — propagate as 404-ish.
          throw err;
        }
        this.logger.error(
          `cold-read HCM fetch failed for ${employeeId}/${locationId}: ${String(err)}`,
        );
        throw new ServiceUnavailableException(
          'HCM is unavailable and no local balance is cached',
        );
      }
    } else if (this.isStale(row)) {
      // Warm read with stale projection: serve stale, refresh in the background.
      void this.refreshFromHcm(employeeId, locationId).catch((err) => {
        this.logger.warn(
          `background refresh failed for ${employeeId}/${locationId}: ${String(err)}`,
        );
      });
    }

    return this.toResponse(row!);
  }

  async refreshFromHcm(
    employeeId: string,
    locationId: string,
  ): Promise<Balance> {
    const snapshot = await this.hcm.getBalance(employeeId, locationId);
    const now = this.clock();
    const existing = await this.repo.findOne({
      where: { employeeId, locationId },
    });
    const entity =
      existing ??
      this.repo.create({
        employeeId,
        locationId,
        pendingAtHcm: 0,
        localHolds: 0,
      });
    entity.hcmBalance = snapshot.balance;
    entity.hcmSyncedAt = now;
    return this.repo.save(entity);
  }

  private isStale(row: Balance): boolean {
    if (!row.hcmSyncedAt) return true;
    const now = this.clock().getTime();
    return now - row.hcmSyncedAt.getTime() > this.staleMs;
  }

  private toResponse(row: Balance): BalanceResponseDto {
    return {
      employeeId: row.employeeId,
      locationId: row.locationId,
      hcmBalance: row.hcmBalance,
      pendingAtHcm: row.pendingAtHcm,
      localHolds: row.localHolds,
      effectiveAvailable: effectiveAvailable({
        hcmBalance: row.hcmBalance,
        pendingAtHcm: row.pendingAtHcm,
        localHolds: row.localHolds,
      }),
      hcmSyncedAt: row.hcmSyncedAt ? row.hcmSyncedAt.toISOString() : null,
      stale: this.isStale(row),
    };
  }
}
