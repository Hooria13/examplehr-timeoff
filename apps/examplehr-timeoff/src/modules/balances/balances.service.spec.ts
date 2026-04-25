import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CLOCK, Clock } from '../../common/clock';
import { HcmClient, HcmError } from '../hcm/hcm.client';
import { BalancesService } from './balances.service';
import { Balance } from './entities/balance.entity';

type Fixture = {
  svc: BalancesService;
  repo: jest.Mocked<Repository<Balance>>;
  hcm: jest.Mocked<Pick<HcmClient, 'getBalance'>>;
  advanceTime: (ms: number) => void;
};

async function build(initialNow = new Date('2026-04-24T12:00:00Z')): Promise<Fixture> {
  let now = initialNow;
  const clock: Clock = () => new Date(now);

  const repo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v) => v as Balance),
  } as unknown as jest.Mocked<Repository<Balance>>;

  const hcm = {
    getBalance: jest.fn(),
  } as jest.Mocked<Pick<HcmClient, 'getBalance'>>;

  const config = {
    get: (key: string) => {
      if (key === 'HCM_STALE_MS') return String(15 * 60 * 1000);
      return undefined;
    },
  } as unknown as ConfigService;

  const moduleRef = await Test.createTestingModule({
    providers: [
      BalancesService,
      { provide: getRepositoryToken(Balance), useValue: repo },
      { provide: HcmClient, useValue: hcm },
      { provide: ConfigService, useValue: config },
      { provide: CLOCK, useValue: clock },
    ],
  }).compile();

  return {
    svc: moduleRef.get(BalancesService),
    repo,
    hcm,
    advanceTime: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const mkRow = (overrides: Partial<Balance> = {}): Balance =>
  ({
    id: 'row-1',
    employeeId: 'e1',
    locationId: 'us',
    hcmBalance: 10,
    pendingAtHcm: 0,
    localHolds: 0,
    hcmSyncedAt: new Date('2026-04-24T12:00:00Z'),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Balance;

describe('BalancesService', () => {
  it('cold read: fetches from HCM and persists when no local row exists', async () => {
    const f = await build();
    f.repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    f.hcm.getBalance.mockResolvedValue({
      employeeId: 'e1',
      locationId: 'us',
      balance: 10,
      updatedAt: '2026-04-24T12:00:00Z',
    });
    f.repo.save.mockImplementation(async (v) => v as Balance);

    const r = await f.svc.getEffective('e1', 'us');

    expect(f.hcm.getBalance).toHaveBeenCalledWith('e1', 'us');
    expect(r.hcmBalance).toBe(10);
    expect(r.effectiveAvailable).toBe(10);
    expect(r.stale).toBe(false);
  });

  it('fresh read: serves from projection, does NOT refetch', async () => {
    const f = await build();
    f.repo.findOne.mockResolvedValue(mkRow());

    const r = await f.svc.getEffective('e1', 'us');

    expect(f.hcm.getBalance).not.toHaveBeenCalled();
    expect(r.stale).toBe(false);
    expect(r.hcmBalance).toBe(10);
  });

  it('stale read: serves stale value with stale=true, triggers background refresh', async () => {
    const f = await build();
    f.repo.findOne.mockResolvedValue(
      mkRow({ hcmSyncedAt: new Date('2026-04-24T11:30:00Z') }),
    );
    f.advanceTime(16 * 60 * 1000);
    f.hcm.getBalance.mockResolvedValue({
      employeeId: 'e1',
      locationId: 'us',
      balance: 15,
      updatedAt: '2026-04-24T12:16:00Z',
    });
    f.repo.save.mockImplementation(async (v) => v as Balance);

    const r = await f.svc.getEffective('e1', 'us');

    expect(r.stale).toBe(true);
    expect(r.hcmBalance).toBe(10);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.hcm.getBalance).toHaveBeenCalled();
  });

  it('effective formula reflects pending + holds', async () => {
    const f = await build();
    f.repo.findOne.mockResolvedValue(
      mkRow({ hcmBalance: 10, pendingAtHcm: 2, localHolds: 1 }),
    );
    const r = await f.svc.getEffective('e1', 'us');
    expect(r.effectiveAvailable).toBe(7);
  });

  it('cold read surfaces HCM 404 as-is', async () => {
    const f = await build();
    f.repo.findOne.mockResolvedValue(null);
    f.hcm.getBalance.mockRejectedValue(new HcmError(404, 'not found', false));

    await expect(f.svc.getEffective('e1', 'us')).rejects.toBeInstanceOf(
      HcmError,
    );
  });

  it('cold read converts other HCM failures to 503', async () => {
    const f = await build();
    f.repo.findOne.mockResolvedValue(null);
    f.hcm.getBalance.mockRejectedValue(new HcmError(500, 'boom', true));

    await expect(f.svc.getEffective('e1', 'us')).rejects.toMatchObject({
      status: 503,
    });
  });
});
