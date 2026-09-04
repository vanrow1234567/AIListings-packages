import { GENERIC_BUSINESS_WORDS, SERVICE_CATALOGUE, TRADE_WORDS } from '../business/catalogue.ts';

const SERVICE_WORDS = new Set([...SERVICE_CATALOGUE.flatMap((p) => p.genericWords), ...TRADE_WORDS]);
const GENERIC = new Set(GENERIC_BUSINESS_WORDS);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Tokens of the market/location so "ABC Roofing Southampton" merges with "ABC Roofing". */
export function locationTokens(location: string): Set<string> {
  return new Set(tokens(location).filter((t) => t.length > 2));
}

/**
 * Normalisation key: lowercase tokens with legal suffixes, filler words and the
 * audit location removed. Service words are kept so "Solent Plumbing" and
 * "Solent Roofing" stay distinct.
 */
export function nameKey(name: string, location: string): string {
  const loc = locationTokens(location);
  return tokens(name)
    .filter((t) => !GENERIC.has(t) && !loc.has(t))
    .join(' ');
}

/** Tokens that identify a business rather than describe what it does. */
export function distinctiveTokens(name: string, location: string, extraServiceTerms: readonly string[] = []): string[] {
  const loc = locationTokens(location);
  const extra = new Set(extraServiceTerms.map((t) => t.toLowerCase()));
  return tokens(name).filter((t) => !GENERIC.has(t) && !loc.has(t) && !SERVICE_WORDS.has(t) && !extra.has(t) && t !== '&');
}

export function isServiceWord(t: string, extraServiceTerms: readonly string[] = []): boolean {
  return SERVICE_WORDS.has(t) || extraServiceTerms.includes(t);
}

/**
 * Do two names clearly refer to the same business?
 * Equal keys, or one key's tokens are a subset of the other's and the shorter
 * name still carries at least one distinctive token.
 */
export function sameBusiness(a: string, b: string, location: string): boolean {
  const ka = nameKey(a, location);
  const kb = nameKey(b, location);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ta = new Set(ka.split(' '));
  const tb = new Set(kb.split(' '));
  const [small, large, smallName] = ta.size <= tb.size ? [ta, tb, a] : [tb, ta, b];
  if (![...small].every((t) => large.has(t))) return false;
  return distinctiveTokens(smallName, location).length > 0;
}

/** Domain -> a "brand token" e.g. "spproofing.co.uk" -> "spproofing". */
export function domainBrand(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '';
}

export function hostOf(href: string): string | undefined {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
