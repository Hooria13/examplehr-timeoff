export interface BalanceSnapshot {
  hcmBalance: number;
  pendingAtHcm: number;
  localHolds: number;
}

export const EPSILON = 1e-6;

function assertNonNegativeFinite(label: string, v: number): void {
  if (!Number.isFinite(v)) {
    throw new Error(`balance-accounting: ${label} is not finite (${v})`);
  }
  if (v < -EPSILON) {
    throw new Error(`balance-accounting: ${label} is negative (${v})`);
  }
}

export function effectiveAvailable(snap: BalanceSnapshot): number {
  assertNonNegativeFinite('hcmBalance', snap.hcmBalance);
  assertNonNegativeFinite('pendingAtHcm', snap.pendingAtHcm);
  assertNonNegativeFinite('localHolds', snap.localHolds);

  const raw = snap.hcmBalance - snap.pendingAtHcm - snap.localHolds;
  return Math.abs(raw) < EPSILON ? 0 : raw;
}

export function canReserve(snap: BalanceSnapshot, days: number): boolean {
  assertNonNegativeFinite('days', days);
  return effectiveAvailable(snap) - days >= -EPSILON;
}
