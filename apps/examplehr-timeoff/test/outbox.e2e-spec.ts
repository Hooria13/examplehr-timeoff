import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { OutboxService } from '../src/modules/hcm/outbox.service';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';

const EMP = 'e-alice';
const LOC = 'us';
const MGR_HEADERS = { 'x-user-id': 'm-bob', 'x-user-role': 'manager' };
const EMP_HEADERS = { 'x-user-id': EMP, 'x-user-role': 'employee' };

describe('outbox worker (HTTP integration, real mock-hcm)', () => {
  let mockHcmApp: INestApplication;
  let hrApp: INestApplication;
  let hrHttp: ReturnType<INestApplication['getHttpServer']>;
  let mockHcmHttp: ReturnType<INestApplication['getHttpServer']>;
  let outbox: OutboxService;
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
    process.env.OUTBOX_MAX_ATTEMPTS = '3';

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
    outbox = hrApp.get(OutboxService);
    ds = hrApp.get(DataSource);
  });

  afterAll(async () => {
    delete process.env.OUTBOX_MAX_ATTEMPTS;
    await hrApp.close();
    await mockHcmApp.close();
  });

  beforeEach(async () => {
    await request(mockHcmHttp).post('/__test/reset').expect(204);
    await request(mockHcmHttp)
      .post('/__test/seed')
      .send({ records: [{ employeeId: EMP, locationId: LOC, balance: 10 }] })
      .expect(204);
    await ds.query('DELETE FROM hcm_outbox');
    await ds.query('DELETE FROM time_off_requests');
    await ds.query('DELETE FROM balances');
    await ds.query('DELETE FROM hcm_sync_log');
  });

  function submit(startDate: string, endDate: string) {
    return request(hrHttp)
      .post('/time-off/requests')
      .set(EMP_HEADERS)
      .send({ employeeId: EMP, locationId: LOC, startDate, endDate });
  }

  async function submitAndApprove(startDate: string, endDate: string) {
    const sub = await submit(startDate, endDate).expect(201);
    await request(hrHttp)
      .post(`/time-off/requests/${sub.body.id}/approve`)
      .set(MGR_HEADERS)
      .send({})
      .expect(201);
    return sub.body.id as string;
  }

  async function expediteOutbox() {
    await ds.query(
      "UPDATE hcm_outbox SET next_attempt_at = '1970-01-01 00:00:00' WHERE status IN ('PENDING', 'FAILED_RETRYABLE')",
    );
  }

  async function getRequest(id: string) {
    const r = await request(hrHttp)
      .get(`/time-off/requests/${id}`)
      .set(EMP_HEADERS)
      .expect(200);
    return r.body;
  }

  async function getBalance() {
    const r = await request(hrHttp)
      .get(`/balances/${EMP}/${LOC}`)
      .expect(200);
    return r.body;
  }

  async function getOutboxRow(correlationId: string) {
    const rows = await ds.query(
      'SELECT * FROM hcm_outbox WHERE correlation_id = ? ORDER BY created_at ASC',
      [correlationId],
    );
    return rows;
  }

  it('DEDUCT happy path: request goes APPROVED, hcm_balance decrements, pending released', async () => {
    const reqId = await submitAndApprove('2026-05-01', '2026-05-02');
    await outbox.processPendingBatch();

    const req = await getRequest(reqId);
    expect(req.status).toBe('APPROVED');

    const bal = await getBalance();
    expect(bal.hcmBalance).toBe(8);
    expect(bal.pendingAtHcm).toBe(0);
    expect(bal.effectiveAvailable).toBe(8);

    const outboxRows = await getOutboxRow(reqId);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe('CONFIRMED');
  });

  it('DEDUCT silent-accept: request goes REJECTED_BY_HCM, pending rolled back', async () => {
    await request(mockHcmHttp)
      .post('/__test/fault')
      .send({ op: 'deduct', mode: 'silent-accept', remainingTriggers: 1 })
      .expect(201);

    const reqId = await submitAndApprove('2026-05-01', '2026-05-02');
    await outbox.processPendingBatch();

    const req = await getRequest(reqId);
    expect(req.status).toBe('REJECTED_BY_HCM');

    const bal = await getBalance();
    expect(bal.hcmBalance).toBe(10);
    expect(bal.pendingAtHcm).toBe(0);
    expect(bal.effectiveAvailable).toBe(10);

    const outboxRows = await getOutboxRow(reqId);
    expect(outboxRows[0].status).toBe('FAILED_TERMINAL');
    expect(outboxRows[0].last_error).toContain('silent-accept');
  });

  it('DEDUCT retryable error then recovery: eventually APPROVED after multiple ticks', async () => {
    await request(mockHcmHttp)
      .post('/__test/fault')
      .send({ op: 'deduct', mode: 'error500', remainingTriggers: 1 })
      .expect(201);

    const reqId = await submitAndApprove('2026-05-01', '2026-05-02');

    await outbox.processPendingBatch();
    let rows = await getOutboxRow(reqId);
    expect(rows[0].status).toBe('FAILED_RETRYABLE');
    expect(rows[0].attempts).toBe(1);

    await expediteOutbox();
    await outbox.processPendingBatch();

    rows = await getOutboxRow(reqId);
    expect(rows[0].status).toBe('CONFIRMED');

    const req = await getRequest(reqId);
    expect(req.status).toBe('APPROVED');
    const bal = await getBalance();
    expect(bal.hcmBalance).toBe(8);
  });

  it('DEDUCT hits max attempts: outbox FAILED_TERMINAL, request REJECTED_BY_HCM, pending released', async () => {
    await request(mockHcmHttp)
      .post('/__test/fault')
      .send({ op: 'deduct', mode: 'error500' })
      .expect(201);

    const reqId = await submitAndApprove('2026-05-01', '2026-05-02');

    for (let i = 0; i < 3; i++) {
      await expediteOutbox();
      await outbox.processPendingBatch();
    }

    const rows = await getOutboxRow(reqId);
    expect(rows[0].status).toBe('FAILED_TERMINAL');
    expect(rows[0].attempts).toBe(3);

    const req = await getRequest(reqId);
    expect(req.status).toBe('REJECTED_BY_HCM');

    const bal = await getBalance();
    expect(bal.hcmBalance).toBe(10);
    expect(bal.pendingAtHcm).toBe(0);
  });

  it('DEDUCT business rejection (insufficient at HCM): terminal on first try', async () => {
    await submitAndApprove('2026-05-01', '2026-05-03');
    await request(mockHcmHttp)
      .post('/__test/anniversary')
      .send({ employeeId: EMP, locationId: LOC, delta: -9 })
      .expect(200);

    await outbox.processPendingBatch();

    const rows = await ds.query('SELECT * FROM hcm_outbox');
    expect(rows[0].status).toBe('FAILED_TERMINAL');
    expect(rows[0].attempts).toBe(1);
  });

  it('REVERSE happy path: CANCELLATION_REQUESTED -> CANCELLED, balance restored', async () => {
    const reqId = await submitAndApprove('2026-05-01', '2026-05-02');
    await outbox.processPendingBatch();

    await request(hrHttp)
      .post(`/time-off/requests/${reqId}/cancel`)
      .set(EMP_HEADERS)
      .expect(201);

    let req = await getRequest(reqId);
    expect(req.status).toBe('CANCELLATION_REQUESTED');

    await expediteOutbox();
    await outbox.processPendingBatch();

    req = await getRequest(reqId);
    expect(req.status).toBe('CANCELLED');

    const bal = await getBalance();
    expect(bal.hcmBalance).toBe(10);
    expect(bal.pendingAtHcm).toBe(0);

    const outboxRows = await getOutboxRow(reqId);
    const reverseRow = outboxRows.find((r: any) => r.op === 'REVERSE');
    expect(reverseRow.status).toBe('CONFIRMED');
  });

  it('idempotent processing: processing an already-CONFIRMED row is a no-op', async () => {
    const reqId = await submitAndApprove('2026-05-01', '2026-05-02');
    await outbox.processPendingBatch();

    const bal1 = await getBalance();
    await outbox.processPendingBatch();
    const bal2 = await getBalance();
    expect(bal2.hcmBalance).toBe(bal1.hcmBalance);
  });
});
