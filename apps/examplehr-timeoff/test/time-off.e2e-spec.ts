import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';

const EMP = 'e-alice';
const LOC = 'us';
const MGR_HEADERS = { 'x-user-id': 'm-bob', 'x-user-role': 'manager' };
const EMP_HEADERS = { 'x-user-id': EMP, 'x-user-role': 'employee' };

describe('time-off state machine (HTTP integration, real mock-hcm)', () => {
  let mockHcmApp: INestApplication;
  let hrApp: INestApplication;
  let hrHttp: ReturnType<INestApplication['getHttpServer']>;
  let mockHcmHttp: ReturnType<INestApplication['getHttpServer']>;

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
  });

  afterAll(async () => {
    await hrApp.close();
    await mockHcmApp.close();
  });

  beforeEach(async () => {
    await request(mockHcmHttp).post('/__test/reset').expect(204);
    await request(mockHcmHttp)
      .post('/__test/seed')
      .send({ records: [{ employeeId: EMP, locationId: LOC, balance: 10 }] })
      .expect(204);

    const ds = hrApp.get(DataSource);
    await ds.query('DELETE FROM hcm_outbox');
    await ds.query('DELETE FROM time_off_requests');
    await ds.query('DELETE FROM balances');
  });

  function submit(
    body: {
      employeeId?: string;
      locationId?: string;
      startDate: string;
      endDate: string;
      reason?: string;
    },
    headers = EMP_HEADERS,
  ) {
    return request(hrHttp)
      .post('/time-off/requests')
      .set(headers)
      .send({
        employeeId: EMP,
        locationId: LOC,
        ...body,
      });
  }

  async function getBalance() {
    const r = await request(hrHttp)
      .get(`/balances/${EMP}/${LOC}`)
      .expect(200);
    return r.body;
  }

  it('submit happy path: reserves days in local_holds', async () => {
    const r = await submit({ startDate: '2026-05-01', endDate: '2026-05-02' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('SUBMITTED');
    expect(r.body.days).toBe(2);

    const bal = await getBalance();
    expect(bal.hcmBalance).toBe(10);
    expect(bal.localHolds).toBe(2);
    expect(bal.effectiveAvailable).toBe(8);
  });

  it('submit rejects with 409 when balance insufficient', async () => {
    const r = await submit({ startDate: '2026-05-01', endDate: '2026-05-15' }); // 15 days > 10
    expect(r.status).toBe(409);
  });

  it('submit rejects overlapping request', async () => {
    await submit({ startDate: '2026-05-01', endDate: '2026-05-03' }).expect(201);
    const overlap = await submit({
      startDate: '2026-05-03',
      endDate: '2026-05-05',
    });
    expect(overlap.status).toBe(409);
  });

  it('submit rejects when endDate before startDate', async () => {
    const r = await submit({
      startDate: '2026-05-05',
      endDate: '2026-05-01',
    });
    expect(r.status).toBe(400);
  });

  it('approve happy path: SUBMITTED -> APPROVING, localHolds moves to pending_at_hcm, outbox row created', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-02',
    }).expect(201);

    const { body: approved } = await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);

    expect(approved.status).toBe('APPROVING');
    expect(approved.decidedBy).toBe('m-bob');

    const bal = await getBalance();
    expect(bal.localHolds).toBe(0);
    expect(bal.pendingAtHcm).toBe(2);
    expect(bal.effectiveAvailable).toBe(8);
  });

  it('approve auto-rejects when HCM balance dropped below reservation', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-05',
    }).expect(201); // 5 days reserved, HCM=10 so avail=5

    // HCM independently drops balance to 3 (below this request's 5 days)
    await request(mockHcmHttp)
      .post('/__test/anniversary')
      .send({ employeeId: EMP, locationId: LOC, delta: -7 })
      .expect(200);

    const { body: decided } = await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);

    expect(decided.status).toBe('REJECTED_BY_HCM');
    const bal = await getBalance();
    expect(bal.localHolds).toBe(0);
    expect(bal.pendingAtHcm).toBe(0);
  });

  it('approve is idempotent on repeat', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-02',
    }).expect(201);

    await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);
    const second = await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);
    expect(second.body.status).toBe('APPROVING');

    // Balance should have been mutated exactly once
    const bal = await getBalance();
    expect(bal.pendingAtHcm).toBe(2);
  });

  it('reject releases local_holds', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-02',
    }).expect(201);

    const { body: rejected } = await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/reject`)
      .set(MGR_HEADERS)
      .send({ notes: 'team coverage conflict' })
      .expect(201);

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.decisionNotes).toBe('team coverage conflict');
    const bal = await getBalance();
    expect(bal.localHolds).toBe(0);
    expect(bal.effectiveAvailable).toBe(10);
  });

  it('cancel before approval releases local_holds', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-02',
    }).expect(201);

    const { body: cancelled } = await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/cancel`)
      .set(EMP_HEADERS)
      .expect(201);

    expect(cancelled.status).toBe('CANCELLED');
    const bal = await getBalance();
    expect(bal.localHolds).toBe(0);
  });

  it('cancel after approval enqueues REVERSE, keeps pending_at_hcm until confirmed', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-02',
    }).expect(201);
    await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);

    const { body: cancelled } = await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/cancel`)
      .set(EMP_HEADERS)
      .expect(201);

    expect(cancelled.status).toBe('CANCELLATION_REQUESTED');
    const bal = await getBalance();
    // pending stays until the REVERSE outbox op confirms
    expect(bal.pendingAtHcm).toBe(2);
  });

  it('list returns all requests for employee', async () => {
    await submit({ startDate: '2026-05-01', endDate: '2026-05-02' }).expect(201);
    await submit({ startDate: '2026-06-01', endDate: '2026-06-01' }).expect(201);

    const r = await request(hrHttp)
      .get(`/time-off/requests?employeeId=${EMP}`)
      .set(EMP_HEADERS)
      .expect(200);
    expect(r.body).toHaveLength(2);
    const starts = r.body.map((x: { startDate: string }) => x.startDate).sort();
    expect(starts).toEqual(['2026-05-01', '2026-06-01']);
  });

  it('guard rejects requests without X-User-Id', async () => {
    await request(hrHttp)
      .post('/time-off/requests')
      .send({
        employeeId: EMP,
        locationId: LOC,
        startDate: '2026-05-01',
        endDate: '2026-05-02',
      })
      .expect(401);
  });

  it('guard rejects employee trying to approve', async () => {
    const { body: submitted } = await submit({
      startDate: '2026-05-01',
      endDate: '2026-05-02',
    }).expect(201);

    await request(hrHttp)
      .post(`/time-off/requests/${submitted.id}/approve`)
      .set(EMP_HEADERS)
      .send({})
      .expect(403);
  });
});
