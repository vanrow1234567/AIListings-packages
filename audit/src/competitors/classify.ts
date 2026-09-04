import type { Competitor, EntityKind, EntityMention, Layer, Prospect, ProspectMatchEvidence } from '../domain/types.ts';
import { isBareDomain, type Candidate } from '../analysis/extract.ts';
import { distinctiveTokens, domainBrand, isServiceWord, locationTokens, nameKey, sameBusiness, tokens } from '../analysis/normalise.ts';

interface KnownEntity {
  kind: EntityKind;
  names: string[];
  domains: string[];
}

/**
 * Infrastructure that appears inside ChatGPT answers but is never a business the user
 * is being sent to: map tiles and attribution, search/maps deep links, ChatGPT/OpenAI
 * itself, CDNs, analytics and link shorteners.
 */
const INFRASTRUCTURE_DOMAINS = [
  'mapbox.com', 'openstreetmap.org', 'maps.google.com', 'google.com', 'google.co.uk', 'goo.gl', 'maps.apple.com',
  'bing.com', 'here.com', 'chatgpt.com', 'openai.com', 'oaiusercontent.com', 'oaistatic.com', 'googleapis.com',
  'gstatic.com', 'cloudflare.com', 'cloudfront.net', 'akamaized.net', 'doubleclick.net', 'google-analytics.com',
  'googletagmanager.com', 'googleadservices.com', 'bit.ly', 't.co', 'lnkd.in', 'ow.ly', 'tinyurl.com', 'utm.io',
];
const INFRASTRUCTURE_NAMES = ['mapbox', 'openstreetmap', 'google maps', 'maps', 'apple maps', 'bing maps', 'improve this map', 'chatgpt', 'openai', 'gpt', 'temporary chat', 'sources', 'citations', 'search'];

/** Well-known non-competitor entities that appear in UK local-service answers. */
const KNOWN: KnownEntity[] = [
  {
    kind: 'directory',
    names: ['checkatrade', 'yell', 'thomson local', 'trustatrader', 'trust a trader', 'which trusted traders', 'which? trusted traders', 'cylex', 'freeindex', 'scoot', '192', 'hotfrog', 'bing places', 'google business profile', 'google business', 'yelp', 'nextdoor', 'facebook', 'instagram', 'linkedin', 'local directories', 'houzz'],
    domains: ['checkatrade.com', 'yell.com', 'thomsonlocal.com', 'trustatrader.com', 'trustedtraders.which.co.uk', 'cylex-uk.co.uk', 'freeindex.co.uk', 'scoot.co.uk', '192.com', 'hotfrog.co.uk', 'yelp.co.uk', 'yelp.com', 'nextdoor.co.uk', 'facebook.com', 'instagram.com', 'linkedin.com', 'houzz.co.uk'],
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
    names: ['wikipedia', 'which?', 'which', 'citizens advice', 'gov.uk', 'bbc', 'moneysavingexpert', 'money saving expert', 'reddit', 'youtube', 'nhs', 'federation of master builders', 'fmb', 'nfrc', 'national federation of roofing contractors', 'competent roofer', 'competentroofer', 'trustmark', 'gas safe register', 'gas safe', 'niceic', 'napit', 'companies house', 'city council', 'county council', 'trading standards', 'homeowners alliance', 'homebuilding & renovating', 'the guardian', 'the times', 'daily echo', 'law society', 'sra', 'rics', 'royal institution of chartered surveyors', 'ico', 'ofsted', 'hmrc', 'the tile association', 'tta'],
    domains: ['wikipedia.org', 'which.co.uk', 'citizensadvice.org.uk', 'gov.uk', 'bbc.co.uk', 'moneysavingexpert.com', 'reddit.com', 'youtube.com', 'nhs.uk', 'fmb.org.uk', 'nfrc.co.uk', 'competentroofer.co.uk', 'trustmark.org.uk', 'gassaferegister.co.uk', 'niceic.com', 'napit.org.uk', 'companieshouse.gov.uk', 'find-and-update.company-information.service.gov.uk', 'hoa.org.uk', 'homebuilding.co.uk', 'theguardian.com', 'dailyecho.co.uk', 'lawsociety.org.uk', 'rics.org', 'hmrc.gov.uk', 'tiles.org.uk'],
  },
  { kind: 'unrelated', names: INFRASTRUCTURE_NAMES, domains: INFRASTRUCTURE_DOMAINS },
];

function domainMatches(domain: string | undefined, list: readonly string[]): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^www\./, '');
  return list.some((k) => d === k || d.endsWith(`.${k}`));
}

export function isInfrastructure(nameOrDomain: string, domain?: string): boolean {
  const lower = nameOrDomain.toLowerCase().replace(/^©\s*/, '').trim();
  return domainMatches(domain, INFRASTRUCTURE_DOMAINS) || domainMatches(isBareDomain(lower) ? lower : undefined, INFRASTRUCTURE_DOMAINS) || INFRASTRUCTURE_NAMES.includes(lower);
}

function knownKind(name: string, domain: string | undefined): EntityKind | undefined {
  const lower = name.toLowerCase().replace(/^©\s*/, '').replace(/[^a-z0-9?. -]/g, '').trim();
  for (const k of KNOWN) {
    if (domainMatches(domain, k.domains)) return k.kind;
    if (isBareDomain(lower) && domainMatches(lower.split('/')[0], k.domains)) return k.kind;
    if (k.names.some((n) => lower === n || lower === `${n}.com` || lower === `${n}.co.uk`)) return k.kind;
    // e.g. "Checkatrade UK"
    if (k.names.some((n) => n.length >= 5 && lower.startsWith(`${n} `))) return k.kind;
  }
  return undefined;
}

function serviceTerms(prospect: Prospect): readonly string[] {
  return prospect.serviceTerms ?? [];
}

/**
 * Evidence-bound prospect match. Returns the visible evidence when the candidate
 * genuinely names the prospect, otherwise undefined. Rules:
 *  - a hidden href alone never counts; only the visible text of the candidate is considered;
 *  - a candidate made only of trade / location / legal words ("Tiling", "Wendover Tilers") never matches;
 *  - every identity token of the prospect (e.g. "ls" in "LS-Tiling", "spp" in "SPP Roofing") must be visible;
 *  - a short identity token (<= 3 chars) additionally needs one of the prospect's trade words alongside it;
 *  - the candidate must not carry a different trade ("LS Plumbing" is not "LS-Tiling").
 */
export function matchProspect(candidate: Candidate, prospect: Prospect, turnIndex = 0): ProspectMatchEvidence | undefined {
  const terms = serviceTerms(prospect);
  const raw = candidate.raw.trim();
  const base = { snippet: raw, context: candidate.context, source: candidate.source, turnIndex };

  // 1. The prospect's own website visibly presented.
  if (prospect.domain && isBareDomain(raw)) {
    const shown = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
    if (shown === prospect.domain || shown.endsWith(`.${prospect.domain}`)) return { ...base, matchedBy: 'visible_domain' };
    return undefined;
  }

  const candTokens = tokens(raw).filter((t) => t !== '&');
  const candIdentity = distinctiveTokens(raw, prospect.location, terms);
  if (candIdentity.length === 0) return undefined; // generic description, never the prospect

  // 2. Business name with a strong identity match.
  if (matchesBusinessName(candTokens, candIdentity, prospect, terms, raw)) return { ...base, matchedBy: 'business_name' };

  // 3. Alias: the website brand written as a word, e.g. "LSTiling" / "spproofing".
  const brand = domainBrand(prospect.domain).replace(/-/g, '');
  if (brand.length >= 5 && candTokens.join('') === brand) return { ...base, matchedBy: 'name_alias' };
  return undefined;
}

function matchesBusinessName(candTokens: string[], candIdentity: string[], prospect: Prospect, terms: readonly string[], raw: string): boolean {
  const prospectTokens = tokens(prospect.name).filter((t) => t !== '&');
  const prospectIdentity = distinctiveTokens(prospect.name, prospect.location, terms);
  if (prospectIdentity.length === 0) {
    // Prospect is itself named descriptively ("Wendover Tiling"): require the full normalised name.
    return candTokens.length > 0 && nameKey(raw, '') === nameKey(prospect.name, '');
  }
  const candSet = new Set(candTokens);
  if (!prospectIdentity.every((t) => candSet.has(t))) return false;
  const prospectSet = new Set(prospectTokens);
  if (!candIdentity.every((t) => prospectSet.has(t))) return false; // foreign identity words
  const prospectTrade = prospectTokens.filter((t) => isServiceWord(t, terms));
  const candTrade = candTokens.filter((t) => isServiceWord(t, terms));
  if (prospectTrade.length > 0 && candTrade.length > 0 && !candTrade.some((t) => prospectTrade.includes(t) || terms.includes(t))) {
    return false; // same initials, different trade
  }
  const shortIdentity = prospectIdentity.every((t) => t.length <= 3);
  if (shortIdentity && candTrade.length === 0) return false; // "LS" alone is not LS-Tiling
  return true;
}

/** Backwards-compatible boolean form. */
export function isProspect(candidate: Candidate, prospect: Prospect): boolean {
  return matchProspect(candidate, prospect) !== undefined;
}

/** Decide whether a candidate is a genuine alternative service provider. */
export function classifyCandidate(c: Candidate, prospect: Prospect): EntityKind {
  if (matchProspect(c, prospect)) return 'prospect';
  if (isInfrastructure(c.raw, c.domain)) return 'unrelated';
  const known = knownKind(c.raw, c.domain);
  if (known) return known;
  // A bare domain that is not the prospect's is never a named business result on its own.
  if (isBareDomain(c.raw)) return 'uncertain';

  const terms = serviceTerms(prospect);
  const toks = tokens(c.raw).filter((t) => t !== '&');
  const distinct = distinctiveTokens(c.raw, prospect.location, terms);
  if (toks.length === 0) return 'unrelated';
  const loc = locationTokens(prospect.location);
  if (toks.every((t) => loc.has(t))) return 'unrelated';
  const hasLegalWord = toks.some((t) => /^(ltd|limited|llp|plc|group|co|company|contractors)$/.test(t));
  // "Wendover Tilers" is a description, not a company; "Wendover Tiling Ltd" presented as a name is.
  if (distinct.length === 0) {
    return hasLegalWord && c.source !== 'text' ? 'competitor' : 'uncertain';
  }
  const hasTradeWord = hasLegalWord || toks.some((t) => isServiceWord(t, terms) || t === 'services');
  if (hasTradeWord) return 'competitor';
  // Multi-word bold / list / linked names ("Signature Tiling & Carpentry" is caught above; "Stone & Slate Co" here)
  if ((c.source === 'bold' || c.source === 'list' || c.source === 'link') && toks.length >= 2 && toks.length <= 4 && /[A-Z]/.test(c.raw)) {
    return 'competitor';
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
    const evidence = matchProspect(c, prospect, turnIndex);
    const kind: EntityKind = evidence ? 'prospect' : classifyCandidate(c, prospect);
    const key = kind === 'prospect' ? '__prospect__' : nameKey(c.raw, prospect.location) || c.raw.toLowerCase();
    const existing = mentions.find(
      (m) => m.key === key || (m.kind === kind && kind === 'competitor' && sameBusiness(m.name, c.raw, prospect.location)),
    );
    if (existing) {
      if (c.raw.length < existing.name.length && !/\./.test(c.raw) && kind !== 'prospect') existing.name = c.raw;
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
    if (evidence) m.evidence = evidence;
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
    if (isBareDomain(m.name) || isInfrastructure(m.name, m.domain)) continue; // belt and braces
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
