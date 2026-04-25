import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MockHcmModule } from '../src/mock-hcm.module';

describe('mock-hcm (HTTP integration)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [MockHcmModule],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await request(http).post('/__test/reset').expect(204);
    await request(http)
      .post('/__test/seed')
      .send({
        records: [
          { employeeId: 'e1', locationId: 'us', balance: 10 },
          { employeeId: 'e1', locationId: 'uk', balance: 4 },
        ],
      })
      .expect(204);
  });

  it('healthz returns ok', async () => {
    await request(http).get('/healthz').expect(200, { ok: true });
  });

  it('GET balance returns seeded value', async () => {
    const r = await request(http).get('/hcm/balance/e1/us').expect(200);
    expect(r.body.balance).toBe(10);
  });

  it('GET balance 404 on unknown key', async () => {
    await request(http).get('/hcm/balance/nope/us').expect(404);
  });

  it('POST deduct happy path', async () => {
    const r = await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'k1',
      })
      .expect(201);
    expect(r.body.newBalance).toBe(7);
    const after = await request(http).get('/hcm/balance/e1/us').expect(200);
    expect(after.body.balance).toBe(7);
  });

  it('POST deduct insufficient balance returns 409', async () => {
    await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 11,
        idempotencyKey: 'k2',
      })
      .expect(409);
  });

  it('POST deduct is idempotent on same key', async () => {
    const first = await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'k-dup',
      })
      .expect(201);
    const second = await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'k-dup',
      })
      .expect(201);
    expect(first.body.newBalance).toBe(7);
    expect(second.body.newBalance).toBe(7);
    const after = await request(http).get('/hcm/balance/e1/us').expect(200);
    expect(after.body.balance).toBe(7);
  });

  it('silent-accept fault: deduct returns 201 but balance unchanged', async () => {
    await request(http)
      .post('/__test/fault')
      .send({ op: 'deduct', mode: 'silent-accept', remainingTriggers: 1 })
      .expect(201);

    const r = await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 2,
        idempotencyKey: 'k-silent',
      })
      .expect(201);
    expect(r.body.newBalance).toBe(8);

    const after = await request(http).get('/hcm/balance/e1/us').expect(200);
    expect(after.body.balance).toBe(10);
  });

  it('error500 fault clears after exhausting remainingTriggers', async () => {
    await request(http)
      .post('/__test/fault')
      .send({ op: 'deduct', mode: 'error500', remainingTriggers: 1 })
      .expect(201);

    await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 1,
        idempotencyKey: 'e-1',
      })
      .expect(500);

    await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: 1,
        idempotencyKey: 'e-2',
      })
      .expect(201);
  });

  it('throttle fault returns 429', async () => {
    await request(http)
      .post('/__test/fault')
      .send({ op: 'balance', mode: 'throttle', remainingTriggers: 1 })
      .expect(201);
    await request(http).get('/hcm/balance/e1/us').expect(429);
  });

  it('anniversary bumps balance for one key', async () => {
    await request(http)
      .post('/__test/anniversary')
      .send({ employeeId: 'e1', locationId: 'us', delta: 5 })
      .expect(200);
    const r = await request(http).get('/hcm/balance/e1/us').expect(200);
    expect(r.body.balance).toBe(15);
    const uk = await request(http).get('/hcm/balance/e1/uk').expect(200);
    expect(uk.body.balance).toBe(4);
  });

  it('anniversary without locationId fans out across all locations for that employee', async () => {
    const resp = await request(http)
      .post('/__test/anniversary')
      .send({ employeeId: 'e1', delta: 2 })
      .expect(200);
    expect(resp.body.mutated).toBe(2);
  });

  it('yearstart resets all balances', async () => {
    await request(http)
      .post('/__test/yearstart')
      .send({ balance: 20 })
      .expect(204);
    const us = await request(http).get('/hcm/balance/e1/us').expect(200);
    const uk = await request(http).get('/hcm/balance/e1/uk').expect(200);
    expect(us.body.balance).toBe(20);
    expect(uk.body.balance).toBe(20);
  });

  it('batch returns all records, paginated', async () => {
    const r = await request(http).get('/hcm/batch').expect(200);
    expect(r.body.total).toBe(2);
    expect(r.body.items).toHaveLength(2);
  });

  it('validation rejects malformed deduct payload', async () => {
    await request(http)
      .post('/hcm/deduct')
      .send({ employeeId: 'e1', locationId: 'us' })
      .expect(400);
    await request(http)
      .post('/hcm/deduct')
      .send({
        employeeId: 'e1',
        locationId: 'us',
        days: -1,
        idempotencyKey: 'x',
      })
      .expect(400);
  });
});
