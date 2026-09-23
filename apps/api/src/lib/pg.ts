/**
 * Postgres parameter helpers and error unwrapping.
 *
 * `postgres-js` chooses how to serialise a parameter from the type Postgres
 * reports for it. Writing `$1::text[]` does NOT make Postgres describe `$1` as
 * an array — it describes it as text and then casts that text to an array,
 * so an actual JS array arrives as `walker` and fails with
 * `malformed array literal`.
 *
 * Rather than relying on inference being right at every call site, array
 * parameters are formatted into a Postgres array literal here and cast
 * explicitly. Verbose, but it behaves the same in every query.
 */

/** Formats a string array as a Postgres array literal: `{"a","b"}`. */
export function pgArray(values: readonly string[] | null | undefined): string | null {
  if (!values) return null;
  if (values.length === 0) return '{}';
  return `{${values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** Formats a number array as a Postgres array literal: `{1,2}`. */
export function pgIntArray(values: readonly number[] | null | undefined): string | null {
  if (!values) return null;
  return `{${values.map((v) => String(Math.trunc(v))).join(',')}}`;
}

/** Instants as an unambiguous `timestamptz` parameter. */
export function pgTimestamp(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * drizzle-orm >=0.45 wraps driver errors in `Failed query: ...`; the Postgres
 * error (and its SQLSTATE code) lives on the error's `cause` chain. Walk the
 * chain and return the first SQLSTATE found.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
