import { calendarDaysInclusive, datesOverlap } from './days-calculator';

describe('calendarDaysInclusive', () => {
  it('same-day request is 1 day', () => {
    expect(calendarDaysInclusive('2026-05-01', '2026-05-01')).toBe(1);
  });

  it('counts the end date inclusively', () => {
    expect(calendarDaysInclusive('2026-05-01', '2026-05-02')).toBe(2);
    expect(calendarDaysInclusive('2026-05-01', '2026-05-07')).toBe(7);
  });

  it('crosses month boundaries', () => {
    expect(calendarDaysInclusive('2026-01-30', '2026-02-02')).toBe(4);
  });

  it('handles leap-year Feb 29', () => {
    // 2028 is a leap year
    expect(calendarDaysInclusive('2028-02-28', '2028-03-01')).toBe(3);
  });

  it('rejects end before start', () => {
    expect(() => calendarDaysInclusive('2026-05-02', '2026-05-01')).toThrow(
      /endDate.*before/,
    );
  });

  it('rejects malformed dates', () => {
    expect(() => calendarDaysInclusive('not-a-date', '2026-05-01')).toThrow(
      /ISO date/,
    );
    expect(() => calendarDaysInclusive('2026-13-01', '2026-05-01')).toThrow();
  });
});

describe('datesOverlap', () => {
  it('identifies full overlap', () => {
    expect(datesOverlap('2026-05-01', '2026-05-05', '2026-05-02', '2026-05-04')).toBe(true);
  });

  it('identifies partial overlap', () => {
    expect(datesOverlap('2026-05-01', '2026-05-03', '2026-05-03', '2026-05-05')).toBe(true);
  });

  it('returns false for adjacent ranges (no shared day)', () => {
    expect(datesOverlap('2026-05-01', '2026-05-03', '2026-05-04', '2026-05-06')).toBe(false);
  });

  it('returns false for fully disjoint ranges', () => {
    expect(datesOverlap('2026-05-01', '2026-05-03', '2026-05-10', '2026-05-12')).toBe(false);
  });

  it('is symmetric', () => {
    const a = ['2026-05-01', '2026-05-05'] as const;
    const b = ['2026-05-04', '2026-05-08'] as const;
    expect(datesOverlap(...a, ...b)).toBe(datesOverlap(...b, ...a));
  });
});
