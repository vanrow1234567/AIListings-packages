import type { Prospect, ProspectIdentityFacts } from '../domain/types.ts';
import { toDomain } from '../business/understand.ts';

/** Fetches raw HTML for the prospect's own website. Injected so tests never touch the network. */
export type HtmlFetcher = (url: string) => Promise<string | undefined>;

export const fetchHtml: HtmlFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 AIListingsAudit/0.1 identity-facts' } });
    if (!res.ok) return undefined;
    return (await res.text()).slice(0, 400_000);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** Digits only, national UK format: +44 7700 900123 -> 07700900123. Returns undefined for anything that is not a plausible UK number. */
export function normalisePhone(raw: string): string | undefined {
  let digits = raw.replace(/[^\d+]/g, '');
  // International forms: +44 1296 ..., +44 (0)1296 ..., 0044 ..., 44 ... -> national 0...
  const international = digits.startsWith('+44') ? digits.slice(3) : digits.startsWith('0044') ? digits.slice(4) : digits.startsWith('44') && digits.length >= 12 ? digits.slice(2) : undefined;
  if (international !== undefined) digits = `0${international.replace(/^0/, '')}`;
  digits = digits.replace(/\D/g, '');
  if (!/^0\d{9,10}$/.test(digits)) return undefined;
  return digits;
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

export function normalisePostcode(raw: string): string | undefined {
  const m = raw.toUpperCase().match(UK_POSTCODE);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * Extract identity facts from the prospect's homepage HTML. Sources, in order of trust:
 * JSON-LD LocalBusiness/Organization (name, telephone, address), tel: links, then a
 * conservative UK phone pattern in visible text. Nothing is inferred.
 */
export function extractProspectFacts(html: string, url: string, now: () => Date = () => new Date()): ProspectIdentityFacts {
  const facts: ProspectIdentityFacts = { source: 'website', canonicalDomain: toDomain(url), phones: [], schemaTypes: [], fetchedAt: now().toISOString() };
  const canonical = html.match(/<link\b[^>]*rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i)?.[1] ?? html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']?canonical["']?/i)?.[1];
  if (canonical) {
    const d = toDomain(canonical);
    if (d) facts.canonicalDomain = d;
  }
  const phones = new Set<string>();

  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1] ?? '');
      const nodes: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && '@graph' in parsed ? (parsed as { '@graph': unknown[] })['@graph'] : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as Record<string, unknown>;
        const types = ([] as unknown[]).concat(n['@type'] ?? []).map(String);
        if (!types.some((t) => /Business|Organization|Organisation|Store|Service|Contractor|Plumber|Electrician|Roofing|Dentist|Attorney|Accounting/i.test(t))) continue;
        facts.schemaTypes.push(...types);
        if (typeof n.name === 'string' && !facts.businessName) facts.businessName = decode(n.name);
        for (const tel of ([] as unknown[]).concat(n.telephone ?? [])) {
          const p = normalisePhone(String(tel));
          if (p) phones.add(p);
        }
        const addr = n.address && typeof n.address === 'object' ? (n.address as Record<string, unknown>) : undefined;
        if (addr) {
          if (typeof addr.streetAddress === 'string' && !facts.streetAddress) facts.streetAddress = decode(addr.streetAddress);
          if (typeof addr.addressLocality === 'string' && !facts.locality) facts.locality = decode(addr.addressLocality);
          if (typeof addr.postalCode === 'string' && !facts.postcode) facts.postcode = normalisePostcode(addr.postalCode) ?? decode(addr.postalCode);
        }
      }
    } catch {
      /* malformed JSON-LD: ignore */
    }
  }

  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const p = normalisePhone(decodeURIComponent(m[1] ?? ''));
    if (p) phones.add(p);
  }
  const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  for (const m of text.matchAll(/(?:\+44\s?\(?0?\)?\s?|\b0)(?:\d\s?){9,10}\b/g)) {
    const p = normalisePhone(m[0]);
    if (p) phones.add(p);
  }
  if (!facts.postcode) {
    const pc = normalisePostcode(text);
    if (pc) facts.postcode = pc;
  }
  if (!facts.businessName) {
    const og = html.match(/<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)?.[1];
    if (og) facts.businessName = decode(og);
  }
  facts.phones = [...phones];
  return facts;
}

/** Fetch and extract facts for a prospect, caching them on the prospect record. */
export function prospectFactsSource(fetcher: HtmlFetcher = fetchHtml, now: () => Date = () => new Date()) {
  return async (prospect: Prospect): Promise<ProspectIdentityFacts> => {
    if (prospect.identityFacts) return prospect.identityFacts;
    const html = prospect.website ? await fetcher(prospect.website) : undefined;
    const facts: ProspectIdentityFacts = html
      ? extractProspectFacts(html, prospect.website, now)
      : { source: 'none', canonicalDomain: prospect.domain, phones: [], schemaTypes: [], fetchedAt: now().toISOString(), error: prospect.website ? 'Prospect website could not be fetched' : 'No prospect website supplied' };
    prospect.identityFacts = facts;
    return facts;
  };
}
