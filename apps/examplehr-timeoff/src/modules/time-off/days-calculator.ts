const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseISODate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`days-calculator: expected ISO date (YYYY-MM-DD), got "${s}"`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`days-calculator: invalid date "${s}"`);
  }
  return d;
}

export function calendarDaysInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate);
  const end = parseISODate(endDate);
  if (end.getTime() < start.getTime()) {
    throw new Error(
      `days-calculator: endDate (${endDate}) is before startDate (${startDate})`,
    );
  }
  return Math.round((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1;
}

export function datesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const as = parseISODate(aStart).getTime();
  const ae = parseISODate(aEnd).getTime();
  const bs = parseISODate(bStart).getTime();
  const be = parseISODate(bEnd).getTime();
  return as <= be && ae >= bs;
}
