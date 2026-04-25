import {
  BalanceSnapshot,
  canReserve,
  effectiveAvailable,
} from './balance-accounting';

const snap = (
  hcmBalance: number,
  pendingAtHcm: number,
  localHolds: number,
): BalanceSnapshot => ({ hcmBalance, pendingAtHcm, localHolds });

describe('balance-accounting', () => {
  describe('effectiveAvailable', () => {
    it('returns hcmBalance when nothing is reserved', () => {
      expect(effectiveAvailable(snap(10, 0, 0))).toBe(10);
    });

    it('subtracts pendingAtHcm and localHolds', () => {
      expect(effectiveAvailable(snap(10, 2, 1))).toBe(7);
    });

    it('handles half-day granularity', () => {
      expect(effectiveAvailable(snap(10, 0.5, 1.5))).toBe(8);
    });

    it('returns zero when fully reserved', () => {
      expect(effectiveAvailable(snap(5, 3, 2))).toBe(0);
    });

    it('returns a negative number when over-reserved (invariant violation to surface)', () => {
      expect(effectiveAvailable(snap(5, 3, 3))).toBeLessThan(0);
    });

    it('clamps tiny floating-point noise to zero', () => {
      const noisy = effectiveAvailable(snap(0.3, 0.1, 0.2));
      expect(noisy).toBe(0);
    });

    it('rejects non-finite inputs', () => {
      expect(() => effectiveAvailable(snap(NaN, 0, 0))).toThrow(/not finite/);
      expect(() => effectiveAvailable(snap(Infinity, 0, 0))).toThrow(
        /not finite/,
      );
    });

    it('rejects negative inputs (corruption guard)', () => {
      expect(() => effectiveAvailable(snap(-1, 0, 0))).toThrow(/negative/);
      expect(() => effectiveAvailable(snap(10, -1, 0))).toThrow(/negative/);
      expect(() => effectiveAvailable(snap(10, 0, -1))).toThrow(/negative/);
    });
  });

  describe('canReserve', () => {
    it('allows reserving exactly the available amount', () => {
      expect(canReserve(snap(10, 2, 1), 7)).toBe(true);
    });

    it('refuses to reserve more than available', () => {
      expect(canReserve(snap(10, 2, 1), 7.5)).toBe(false);
    });

    it('allows reserving zero', () => {
      expect(canReserve(snap(10, 0, 0), 0)).toBe(true);
    });

    it('refuses negative requested days', () => {
      expect(() => canReserve(snap(10, 0, 0), -1)).toThrow(/negative/);
    });
  });
});
