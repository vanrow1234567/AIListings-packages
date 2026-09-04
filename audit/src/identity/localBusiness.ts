import type { IdentityResolution, LocalBusinessLookupEvidence, Prospect, ProspectIdentityFacts, ResolutionState } from '../domain/types.ts';
import { domainKind } from '../competitors/classify.ts';
import { nameKey, sameBusiness } from '../analysis/normalise.ts';
import { toDomain } from '../business/understand.ts';
import type { IdentityCandidate, IdentityProvider } from './provider.ts';
import { normalisePhone, normalisePostcode } from './prospectFacts.ts';

/** A public local-business listing (Google Business Profile / Maps or equivalent). */
export interface LocalBusinessListing {
  name: string;
  website?: string;
  phone?: string;
  /** Full street address as shown. */
  address?: string;
  /** Town / locality as shown. */
  locality?: string;
  /** Provider's stable identifier (Google place_id / cid, Apify id, ...). */
  providerBusinessId?: string;
  /** Vendor / dataset the listing came from. */
  source: string;
}

export interface LocalBusinessQuery {
  candidateName: string;
  candidateContext: string;
  prospectName: string;
  prospectDomain: string;
  prospectLocation: string;
}

/**
 * Vendor seam. Implement with DataForSEO, Apify, SerpApi or another Google Business / Maps
 * source. Must throw (or reject) on any transport / API / quota failure so the identity
 * provider can record UNRESOLVED; must never fabricate listings.
 */
export interface LocalBusinessLookupProvider {
  readonly name: string;
  /** Build the human-readable query that will be sent, for the evidence record. */
  queryFor(q: LocalBusinessQuery): string;
  search(q: LocalBusinessQuery): Promise<LocalBusinessListing[]>;
}

type ListingVerdict = { state: ResolutionState; fields: string[]; conflict?: string };

function evaluateListing(listing: LocalBusinessListing, prospect: Prospect, facts: ProspectIdentityFacts): ListingVerdict {
  const fields: string[] = [];
  let websiteVerdict: ResolutionState | undefined;
  const site = listing.website ? toDomain(listing.website) : '';
  if (site) {
    const kind = domainKind(site, prospect);
    if (kind === 'prospect' || (facts.canonicalDomain && (site === facts.canonicalDomain || site.endsWith(`.${facts.canonicalDomain}`)))) {
      websiteVerdict = 'CONFIRMED_PROSPECT';
      fields.push('website');
    } else if (kind === 'business') {
      websiteVerdict = 'CONFIRMED_OTHER_BUSINESS';
      fields.push('website');
    }
    // A social / directory page as "website" proves nothing either way.
  }
  const phone = listing.phone ? normalisePhone(listing.phone) : undefined;
  const phoneMatches = !!phone && facts.phones.includes(phone);
  const phoneConflicts = !!phone && facts.phones.length > 0 && !phoneMatches;

  let addressMatches = false;
  if (listing.address && facts.postcode) {
    const pc = normalisePostcode(listing.address);
    const street = (facts.streetAddress ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    const streetTokens = street.split(/\s+/).filter(Boolean);
    const addr = listing.address.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    // Unique enough: same postcode AND the prospect's first address line (number + street) present.
    addressMatches = pc === normalisePostcode(facts.postcode) && streetTokens.length >= 2 && streetTokens.every((t) => addr.includes(t));
  }

  if (websiteVerdict === 'CONFIRMED_PROSPECT') {
    if (phoneConflicts) return { state: 'UNRESOLVED', fields, conflict: 'listing website matches the prospect but its phone does not' };
    if (phoneMatches) fields.push('phone');
    return { state: 'CONFIRMED_PROSPECT', fields };
  }
  if (websiteVerdict === 'CONFIRMED_OTHER_BUSINESS') {
    if (phoneMatches || addressMatches) return { state: 'UNRESOLVED', fields, conflict: 'listing website is another business but its contact details match the prospect' };
    return { state: 'CONFIRMED_OTHER_BUSINESS', fields };
  }
  // No usable website on the listing: fall back to independently sourced contact facts.
  if (phoneMatches) {
    fields.push('phone');
    if (addressMatches) fields.push('address');
    return { state: 'CONFIRMED_PROSPECT', fields };
  }
  if (addressMatches && !phoneConflicts) {
    fields.push('address');
    return { state: 'CONFIRMED_PROSPECT', fields };
  }
  if (addressMatches && phoneConflicts) return { state: 'UNRESOLVED', fields, conflict: 'listing address matches the prospect but its phone does not' };
  return { state: 'UNRESOLVED', fields }; // name / location similarity alone is never enough
}

/**
 * Proves whether a surfaced result is the same entity as the prospect using public
 * local-business data, with the prospect's own website as the source of truth.
 * Rules: website domain equals prospect -> CONFIRMED_PROSPECT; website is another business ->
 * CONFIRMED_OTHER_BUSINESS; no website but phone (or unique address) independently obtained from
 * the prospect website matches -> CONFIRMED_PROSPECT; name or location similarity alone -> never;
 * conflicting evidence -> UNRESOLVED; provider failure -> UNRESOLVED.
 */
export class LocalBusinessIdentityProvider implements IdentityProvider {
  readonly name: string;
  private readonly lookup: LocalBusinessLookupProvider;
  private readonly facts: (prospect: Prospect) => Promise<ProspectIdentityFacts>;
  private readonly now: () => Date;

  constructor(lookup: LocalBusinessLookupProvider, facts: (prospect: Prospect) => Promise<ProspectIdentityFacts>, now: () => Date = () => new Date()) {
    this.lookup = lookup;
    this.facts = facts;
    this.now = now;
    this.name = `local-business:${lookup.name}`;
  }

  async resolve(candidate: IdentityCandidate, prospect: Prospect): Promise<IdentityResolution> {
    const query: LocalBusinessQuery = { candidateName: candidate.name, candidateContext: candidate.context, prospectName: prospect.name, prospectDomain: prospect.domain, prospectLocation: prospect.location };
    const lookupQuery = this.lookup.queryFor(query);
    const base: IdentityResolution = {
      candidateName: candidate.name,
      candidateContext: candidate.context,
      ...(candidate.href ? { sourceUrl: candidate.href } : {}),
      prospectDomain: prospect.domain,
      resolutionMethod: 'local_business_lookup',
      resolutionState: 'UNRESOLVED',
      layer: candidate.layer,
      turnIndex: candidate.turnIndex,
      provider: this.name,
      resolvedAt: this.now().toISOString(),
      lookup: { lookupQuery, provider: this.lookup.name, matchedFields: [] },
    };

    let facts: ProspectIdentityFacts;
    try {
      facts = await this.facts(prospect);
    } catch (err) {
      return { ...base, error: `Prospect website facts unavailable: ${(err as Error).message}` };
    }
    const evidence: LocalBusinessLookupEvidence = base.lookup!;
    if (facts.phones.length) evidence.prospectPhone = facts.phones;
    const prospectAddress = [facts.streetAddress, facts.locality, facts.postcode].filter(Boolean).join(', ');
    if (prospectAddress) evidence.prospectAddress = prospectAddress;

    let listings: LocalBusinessListing[];
    try {
      listings = await this.lookup.search(query);
    } catch (err) {
      return { ...base, error: `Lookup failed: ${(err as Error).message}` };
    }

    // Only listings whose name corresponds to the candidate can prove anything about it.
    const matching = listings.filter((l) => l.name && (nameKey(l.name, '') === nameKey(candidate.name, '') || sameBusiness(l.name, candidate.name, prospect.location)));
    evidence.ignoredListings = listings.length - matching.length;
    if (matching.length === 0) return { ...base, error: listings.length ? 'No listing corresponded to the candidate name' : 'No listings returned' };

    const verdicts = matching.map((l) => ({ listing: l, verdict: evaluateListing(l, prospect, facts) }));
    const confirmed = verdicts.filter((v) => v.verdict.state === 'CONFIRMED_PROSPECT');
    const other = verdicts.filter((v) => v.verdict.state === 'CONFIRMED_OTHER_BUSINESS');
    const conflicts = verdicts.filter((v) => v.verdict.conflict);

    const describe = (l: LocalBusinessListing) => {
      evidence.returnedBusinessName = l.name;
      if (l.website) evidence.returnedWebsite = l.website;
      if (l.phone) evidence.returnedPhone = l.phone;
      if (l.address) evidence.returnedAddress = l.address;
      if (l.locality) evidence.returnedLocation = l.locality;
      if (l.providerBusinessId) evidence.providerBusinessId = l.providerBusinessId;
    };

    if (conflicts.length || (confirmed.length && other.length)) {
      const first = conflicts[0] ?? confirmed[0]!;
      describe(first.listing);
      return { ...base, error: first.verdict.conflict ?? 'Listings disagree about whether this is the prospect' };
    }
    if (confirmed.length) {
      const hit = confirmed[0]!;
      describe(hit.listing);
      evidence.matchedFields = hit.verdict.fields;
      const method = hit.verdict.fields.includes('website') ? 'local_business_website' : hit.verdict.fields.includes('phone') ? 'local_business_phone' : 'local_business_address';
      const matched = hit.listing.website ? toDomain(hit.listing.website) : facts.canonicalDomain || prospect.domain;
      return { ...base, resolutionMethod: method, resolutionState: 'CONFIRMED_PROSPECT', matchedDomain: matched, ...(hit.listing.website ? { finalUrl: hit.listing.website } : {}) };
    }
    if (other.length) {
      const hit = other[0]!;
      describe(hit.listing);
      evidence.matchedFields = hit.verdict.fields;
      return { ...base, resolutionMethod: 'local_business_website', resolutionState: 'CONFIRMED_OTHER_BUSINESS', matchedDomain: toDomain(hit.listing.website ?? ''), ...(hit.listing.website ? { finalUrl: hit.listing.website } : {}) };
    }
    describe(matching[0]!);
    return { ...base, error: 'Listing found but neither website, phone nor address proved identity either way' };
  }
}
