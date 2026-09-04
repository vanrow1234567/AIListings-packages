import type { BusinessUnderstanding, Prospect } from '../domain/types.ts';
import { SERVICE_CATALOGUE, type ServiceProfile } from './catalogue.ts';

export interface WebsiteSnapshot {
  title: string;
  description: string;
  headings: string[];
  text: string;
}

export type WebsiteFetcher = (url: string) => Promise<WebsiteSnapshot | undefined>;

/** Turn a website string into a registrable-looking domain: "https://www.spproofing.co.uk/" -> "spproofing.co.uk". */
export function toDomain(website: string): string {
  const trimmed = website.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0] ?? '';
  }
}

export function normaliseWebsite(website: string): string {
  const t = website.trim();
  if (!t) return '';
  return t.includes('://') ? t : `https://${t}`;
}

/** Best-effort homepage fetch with a short timeout. Any failure returns undefined. */
export const fetchWebsite: WebsiteFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 AIListingsAudit/0.1' },
    });
    if (!res.ok) return undefined;
    const html = (await res.text()).slice(0, 300_000);
    return parseHtml(html);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

export function parseHtml(html: string): WebsiteSnapshot {
  const title = decode(match(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const description = decode(
    match(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
      match(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
  );
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => decode(stripTags(m[1] ?? '')))
    .filter(Boolean)
    .slice(0, 20);
  const text = decode(
    stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')),
  ).slice(0, 5000);
  return { title, description, headings, text };
}

function match(html: string, re: RegExp): string {
  const m = html.match(re);
  return m?.[1]?.trim() ?? '';
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** Score each catalogue profile against a body of text; returns the best match or undefined. */
export function detectService(texts: { text: string; weight: number }[]): ServiceProfile | undefined {
  let best: { profile: ServiceProfile; score: number } | undefined;
  for (const profile of SERVICE_CATALOGUE) {
    let score = 0;
    for (const { text, weight } of texts) {
      const lower = text.toLowerCase();
      for (const kw of profile.keywords) {
        const hits = lower.split(kw.toLowerCase()).length - 1;
        if (hits > 0) score += weight * Math.min(hits, 5);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { profile, score };
  }
  return best?.profile;
}

export interface UnderstandOptions {
  fetcher?: WebsiteFetcher;
}

/**
 * Determine the main commercial service, the market, a realistic requirement
 * and a realistic problem from the business name, website and location.
 */
export async function understandBusiness(
  input: { business_name: string; website: string; location: string },
  options: UnderstandOptions = {},
): Promise<BusinessUnderstanding> {
  const name = input.business_name.trim();
  const location = input.location.trim();
  const website = normaliseWebsite(input.website);
  const prospect: Prospect = { name, website, domain: toDomain(website), location };
  const notes: string[] = [];

  const fetcher = options.fetcher ?? fetchWebsite;
  const snapshot = website ? await fetcher(website) : undefined;
  if (snapshot) {
    notes.push(`Website title: ${snapshot.title || '(none)'}`);
    if (snapshot.description) notes.push(`Website description: ${snapshot.description}`);
  } else if (website) {
    notes.push('Website could not be fetched; service derived from business name.');
  }

  // Name is the strongest signal (it is what the prospect calls themselves), then title/description, then body text.
  const fromName = detectService([{ text: name, weight: 10 }, { text: prospect.domain, weight: 6 }]);
  const fromSite = snapshot
    ? detectService([
        { text: snapshot.title, weight: 5 },
        { text: snapshot.description, weight: 4 },
        { text: snapshot.headings.join(' '), weight: 2 },
        { text: snapshot.text, weight: 0.2 },
      ])
    : undefined;

  const profile = fromName ?? fromSite;
  const source: BusinessUnderstanding['source'] = fromName ? 'name' : fromSite ? 'website' : 'fallback';

  if (profile) {
    return {
      prospect,
      service: profile.service,
      providerNoun: profile.providerNoun,
      customerRequirement: profile.requirement,
      customerProblem: profile.problem,
      market: location,
      source,
      notes,
    };
  }

  // Fallback: use the most descriptive non-generic word in the name as the service.
  const words = name
    .split(/[^a-zA-Z]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && !['ltd', 'limited', 'services', 'group', 'company'].includes(w));
  const service = words.at(-1) ?? 'local services';
  notes.push(`No catalogue match; falling back to "${service}".`);
  return {
    prospect,
    service,
    providerNoun: `${service} companies`,
    customerRequirement: `help with ${service}`,
    customerProblem: `I need some help with ${service} and I'm not sure where to start or what to look out for. What should I do?`,
    market: location,
    source,
    notes,
  };
}
