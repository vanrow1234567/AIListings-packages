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

const UK_REGIONS = new Set([
  'buckinghamshire', 'bucks', 'hampshire', 'hants', 'berkshire', 'berks', 'oxfordshire', 'oxon', 'hertfordshire', 'herts',
  'bedfordshire', 'beds', 'surrey', 'kent', 'essex', 'sussex', 'wiltshire', 'wilts', 'dorset', 'somerset', 'devon',
  'cornwall', 'gloucestershire', 'glos', 'warwickshire', 'worcestershire', 'herefordshire', 'northamptonshire',
  'cambridgeshire', 'cambs', 'norfolk', 'suffolk', 'lincolnshire', 'lincs', 'leicestershire', 'leics', 'rutland',
  'nottinghamshire', 'notts', 'derbyshire', 'staffordshire', 'staffs', 'shropshire', 'cheshire', 'lancashire', 'lancs',
  'yorkshire', 'cumbria', 'durham', 'northumberland', 'merseyside', 'manchester', 'london', 'midlands', 'england',
  'scotland', 'wales', 'uk', 'united', 'kingdom', 'britain', 'chilterns', 'cotswolds', 'thames', 'valley', 'home', 'counties',
  'aylesbury', 'chesham', 'amersham', 'tring', 'princes', 'risborough', 'thame', 'high', 'wycombe', 'beaconsfield',
]);
const STREET_WORDS =
  /\b(street|st|road|rd|lane|ln|avenue|ave|close|cl|drive|dr|way|place|pl|court|ct|crescent|cres|hill|park|gardens|gdns|square|sq|terrace|row|grove|rise|view|end|green|walk|mews|parade|estate|industrial|business|centre|center|unit|units|suite|floor)\b\.?$/i;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

/**
 * "Wendover, Buckinghamshire", "Pound Street, Wendover", "12 London Road", "HP22 6EJ":
 * places and street addresses shown on map cards, never businesses.
 */
export function looksLikePlaceOrAddress(raw: string, location: string): boolean {
  const name = raw.trim();
  if (UK_POSTCODE.test(name)) return true;
  if (/^\d+[a-z]?\b/i.test(name)) return true; // house number
  const loc = locationTokens(location);
  const parts = name.split(/\s*,\s*/).filter(Boolean);
  const isPlaceToken = (t: string) => loc.has(t) || UK_REGIONS.has(t);
  const partIsPlace = (part: string) => {
    const toks = tokens(part).filter((t) => t !== '&');
    if (toks.length === 0) return false;
    if (toks.every(isPlaceToken)) return true;
    return STREET_WORDS.test(part) && !toks.some((t) => isServiceWord(t) || /^(ltd|limited|plc|llp|co|company)$/.test(t));
  };
  if (parts.length >= 2 && parts.every(partIsPlace)) return true;
  if (parts.length >= 2 && parts.slice(1).every((p) => tokens(p).every(isPlaceToken)) && partIsPlace(parts[0] ?? '')) return true;
  if (parts.length === 1) {
    const toks = tokens(name).filter((t) => t !== '&');
    if (toks.length > 0 && toks.every(isPlaceToken)) return true;
    if (STREET_WORDS.test(name) && !toks.some((t) => isServiceWord(t) || /^(ltd|limited|plc|llp|co|company)$/.test(t))) return true;
  }
  return false;
}

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

  // 2. Business name with a strong identity match. A candidate that links to the prospect's own
  //    website may carry extra trading-name words ("LS Tiling & Patios" -> ls-tiling.co.uk); by name
  //    alone it may not.
  const linksToProspect = !!candidate.domain && domainMatches(candidate.domain, [prospect.domain]) && prospect.domain.length > 0;
  const nameMatch = matchesBusinessName(candTokens, candIdentity, prospect, terms, raw, linksToProspect);
  if (nameMatch) return { ...base, matchedBy: linksToProspect && nameMatch === 'with_domain' ? 'name_with_domain' : 'business_name' };

  // 3. Alias: the website brand written as a word, e.g. "LSTiling" / "spproofing".
  const brand = domainBrand(prospect.domain).replace(/-/g, '');
  if (brand.length >= 5 && candTokens.join('') === brand) return { ...base, matchedBy: 'name_alias' };
  return undefined;
}

/** "tiling" / "tilers" / "tiler" -> "til"; "roofing" / "roofers" -> "roof". Morphological variants of one trade. */
function tradeStem(word: string): string {
  const stem = word.replace(/(ings?|ers?|s)$/, '');
  return stem.length >= 3 ? stem : word;
}

/**
 * Strong identity match between a visible candidate name and the prospect's name.
 * Accepted variants: punctuation, spacing, capitalisation, legal suffixes, the audit location,
 * and morphological forms of the prospect's own trade words ("LS Tilers Ltd, Wendover").
 * Rejected by name alone: any foreign identity word, and any trade word the prospect's name
 * does not carry ("Ls tiling & Patios" is not "LS-Tiling" without independent evidence).
 * Returns 'exact' | 'with_domain' (extra trading words allowed only because the candidate links
 * to the prospect's own domain) | false.
 */
function matchesBusinessName(
  candTokens: string[],
  candIdentity: string[],
  prospect: Prospect,
  terms: readonly string[],
  raw: string,
  linksToProspect: boolean,
): 'exact' | 'with_domain' | false {
  const prospectTokens = tokens(prospect.name).filter((t) => t !== '&');
  const prospectIdentity = distinctiveTokens(prospect.name, prospect.location, terms);
  if (prospectIdentity.length === 0) {
    // Prospect is itself named descriptively ("Wendover Tiling"): require the full normalised name.
    return candTokens.length > 0 && nameKey(raw, '') === nameKey(prospect.name, '') ? 'exact' : false;
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
  // Extra trading-name words are identity, not noise: "& Patios" is only accepted with domain evidence.
  const prospectStems = new Set(prospectTrade.map(tradeStem));
  const extraTrade = candTrade.filter((t) => !prospectStems.has(tradeStem(t)));
  if (extraTrade.length > 0) return linksToProspect ? 'with_domain' : false;
  return 'exact';
}

/**
 * A candidate that carries every identity token of the prospect but is not an accepted
 * variant ("Ls tiling & Patios" vs LS-Tiling, "SPP Roofing & Guttering" vs SPP Roofing).
 * Only these are worth an identity-resolution attempt; nothing else ever becomes the prospect.
 */
export function isAmbiguousProspectCandidate(candidate: Pick<Candidate, 'raw'>, prospect: Prospect): boolean {
  const terms = serviceTerms(prospect);
  const prospectIdentity = distinctiveTokens(prospect.name, prospect.location, terms);
  const candTokens = new Set(tokens(candidate.raw).filter((t) => t !== '&'));
  if (prospectIdentity.length === 0) {
    const candKey = nameKey(candidate.raw, prospect.location);
    return candKey.length > 0 && candKey.includes(nameKey(prospect.name, prospect.location));
  }
  return prospectIdentity.every((t) => candTokens.has(t));
}

/** What kind of place a hostname is, for identity resolution. */
export function domainKind(host: string, prospect: Prospect): 'prospect' | 'infrastructure' | 'intermediary' | 'business' {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (prospect.domain && domainMatches(h, [prospect.domain])) return 'prospect';
  if (domainMatches(h, INFRASTRUCTURE_DOMAINS)) return 'infrastructure';
  const known = knownKind(h, h);
  if (known === 'directory' || known === 'review_site' || known === 'marketplace' || known === 'informational' || known === 'unrelated') return 'intermediary';
  return 'business';
}

/** Backwards-compatible boolean form. */
export function isProspect(candidate: Candidate, prospect: Prospect): boolean {
  return matchProspect(candidate, prospect) !== undefined;
}

/** Decide whether a candidate is a genuine alternative service provider. */
export function classifyCandidate(c: Candidate, prospect: Prospect): EntityKind {
  if (matchProspect(c, prospect)) return 'prospect';
  if (isInfrastructure(c.raw, c.domain)) return 'unrelated';

  // Action/checklist headings are instructions, not providers. Keep this source-aware
  // so a genuine map result or linked business named "Audit ..." is not discarded.
  if (
    c.source !== 'map' &&
    c.source !== 'link' &&
    /^(audit|review|check|fix|improve|update|optimise|optimize)\b/i.test(c.raw)
  ) {
    return 'unrelated';
  }
  if (looksLikePlaceOrAddress(c.raw, prospect.location)) return 'unrelated';
  const known = knownKind(c.raw, c.domain);
  if (known) return known;
  // ChatGPT's business-marker UI explicitly identifies a local business. Once prospect,
  // infrastructure, place/address and known intermediary checks have failed, it is a
  // genuine alternative business rather than an inferred proper noun.
  if (c.source === 'map') return 'competitor';
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
    if (hasLegalWord && c.source !== 'text') return 'competitor';
    // "Wendover Interiors" shown as a link to its own (non-directory) website is a named provider.
    if (c.source === 'link' && c.domain && !isBareDomain(c.raw) && toks.length >= 2) return 'competitor';
    return 'uncertain';
  }
  const hasTradeWord = hasLegalWord || toks.some((t) => isServiceWord(t, terms) || t === 'services');
  if (hasTradeWord) return 'competitor';
  // A visible name that links to its own (non-directory, non-infrastructure) website is a named provider.
  if (c.source === 'link' && c.domain && !isBareDomain(c.raw) && toks.length >= 1 && toks.length <= 4) return 'competitor';
  // Otherwise a bold / list name needs to read as a proper noun: every word capitalised (joiners aside),
  // at least two words, no comma (a comma is a place or an address on a map card).
  if ((c.source === 'bold' || c.source === 'list') && toks.length >= 2 && toks.length <= 4 && isTitleCaseName(c.raw)) {
    return 'competitor';
  }
  return 'uncertain';
}

function isTitleCaseName(raw: string): boolean {
  if (/,/.test(raw)) return false;
  const words = raw.split(/\s+/);
  return words.every((w) => /^[A-Z0-9]/.test(w) || /^(and|of|the|&|for|at|in|on|by|de|du|la|le|von|van)$/i.test(w));
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
      if (c.href && !existing.href) existing.href = c.href;
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
    if (c.href) m.href = c.href;
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
