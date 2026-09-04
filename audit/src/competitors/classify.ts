import type { Competitor, EntityKind, EntityMention, Layer, Prospect } from '../domain/types.ts';
import type { Candidate } from '../analysis/extract.ts';
import { distinctiveTokens, domainBrand, isServiceWord, locationTokens, nameKey, sameBusiness, tokens } from '../analysis/normalise.ts';

interface KnownEntity {
  kind: EntityKind;
  names: string[];
  domains: string[];
}

/** Well-known non-competitor entities that appear in UK local-service answers. */
const KNOWN: KnownEntity[] = [
  {
    kind: 'directory',
    names: ['checkatrade', 'yell', 'thomson local', 'trustatrader', 'trust a trader', 'which trusted traders', 'which? trusted traders', 'cylex', 'freeindex', 'scoot', '192', 'hotfrog', 'bing places', 'google maps', 'google business profile', 'google business', 'apple maps', 'yelp', 'nextdoor', 'facebook', 'instagram', 'linkedin', 'local directories', 'houzz'],
    domains: ['checkatrade.com', 'yell.com', 'thomsonlocal.com', 'trustatrader.com', 'trustedtraders.which.co.uk', 'cylex-uk.co.uk', 'freeindex.co.uk', 'scoot.co.uk', '192.com', 'hotfrog.co.uk', 'bing.com', 'google.com', 'google.co.uk', 'maps.google.com', 'yelp.co.uk', 'yelp.com', 'nextdoor.co.uk', 'facebook.com', 'instagram.com', 'linkedin.com', 'houzz.co.uk'],
  },
  {
    kind: 'review_site',
    names: ['trustpilot', 'google reviews', 'reviews.io', 'feefo', 'tripadvisor'],
    domains: ['trustpilot.com', 'uk.trustpilot.com', 'reviews.io', 'feefo.com', 'tripadvisor.co.uk'],
  },
  {
    kind: 'marketplace',
    names: ['mybuilder', 'my builder', 'rated people', 'ratedpeople', 'bark', 'bark.com', 'airtasker', 'taskrabbit', 'amazon', 'ebay', 'bidvine'],
    domains: ['mybuilder.com', 'ratedpeople.com', 'bark.com', 'airtasker.com', 'taskrabbit.co.uk', 'amazon.co.uk', 'ebay.co.uk', 'bidvine.com'],
  },
  {
    kind: 'informational',
    names: ['wikipedia', 'which?', 'which', 'citizens advice', 'gov.uk', 'bbc', 'moneysavingexpert', 'money saving expert', 'reddit', 'youtube', 'nhs', 'federation of master builders', 'fmb', 'nfrc', 'national federation of roofing contractors', 'competent roofer', 'competentroofer', 'trustmark', 'gas safe register', 'gas safe', 'niceic', 'napit', 'companies house', 'city council', 'county council', 'trading standards', 'homeowners alliance', 'homebuilding & renovating', 'the guardian', 'the times', 'daily echo', 'law society', 'sra', 'rics', 'royal institution of chartered surveyors', 'ico', 'ofsted', 'hmrc'],
    domains: ['wikipedia.org', 'which.co.uk', 'citizensadvice.org.uk', 'gov.uk', 'bbc.co.uk', 'moneysavingexpert.com', 'reddit.com', 'youtube.com', 'nhs.uk', 'fmb.org.uk', 'nfrc.co.uk', 'competentroofer.co.uk', 'trustmark.org.uk', 'gassaferegister.co.uk', 'niceic.com', 'napit.org.uk', 'companieshouse.gov.uk', 'find-and-update.company-information.service.gov.uk', 'hoa.org.uk', 'homebuilding.co.uk', 'theguardian.com', 'dailyecho.co.uk', 'lawsociety.org.uk', 'rics.org', 'hmrc.gov.uk'],
  },
  {
    kind: 'unrelated',
    names: ['chatgpt', 'openai', 'gpt', 'temporary chat'],
    domains: ['chatgpt.com', 'openai.com'],
  },
];

function knownKind(name: string, domain: string | undefined): EntityKind | undefined {
  const lower = name.toLowerCase().replace(/[^a-z0-9?. ]/g, '').trim();
  for (const k of KNOWN) {
    if (domain && k.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return k.kind;
    if (k.names.some((n) => lower === n || lower === `${n}.com` || lower === `${n}.co.uk`)) return k.kind;
    // e.g. "Checkatrade (checkatrade.com)" or "Checkatrade UK"
    if (k.names.some((n) => n.length >= 5 && lower.startsWith(`${n} `))) return k.kind;
  }
  return undefined;
}

export function isProspect(candidate: Candidate, prospect: Prospect): boolean {
  if (candidate.domain && prospect.domain) {
    const cd = candidate.domain.replace(/^www\./, '');
    if (cd === prospect.domain || cd.endsWith(`.${prospect.domain}`)) return true;
  }
  if (sameBusiness(candidate.raw, prospect.name, prospect.location)) return true;
  // Website brand token showing up as text, e.g. "spproofing.co.uk" or "SPPRoofing".
  const brand = domainBrand(prospect.domain);
  if (brand.length >= 5) {
    const flat = tokens(candidate.raw).join('');
    if (flat === brand || (candidate.domain && domainBrand(candidate.domain) === brand)) return true;
  }
  return false;
}

/** Decide whether a candidate is a genuine alternative service provider. */
export function classifyCandidate(c: Candidate, prospect: Prospect): EntityKind {
  if (isProspect(c, prospect)) return 'prospect';
  const known = knownKind(c.raw, c.domain);
  if (known) return known;
  if (c.domain) {
    const dk = knownKind(c.domain, c.domain);
    if (dk) return dk;
  }

  const toks = tokens(c.raw).filter((t) => t !== '&');
  const distinct = distinctiveTokens(c.raw, prospect.location);
  if (toks.length === 0) return 'unrelated';
  const loc = locationTokens(prospect.location);
  if (toks.every((t) => loc.has(t))) return 'unrelated';
  const hasLegalWord = toks.some((t) => /^(ltd|limited|llp|plc|group|co|company|contractors)$/.test(t));
  // "Southampton Roofers" is a description, not a company; "Southampton Roofing Ltd" presented as a name is.
  if (distinct.length === 0) {
    return hasLegalWord && c.source !== 'text' ? 'competitor' : 'uncertain';
  }

  const hasTradeWord = hasLegalWord || toks.some((t) => isServiceWord(t) || /^(services)$/.test(t));
  if (hasTradeWord) return 'competitor';
  // A linked name to a business-looking website is a strong signal.
  if (c.domain && c.source === 'link') return 'competitor';
  // Bare bold names ("Stormguard") in a list of providers are plausible businesses; heading-less capitalised
  // single words from body text are not.
  if ((c.source === 'bold' || c.source === 'list') && toks.length >= 1 && toks.length <= 4 && /[A-Z]/.test(c.raw)) {
    return distinct.length >= 1 && toks.length >= 2 ? 'competitor' : 'uncertain';
  }
  return 'uncertain';
}

/** Turn raw candidates into merged entity mentions for one layer/turn. */
export function toMentions(
  candidates: Candidate[],
  prospect: Prospect,
  layer: EntityMention['layer'],
  turnIndex: number,
): EntityMention[] {
  const mentions: EntityMention[] = [];
  for (const c of candidates) {
    const kind = classifyCandidate(c, prospect);
    const key = kind === 'prospect' ? '__prospect__' : nameKey(c.raw, prospect.location) || c.raw.toLowerCase();
    const existing = mentions.find(
      (m) => m.key === key || (m.kind === kind && kind === 'competitor' && sameBusiness(m.name, c.raw, prospect.location)),
    );
    if (existing) {
      // Prefer the shorter clean display name and keep any domain we learn.
      if (c.raw.length < existing.name.length && !/\./.test(c.raw)) existing.name = c.raw;
      if (c.domain && !existing.domain) existing.domain = c.domain;
      continue;
    }
    const m: EntityMention = {
      raw: c.raw,
      key,
      name: kind === 'prospect' ? prospect.name : c.raw,
      kind,
      layer,
      turnIndex,
    };
    if (c.domain) m.domain = c.domain;
    mentions.push(m);
  }
  return mentions;
}

const LAYER_WEIGHT: Record<Layer, number> = { CONVERSATIONAL: 3, RECOMMENDED: 2, VISIBLE: 1 };

/**
 * Rank genuine competitors across all layers. Prefers Conversational, then
 * Recommended, then recurrence. Never pads the list.
 */
export function rankCompetitors(mentions: EntityMention[], location: string, limit = 3): Competitor[] {
  const groups: { rep: EntityMention; all: EntityMention[] }[] = [];
  for (const m of mentions) {
    if (m.kind !== 'competitor' || m.layer === 'BRAND_DIAGNOSTIC') continue;
    const g = groups.find((x) => sameBusiness(x.rep.name, m.name, location));
    if (g) g.all.push(m);
    else groups.push({ rep: m, all: [m] });
  }
  const ranked: Competitor[] = groups.map((g) => {
    const layers = [...new Set(g.all.map((m) => m.layer as Layer))];
    const distinctTurns = new Set(g.all.map((m) => `${m.layer}:${m.turnIndex}`)).size;
    const score = layers.reduce((s, l) => s + LAYER_WEIGHT[l], 0) + (layers.length - 1) + (distinctTurns - 1) * 0.5;
    const name = g.all.map((m) => m.name).sort((a, b) => a.length - b.length)[0] ?? g.rep.name;
    const c: Competitor = { name, layers, mentions: distinctTurns, score };
    const domain = g.all.find((m) => m.domain)?.domain;
    if (domain) c.domain = domain;
    return c;
  });
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.slice(0, limit);
}
