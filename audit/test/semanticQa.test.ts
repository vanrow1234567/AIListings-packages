import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditEngine, newAuditRecord } from '../src/audit/engine.ts';
import { detectService } from '../src/business/understand.ts';
import { MockChatGptProvider, textResponse } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import type {
  SemanticBusinessReview,
  SemanticFinalReview,
} from '../src/domain/types.ts';
import type {
  SemanticFinalInput,
  SemanticPreflightInput,
  SemanticQaProvider,
} from '../src/quality/semanticQa.ts';
import type { WebsiteEvidence } from '../src/quality/websiteEvidence.ts';

test('roof does not match inside proof', () => {
  const result = detectService([{ text: 'authority, proof and coverage', weight: 1 }]);
  assert.notEqual(result?.service, 'roofing');
});

const website: WebsiteEvidence = {
  requestedUrl: 'https://ailistings.co.uk',
  finalUrl: 'https://ailistings.co.uk/',
  rendered: true,
  pages: [
    {
      url: 'https://ailistings.co.uk/',
      title: 'AI Listings | Get Found and Recommended in AI Search',
      description: 'AI search visibility and GEO for businesses.',
      headings: ['Get found and recommended in AI search'],
      navigation: ['Services', 'About'],
      jsonLd: [],
      text: 'We help businesses improve visibility in ChatGPT, Gemini and AI search. Authority, proof and coverage.',
    },
  ],
};

class Qa implements SemanticQaProvider {
  finalApproved = true;
  async preflight(_input: SemanticPreflightInput): Promise<SemanticBusinessReview> {
    return {
      approved: true,
      confidence: 0.98,
      businessType: 'AI search visibility agency',
      primaryService: 'AI search visibility',
      providerNoun: 'AI search visibility agencies',
      customerRequirement: 'improving visibility in AI search',
      customerProblem: "My business isn't appearing when customers ask AI who to use. How can I improve that?",
      serviceTerms: ['AI search visibility', 'GEO', 'generative engine optimisation'],
      evidence: ['Homepage says it helps businesses improve visibility in ChatGPT and AI search.'],
      concerns: [],
      model: 'test-model',
    };
  }
  async finalReview(_input: SemanticFinalInput): Promise<SemanticFinalReview> {
    return {
      approved: this.finalApproved,
      confidence: 0.99,
      reason: this.finalApproved ? 'Relevant and supported.' : 'Deliberate test rejection.',
      concerns: this.finalApproved ? [] : ['Mismatch'],
      model: 'test-review-model',
    };
  }
}

async function makeEngine(qa: Qa) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semantic-qa-'));
  const provider = new MockChatGptProvider({
    conversations: [
      { answers: [textResponse('No specific agencies named.')] },
      { answers: [textResponse('I would suggest Example AI Agency.')] },
      {
        answers: [
          textResponse('You should review your AI visibility. Would you like help finding someone?'),
          textResponse(
            'Acme Visibility Partners – well reviewed locally.',
            '<ul><li><p><strong>Acme Visibility Partners</strong> – well reviewed locally.</p></li></ul>',
          ),
        ],
      },
    ],
  });
  const engine = new AuditEngine({
    provider,
    evidence: new EvidenceStore(path.join(dir, 'evidence')),
    store: new AuditStore(path.join(dir, 'audits')),
    semanticQa: qa,
    semanticQaRequired: true,
    websiteEvidenceCollector: async () => website,
    fetcher: async () => ({
      title: 'AI Listings',
      description: 'Authority, proof and coverage',
      headings: ['AI search'],
      text: 'proof proof proof',
    }),
  });
  return { engine, provider };
}

test('semantic preflight overrides brittle deterministic classification', async () => {
  const qa = new Qa();
  const { engine, provider } = await makeEngine(qa);
  const record = newAuditRecord(
    {
      business_name: 'AI Listings',
      website: 'https://ailistings.co.uk',
      location: 'Warrington',
    },
    provider.name,
  );
  await engine.run(record);
  assert.equal(record.understanding?.service, 'AI search visibility');
  assert.equal(record.understanding?.source, 'semantic');
  assert.match(provider.transcript[0]?.prompt ?? '', /AI search visibility agencies in Warrington/i);
  assert.equal(record.quality?.preflight?.approved, true);
});

test('final semantic rejection prevents public report and outreach release', async () => {
  const qa = new Qa();
  qa.finalApproved = false;
  const { engine, provider } = await makeEngine(qa);
  const record = newAuditRecord(
    {
      business_name: 'AI Listings',
      website: 'https://ailistings.co.uk',
      location: 'Warrington',
    },
    provider.name,
  );
  await engine.run(record);
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.publicReport, undefined);
  assert.equal(record.outreachMessage, undefined);
  assert.equal(record.competitorOutreachMessage, undefined);
  assert.equal(record.quality?.final?.approved, false);
});
