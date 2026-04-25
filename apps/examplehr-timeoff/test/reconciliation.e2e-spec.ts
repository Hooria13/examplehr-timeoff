import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ReconciliationService } from '../src/modules/hcm/reconciliation.service';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';

const EMP = 'e-alice';
const LOC = 'us';
const MGR_HEADERS = { 'x-user-id': 'm-bob', 'x-user-role': 'manager' };
const EMP_HEADERS = { 'x-user-id': EMP, 'x-user-role': 'employee' };

describe('reconciliation cron (HTTP integration, real mock-hcm)', () => {
  let mockHcmApp: INestApplication;
  let hrApp: INestApplication;
  let hrHttp: ReturnType<INestApplication['getHttpServer']>;
  let mockHcmHttp: ReturnType<INestApplication['getHttpServer']>;
  let reconciliation: ReconciliationService;
  let ds: DataSource;

  beforeAll(async () => {
    const mockRef = await Test.createTestingModule({
      imports: [MockHcmModule],
    }).compile();
    mockHcmApp = mockRef.createNestApplication();
    mockHcmApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await mockHcmApp.listen(0);
    mockHcmHttp = mockHcmApp.getHttpServer();
    const addr = mockHcmHttp.address() as AddressInfo;

    process.env.HCM_BASE_URL = `http://localhost:${addr.port}`;
    process.env.HCM_TIMEOUT_MS = '2000';
    process.env.DB_PATH = ':memory:';

    const hrRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    hrApp = hrRef.createNestApplication();
    hrApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await hrApp.init();
    hrHttp = hrApp.getHttpServer();
    reconciliation = hrApp.get(ReconciliationService);
    ds = hrApp.get(DataSource);
  });

  afterAll(async () => {
    await hrApp.close();
    await mockHcmApp.close();
  });

  beforeEach(async () => {
    await request(mockHcmHttp).post('/__test/reset').expect(204);
    await request(mockHcmHttp)
      .post('/__test/seed')
      .send({
        records: [
          { employeeId: EMP, locationId: LOC, balance: 10 },
          { employeeId: EMP, locationId: 'uk', balance: 4 },
        ],
      })
      .expect(204);
    await ds.query('DELETE FROM hcm_outbox');
    await ds.query('DELETE FROM time_off_requests');
    await ds.query('DELETE FROM balances');
    await ds.query('DELETE FROM hcm_sync_log');
  });

  it('creates local balances on first sync', async () => {
    const result = await reconciliation.runSync();
    expect(result.recordsSeen).toBe(2);
    expect(result.driftCount).toBe(0);

    const bal = await request(hrHttp).get(`/balances/${EMP}/${LOC}`).expect(200);
    expect(bal.body.hcmBalance).toBe(10);
  });

  it('detects and applies drift from independent HCM update', async () => {
    await request(hrHttp).get(`/balances/${EMP}/${LOC}`).expect(200);

    await request(mockHcmHttp)
      .post('/__test/anniversary')
      .send({ employeeId: EMP, locationId: LOC, delta: 5 })
      .expect(200);

    const result = await reconciliation.runSync();
    expect(result.driftCount).toBe(1);

    const bal = await request(hrHttp).get(`/balances/${EMP}/${LOC}`).expect(200);
    expect(bal.body.hcmBalance).toBe(15);
  });

  it('skips keys with in-flight outbox ops, counts them separately', async () => {
    await request(hrHttp).get(`/balances/${EMP}/${LOC}`).expect(200);
    const sub = await request(hrHttp)
      .post('/time-off/requests')
      .set(EMP_HEADERS)
      .send({
        employeeId: EMP,
        locationId: LOC,
        startDate: '2026-05-01',
        endDate: '2026-05-02',
      })
      .expect(201);
    await request(hrHttp)
      .post(`/time-off/requests/${sub.body.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);

    await request(mockHcmHttp)
      .post('/__test/anniversary')
      .send({ employeeId: EMP, locationId: LOC, delta: -3 })
      .expect(200);

    const result = await reconciliation.runSync();
    expect(result.skippedInFlight).toBe(1);

    const bal = await request(hrHttp).get(`/balances/${EMP}/${LOC}`).expect(200);
    expect(bal.body.hcmBalance).toBe(10);
    const ukBal = await request(hrHttp).get(`/balances/${EMP}/uk`).expect(200);
    expect(ukBal.body.hcmBalance).toBe(4);
  });

  it('writes a sync log entry for each run', async () => {
    await reconciliation.runSync();
    await reconciliation.runSync();
    const logs = await ds.query(
      'SELECT * FROM hcm_sync_log ORDER BY started_at DESC',
    );
    expect(logs).toHaveLength(2);
    expect(logs[0].status).toBe('COMPLETED');
    expect(logs[0].records_seen).toBe(2);
  });

  it('marks sync log FAILED when HCM batch throws', async () => {
    await request(mockHcmHttp)
      .post('/__test/fault')
      .send({ op: 'batch', mode: 'error500' })
      .expect(201);

    await expect(reconciliation.runSync()).rejects.toBeTruthy();

    const logs = await ds.query(
      'SELECT * FROM hcm_sync_log ORDER BY started_at DESC',
    );
    expect(logs[0].status).toBe('FAILED');
    expect(logs[0].error).toContain('500');
  });
});
