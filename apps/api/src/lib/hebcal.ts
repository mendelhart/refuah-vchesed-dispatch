import { HDate, HebrewCalendar, Location, Zmanim, flags } from '@hebcal/core';
import { ORG_TIMEZONE } from '@rvc/shared';
import { localDateString, addDaysToDateString } from './time.js';

/**
 * Hebrew calendar and Montreal zmanim.
 *
 * This is not decoration. Refuah V'Chesed dispatches for a community whose week
 * is bounded by candle-lighting and havdalah: a trip offered at 6:50pm on a
 * Friday in December is an offer nobody can accept, and a dispatcher who cannot
 * see the boundary will make that mistake. The legacy application had this;
 * losing it would have been a regression, so it is here as a first-class
 * server-side service rather than a widget computing dates in the browser.
 *
 * Coordinates are the Outremont/Mile End area of Montreal, which is where the
 * organisation and the overwhelming majority of its volunteers are.
 */

export const MONTREAL = new Location(
  45.5088, // latitude
  -73.6039, // longitude
  false, // not Israel
  ORG_TIMEZONE,
  'Montreal',
  'CA',
);

/** Minutes before sunset for candle lighting. Montreal custom is 18. */
const CANDLE_MINUTES = 18;

export interface ZmanimOfDay {
  date: string;
  hebrewDate: string;
  hebrewDateHe: string;
  alotHaShachar: string | null;
  sunrise: string | null;
  sofZmanShmaGRA: string | null;
  sofZmanTfillaGRA: string | null;
  chatzot: string | null;
  minchaGedola: string | null;
  plagHaMincha: string | null;
  sunset: string | null;
  tzeit: string | null;
}

/**
 * hebcal declares `eventTime` and `linkedEvent` on its timed subclasses
 * (CandleLightingEvent, HavdalahEvent, TimedEvent) rather than on the Event
 * base type, so reading them off a heterogeneous calendar array needs this
 * narrowing. The runtime values are exactly as documented; only the static type
 * is broader than the objects actually returned.
 */
interface Timedish {
  eventTime?: Date;
  linkedEvent?: { getDesc(): string; render(locale?: string): string };
}

function timed(ev: unknown): Timedish {
  return ev as Timedish;
}

function iso(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function zmanimFor(date: Date = new Date()): ZmanimOfDay {
  const z = new Zmanim(MONTREAL, date, false);
  const hd = new HDate(date);
  return {
    date: localDateString(date),
    hebrewDate: hd.render('en'),
    hebrewDateHe: hd.render('he'),
    alotHaShachar: iso(z.alotHaShachar()),
    sunrise: iso(z.sunrise()),
    sofZmanShmaGRA: iso(z.sofZmanShma()),
    sofZmanTfillaGRA: iso(z.sofZmanTfilla()),
    chatzot: iso(z.chatzot()),
    minchaGedola: iso(z.minchaGedola()),
    plagHaMincha: iso(z.plagHaMincha()),
    sunset: iso(z.sunset()),
    tzeit: iso(z.tzeit(8.5)),
  };
}

export interface RestPeriod {
  /** Candle lighting / start of the prohibition. */
  startsAt: string;
  /** Havdalah / end. */
  endsAt: string;
  label: string;
  kind: 'shabbat' | 'yomtov';
}

/**
 * Rest periods (Shabbos and yom tov) overlapping a window.
 *
 * Used for two things: showing the boundary on the dispatcher board, and
 * warning when a trip is scheduled inside one. It warns — it does not refuse.
 * Pikuach nefesh is exactly the case this organisation exists for, and the
 * software is not the authority on whether a particular ride may happen.
 */
export function restPeriodsBetween(from: Date, to: Date): RestPeriod[] {
  const events = HebrewCalendar.calendar({
    start: from,
    end: to,
    location: MONTREAL,
    candlelighting: true,
    candleLightingMins: CANDLE_MINUTES,
    havdalahMins: 72,
    il: false,
  });

  const periods: RestPeriod[] = [];
  let open: { startsAt: Date; label: string; kind: 'shabbat' | 'yomtov' } | null = null;

  for (const ev of events) {
    const mask = ev.getFlags();
    const desc = ev.getDesc();

    // Order matters: hebcal marks Havdalah with LIGHT_CANDLES_TZEIS, the same
    // bit as a second-night yom tov lighting. Matching on the flag first closes
    // nothing and every rest period stays open forever, which is how this read
    // "no Shabbos in December" the first time it ran.
    const at = timed(ev).eventTime;

    if (desc.startsWith('Havdalah') && at) {
      if (open) {
        periods.push({
          startsAt: open.startsAt.toISOString(),
          endsAt: at.toISOString(),
          label: open.label,
          kind: open.kind,
        });
        open = null;
      }
      continue;
    }

    if (mask & flags.CHANUKAH_CANDLES) continue; // not a rest period

    // Only the timed "Candle lighting" event opens a period. The holiday event
    // itself ("Erev Rosh Hashana") also carries LIGHT_CANDLES but has no time,
    // and matching it started the period at local midnight.
    if (desc.startsWith('Candle lighting') && at) {
      if (!open) {
        const linked = timed(ev).linkedEvent?.getDesc();
        open = {
          startsAt: at,
          label: linked ? linked.replace(/^Erev /, '') : 'Shabbos',
          kind: linked ? 'yomtov' : 'shabbat',
        };
      }
    }
  }
  return periods;
}

/** True when the instant falls inside Shabbos or yom tov. */
export function isRestTime(at: Date): { resting: boolean; period?: RestPeriod } {
  const periods = restPeriodsBetween(
    new Date(at.getTime() - 3 * 86_400_000),
    new Date(at.getTime() + 3 * 86_400_000),
  );
  const hit = periods.find(
    (p) => new Date(p.startsAt) <= at && at <= new Date(p.endsAt),
  );
  return hit ? { resting: true, period: hit } : { resting: false };
}

export interface HebrewDay {
  date: string;
  hebrewDate: string;
  hebrewDateHe: string;
  parsha: string | null;
  holidays: string[];
  isRoshChodesh: boolean;
  isFastDay: boolean;
  isYomTov: boolean;
  candleLighting: string | null;
  havdalah: string | null;
}

/** A month (or any window) of Hebrew-calendar context for the calendar screen. */
export function hebrewDays(startDate: string, days: number): HebrewDay[] {
  const [y, m, d] = startDate.split('-').map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const end = new Date(start.getTime() + (days - 1) * 86_400_000);

  const events = HebrewCalendar.calendar({
    start,
    end,
    location: MONTREAL,
    candlelighting: true,
    candleLightingMins: CANDLE_MINUTES,
    havdalahMins: 72,
    sedrot: true,
    il: false,
  });

  const byDate = new Map<string, HebrewDay>();
  for (let i = 0; i < days; i++) {
    const date = addDaysToDateString(startDate, i);
    const [yy, mm, dd] = date.split('-').map(Number);
    const hd = new HDate(new Date(yy!, mm! - 1, dd!));
    byDate.set(date, {
      date,
      hebrewDate: hd.render('en'),
      hebrewDateHe: hd.render('he'),
      parsha: null,
      holidays: [],
      isRoshChodesh: false,
      isFastDay: false,
      isYomTov: false,
      candleLighting: null,
      havdalah: null,
    });
  }

  for (const ev of events) {
    const greg = ev.getDate().greg();
    const key = `${greg.getFullYear()}-${String(greg.getMonth() + 1).padStart(2, '0')}-${String(greg.getDate()).padStart(2, '0')}`;
    const day = byDate.get(key);
    if (!day) continue;
    const mask = ev.getFlags();
    const desc = ev.getDesc();

    const at = timed(ev).eventTime;

    if (desc.startsWith('Havdalah') && at) {
      day.havdalah = at.toISOString();
    } else if (desc.startsWith('Candle lighting') && at) {
      day.candleLighting = at.toISOString();
    } else if (mask & flags.PARSHA_HASHAVUA) {
      day.parsha = ev.render('en');
    } else if (mask & flags.CHANUKAH_CANDLES) {
      day.holidays.push(ev.render('en'));
    } else {
      day.holidays.push(ev.render('en'));
      if (mask & flags.ROSH_CHODESH) day.isRoshChodesh = true;
      if (mask & flags.MINOR_FAST || mask & flags.MAJOR_FAST) day.isFastDay = true;
      if (mask & flags.CHAG) day.isYomTov = true;
    }
  }

  return [...byDate.values()];
}
