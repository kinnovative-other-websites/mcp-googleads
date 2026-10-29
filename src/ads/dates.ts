/**
 * Date ranges, resolved to explicit YYYY-MM-DD bounds in the account's time
 * zone so every report states exactly which days it covers and comparisons
 * with the previous period line up.
 */

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'last_90_days',
  'this_month',
  'last_month',
  'this_year',
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

export interface DateRange {
  start: string;
  end: string;
  label: string;
  days: number;
}

export interface DateRangeInput {
  date_range?: DatePreset;
  start_date?: string;
  end_date?: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export class DateRangeError extends Error {}

const toUtc = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (ymd: string, days: number): string => fromUtc(toUtc(ymd) + days * DAY_MS);

/** Inclusive number of days from start to end. */
export const daysInclusive = (start: string, end: string): number => Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;

export const daysInMonth = (ymd: string): number => {
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Today's date in an IANA time zone, e.g. "Asia/Kolkata". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function isValidDate(ymd: string): boolean {
  return YMD.test(ymd) && fromUtc(toUtc(ymd)) === ymd;
}

export function resolveDateRange(input: DateRangeInput, timeZone: string, now: Date = new Date()): DateRange {
  const today = todayIn(timeZone, now);
  if (input.start_date || input.end_date) {
    const { start_date: start, end_date: end } = input;
    if (!start || !end) throw new DateRangeError('Provide both start_date and end_date (YYYY-MM-DD), or use date_range.');
    if (!isValidDate(start) || !isValidDate(end)) throw new DateRangeError('start_date and end_date must be valid YYYY-MM-DD dates.');
    if (start > end) throw new DateRangeError('start_date must be on or before end_date.');
    return { start, end, label: 'custom', days: daysInclusive(start, end) };
  }
  const preset: DatePreset = input.date_range ?? 'last_30_days';
  const yesterday = addDays(today, -1);
  const lastN = (n: number): [string, string] => [addDays(today, -n), yesterday];
  const monthStart = `${today.slice(0, 8)}01`;
  let start: string;
  let end: string;
  switch (preset) {
    case 'today':
      [start, end] = [today, today];
      break;
    case 'yesterday':
      [start, end] = [yesterday, yesterday];
      break;
    case 'last_7_days':
      [start, end] = lastN(7);
      break;
    case 'last_14_days':
      [start, end] = lastN(14);
      break;
    case 'last_30_days':
      [start, end] = lastN(30);
      break;
    case 'last_90_days':
      [start, end] = lastN(90);
      break;
    case 'this_month':
      [start, end] = [monthStart, today];
      break;
    case 'last_month': {
      const lastMonthEnd = addDays(monthStart, -1);
      [start, end] = [`${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd];
      break;
    }
    case 'this_year':
      [start, end] = [`${today.slice(0, 4)}-01-01`, today];
      break;
    default:
      throw new DateRangeError(`Unknown date_range ${String(preset)}`);
  }
  return { start, end, label: preset, days: daysInclusive(start, end) };
}

/** The period of equal length that ends the day before `range` starts. */
export function previousPeriod(range: DateRange): DateRange {
  const end = addDays(range.start, -1);
  const start = addDays(end, -(range.days - 1));
  return { start, end, label: 'previous_period', days: range.days };
}

export const dateClause = (range: DateRange): string => `segments.date BETWEEN '${range.start}' AND '${range.end}'`;
