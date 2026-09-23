import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type { GeocodeResult, GeocodingProvider } from './types.js';

/** Roughly the island of Montreal plus the close suburbs dispatch actually
 *  drives to (Côte-Saint-Luc, Hampstead, Verdun, Pointe-Claire). A bias, not
 *  a fence: nothing is bounded, so an out-of-area address still resolves. */
const VIEWBOX = '-74.10,45.75,-73.40,45.38'; // left,top,right,bottom

type RawResult = Record<string, any>;

async function nominatim(params: Record<string, string>): Promise<RawResult[]> {
  const url = new URL('/search', env.GEOCODER_BASE_URL);
  url.search = new URLSearchParams({
    format: 'json',
    addressdetails: '1',
    countrycodes: 'ca',
    viewbox: VIEWBOX,
    ...params,
  }).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': env.GEOCODER_USER_AGENT, 'Accept-Language': 'en' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return (await res.json()) as RawResult[];
  } catch (err) {
    logger.warn({ err }, 'geocoder lookup failed');
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function toResult(r: RawResult): GeocodeResult {
  const a = (r.address ?? {}) as Record<string, string>;
  const houseNumber = a.house_number ?? '';
  const road = a.road ?? '';
  const line1 = [houseNumber, road].filter(Boolean).join(' ') || (r.name ?? r.display_name ?? '');
  return {
    formatted: String(r.display_name ?? line1),
    line1,
    unit: null,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? 'Montreal',
    province: a.state === 'Quebec' ? 'QC' : (a.state ?? 'QC'),
    postalCode: a.postcode ?? null,
    country: (a.country_code ?? 'ca').toUpperCase(),
    latitude: r.lat ? Number(r.lat) : null,
    longitude: r.lon ? Number(r.lon) : null,
  };
}

const POSTAL = /\b([A-Za-z]\d[A-Za-z])\s?(\d[A-Za-z]\d)\b/;
const PROVINCE_WORDS = /\b(qu[eé]bec|qc|canada)\b\.?/gi;
// Street types as people type them. "760 Querbes av" (type after the name) is
// the usual English order; "760 avenue Querbes" the French one.
const STREET_TYPE = /^(av|ave|avenue|rue|st|street|blvd|boul|boulevard|ch|chemin|rd|road|cr|cres|crescent|pl|place|dr|drive|ct|court|terr|terrace|way|lane|ln|cote|côte)\.?$/i;

/** Splits what a dispatcher typed into the street part, the postal code and
 *  the rest. "760 querbes av Outremont Quebec H2V 3W9" ->
 *  { street: "760 querbes av", postal: "H2V 3W9", cleaned: "760 querbes av Outremont" }. */
export function parseTypedAddress(input: string): { street: string; postal: string | null; cleaned: string } {
  const m = POSTAL.exec(input);
  const postal = m ? `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}` : null;
  const cleaned = input
    .replace(POSTAL, ' ')
    .replace(PROVINCE_WORDS, ' ')
    .replace(/\s*,\s*(,\s*)*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
  let street = cleaned.split(',')[0]!.trim();
  const tokens = street.split(' ');
  if (!cleaned.includes(',') && /^\d/.test(street)) {
    // Cut after an English-order street type ("Querbes av | Outremont").
    const idx = tokens.findIndex((t, i) => i >= 2 && STREET_TYPE.test(t));
    if (idx >= 0) street = tokens.slice(0, idx + 1).join(' ');
  }
  return { street, postal, cleaned };
}

const cache = new Map<string, { at: number; results: GeocodeResult[] }>();
const CACHE_MS = 60 * 60 * 1000;

/** Address lookup, proxied server-side so the browser never talks to the
 *  geocoder directly and caller addresses are not leaked from clients.
 *
 *  Nominatim is strict: a street query with the borough, province and postal
 *  code tacked on ("760 querbes av Outremont Quebec H2V 3W9") finds nothing.
 *  So the typed text is split first and tried from most to least exact: the
 *  street alone as a structured query (exact house numbers), then free text.
 *  A postal code the dispatcher typed wins over the map's, because the map's
 *  postal codes are often a block off (OSM has H2V 3R9 for 760 Querbes; the
 *  real one is H2V 3W9). Results are cached for an hour to stay well inside
 *  the public geocoder's usage limits. */
export const nominatimProvider: GeocodingProvider = {
  name: 'nominatim',
  async search(query: string, limit = 8): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    const key = `${trimmed.toLowerCase()}|${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

    const capped = String(Math.min(limit, 10));
    const { street, postal, cleaned } = parseTypedAddress(trimmed);
    const attempts: Array<Record<string, string>> = [];
    if (/^\d{1,6}\s+\S/.test(street)) attempts.push({ street });
    if (cleaned) attempts.push({ q: `${cleaned}, ${env.GEOCODER_BIAS}` });
    if (cleaned && cleaned !== street) attempts.push({ q: cleaned });
    if (street && street !== cleaned && !/^\d/.test(street)) attempts.push({ q: `${street}, ${env.GEOCODER_BIAS}` });

    let raw: RawResult[] = [];
    for (const params of attempts.slice(0, 3)) {
      raw = await nominatim({ ...params, limit: capped });
      if (raw.length > 0) break;
    }

    const seen = new Set<string>();
    const results = raw
      .map(toResult)
      .map((r) => (postal && /^\d/.test(r.line1) ? { ...r, postalCode: postal } : r))
      .filter((r) => {
        const k = `${r.line1.toLowerCase()}|${r.city.toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => Number(/^\d/.test(b.line1)) - Number(/^\d/.test(a.line1)))
      .slice(0, limit);

    if (results.length > 0) {
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), results });
    }
    return results;
  },
};
