import { ORG_TIMEZONE } from '@rvc/shared';

/**
 * Wall-clock arithmetic in the organisation's timezone.
 *
 * Everything the product schedules is expressed in Montreal local time — a
 * volunteer's Tuesday-evening availability, a standing ride at 9:00, a Shabbos
 * boundary. Storing those as UTC instants would drift by an hour twice a year,
 * so they are stored as (local date, minute-of-day) and converted here.
 *
 * Deliberately implemented on Intl rather than a date library: the conversion
 * is thirty lines, and a dependency that gets its own timezone database wrong
 * is a worse failure than this being slightly verbose.
 */

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    PARTS.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, matching Postgres `extract(dow)` and availability_rules. */
  weekday: number;
}

export function localParts(instant: Date, timeZone: string = ORG_TIMEZONE): LocalParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  // Some engines render midnight as hour 24 even under h23; normalise it.
  const hour = Number(get('hour')) % 24;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** YYYY-MM-DD in the given zone. */
export function localDateString(instant: Date, timeZone: string = ORG_TIMEZONE): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since local midnight, 0..1439. */
export function localMinuteOfDay(instant: Date, timeZone: string = ORG_TIMEZONE): number {
  const p = localParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

export function localWeekday(instant: Date, timeZone: string = ORG_TIMEZONE): number {
  return localParts(instant, timeZone).weekday;
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which the given local wall-clock time occurs.
 *
 * Two passes: guess using the offset at the naive instant, then re-read the
 * offset at the corrected instant. That resolves the DST edge cases — the
 * second pass is what stops a 2:30am local time in March landing an hour out.
 */
export function fromLocal(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string = ORG_TIMEZONE,
): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = naive - offsetMs(new Date(naive), timeZone);
  ts = naive - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** `2026-09-14` + minute-of-day → instant. */
export function fromLocalDateString(
  isoDate: string,
  minuteOfDay: number,
  timeZone: string = ORG_TIMEZONE,
): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Invalid local date: ${isoDate}`);
  return fromLocal(y, m, d, minuteOfDay, timeZone);
}

/** Adds whole days to a YYYY-MM-DD string without touching timezones. */
export function addDaysToDateString(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Difference in whole days, b - a. Both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0]!, pa[1]! - 1, pa[2]!);
  const tb = Date.UTC(pb[0]!, pb[1]! - 1, pb[2]!);
  return Math.round((tb - ta) / 86_400_000);
}

export function weekdayOfDateString(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function minuteToClock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function clockToMinute(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid clock time: ${clock}`);
  }
  return h * 60 + m;
}

/** Human date+time for messages, always in the organisation's zone. */
export function formatWhen(instant: Date, timeZone: string = ORG_TIMEZONE): string {
  return instant.toLocaleString('en-CA', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatClock(instant: Date, timeZone: string = ORG_TIMEZONE): string {
  return instant.toLocaleTimeString('en-CA', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
}
