import { backoffMs, nextAttemptAt } from './backoff';

describe('backoff', () => {
  it('first attempt waits 1s', () => {
    expect(backoffMs(1)).toBe(1000);
  });

  it('doubles each attempt', () => {
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(4)).toBe(8000);
  });

  it('caps at 5 minutes', () => {
    expect(backoffMs(20)).toBe(5 * 60 * 1000);
  });

  it('returns 0 for zero/negative attempts', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
  });

  it('nextAttemptAt advances the clock by backoff duration', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const next = nextAttemptAt(now, 3);
    expect(next.getTime() - now.getTime()).toBe(4000);
  });
});
