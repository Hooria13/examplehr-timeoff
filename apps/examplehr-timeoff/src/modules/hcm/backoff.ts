const ONE_SECOND_MS = 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Exponential backoff without jitter. Production would add full-jitter
 * to avoid thundering-herd; omitted here because deterministic retry
 * timing dramatically simplifies tests, and this take-home runs a single
 * outbox worker against a single HCM so the herd is always of size 1.
 */
export function backoffMs(attempts: number, capMs = FIVE_MINUTES_MS): number {
  if (attempts <= 0) return 0;
  const raw = ONE_SECOND_MS * Math.pow(2, attempts - 1);
  return Math.min(raw, capMs);
}

export function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + backoffMs(attempts));
}
