import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProspectIdentityFacts } from '../src/domain/types.ts';
import type {
  LocalBusinessListing,
  LocalBusinessLookupProvider,
  LocalBusinessQuery,
} from '../src/identity/localBusiness.ts';
import { resolveAuditIntake } from '../src/intake/resolve.ts';

function websiteFacts(
  overrides: Partial<ProspectIdentityFacts> = {},
): ProspectIdentityFacts {
  return {
    source: 'website',
    canonicalDomain: 'example.com',
    phones: [],
    schemaTypes: [],
    fetchedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function fakeMaps(
  listings: LocalBusinessListing[],
  fail = false,
): LocalBusinessLookupProvider {
  return {
    name: 'fake-maps',

    queryFor(q: LocalBusinessQuery): string {
      return q.candidateName;
    },

    async search(): Promise<LocalBusinessListing[]> {
      if (fail) throw new Error('Maps unavailable');
      return listings;
    },
  };
}

test('1. supplied City is used immediately', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      city: 'Warrington',
      phone: '01925123456',
      lead_id: 'ghl-123',
    },
    {
      facts: async () => websiteFacts(),
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.location, 'Warrington');
    assert.equal(result.value.lead_id, 'ghl-123');
    assert.equal(result.resolution.source, 'supplied');
    assert.equal(result.resolution.matchedBy, 'city');
  }
});

test('2. website locality is used when GHL has no City', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      phone: '01925123456',
    },
    {
      facts: async () =>
        websiteFacts({
          locality: 'Widnes',
        }),
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.location, 'Widnes');
    assert.equal(result.resolution.source, 'website');
    assert.equal(result.resolution.matchedBy, 'website_locality');
  }
});

test('3. Maps locality is accepted when the listing website matches', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      phone: '01925123456',
    },
    {
      facts: async () => websiteFacts(),
      maps: fakeMaps([
        {
          name: 'Example Roofing',
          website: 'https://www.example.com/',
          phone: '01925123456',
          locality: 'Runcorn',
          source: 'fake-maps',
        },
      ]),
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.location, 'Runcorn');
    assert.equal(result.resolution.source, 'maps');
    assert.equal(result.resolution.matchedBy, 'maps_website');
  }
});

test('4. Maps locality is accepted when the supplied phone matches', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      phone: '01925123456',
    },
    {
      facts: async () => websiteFacts(),
      maps: fakeMaps([
        {
          name: 'Example Roofing',
          website: 'https://different-domain.co.uk',
          phone: '01925 123456',
          locality: 'St Helens',
          source: 'fake-maps',
        },
      ]),
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.location, 'St Helens');
    assert.equal(result.resolution.source, 'maps');
    assert.equal(result.resolution.matchedBy, 'maps_phone');
  }
});

test('5. a similar business name alone never proves location', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      phone: '01925123456',
    },
    {
      facts: async () => websiteFacts(),
      maps: fakeMaps([
        {
          name: 'Example Roofing',
          website: 'https://another-roofer.co.uk',
          phone: '01925999999',
          locality: 'Manchester',
          source: 'fake-maps',
        },
      ]),
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, 422);
    assert.equal(result.error, 'LOCATION_UNRESOLVED');
  }
});

test('6. conflicting matched locations remain unresolved', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      phone: '01925123456',
    },
    {
      facts: async () => websiteFacts(),
      maps: fakeMaps([
        {
          name: 'Example Roofing',
          website: 'https://example.com',
          locality: 'Warrington',
          source: 'fake-maps',
        },
        {
          name: 'Example Roofing',
          website: 'https://example.com',
          locality: 'Liverpool',
          source: 'fake-maps',
        },
      ]),
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.error, 'LOCATION_UNRESOLVED');
  }
});

test('7. Maps/API failure never turns into a guessed location', async () => {
  const result = await resolveAuditIntake(
    {
      business_name: 'Example Roofing',
      website: 'https://example.com',
      phone: '01925123456',
    },
    {
      facts: async () => websiteFacts(),
      maps: fakeMaps([], true),
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, 422);
    assert.equal(result.error, 'LOCATION_UNRESOLVED');
  }
});