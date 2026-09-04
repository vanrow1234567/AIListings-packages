import type { LocalBusinessListing, LocalBusinessLookupProvider, LocalBusinessQuery } from './localBusiness.ts';

export interface DataForSeoOptions {
  login: string;
  password: string;
  /** Defaults to the Google Maps live advanced SERP endpoint. */
  endpoint?: string;
  /** DataForSEO location_name; defaults to "United Kingdom" with the town carried in the keyword. */
  locationName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Google Maps listings via DataForSEO (POST /v3/serp/google/maps/live/advanced).
 * Needs DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD. Throws on any transport, auth or API error so
 * the identity provider records UNRESOLVED. Not validated against the live API in this
 * environment: the parser reads the documented fields defensively (title, url/domain, phone,
 * address, address_info.city, place_id / cid) and accepts only the documented item types
 * (maps_search, maps_paid_item).
 */
/** Documented result item types for Google Maps live advanced: organic listings and paid listings. */
const MAPS_ITEM_TYPES = new Set(['maps_search', 'maps_paid_item']);

export class DataForSeoMapsProvider implements LocalBusinessLookupProvider {
  readonly name = 'dataforseo-google-maps';
  private readonly opts: Required<Omit<DataForSeoOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(options: DataForSeoOptions) {
    this.opts = {
      endpoint: 'https://api.dataforseo.com/v3/serp/google/maps/live/advanced',
      locationName: 'United Kingdom',
      timeoutMs: 20_000,
      fetchImpl: fetch,
      ...options,
    };
  }

  queryFor(q: LocalBusinessQuery): string {
    return `${q.candidateName} ${q.prospectLocation}`.trim();
  }

  async search(q: LocalBusinessQuery): Promise<LocalBusinessListing[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.opts.fetchImpl(this.opts.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.opts.login}:${this.opts.password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([{ keyword: this.queryFor(q), location_name: this.opts.locationName, language_code: 'en', depth: 20 }]),
      });
      if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}`);
      const body = (await res.json()) as {
        status_code?: number;
        status_message?: string;
        tasks?: { status_code?: number; status_message?: string; result?: { items?: Record<string, unknown>[] }[] }[];
      };
      if (body.status_code && body.status_code >= 40000) throw new Error(`DataForSEO ${body.status_code}: ${body.status_message ?? 'error'}`);
      const task = body.tasks?.[0];
      if (!task) throw new Error('DataForSEO returned no task');
      if (task.status_code && task.status_code >= 40000) throw new Error(`DataForSEO task ${task.status_code}: ${task.status_message ?? 'error'}`);
      const items = task.result?.flatMap((r) => r.items ?? []) ?? [];
      return items
        .filter((i) => typeof i.title === 'string' && typeof i.type === 'string' && MAPS_ITEM_TYPES.has(i.type))
        .map((i) => {
          const info = (i.address_info && typeof i.address_info === 'object' ? i.address_info : {}) as Record<string, unknown>;
          const listing: LocalBusinessListing = { name: String(i.title), source: this.name };
          const website = typeof i.url === 'string' ? i.url : typeof i.domain === 'string' ? `https://${i.domain}` : undefined;
          if (website) listing.website = website;
          if (typeof i.phone === 'string') listing.phone = i.phone;
          if (typeof i.address === 'string') listing.address = i.address;
          if (typeof info.city === 'string') listing.locality = info.city;
          const id = typeof i.place_id === 'string' ? i.place_id : typeof i.cid === 'string' ? i.cid : undefined;
          if (id) listing.providerBusinessId = id;
          return listing;
        });
    } finally {
      clearTimeout(timer);
    }
  }
}
