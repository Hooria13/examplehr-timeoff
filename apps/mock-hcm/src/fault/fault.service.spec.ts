import { FaultService } from './fault.service';

describe('FaultService', () => {
  let svc: FaultService;

  beforeEach(() => {
    svc = new FaultService();
  });

  it('list is empty by default', () => {
    expect(svc.list()).toEqual([]);
  });

  it('consume returns undefined when no fault matches', () => {
    expect(svc.consume('deduct')).toBeUndefined();
  });

  it('register then consume returns the spec', () => {
    svc.register({ op: 'deduct', mode: 'error500' });
    const f = svc.consume('deduct');
    expect(f).toMatchObject({ op: 'deduct', mode: 'error500' });
  });

  it('unlimited fault stays across consumes', () => {
    svc.register({ op: 'balance', mode: 'throttle' });
    for (let i = 0; i < 5; i++) {
      expect(svc.consume('balance')).toBeDefined();
    }
    expect(svc.list()).toHaveLength(1);
  });

  it('finite-trigger fault clears after exhaustion', () => {
    svc.register({
      op: 'deduct',
      mode: 'silent-accept',
      remainingTriggers: 2,
    });
    expect(svc.consume('deduct')).toBeDefined();
    expect(svc.consume('deduct')).toBeDefined();
    expect(svc.consume('deduct')).toBeUndefined();
    expect(svc.list()).toHaveLength(0);
  });

  it('consume matches only the requested op', () => {
    svc.register({ op: 'deduct', mode: 'error500' });
    expect(svc.consume('balance')).toBeUndefined();
    expect(svc.consume('deduct')).toBeDefined();
  });

  it('clearAll wipes everything', () => {
    svc.register({ op: 'deduct', mode: 'error500' });
    svc.register({ op: 'balance', mode: 'throttle' });
    svc.clearAll();
    expect(svc.list()).toEqual([]);
  });
});
