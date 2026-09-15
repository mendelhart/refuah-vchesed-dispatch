/**
 * Value-level normalisation shared by the transforms.
 *
 * Every function here is total and reports failure in its return value rather
 * than throwing or silently substituting a default — the caller turns a failure
 * into an Issue.
 */

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/** Trim; treat empty / whitespace-only / the literal strings 'null'/'undefined'
 *  as absent, because Base44 string columns accumulated all three. */
export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'N/A') return null;
  return s;
}

export function lower(v: unknown): string | null {
  const s = text(v);
  return s === null ? null : s.toLowerCase();
}

/** The canonical identity key for a person. */
export function emailKey(v: unknown): string | null {
  const s = lower(v);
  if (s === null) return null;
  // A bare sanity check only. We are not validating addresses, just keying on
  // them; rejecting a weird-but-real address would lose a person.
  if (!s.includes('@')) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Booleans
//
// Base44 checkbox fields arrive as true/false/'true'/'false'/1/0/''/null.
// ---------------------------------------------------------------------------

export function bool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function int(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export interface DateResult {
  value: Date | null;
  /** True when a value was present but could not be parsed — worth an Issue. */
  failed: boolean;
  raw: string | null;
}

/**
 * Parse a legacy timestamp. Handles ISO strings, `YYYY-MM-DD` (dates-only came
 * from the equipment screens, which did `.toISOString().split('T')[0]`), and
 * epoch milliseconds.
 *
 * A bare `YYYY-MM-DD` is interpreted as UTC midnight. That is a choice, not a
 * fact — the legacy app produced them by truncating a UTC ISO string, so UTC
 * midnight is the faithful inverse.
 */
export function timestamp(v: unknown): DateResult {
  const raw = text(v);
  if (raw === null) return { value: null, failed: false, raw: null };

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(d.getTime())
      ? { value: null, failed: true, raw }
      : { value: d, failed: false, raw };
  }

  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const d = new Date(raw.length <= 10 ? n * 1000 : n);
    return Number.isNaN(d.getTime())
      ? { value: null, failed: true, raw }
      : { value: d, failed: false, raw };
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? { value: null, failed: true, raw }
    : { value: d, failed: false, raw };
}

// ---------------------------------------------------------------------------
// Phone numbers
//
// The legacy app stored whatever the operator typed: '514-555-0142',
// '(514) 555-0142', '5145550142', '+15145550142', '1-514-555-0142 ext 12',
// 'call the shul'. The SMS webhook then compared `phone.replace(/\D/g,'')
// .slice(-10)`, which is why a number typed with an extension silently matched
// the wrong person.
//
// The new schema puts a live-unique index on users.phone and routes inbound SMS
// through it, so a number that cannot be normalised to E.164 is not merely
// untidy — it is a routing hazard.
// ---------------------------------------------------------------------------

export interface PhoneResult {
  /** E.164, or null when the input could not be normalised. */
  e164: string | null;
  /** The original, always preserved so nothing is lost. */
  raw: string | null;
  /** Why normalisation failed, for the report. */
  reason?: 'empty' | 'too_short' | 'too_long' | 'non_numeric' | 'invalid_country';
}

export function phone(v: unknown): PhoneResult {
  const raw = text(v);
  if (raw === null) return { e164: null, raw: null, reason: 'empty' };

  // Already E.164 and plausible.
  const trimmed = raw.replace(/\s+/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return { e164: trimmed, raw };

  const digits = raw.replace(/\D/g, '');
  if (digits === '') return { e164: null, raw, reason: 'non_numeric' };

  // North American 10-digit, with or without the country code.
  if (digits.length === 10) {
    if (!/^[2-9]/.test(digits)) return { e164: null, raw, reason: 'invalid_country' };
    return { e164: `+1${digits}`, raw };
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    const rest = digits.slice(1);
    if (!/^[2-9]/.test(rest)) return { e164: null, raw, reason: 'invalid_country' };
    return { e164: `+1${rest}`, raw };
  }

  if (digits.length < 10) return { e164: null, raw, reason: 'too_short' };

  // 12+ digits with no leading '+': could be an international number typed
  // without one, or a 10-digit number with an extension glued on. We refuse to
  // guess — guessing here dials a stranger.
  return { e164: null, raw, reason: 'too_long' };
}

/** Last four digits, for `calls.destination_last4`. */
export function last4(v: unknown): string | null {
  const raw = text(v);
  if (raw === null) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// ---------------------------------------------------------------------------
// Enum mapping
// ---------------------------------------------------------------------------

export interface EnumResult<T> {
  value: T;
  /** True when the input was present but unrecognised and the default was used. */
  fellBack: boolean;
  raw: string | null;
}

export function mapEnum<T extends string>(
  v: unknown,
  table: Readonly<Record<string, T>>,
  fallback: T,
): EnumResult<T> {
  const raw = lower(v);
  if (raw === null) return { value: fallback, fellBack: false, raw: null };
  const key = raw.replace(/[\s-]+/g, '_');
  const hit = table[key];
  if (hit !== undefined) return { value: hit, fellBack: false, raw };
  return { value: fallback, fellBack: true, raw };
}

/** Slugify a free-text group name into a volunteer_groups.slug. */
export function slugify(v: unknown): string | null {
  const s = lower(v);
  if (s === null) return null;
  const slug = s
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? null : slug;
}

/** A stable YYMMDD key in America/Toronto, matching `trip_counters.day`. */
export function torontoDayKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}`;
}
