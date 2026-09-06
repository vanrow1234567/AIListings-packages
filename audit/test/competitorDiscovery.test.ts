import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditEngine, newAuditRecord } from '../src/audit/engine.ts';
import { MockChatGptProvider, textResponse } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import type {
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

class DiscoveryQa implements SemanticQaProvider {
  async preflight(_input: SemanticPreflightInput): Promise<SemanticBusinessReview> {
    throw new Error('preflight must not run in this test');
  }

  async visualReview(input: SemanticVisualInput): Promise<SemanticVisualReview> {
    let businesses: string[];
    if (input.layer === 'COMPETITOR_DISCOVERY') {
      businesses = /Which local/i.test(input.prompt)
        ? ['Southgate Roofing Ltd']
        : ['Harbour Roofing Ltd'];
    } else {
      businesses = ['National Roofing Ltd'];
    }

    return {
      prospectPresent: 'NO',
      confidence: 0.99,
      businessesSurfaced: businesses,
      businessesRecommended: input.layer === 'VISIBLE' ? [] : businesses,
      citationsOrSources: [],
      evidence: ['test screenshot'],
      reason: 'test visual witness',
      concerns: [],
      model: 'test-vision',
    };
  }

  async finalReview(_input: SemanticFinalInput): Promise<SemanticFinalReview> {
    throw new Error('final review must not run when semantic QA is disabled');
  }
}

const strong = (name: string) =>
  textResponse(name, `<p><strong>${name}</strong></p>`);

test('competitor discovery fills toward three verified rivals and ranks the local rival first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'competitor-discovery-'));
  const provider = new MockChatGptProvider({
    conversations: [
      { answers: [strong('National Roofing Ltd')] },
      { answers: [strong('National Roofing Ltd')] },
      {
        answers: [
          strong('National Roofing Ltd'),
          strong('National Roofing Ltd'),
        ],
      },
      { answers: [strong('Southgate Roofing Ltd')] },
      { answers: [strong('Harbour Roofing Ltd')] },
    ],
  });

  const engine = new AuditEngine({
    provider,
    evidence: new EvidenceStore(path.join(dir, 'evidence')),
    store: new AuditStore(path.join(dir, 'audits')),
    semanticQa: new DiscoveryQa(),
    semanticQaRequired: false,
    visualQaRequired: true,
    competitorDiscoveryEnabled: true,
    fetcher: async () => ({
      title: 'SPP Roofing',
      description: 'Roof repairs and roofing services in Southampton',
      headings: ['Roofing services'],
      text: 'Roof repairs, new roofs and roofing services.',
    }),
  });

  const record = newAuditRecord(
    {
      business_name: 'SPP Roofing',
      website: 'https://www.spproofing.co.uk/',
      location: 'Southampton',
    },
    provider.name,
  );

  await engine.run(record);

  assert.equal(record.status, 'COMPLETE');
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');

  assert.equal(record.competitorDiscovery?.turns.length, 2);
  assert.deepEqual(
    record.competitorDiscovery?.verifiedCompetitors.sort(),
    ['Southgate Roofing Ltd', 'Harbour Roofing Ltd'].sort(),
  );
  assert.deepEqual(record.competitorDiscovery?.localMarketCompetitors, ['Southgate Roofing Ltd']);

  assert.equal(record.topCompetitors.length, 3);
  assert.equal(record.topCompetitors[0]?.name, 'Southgate Roofing Ltd');
  assert.equal(record.topCompetitors[0]?.localMarketEvidence, true);
  assert.ok(record.topCompetitors.some((c) => c.name === 'National Roofing Ltd'));
  assert.ok(record.topCompetitors.some((c) => c.name === 'Harbour Roofing Ltd'));

  assert.match(record.competitorOutreachMessage ?? '', /Southgate Roofing Ltd/);
  assert.match(record.competitorOutreachMessage ?? '', /National Roofing Ltd/);
  assert.match(record.competitorOutreachMessage ?? '', /Harbour Roofing Ltd/);

  const discoveryPrompts = provider.transcript.filter((x) => x.conversation >= 3);
  assert.equal(discoveryPrompts.length, 2);
  assert.match(discoveryPrompts[0]!.prompt, /Which local roofing companies in Southampton/i);
  assert.match(discoveryPrompts[1]!.prompt, /serving Southampton/i);
  assert.ok(discoveryPrompts.every((x) => !/SPP Roofing/i.test(x.prompt)));

  assert.equal(record.evidence.competitorDiscoveryScreenshots?.length, 2);
  assert.ok(record.publicReport?.token);
});
