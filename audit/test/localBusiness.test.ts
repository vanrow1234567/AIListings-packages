/**
 * Google Business / Maps identity fallback for ambiguous prospect candidates.
 * "Can we prove this listing is the same entity as the prospect?" The prospect's own
 * website is the source of truth; names and locations alone never are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditEngine, newAuditRecord } from '../src/audit/engine.ts';
import { MockChatGptProvider } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import type { AuditRecord, Prospect, ProspectIdentityFacts } from '../src/domain/types.ts';
import { ChainedIdentityProvider } from '../src/identity/chain.ts';
import { DataForSeoMapsProvider } from '../src/identity/dataforseo.ts';
import { LocalBusinessIdentityProvider, type LocalBusinessListing, type LocalBusinessLookupProvider, type LocalBusinessQuery } from '../src/identity/localBusiness.ts';
import { extractProspectFacts, normalisePhone, normalisePostcode, prospectFactsSource } from '../src/identity/prospectFacts.ts';
import type { DestinationResolver, IdentityCandidate, IdentityProvider } from '../src/identity/provider.ts';
import { LinkIdentityResolver } from '../src/identity/resolver.ts';
import { LS_TILING, conversationalTurn1, lsTilingSite, recommendedResponse, visibleResponse } from './fixtures/lsTiling.ts';

const clock = () => new Date('2026-09-06T09:00:00.000Z');
const LS: Prospect = { name: 'LS-Tiling', website: 'https://ls-tiling.co.uk', domain: 'ls-tiling.co.uk', location: 'Wendover', serviceTerms: ['tiling', 'tilings', 'tiler', 'tilers'] };
const REAL_CONTEXT = 'Stone Reflection 5.0 Touchstone Bathrooms 5.0 SDB Tiling 5.0 Ls tiling & Patios Expand Use two fingers to move the map';
const candidate = (name = 'Ls tiling & Patios', href?: string): IdentityCandidate => ({ name, context: REAL_CONTEXT, layer: 'VISIBLE', turnIndex: 0, ...(href ? { href } : {}) });

/** Facts "independently obtained" from ls-tiling.co.uk (fixture). */
const LS_FACTS: ProspectIdentityFacts = {
  source: 'website',
  canonicalDomain: 'ls-tiling.co.uk',
  businessName: 'LS Tiling',
  phones: ['07700900123', '01296123456'],
  streetAddress: '12 Pound Street',
  locality: 'Wendover',
  postcode: 'HP22 6EJ',
  schemaTypes: ['LocalBusiness'],
  fetchedAt: clock().toISOString(),
};
const factsOf = (facts: ProspectIdentityFacts) => async () => facts;

/** Scripted vendor. Records calls; throws when told to. */
function fakeLookup(listings: LocalBusinessListing[] | Error): LocalBusinessLookupProvider & { calls: LocalBusinessQuery[] } {
  const calls: LocalBusinessQuery[] = [];
  return {
    name: 'fake-maps',
    calls,
    queryFor: (q) => `${q.candidateName} ${q.prospectLocation}`,
    async search(q) {
      calls.push(q);
      if (listings instanceof Error) throw listings;
      return listings;
    },
  };
}
const listing = (over: Partial<LocalBusinessListing> = {}): LocalBusinessListing => ({ name: 'LS Tiling & Patios', source: 'fake-maps', providerBusinessId: 'ChIJ-ls-tiling', locality: 'Aylesbury', ...over });

test('1. LS-Tiling ambiguous candidate + GBP website ls-tiling.co.uk => CONFIRMED_PROSPECT', async () => {
  const lookup = fakeLookup([listing({ website: 'https://www.ls-tiling.co.uk/', phone: '+44 7700 900123', address: '12 Pound Street, Wendover HP22 6EJ' })]);
  const r = await new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'local_business_website');
  assert.equal(r.matchedDomain, 'ls-tiling.co.uk');
  assert.equal(r.provider, 'local-business:fake-maps');
  assert.deepEqual(r.lookup?.matchedFields, ['website', 'phone']);
  assert.equal(r.lookup?.lookupQuery, 'Ls tiling & Patios Wendover');
  assert.equal(r.lookup?.returnedBusinessName, 'LS Tiling & Patios');
  assert.equal(r.lookup?.returnedWebsite, 'https://www.ls-tiling.co.uk/');
  assert.equal(r.lookup?.returnedPhone, '+44 7700 900123');
  assert.equal(r.lookup?.returnedAddress, '12 Pound Street, Wendover HP22 6EJ');
  assert.equal(r.lookup?.returnedLocation, 'Aylesbury');
  assert.equal(r.lookup?.providerBusinessId, 'ChIJ-ls-tiling');
  assert.deepEqual(r.lookup?.prospectPhone, ['07700900123', '01296123456']);
  assert.equal(r.lookup?.prospectAddress, '12 Pound Street, Wendover, HP22 6EJ');
  assert.equal(r.candidateContext, REAL_CONTEXT);
  assert.deepEqual(lookup.calls.map((c) => [c.candidateName, c.prospectName, c.prospectDomain, c.prospectLocation]), [['Ls tiling & Patios', 'LS-Tiling', 'ls-tiling.co.uk', 'Wendover']]);
});

test('2. same candidate + GBP website another-domain.co.uk => CONFIRMED_OTHER_BUSINESS', async () => {
  const lookup = fakeLookup([listing({ website: 'https://another-domain.co.uk/', phone: '01296 555555', address: '3 High Street, Aylesbury HP20 1AA' })]);
  const r = await new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_OTHER_BUSINESS');
  assert.equal(r.resolutionMethod, 'local_business_website');
  assert.equal(r.matchedDomain, 'another-domain.co.uk');
  assert.deepEqual(r.lookup?.matchedFields, ['website']);
  assert.equal(r.finalUrl, 'https://another-domain.co.uk/');
});

test('3. no GBP website + exact independently sourced phone match => CONFIRMED_PROSPECT', async () => {
  const lookup = fakeLookup([listing({ phone: '07700 900 123', address: 'Aylesbury' })]);
  const r = await new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'local_business_phone');
  assert.deepEqual(r.lookup?.matchedFields, ['phone']);
  assert.equal(r.matchedDomain, 'ls-tiling.co.uk', 'attributed to the prospect domain via its own website facts');
  // A social page as the listing "website" proves nothing; the phone still does.
  const social = fakeLookup([listing({ website: 'https://www.facebook.com/lstilingpatios', phone: '+447700900123' })]);
  assert.equal((await new LocalBusinessIdentityProvider(social, factsOf(LS_FACTS), clock).resolve(candidate(), LS)).resolutionMethod, 'local_business_phone');
  // Unique address match (postcode + first line) also proves identity without a website.
  const addr = fakeLookup([listing({ address: '12 Pound Street, Wendover, Aylesbury HP22 6EJ' })]);
  const byAddress = await new LocalBusinessIdentityProvider(addr, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(byAddress.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(byAddress.resolutionMethod, 'local_business_address');
  // Postcode alone is not unique enough.
  const pcOnly = fakeLookup([listing({ address: 'Unit 4, HP22 6EJ' })]);
  assert.equal((await new LocalBusinessIdentityProvider(pcOnly, factsOf(LS_FACTS), clock).resolve(candidate(), LS)).resolutionState, 'UNRESOLVED');
});

test('4. similar name / location only => UNRESOLVED', async () => {
  const lookup = fakeLookup([listing({ locality: 'Wendover', address: 'Wendover, Buckinghamshire' })]);
  const r = await new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(r.resolutionState, 'UNRESOLVED');
  assert.equal(r.resolutionMethod, 'local_business_lookup');
  assert.deepEqual(r.lookup?.matchedFields, []);
  assert.match(r.error ?? '', /neither website, phone nor address/);
  // Listings that do not correspond to the candidate name are ignored, never borrowed.
  const wrongName = fakeLookup([listing({ name: 'SDB Tiling', website: 'https://ls-tiling.co.uk/' })]);
  const r2 = await new LocalBusinessIdentityProvider(wrongName, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(r2.resolutionState, 'UNRESOLVED');
  assert.equal(r2.lookup?.ignoredListings, 1);
  // No prospect facts at all (website unreachable): a phone on the listing cannot be checked.
  const noFacts: ProspectIdentityFacts = { source: 'none', canonicalDomain: 'ls-tiling.co.uk', phones: [], schemaTypes: [], fetchedAt: clock().toISOString(), error: 'Prospect website could not be fetched' };
  const r3 = await new LocalBusinessIdentityProvider(fakeLookup([listing({ phone: '07700900123' })]), factsOf(noFacts), clock).resolve(candidate(), LS);
  assert.equal(r3.resolutionState, 'UNRESOLVED');
});

test('5. conflicting phone / domain evidence => UNRESOLVED', async () => {
  // Website says another business, phone says the prospect.
  const a = fakeLookup([listing({ website: 'https://another-domain.co.uk/', phone: '07700900123' })]);
  const ra = await new LocalBusinessIdentityProvider(a, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(ra.resolutionState, 'UNRESOLVED');
  assert.match(ra.error ?? '', /another business but its contact details match/);
  // Website says the prospect, phone belongs to someone else.
  const b = fakeLookup([listing({ website: 'https://ls-tiling.co.uk/', phone: '01296 999999' })]);
  const rb = await new LocalBusinessIdentityProvider(b, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(rb.resolutionState, 'UNRESOLVED');
  assert.match(rb.error ?? '', /phone does not/);
  // Two listings with the same name disagree.
  const c = fakeLookup([listing({ website: 'https://ls-tiling.co.uk/' }), listing({ website: 'https://another-domain.co.uk/', providerBusinessId: 'other' })]);
  const rc = await new LocalBusinessIdentityProvider(c, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(rc.resolutionState, 'UNRESOLVED');
  assert.match(rc.error ?? '', /disagree/);
});

test('6. API / provider failure => UNRESOLVED, layer IDENTITY_UNRESOLVED, audit INCOMPLETE', async () => {
  const lookup = fakeLookup(new Error('DataForSEO HTTP 401'));
  const provider = new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock);
  const r = await provider.resolve(candidate(), LS);
  assert.equal(r.resolutionState, 'UNRESOLVED');
  assert.equal(r.resolutionMethod, 'local_business_lookup');
  assert.match(r.error ?? '', /Lookup failed: DataForSEO HTTP 401/);
  // Facts fetch failure is also fail-closed.
  const factsFail = new LocalBusinessIdentityProvider(fakeLookup([listing({ website: 'https://ls-tiling.co.uk/' })]), async () => { throw new Error('ETIMEDOUT'); }, clock);
  assert.equal((await factsFail.resolve(candidate(), LS)).resolutionState, 'UNRESOLVED');
  // End to end through the chain and the engine.
  const { record } = await runChain(undefined, lookup);
  assert.equal(record.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED');
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.outreachMessage, undefined);
  assert.equal(record.publicReport, undefined);
  const stored = record.layers.CONVERSATIONAL.identityResolutions?.[0];
  assert.equal(stored?.provider, 'local-business:fake-maps');
  assert.deepEqual(stored?.previousAttempts, [{ provider: 'link-resolver', resolutionMethod: 'no_link', resolutionState: 'UNRESOLVED' }]);
});

// ---- chain gating -------------------------------------------------------------------------
const noopDestinations: DestinationResolver = { async resolve(url) { return { ok: true, sourceUrl: url, finalUrl: url, finalHost: new URL(url).hostname, hops: [] }; } };

test('7. link resolver already CONFIRMED_PROSPECT => GBP provider is never called', async () => {
  const lookup = fakeLookup([listing({ website: 'https://another-domain.co.uk/' })]);
  const chain = new ChainedIdentityProvider([new LinkIdentityResolver(noopDestinations, clock), new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock)]);
  const r = await chain.resolve(candidate('Ls tiling & Patios', 'https://ls-tiling.co.uk/'), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.provider, 'link-resolver');
  assert.equal(r.previousAttempts, undefined);
  assert.deepEqual(lookup.calls, []);
});

test('8. link resolver already CONFIRMED_OTHER_BUSINESS => GBP provider is never called', async () => {
  const lookup = fakeLookup([listing({ website: 'https://ls-tiling.co.uk/' })]);
  const chain = new ChainedIdentityProvider([new LinkIdentityResolver(noopDestinations, clock), new LocalBusinessIdentityProvider(lookup, factsOf(LS_FACTS), clock)]);
  const r = await chain.resolve(candidate('Ls tiling & Patios', 'https://different-tiler.co.uk/'), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_OTHER_BUSINESS');
  assert.deepEqual(lookup.calls, []);
});

test('9. ordinary unrelated competitor => GBP provider is never called (no resolution attempted at all)', async () => {
  const lookup = fakeLookup([listing({ name: 'SDB Tiling', website: 'https://ls-tiling.co.uk/' })]);
  const { record } = await runChain(undefined, lookup, conversationalWith('<strong>SDB Tiling</strong>', 'SDB Tiling'));
  assert.deepEqual(lookup.calls, []);
  assert.deepEqual(record.layers.CONVERSATIONAL.identityResolutions, []);
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.status, 'COMPLETE');
});

test('chain: link UNRESOLVED then GBP CONFIRMED_PROSPECT flips the layer to YES with both attempts stored', async () => {
  const lookup = fakeLookup([listing({ website: 'https://ls-tiling.co.uk/', phone: '07700900123' })]);
  const { record } = await runChain(undefined, lookup);
  const conv = record.layers.CONVERSATIONAL;
  assert.equal(conv.state, 'YES');
  assert.equal(conv.prospectMatchEvidence?.[0]?.matchedBy, 'resolved_destination');
  assert.equal(conv.prospectMatchEvidence?.[0]?.snippet, 'Ls tiling & Patios');
  const r = conv.identityResolutions![0]!;
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'local_business_website');
  assert.equal(r.lookup?.providerBusinessId, 'ChIJ-ls-tiling');
  assert.deepEqual(r.previousAttempts?.map((a) => a.provider), ['link-resolver']);
  assert.equal(record.status, 'COMPLETE');
  assert.equal(lookup.calls.length, 1, 'one lookup per candidate');
  // Prospect facts were stored on the record as identity evidence.
  assert.equal(record.understanding?.prospect.identityFacts?.canonicalDomain, 'ls-tiling.co.uk');
  // GBP says another business: layer NO, audit complete, no lookups for the other names.
  const other = fakeLookup([listing({ website: 'https://another-domain.co.uk/' })]);
  const b = await runChain(undefined, other);
  assert.equal(b.record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(b.record.status, 'COMPLETE');
  assert.equal(other.calls.length, 1);
});

// ---- prospect facts extraction -----------------------------------------------------------
test('prospect facts: JSON-LD, tel links, visible phone, postcode, canonical; nothing inferred', () => {
  const html = `<!doctype html><html><head><title>LS Tiling</title>
    <link rel="canonical" href="https://www.ls-tiling.co.uk/">
    <meta property="og:site_name" content="LS Tiling Ltd">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":["LocalBusiness","HomeAndConstructionBusiness"],"name":"LS Tiling","telephone":"+44 7700 900123","address":{"@type":"PostalAddress","streetAddress":"12 Pound Street","addressLocality":"Wendover","postalCode":"hp22 6ej"}}</script>
    </head><body><a href="tel:01296123456">Call us</a><p>Or ring 07700 900123 today. Covering HP22 and beyond.</p><script>var x = "0800 000 0000"</script></body></html>`;
  const f = extractProspectFacts(html, 'https://ls-tiling.co.uk', clock);
  assert.equal(f.source, 'website');
  assert.equal(f.canonicalDomain, 'ls-tiling.co.uk');
  assert.equal(f.businessName, 'LS Tiling');
  assert.deepEqual([...f.phones].sort(), ['01296123456', '07700900123'], 'script content is not a fact');
  assert.equal(f.streetAddress, '12 Pound Street');
  assert.equal(f.locality, 'Wendover');
  assert.equal(f.postcode, 'HP22 6EJ');
  assert.deepEqual(f.schemaTypes, ['LocalBusiness', 'HomeAndConstructionBusiness']);
  const bare = extractProspectFacts('<html><body>Welcome to our site.</body></html>', 'https://example-tiler.co.uk/', clock);
  assert.deepEqual(bare.phones, []);
  assert.equal(bare.postcode, undefined);
  assert.equal(bare.businessName, undefined);
  assert.equal(normalisePhone('+44 (0)1296 123456'), '01296123456');
  assert.equal(normalisePhone('12345'), undefined);
  assert.equal(normalisePostcode('hp226ej'), 'HP22 6EJ');
});

test('prospect facts source: fetch failure yields source none and caches on the prospect', async () => {
  const prospect: Prospect = { ...LS };
  const src = prospectFactsSource(async () => undefined, clock);
  const f = await src(prospect);
  assert.equal(f.source, 'none');
  assert.match(f.error ?? '', /could not be fetched/);
  assert.equal(prospect.identityFacts, f);
  let fetches = 0;
  const ok = prospectFactsSource(async () => { fetches++; return '<a href="tel:07700900123">x</a>'; }, clock);
  const p2: Prospect = { ...LS };
  await ok(p2); await ok(p2);
  assert.equal(fetches, 1, 'facts are fetched once per prospect');
  assert.deepEqual(p2.identityFacts?.phones, ['07700900123']);
});

// ---- DataForSEO adapter (parser + failure handling, injected fetch) ----------------------
/** Realistic DataForSEO Google Maps live/advanced response (documented item shape, type "maps_search"). */
const DATAFORSEO_RESPONSE = {
  version: '0.1.20250101',
  status_code: 20000,
  status_message: 'Ok.',
  tasks: [{
    id: '09041234-1535-0066-0000-abcdef123456',
    status_code: 20000,
    status_message: 'Ok.',
    result: [{
      keyword: 'Ls tiling & Patios Wendover',
      type: 'maps',
      se_domain: 'google.co.uk',
      location_code: 2826,
      language_code: 'en',
      check_url: 'https://www.google.co.uk/maps/search/Ls+tiling+%26+Patios+Wendover/',
      items_count: 4,
      items: [
        {
          type: 'maps_search',
          rank_group: 1,
          rank_absolute: 1,
          domain: 'www.ls-tiling.co.uk',
          title: 'LS Tiling & Patios',
          url: 'https://www.ls-tiling.co.uk/',
          rating: { rating_type: 'Max5', value: 5, votes_count: 12 },
          category: 'Tiling contractor',
          phone: '+44 7700 900123',
          address: '12 Pound St, Wendover, Aylesbury HP22 6EJ',
          address_info: { borough: null, address: '12 Pound St', city: 'Wendover', zip: 'HP22 6EJ', region: 'England', country_code: 'GB' },
          place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
          cid: '10281119596374313554',
          latitude: 51.7607,
          longitude: -0.7435,
        },
        {
          type: 'maps_search',
          rank_group: 2,
          rank_absolute: 2,
          domain: 'sdbtiling.co.uk',
          title: 'SDB Tiling',
          url: null,
          category: 'Tiling contractor',
          phone: null,
          address: 'Aylesbury HP20 1AA',
          address_info: { address: null, city: 'Aylesbury', zip: 'HP20 1AA', region: 'England', country_code: 'GB' },
          place_id: 'ChIJsdb000000000000000000000',
          cid: '20281119596374313555',
        },
        { type: 'local_pack', rank_absolute: 3, title: 'Unrelated organic pack item', domain: 'example.org' },
        { type: 'people_also_search', title: 'Tilers near me' },
      ],
    }],
  }],
};
const Q: LocalBusinessQuery = { candidateName: 'Ls tiling & Patios', candidateContext: REAL_CONTEXT, prospectName: 'LS-Tiling', prospectDomain: 'ls-tiling.co.uk', prospectLocation: 'Wendover' };
const respond = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

test('DataForSEO adapter: a normal maps_search item is parsed into a LocalBusinessListing', async () => {
  const p = new DataForSeoMapsProvider({ login: 'user', password: 'pass', fetchImpl: respond(DATAFORSEO_RESPONSE) });
  const items = await p.search(Q);
  assert.deepEqual(items[0], {
    name: 'LS Tiling & Patios',
    source: 'dataforseo-google-maps',
    website: 'https://www.ls-tiling.co.uk/',
    phone: '+44 7700 900123',
    address: '12 Pound St, Wendover, Aylesbury HP22 6EJ',
    locality: 'Wendover',
    providerBusinessId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  });
  // Null url with a domain falls back to the domain; null phone is omitted rather than stringified.
  assert.deepEqual(items[1], { name: 'SDB Tiling', source: 'dataforseo-google-maps', website: 'https://sdbtiling.co.uk', address: 'Aylesbury HP20 1AA', locality: 'Aylesbury', providerBusinessId: 'ChIJsdb000000000000000000000' });
  // The parsed listing drives the identity rules exactly as a scripted listing does.
  const r = await new LocalBusinessIdentityProvider(p, factsOf(LS_FACTS), clock).resolve(candidate(), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'local_business_website');
  assert.equal(r.lookup?.providerBusinessId, 'ChIJN1t_tDeuEmsRUsoyG83frY4');
});

test('DataForSEO adapter: unrelated result types are ignored; only maps_search and maps_paid_item are accepted', async () => {
  const p = new DataForSeoMapsProvider({ login: 'user', password: 'pass', fetchImpl: respond(DATAFORSEO_RESPONSE) });
  const items = await p.search(Q);
  assert.equal(items.length, 2, 'local_pack and people_also_search are dropped');
  assert.ok(!items.some((i) => /Unrelated|near me/.test(i.name)));
  const mixed = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { type: 'maps_paid_item', title: 'Sponsored Tiler', domain: 'sponsored-tiler.co.uk', address_info: { city: 'Aylesbury' } },
    { type: 'maps_search_element', title: 'Undocumented legacy type is not accepted' },
    { title: 'No type at all' },
    { type: 'maps_search', title: 42 },
    { type: 'organic', title: 'Web result' },
  ] }] }] };
  const items2 = await new DataForSeoMapsProvider({ login: 'user', password: 'pass', fetchImpl: respond(mixed) }).search(Q);
  assert.deepEqual(items2.map((i) => i.name), ['Sponsored Tiler']);
});

test('DataForSEO adapter: sends basic auth and the documented request body; throws on API errors', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(DATAFORSEO_RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const p = new DataForSeoMapsProvider({ login: 'user', password: 'pass', fetchImpl });
  const q = Q;
  await p.search(q);
  assert.equal(seen[0]?.url, 'https://api.dataforseo.com/v3/serp/google/maps/live/advanced');
  assert.equal((seen[0]?.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), [{ keyword: 'Ls tiling & Patios Wendover', location_name: 'United Kingdom', language_code: 'en', depth: 20 }]);

  const unauthorised = new DataForSeoMapsProvider({ login: 'u', password: 'p', fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch });
  await assert.rejects(() => unauthorised.search(q), /HTTP 401/);
  const apiError = new DataForSeoMapsProvider({ login: 'u', password: 'p', fetchImpl: (async () => new Response(JSON.stringify({ status_code: 40200, status_message: 'Payment Required' }), { status: 200 })) as typeof fetch });
  await assert.rejects(() => apiError.search(q), /40200: Payment Required/);
  const taskError = new DataForSeoMapsProvider({ login: 'u', password: 'p', fetchImpl: (async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40501, status_message: 'Invalid Field' }] }), { status: 200 })) as typeof fetch });
  await assert.rejects(() => taskError.search(q), /task 40501/);
  const network = new DataForSeoMapsProvider({ login: 'u', password: 'p', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(() => network.search(q), /fetch failed/);
});

// ---- helpers ------------------------------------------------------------------------------
function conversationalWith(anchorHtml = '<strong>Ls tiling &amp; Patios</strong>', name = 'Ls tiling & Patios') {
  return {
    text: `Tilers people mention locally:\n${name} — flooring contractor in Aylesbury.\nLimartra Tiling and Restoration – Aylesbury.`,
    html: `<p>Tilers people mention locally:</p><ul><li><p>${anchorHtml} — flooring contractor in Aylesbury.</p></li><li><p><strong>Limartra Tiling and Restoration</strong> – Aylesbury.</p></li></ul>`,
    links: [],
  };
}

async function runChain(href: string | undefined, lookup: LocalBusinessLookupProvider, turn2 = conversationalWith(href ? `<a href="${href}">Ls tiling &amp; Patios</a>` : undefined)): Promise<{ record: AuditRecord }> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-gbp-'));
  const store = new AuditStore(path.join(dir, 'audits'));
  const provider = new MockChatGptProvider({ conversations: [{ answers: [visibleResponse] }, { answers: [recommendedResponse] }, { answers: [conversationalTurn1, turn2] }] });
  const identity: IdentityProvider = new ChainedIdentityProvider([
    new LinkIdentityResolver(noopDestinations, clock),
    new LocalBusinessIdentityProvider(lookup, prospectFactsSource(async () => '<a href="tel:07700900123">x</a><script type="application/ld+json">{"@type":"LocalBusiness","name":"LS Tiling","address":{"streetAddress":"12 Pound Street","addressLocality":"Wendover","postalCode":"HP22 6EJ"}}</script>', clock), clock),
  ]);
  const engine = new AuditEngine({ provider, evidence: new EvidenceStore(path.join(dir, 'evidence')), store, fetcher: async () => lsTilingSite, identity, now: clock });
  const record = newAuditRecord(LS_TILING, provider.name, clock());
  await store.save(record);
  await engine.run(record);
  return { record };
}
