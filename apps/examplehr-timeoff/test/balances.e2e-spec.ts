import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';

describe('balances (HTTP integration, real mock-hcm)', () => {
  let mockHcmApp: INestApplication;
  let examplehrApp: INestApplication;
  let examplehrHttp: ReturnType<INestApplication['getHttpServer']>;
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

    const examplehrRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    examplehrApp = examplehrRef.createNestApplication();
    examplehrApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await examplehrApp.init();
    examplehrHttp = examplehrApp.getHttpServer();
  });

  afterAll(async () => {
    await examplehrApp.close();
    await mockHcmApp.close();
  });

  beforeEach(async () => {
    await request(mockHcmHttp).post('/__test/reset').expect(204);
    await request(mockHcmHttp)
      .post('/__test/seed')
      .send({
        records: [
          { employeeId: 'e1', locationId: 'us', balance: 10 },
          { employeeId: 'e1', locationId: 'uk', balance: 4 },
        ],
      })
      .expect(204);
  });

  it('cold read: fetches from HCM and returns correct effective available', async () => {
    const r = await request(examplehrHttp)
      .get('/balances/e1/us')
      .expect(200);
    expect(r.body).toMatchObject({
      employeeId: 'e1',
      locationId: 'us',
      hcmBalance: 10,
      pendingAtHcm: 0,
      localHolds: 0,
      effectiveAvailable: 10,
      stale: false,
    });
    expect(r.body.hcmSyncedAt).toBeTruthy();
  });

  it('warm read: second call does not re-fetch from HCM', async () => {
    await request(examplehrHttp).get('/balances/e1/us').expect(200);
    await request(mockHcmHttp)
      .post('/__test/anniversary')
      .send({ employeeId: 'e1', locationId: 'us', delta: 5 })
      .expect(200);
    const r = await request(examplehrHttp)
      .get('/balances/e1/us')
      .expect(200);
    expect(r.body.hcmBalance).toBe(10);
    expect(r.body.stale).toBe(false);
  });

  it('HCM 404 surfaces as 404 on cold read', async () => {
    await request(examplehrHttp).get('/balances/ghost/us').expect(404);
  });

  it('HCM 500 on cold read surfaces as 503 to the caller', async () => {
    await request(mockHcmHttp)
      .post('/__test/fault')
      .send({ op: 'balance', mode: 'error500', remainingTriggers: 1 })
      .expect(201);
    await request(examplehrHttp).get('/balances/e2/us').expect(503);
  });

  it('effective available reflects HCM balance on first read', async () => {
    const r = await request(examplehrHttp)
      .get('/balances/e1/uk')
      .expect(200);
    expect(r.body.effectiveAvailable).toBe(4);
  });
});
