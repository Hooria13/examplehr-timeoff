import { FaultService } from '../fault/fault.service';
import { HcmService } from './hcm.service';
import { HcmStore } from './hcm.store';

describe('HcmService', () => {
  let store: HcmStore;
  let faults: FaultService;
  let svc: HcmService;

  beforeEach(() => {
    store = new HcmStore();
    faults = new FaultService();
    svc = new HcmService(store, faults);
    store.seed([
      { employeeId: 'e1', locationId: 'us', balance: 10 },
      { employeeId: 'e1', locationId: 'uk', balance: 4 },
      { employeeId: 'e2', locationId: 'us', balance: 0 },
    ]);
  });

  describe('getBalance', () => {
    it('returns the seeded balance', async () => {
      const r = await svc.getBalance('e1', 'us');
      expect(r.balance).toBe(10);
      expect(r.employeeId).toBe('e1');
      expect(r.locationId).toBe('us');
    });

    it('throws 404 for unknown key', async () => {
      await expect(svc.getBalance('e999', 'us')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('throws 500 when error500 fault is registered', async () => {
      faults.register({ op: 'balance', mode: 'error500' });
      await expect(svc.getBalance('e1', 'us')).rejects.toMatchObject({
        status: 500,
      });
    });

    it('throws 429 when throttle fault is registered', async () => {
      faults.register({ op: 'balance', mode: 'throttle' });
      await expect(svc.getBalance('e1', 'us')).rejects.toMatchObject({
        status: 429,
      });
    });
  });

  describe('deduct', () => {
    it('deducts and updates store on happy path', async () => {
      const r = await svc.deduct({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'k1',
      });
      expect(r.newBalance).toBe(7);
      expect(store.get('e1', 'us')!.balance).toBe(7);
    });

    it('replays idempotent result without double-applying', async () => {
      await svc.deduct({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'k1',
      });
      const second = await svc.deduct({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'k1',
      });
      expect(second.newBalance).toBe(7);
      expect(store.get('e1', 'us')!.balance).toBe(7); // only decremented once
    });

    it('rejects with 409 on insufficient balance', async () => {
      await expect(
        svc.deduct({
          employeeId: 'e1',
          locationId: 'us',
          days: 11,
          idempotencyKey: 'k2',
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(store.get('e1', 'us')!.balance).toBe(10);
    });

    it('rejects with 404 for unknown key', async () => {
      await expect(
        svc.deduct({
          employeeId: 'e999',
          locationId: 'us',
          days: 1,
          idempotencyKey: 'k3',
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('silent-accept returns plausible success but does NOT mutate state', async () => {
      faults.register({ op: 'deduct', mode: 'silent-accept' });
      const r = await svc.deduct({
        employeeId: 'e1',
        locationId: 'us',
        days: 2,
        idempotencyKey: 'k-silent',
      });
      expect(r.newBalance).toBe(8); // plausible-looking response
      expect(store.get('e1', 'us')!.balance).toBe(10); // but store is UNCHANGED
      // and critically: no idempotency record — a retry would re-silent-accept,
      // not return the cached lie.
    });

    it('error500 fault does not mutate state', async () => {
      faults.register({ op: 'deduct', mode: 'error500' });
      await expect(
        svc.deduct({
          employeeId: 'e1',
          locationId: 'us',
          days: 2,
          idempotencyKey: 'k-err',
        }),
      ).rejects.toMatchObject({ status: 500 });
      expect(store.get('e1', 'us')!.balance).toBe(10);
    });
  });

  describe('reverse', () => {
    it('adds days back on happy path', async () => {
      const r = await svc.reverse({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'r1',
      });
      expect(r.newBalance).toBe(13);
      expect(store.get('e1', 'us')!.balance).toBe(13);
    });

    it('is idempotent', async () => {
      await svc.reverse({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'r1',
      });
      await svc.reverse({
        employeeId: 'e1',
        locationId: 'us',
        days: 3,
        idempotencyKey: 'r1',
      });
      expect(store.get('e1', 'us')!.balance).toBe(13);
    });
  });

  describe('getBatch', () => {
    it('returns all balances', async () => {
      const r = await svc.getBatch();
      expect(r.total).toBe(3);
      expect(r.items).toHaveLength(3);
    });

    it('honours pagination', async () => {
      const r = await svc.getBatch(1, 2);
      expect(r.total).toBe(3);
      expect(r.items).toHaveLength(1);
      expect(r.page).toBe(1);
      expect(r.limit).toBe(2);
    });
  });
});
