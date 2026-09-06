import { normaliseWebsite, toDomain } from '../business/understand.ts';
import type {
  AuditRequest,
  Prospect,
  ProspectIdentityFacts,
} from '../domain/types.ts';
import type {
  LocalBusinessListing,
  LocalBusinessLookupProvider,
  LocalBusinessQuery,
} from '../identity/localBusiness.ts';
import { normalisePhone } from '../identity/prospectFacts.ts';

export type IntakeLocationSource = 'supplied' | 'website' | 'maps';

export type IntakeLocationMatch =
  | 'location'
  | 'city'
  | 'website_locality'
  | 'maps_website'
  | 'maps_phone';

export interface IntakeResolution {
  source: IntakeLocationSource;
  matchedBy: IntakeLocationMatch;
}

export type IntakeResult =
  | {
      ok: true;
      value: AuditRequest;
      resolution: IntakeResolution;
    }
  | {
      ok: false;
      status: 400 | 422;
      error: string;
      message: string;
    };

export interface IntakeResolverDeps {
  facts: (prospect: Prospect) => Promise<ProspectIdentityFacts>;
  maps?: LocalBusinessLookupProvider;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function listingMatch(
  listing: LocalBusinessListing,
  domain: string,
  suppliedPhone: string | undefined,
): 'maps_website' | 'maps_phone' | undefined {
  const listingDomain = listing.website ? toDomain(listing.website) : '';

  if (domain && listingDomain && listingDomain === domain) {
    return 'maps_website';
  }

  if (suppliedPhone && listing.phone) {
    const listingPhone = normalisePhone(listing.phone);
    if (listingPhone && listingPhone === suppliedPhone) {
      return 'maps_phone';
    }
  }

  return undefined;
}

export async function resolveAuditIntake(
  body: unknown,
  deps: IntakeResolverDeps,
): Promise<IntakeResult> {
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      status: 400,
      error: 'INVALID_REQUEST',
      message: 'Body must be a JSON object',
    };
  }

  const b = body as Record<string, unknown>;

  const business_name = clean(b.business_name);
  const rawWebsite = clean(b.website);
  const website = normaliseWebsite(rawWebsite);
  const directLocation = clean(b.location);
  const city = clean(b.city);
  const lead_id = clean(b.lead_id);
  const contact_name = clean(b.contact_name) || clean(b.first_name);
  const phone = clean(b.phone);
  const industry_hint = clean(b.industry_hint) || clean(b.industry);

  if (!business_name) {
    return {
      ok: false,
      status: 400,
      error: 'BUSINESS_NAME_REQUIRED',
      message: 'business_name is required',
    };
  }

  if (!website) {
    return {
      ok: false,
      status: 400,
      error: 'WEBSITE_REQUIRED',
      message: 'website is required',
    };
  }

  const makeRequest = (location: string): AuditRequest => {
    const value: AuditRequest = {
      business_name,
      website,
      location,
    };

    if (contact_name) value.contact_name = contact_name;
    if (phone) value.phone = phone;
    if (lead_id) value.lead_id = lead_id;
    if (industry_hint) value.industry_hint = industry_hint;

    if (b.include_brand_diagnostic === true) {
      value.include_brand_diagnostic = true;
    }

    return value;
  };

  if (directLocation) {
    return {
      ok: true,
      value: makeRequest(directLocation),
      resolution: {
        source: 'supplied',
        matchedBy: 'location',
      },
    };
  }

  if (city) {
    return {
      ok: true,
      value: makeRequest(city),
      resolution: {
        source: 'supplied',
        matchedBy: 'city',
      },
    };
  }

  const domain = toDomain(website);

  const prospect: Prospect = {
    name: business_name,
    website,
    domain,
    location: '',
  };

  try {
    const facts = await deps.facts(prospect);
    const locality = clean(facts.locality);

    if (locality) {
      return {
        ok: true,
        value: makeRequest(locality),
        resolution: {
          source: 'website',
          matchedBy: 'website_locality',
        },
      };
    }
  } catch {
    // Website evidence unavailable: continue to Maps.
  }

  if (deps.maps) {
    const suppliedPhone = normalisePhone(phone);

    const query: LocalBusinessQuery = {
      candidateName: business_name,
      candidateContext: 'GHL audit intake location resolution',
      prospectName: business_name,
      prospectDomain: domain,
      prospectLocation: '',
    };

    try {
      const listings = await deps.maps.search(query);

      const matches = listings
        .map((listing) => ({
          listing,
          matchedBy: listingMatch(listing, domain, suppliedPhone),
        }))
        .filter(
          (
            item,
          ): item is {
            listing: LocalBusinessListing;
            matchedBy: 'maps_website' | 'maps_phone';
          } => Boolean(item.matchedBy),
        )
        .filter((item) => clean(item.listing.locality));

      const locations: string[] = [];

      for (const item of matches) {
        const locality = clean(item.listing.locality);

        if (!locations.some((existing) => sameText(existing, locality))) {
          locations.push(locality);
        }
      }

      if (locations.length === 1) {
        const location = locations[0]!;
        const matchedBy = matches.some(
          (item) =>
            sameText(clean(item.listing.locality), location) &&
            item.matchedBy === 'maps_website',
        )
          ? 'maps_website'
          : 'maps_phone';

        return {
          ok: true,
          value: makeRequest(location),
          resolution: {
            source: 'maps',
            matchedBy,
          },
        };
      }
    } catch {
      // Provider failure is not permission to guess.
    }
  }

  return {
    ok: false,
    status: 422,
    error: 'LOCATION_UNRESOLVED',
    message:
      'We could not confidently establish the business location from the supplied and publicly available information.',
  };
}