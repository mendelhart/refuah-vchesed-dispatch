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

/** Address lookup, proxied server-side so the browser never talks to the
 *  geocoder directly and caller addresses are not leaked from clients.
 *
 *  Two queries, best first: a number-led address ("5800 Cavendish") goes in
 *  as a structured street query, which is what makes Nominatim return the
 *  exact house number instead of every business on the block. Anything else
 *  ("Jewish General", "corner of Van Horne and Victoria") falls back to a
 *  free-text query biased toward Montreal. Results are deduped and the ones
 *  with real house numbers sort first. */
export const nominatimProvider: GeocodingProvider = {
  name: 'nominatim',
  async search(query: string, limit = 8): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    const capped = String(Math.min(limit, 10));

    let raw: RawResult[] = [];
    if (/^\d{1,6}\s+\S/.test(trimmed)) {
      raw = await nominatim({ street: trimmed, limit: capped });
    }
    if (raw.length === 0) {
      raw = await nominatim({ q: `${trimmed}, ${env.GEOCODER_BIAS}`, limit: capped });
    }

    const seen = new Set<string>();
    return raw
      .map(toResult)
      .filter((r) => {
        const key = `${r.line1.toLowerCase()}|${r.city.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(/^\d/.test(b.line1)) - Number(/^\d/.test(a.line1)))
      .slice(0, limit);
  },
};
