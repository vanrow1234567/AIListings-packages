import assert from 'node:assert/strict';
import test from 'node:test';
import { distinctiveTokens } from '../src/analysis/normalise.ts';
import { classifyCandidate } from '../src/competitors/classify.ts';
import type {
  EntityMention,
  LayerResult,
  Prospect,
  SemanticVisualReview,
} from '../src/domain/types.ts';
import { generateOutreach } from '../src/outreach/generate.ts';
import {
  reconcileLayerVisualEvidence,
  visualConfirmsBusinessName,
} from '../src/quality/reconcile.ts';

const prospect: Prospect = {
  name: 'AI Listings',
  website: 'https://ailistings.co.uk',
  domain: 'ailistings.co.uk',
  location: 'Warrington',
  serviceTerms: [
    'AI SEO',
    'Answer Engine Optimisation (AEO)',
    'Generative Engine Optimisation (GEO)',
    'AI visibility optimisation',
  ],
};

function visual(
  prospectPresent: 'YES' | 'NO' | 'UNRESOLVED',
  businessesSurfaced: string[] = [],
  businessesRecommended: string[] = [],
  confidence = 0.99,
): SemanticVisualReview {
  return {
    prospectPresent,
    confidence,
    businessesSurfaced,
    businessesRecommended,
    citationsOrSources: [],
    evidence: ['live-regression visual evidence'],
    reason: 'live-regression visual result',
    concerns: [],
    model: 'test-vision',
  };
}

function prospectMention(turnIndex: number): EntityMention {
  return {
    raw: 'Ai Listings',
    key: '__prospect__',
    name: 'AI Listings',
    kind: 'prospect',
    layer: 'CONVERSATIONAL',
    turnIndex,
    evidence: {
      snippet: 'Ai Listings',
      context: 'Ai Listings | Ai Seo Agency',
      source: 'map',
      matchedBy: 'business_name',
      turnIndex,
    },
  };
}

test('semantic service phrases are tokenised so AI SEO is not distinctive identity', () => {
  assert.deepEqual(
    distinctiveTokens('AI SEO', 'Warrington', prospect.serviceTerms ?? []),
    [],
  );
});

test('action heading Audit Google Business Profile is not a competitor', () => {
  const kind = classifyCandidate(
    {
      raw: 'Audit Google Business Profile',
      source: 'list',
      context: 'Month 1 — Foundation Audit Google Business Profile Audit website',
    },
    prospect,
  );
  assert.equal(kind, 'unrelated');
});

test('Conversational NO then YES is valid when parser and vision agree turn by turn', () => {
  const layer: LayerResult = {
    layer: 'CONVERSATIONAL',
    state: 'YES',
    prompt: 'My business is not being recommended. What should I do?',
    turns: [
      {
        index: 0,
        prompt: 'My business is not being recommended. What should I do?',
        response: { text: 'General advice only.', html: '<p>General advice only.</p>', links: [] },
        visualReview: visual('NO'),
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
      {
        index: 1,
        prompt: 'Who would you recommend I speak to?',
        response: { text: 'AI Listings is an option.', html: '<p>AI Listings is an option.</p>', links: [] },
        visualReview: visual('YES', ['AI Listings'], ['AI Listings']),
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [prospectMention(1)],
    prospectPresent: 'YES',
    businessesSurfaced: ['AI Listings'],
    competitorsMentioned: [],
  };

  const result = reconcileLayerVisualEvidence(
    layer,
    'Warrington',
    prospect.serviceTerms ?? [],
  );

  assert.equal(result.agreed, true, result.reason);
  assert.deepEqual(
    result.turnProspectComparisons.map((t) => [
      t.turnIndex,
      t.deterministicProspectPresent,
      t.visualProspectPresent,
      t.agreed,
    ]),
    [
      [0, 'NO', 'NO', true],
      [1, 'YES', 'YES', true],
    ],
  );
  assert.equal(result.deterministicProspectPresent, 'YES');
  assert.equal(result.visualProspectPresent, 'YES');
});

test('single-turn aggregate YES remains valid for legacy/stored records without per-turn entities', () => {
  const layer: LayerResult = {
    layer: 'VISIBLE',
    state: 'YES',
    turns: [
      {
        index: 0,
        prompt: 'AI search agencies in Warrington',
        response: { text: 'AI Listings', html: '<p>AI Listings</p>', links: [] },
        visualReview: visual('YES', ['AI Listings'], ['AI Listings']),
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [],
    prospectPresent: 'YES',
    businessesSurfaced: ['AI Listings'],
    competitorsMentioned: [],
  };

  const result = reconcileLayerVisualEvidence(layer, 'Warrington', prospect.serviceTerms ?? []);
  assert.equal(result.agreed, true, result.reason);
  assert.deepEqual(
    result.turnProspectComparisons.map((t) => [
      t.turnIndex,
      t.deterministicProspectPresent,
      t.visualProspectPresent,
      t.agreed,
    ]),
    [[0, 'YES', 'YES', true]],
  );
});

test('a disagreement on any individual Conversational turn fails closed', () => {
  const layer: LayerResult = {
    layer: 'CONVERSATIONAL',
    state: 'YES',
    turns: [
      {
        index: 0,
        prompt: 'Problem prompt',
        response: { text: 'General advice.', html: '<p>General advice.</p>', links: [] },
        visualReview: visual('YES', ['AI Listings'], ['AI Listings']),
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
      {
        index: 1,
        prompt: 'Who should I speak to?',
        response: { text: 'AI Listings.', html: '<p>AI Listings.</p>', links: [] },
        visualReview: visual('YES', ['AI Listings'], ['AI Listings']),
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [prospectMention(1)],
    prospectPresent: 'YES',
    businessesSurfaced: ['AI Listings'],
    competitorsMentioned: [],
  };

  const result = reconcileLayerVisualEvidence(layer, 'Warrington', prospect.serviceTerms ?? []);
  assert.equal(result.agreed, false);
  assert.equal(result.turnProspectComparisons[0]?.agreed, false);
  assert.match(result.reason, /turn 1 parser=NO\/vision=YES\/DISPUTE/);
});

test('visual-confirmed competitor matching accepts brand variants but not service phrases', () => {
  assert.equal(
    visualConfirmsBusinessName(
      'The Crane Consultancy',
      ['Crane Consultancy'],
      'Warrington',
      prospect.serviceTerms ?? [],
    ),
    true,
  );
  assert.equal(
    visualConfirmsBusinessName(
      'AI SEO',
      ['AI Listings | AI SEO Agency'],
      'Warrington',
      prospect.serviceTerms ?? [],
    ),
    false,
  );
});

test('outreach says the prospect appeared after the follow-up, not in the opening problem prompt', () => {
  const message = generateOutreach({
    prospect,
    service: 'AI visibility optimisation',
    status: 'COMPLETE',
    states: { VISIBLE: 'YES', RECOMMENDED: 'YES', CONVERSATIONAL: 'YES' },
    competitors: [
      { name: 'Gregg King', layers: ['CONVERSATIONAL'], mentions: 1, score: 3 },
      { name: 'Pothos Studio', layers: ['RECOMMENDED'], mentions: 1, score: 2 },
    ],
    firstProspectTurn: { VISIBLE: 0, RECOMMENDED: 0, CONVERSATIONAL: 1 },
  });

  assert.match(
    message ?? '',
    /after we described the problem and then asked who we should speak to/,
  );
  assert.doesNotMatch(
    message ?? '',
    /when we described a real AI visibility optimisation problem/,
  );
  assert.doesNotMatch(message ?? '', /when we after we/);
  assert.match(message ?? '', /Across those searches/);
});
