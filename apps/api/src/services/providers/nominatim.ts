import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type { GeocodeResult, GeocodingProvider } from './types.js';

/** Address lookup, proxied server-side so the browser never talks to the
 *  geocoder directly and caller addresses are not leaked from clients. */
export const nominatimProvider: GeocodingProvider = {
  name: 'nominatim',
  async search(query: string, limit = 8): Promise<GeocodeResult[]> {
    const url = new URL('/search', env.GEOCODER_BASE_URL);
    url.searchParams.set('q', `${query}, ${env.GEOCODER_BIAS}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(Math.min(limit, 10)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': env.GEOCODER_USER_AGENT, 'Accept-Language': 'en' },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as Array<Record<string, any>>;
      return raw.map((r) => {
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
      });
    } catch (err) {
      logger.warn({ err }, 'geocoder lookup failed');
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
