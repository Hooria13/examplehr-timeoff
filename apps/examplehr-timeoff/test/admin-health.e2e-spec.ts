import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';

const ADMIN = { 'x-user-id': 'ops', 'x-user-role': 'admin' };
const EMP = { 'x-user-id': 'alice', 'x-user-role': 'employee' };

describe('admin + health endpoints (HTTP integration)', () => {
  let mockHcmApp: INestApplication;
  let hrApp: INestApplication;
  let hrHttp: ReturnType<INestApplication['getHttpServer']>;
  let mockHcmHttp: ReturnType<INestApplication['getHttpServer']>;
  let ds: DataSource;

  beforeAll(async () => {
    const mockRef = await Test.createTestingModule({
      imports: [MockHcmModule],
    }).compile();
    mockHcmApp = mockRef.createNestApplication();
    mockHcmApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await mockHcmApp.listen(0);
    mockHcmHttp = mockHcmApp.getHttpServer();
    const addr = mockHcmHttp.address() as AddressInfo;

    process.env.HCM_BASE_URL = `http://localhost:${addr.port}`;
    process.env.HCM_TIMEOUT_MS = '2000';
    process.env.DB_PATH = ':memory:';

    const hrRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    hrApp = hrRef.createNestApplication();
    hrApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await hrApp.init();
    hrHttp = hrApp.getHttpServer();
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
      .send({ records: [{ employeeId: 'alice', locationId: 'us', balance: 10 }] })
      .expect(204);
    await ds.query('DELETE FROM hcm_outbox');
    await ds.query('DELETE FROM time_off_requests');
    await ds.query('DELETE FROM balances');
    await ds.query('DELETE FROM hcm_sync_log');
  });

  it('GET /healthz returns ok without auth', async () => {
    await request(hrHttp).get('/healthz').expect(200, { ok: true });
  });

  it('GET /readyz reports db up and hcm up when both reachable', async () => {
    const r = await request(hrHttp).get('/readyz').expect(200);
    expect(r.body).toMatchObject({ ok: true, db: 'up', hcm: 'up' });
  });

  it('GET /readyz reports hcm degraded when HCM is faulted', async () => {
    await request(mockHcmHttp)
      .post('/__test/fault')
      .send({ op: 'batch', mode: 'error500' })
      .expect(201);
    const r = await request(hrHttp).get('/readyz').expect(200);
    expect(r.body.hcm).toBe('degraded');
  });

  it('admin endpoints require admin role', async () => {
    await request(hrHttp).post('/admin/sync/run').expect(401);
    await request(hrHttp).post('/admin/sync/run').set(EMP).expect(403);
    await request(hrHttp).post('/admin/sync/run').set(ADMIN).expect(200);
  });

  it('POST /admin/sync/run triggers a reconciliation and returns the result', async () => {
    const r = await request(hrHttp)
      .post('/admin/sync/run')
      .set(ADMIN)
      .expect(200);
    expect(r.body).toMatchObject({ recordsSeen: 1, driftCount: 0 });
  });

  it('GET /admin/sync/log lists recent sync runs', async () => {
    await request(hrHttp).post('/admin/sync/run').set(ADMIN).expect(200);
    await request(hrHttp).post('/admin/sync/run').set(ADMIN).expect(200);
    const r = await request(hrHttp).get('/admin/sync/log').set(ADMIN).expect(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0].status).toBe('COMPLETED');
  });

  it('POST /admin/outbox/run drains the outbox', async () => {
    // Set up a pending outbox row by submitting + approving
    const sub = await request(hrHttp)
      .post('/time-off/requests')
      .set(EMP)
      .send({
        employeeId: 'alice',
        locationId: 'us',
        startDate: '2026-05-01',
        endDate: '2026-05-02',
      })
      .expect(201);
    await request(hrHttp)
      .post(`/time-off/requests/${sub.body.id}/approve`)
      .set({ 'x-user-id': 'mgr', 'x-user-role': 'manager' })
      .send({})
      .expect(201);

    const r = await request(hrHttp)
      .post('/admin/outbox/run')
      .set(ADMIN)
      .expect(200);
    expect(r.body.processed).toBeGreaterThanOrEqual(1);
  });

  it('GET /admin/outbox returns rows, filterable by status', async () => {
    const sub = await request(hrHttp)
      .post('/time-off/requests')
      .set(EMP)
      .send({
        employeeId: 'alice',
        locationId: 'us',
        startDate: '2026-05-01',
        endDate: '2026-05-02',
      })
      .expect(201);
    await request(hrHttp)
      .post(`/time-off/requests/${sub.body.id}/approve`)
      .set({ 'x-user-id': 'mgr', 'x-user-role': 'manager' })
      .send({})
      .expect(201);

    const all = await request(hrHttp).get('/admin/outbox').set(ADMIN).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(1);

    const pending = await request(hrHttp)
      .get('/admin/outbox?status=PENDING')
      .set(ADMIN)
      .expect(200);
    expect(pending.body.every((r: any) => r.status === 'PENDING')).toBe(true);
  });
});
