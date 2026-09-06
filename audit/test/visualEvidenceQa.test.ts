import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditEngine, newAuditRecord } from '../src/audit/engine.ts';
import { MockChatGptProvider, textResponse } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import { EvaluationStore } from '../src/quality/evaluationStore.ts';
import { reconcileLayerVisualEvidence } from '../src/quality/reconcile.ts';
import type {
  LayerResult,
  SemanticBusinessReview,
  SemanticFinalReview,
  SemanticVisualReview,
} from '../src/domain/types.ts';
import type {
  SemanticFinalInput,
  SemanticPreflightInput,
  SemanticQaProvider,
  SemanticVisualInput,
} from '../src/quality/semanticQa.ts';
import type { WebsiteEvidence } from '../src/quality/websiteEvidence.ts';

function review(state: 'YES' | 'NO' | 'UNRESOLVED', confidence = 0.99): SemanticVisualReview {
  return {
    prospectPresent: state,
    confidence,
    businessesSurfaced: [],
    businessesRecommended: [],
    citationsOrSources: [],
    evidence: ['test screenshot evidence'],
    reason: 'test visual result',
    concerns: [],
    model: 'test-vision',
  };
}

test('reconciliation agrees only on high-confidence matching YES/NO', () => {
  const layer: LayerResult = {
    layer: 'RECOMMENDED',
    state: 'NO',
    turns: [
      {
        index: 0,
        prompt: 'Who would you recommend?',
        response: textResponse('Example Agency'),
        screenshotPath: '/evidence/a/x.png',
        visualReview: {
          ...review('NO', 0.99),
          businessesSurfaced: ['Example Agency'],
          businessesRecommended: ['Example Agency'],
        },
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [],
    prospectPresent: 'NO',
    businessesSurfaced: ['Example Agency'],
    competitorsMentioned: ['Example Agency'],
  };

  assert.equal(reconcileLayerVisualEvidence(layer, 'Warrington').agreed, true);
  layer.turns[0]!.visualReview = review('YES', 0.99);
  assert.equal(reconcileLayerVisualEvidence(layer, 'Warrington').agreed, false);
  layer.turns[0]!.visualReview = review('NO', 0.89);
  assert.equal(reconcileLayerVisualEvidence(layer, 'Warrington').agreed, false);
});

test('business-list coverage gaps are recorded but are not hard contradictions', () => {
  const layer: LayerResult = {
    layer: 'VISIBLE',
    state: 'YES',
    turns: [
      {
        index: 0,
        prompt: 'AI SEO agencies in Warrington',
        response: textResponse('AI Listings, Direct First'),
        screenshotPath: '/evidence/a/x.png',
        visualReview: {
          ...review('YES', 0.99),
          businessesSurfaced: ['AI Listings | AI SEO Agency', 'innovAIte'],
        },
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [],
    prospectPresent: 'YES',
    businessesSurfaced: ['AI Listings', 'Direct First'],
    competitorsMentioned: ['Direct First'],
  };

  const result = reconcileLayerVisualEvidence(
    layer,
    'Warrington',
    ['ai', 'seo', 'agency', 'search', 'visibility'],
  );
  assert.equal(result.prospectAgreed, true);
  assert.equal(result.agreed, true);
  assert.deepEqual(result.parserOnlyBusinesses, ['Direct First']);
  assert.deepEqual(result.visionOnlyBusinesses, ['innovAIte']);
});

test('a provider may also appear as a citation source without becoming a false conflict', () => {
  const layer: LayerResult = {
    layer: 'VISIBLE',
    state: 'YES',
    turns: [
      {
        index: 0,
        prompt: 'AI SEO agencies in Warrington',
        response: textResponse('AI Listings and Gregg King'),
        screenshotPath: '/evidence/a/x.png',
        visualReview: {
          ...review('YES', 0.99),
          businessesSurfaced: ['AI Listings | AI SEO Agency', 'Gregg King'],
          citationsOrSources: ['Gregg King'],
        },
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [],
    prospectPresent: 'YES',
    businessesSurfaced: ['AI Listings', 'Gregg King'],
    competitorsMentioned: ['Gregg King'],
  };

  const result = reconcileLayerVisualEvidence(
    layer,
    'Warrington',
    ['ai', 'seo', 'agency', 'search', 'visibility'],
  );
  assert.equal(result.agreed, true);
  assert.deepEqual(result.sourceConflicts, []);
});

test('semantic service terms prevent SEO Warrington being merged with AI Listings', () => {
  const layer: LayerResult = {
    layer: 'RECOMMENDED',
    state: 'YES',
    turns: [
      {
        index: 0,
        prompt: 'Who would you recommend?',
        response: textResponse('AI Listings and SEO Warrington'),
        screenshotPath: '/evidence/a/x.png',
        visualReview: {
          ...review('YES', 0.99),
          businessesSurfaced: ['AI Listings | AI SEO Agency'],
          businessesRecommended: ['AI Listings | AI SEO Agency'],
        },
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [],
    prospectPresent: 'YES',
    businessesSurfaced: ['AI Listings', 'SEO Warrington'],
    competitorsMentioned: ['SEO Warrington'],
  };

  const result = reconcileLayerVisualEvidence(
    layer,
    'Warrington',
    ['ai', 'seo', 'agency', 'search', 'visibility'],
  );
  assert.ok(result.parserOnlyBusinesses.includes('SEO Warrington'));
  assert.equal(result.agreed, true);
});

test('a parser competitor that vision identifies as a citation/source is disputed', () => {
  const layer: LayerResult = {
    layer: 'RECOMMENDED',
    state: 'NO',
    turns: [
      {
        index: 0,
        prompt: 'Who would you recommend?',
        response: textResponse('Example AI Agency. General guidance source: TechRadar.'),
        screenshotPath: '/evidence/a/x.png',
        visualReview: {
          ...review('NO', 0.99),
          businessesSurfaced: ['Example AI Agency'],
          businessesRecommended: ['Example AI Agency'],
          citationsOrSources: ['TechRadar'],
        },
        askedAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
      },
    ],
    entities: [],
    prospectPresent: 'NO',
    businessesSurfaced: ['Example AI Agency', 'TechRadar'],
    competitorsMentioned: ['Example AI Agency', 'TechRadar'],
  };

  const result = reconcileLayerVisualEvidence(layer, 'Warrington');
  assert.equal(result.agreed, false);
  assert.deepEqual(result.sourceConflicts, ['TechRadar']);
  assert.ok(result.parserOnlyBusinesses.includes('TechRadar'));
});

const website: WebsiteEvidence = {
  requestedUrl: 'https://ailistings.co.uk',
  finalUrl: 'https://ailistings.co.uk/',
  rendered: true,
  pages: [{
    url: 'https://ailistings.co.uk/',
    title: 'AI Listings',
    description: 'AI visibility',
    headings: ['AI visibility'],
    navigation: [],
    jsonLd: [],
    text: 'We help businesses improve visibility in AI search.',
  }],
};

class Qa implements SemanticQaProvider {
  mismatchRecommended = false;
  finalCalls = 0;

  async preflight(_input: SemanticPreflightInput): Promise<SemanticBusinessReview> {
    return {
      approved: true,
      confidence: 0.99,
      businessType: 'AI search visibility agency',
      primaryService: 'AI search visibility',
      providerNoun: 'AI search visibility agencies',
      customerRequirement: 'improve AI search visibility',
      customerProblem: "My business isn't appearing in AI answers.",
      serviceTerms: ['ai', 'search', 'visibility'],
      evidence: ['website evidence'],
      concerns: [],
      model: 'test-preflight',
    };
  }

  async visualReview(input: SemanticVisualInput): Promise<SemanticVisualReview> {
    if (input.layer === 'VISIBLE') {
      return {
        ...review('NO'),
        businessesSurfaced: ['Acme Visibility Partners'],
      };
    }

    if (input.layer === 'RECOMMENDED') {
      if (this.mismatchRecommended) {
        return {
          ...review('YES'),
          businessesSurfaced: ['AI Listings', 'Acme Visibility Partners'],
          businessesRecommended: ['AI Listings', 'Acme Visibility Partners'],
        };
      }
      return {
        ...review('NO'),
        businessesSurfaced: ['Acme Visibility Partners'],
        businessesRecommended: ['Acme Visibility Partners'],
      };
    }

    return {
      ...review('NO'),
      businessesSurfaced: ['Acme Visibility Partners'],
      businessesRecommended: ['Acme Visibility Partners'],
    };
  }

  async finalReview(_input: SemanticFinalInput): Promise<SemanticFinalReview> {
    this.finalCalls++;
    return {
      approved: true,
      confidence: 0.99,
      reason: 'All evidence agrees.',
      concerns: [],
      model: 'test-final',
    };
  }
}

async function setup(mismatchRecommended: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'visual-qa-'));
  const provider = new MockChatGptProvider({
    conversations: [
      {
        answers: [
          textResponse(
            'Acme Visibility Partners',
            '<p><strong>Acme Visibility Partners</strong></p>',
          ),
        ],
      },
      {
        answers: [
          textResponse(
            'Acme Visibility Partners',
            '<p><strong>Acme Visibility Partners</strong></p>',
          ),
        ],
      },
      {
        answers: [
          textResponse(
            'Acme Visibility Partners can help.',
            '<p><strong>Acme Visibility Partners</strong> can help.</p>',
          ),
          textResponse(
            'I would speak to Acme Visibility Partners first.',
            '<p>I would speak to <strong>Acme Visibility Partners</strong> first.</p>',
          ),
        ],
      },
    ],
  });

  const qa = new Qa();
  qa.mismatchRecommended = mismatchRecommended;

  const evidence = new EvidenceStore(path.join(dir, 'evidence'));
  const store = new AuditStore(path.join(dir, 'audits'));
  const evaluation = new EvaluationStore(path.join(dir, 'evaluations'));

  const engine = new AuditEngine({
    provider,
    evidence,
    store,
    evaluation,
    semanticQa: qa,
    semanticQaRequired: true,
    visualQaRequired: true,
    websiteEvidenceCollector: async () => website,
    fetcher: async () => ({
      title: 'AI Listings',
      description: 'AI visibility',
      headings: ['AI visibility'],
      text: 'AI visibility',
    }),
  });

  const record = newAuditRecord({
    business_name: 'AI Listings',
    website: 'https://ailistings.co.uk',
    location: 'Warrington',
  }, provider.name);

  await engine.run(record);
  return { record, qa, dir };
}

test('DOM/vision disagreement fails closed and creates an evaluation case', async () => {
  const { record, qa, dir } = await setup(true);

  assert.equal(record.layers.RECOMMENDED.state, 'EVIDENCE_DISPUTED');
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.publicReport, undefined);
  assert.equal(record.outreachMessage, undefined);
  assert.match(record.competitorOutreachMessage ?? '', /Acme Visibility Partners/);
  assert.match(
    record.competitorOutreachMessage ?? '',
    /Across the searches we completed, ChatGPT surfaced/,
  );
  assert.equal(record.quality?.visual?.RECOMMENDED?.agreed, false);
  assert.equal(qa.finalCalls, 0);

  const files = await readdir(path.join(dir, 'evaluations', record.id));
  assert.ok(files.some((f) => f.startsWith('layer-recommended-dispute-')));
});

test('matching DOM and visual witnesses allow the existing Sol-style final gate to release', async () => {
  const { record, qa } = await setup(false);

  assert.equal(
    record.quality?.visual?.VISIBLE?.agreed,
    true,
    JSON.stringify(record.quality?.visual?.VISIBLE),
  );
  assert.equal(
    record.quality?.visual?.RECOMMENDED?.agreed,
    true,
    JSON.stringify(record.quality?.visual?.RECOMMENDED),
  );
  assert.equal(
    record.quality?.visual?.CONVERSATIONAL?.agreed,
    true,
    JSON.stringify(record.quality?.visual?.CONVERSATIONAL),
  );
  assert.equal(record.status, 'COMPLETE');
  assert.equal(record.quality?.final?.approved, true);
  assert.equal(qa.finalCalls, 1);
  assert.ok(record.publicReport?.token);
});
