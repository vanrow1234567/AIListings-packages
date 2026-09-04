import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { AuditEngine, newAuditRecord, reanalyseRecord } from '../src/audit/engine.ts';
import { MockChatGptProvider } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import { extractCandidates, type Candidate } from '../src/analysis/extract.ts';
import { classifyCandidate, matchProspect, rankCompetitors, toMentions } from '../src/competitors/classify.ts';
import { understandBusiness } from '../src/business/understand.ts';
import type { AuditRecord, Prospect } from '../src/domain/types.ts';
import { LS_TILING, conversationalTurn1, conversationalTurn2, lsTilingSite, recommendedResponse, visibleResponse } from './fixtures/lsTiling.ts';

const cand = (raw: string, source: Candidate['source'], domain?: string): Candidate => ({ raw, source, context: raw, ...(domain ? { domain } : {}) });

async function prospect(): Promise<Prospect> {
  return (await understandBusiness(LS_TILING, { fetcher: async () => lsTilingSite })).prospect;
}

async function runLsTiling(): Promise<AuditRecord> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-ls-'));
  const provider = new MockChatGptProvider({
    conversations: [
      { answers: [visibleResponse] },
      { answers: [recommendedResponse] },
      { answers: [conversationalTurn1, conversationalTurn2] },
    ],
  });
  const engine = new AuditEngine({
    provider,
    evidence: new EvidenceStore(path.join(dir, 'evidence')),
    store: new AuditStore(path.join(dir, 'audits')),
    fetcher: async () => lsTilingSite,
  });
  const record = newAuditRecord(LS_TILING, provider.name);
  await engine.run(record);
  return record;
}

test('LS-Tiling live evidence: prospect absent in all three layers -> NO / NO / NO', async () => {
  const record = await runLsTiling();
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.status, 'COMPLETE');
  for (const l of ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'] as const) {
    assert.equal(record.layers[l].prospectPresent, 'NO');
    assert.equal(record.layers[l].prospectMatchEvidence, undefined, `${l} must carry no prospect evidence`);
    assert.equal(record.layers[l].entities.some((e) => e.kind === 'prospect'), false);
  }
});

test('LS-Tiling: prospectPresent and businessesSurfaced are independent', async () => {
  const record = await runLsTiling();
  const conv = record.layers.CONVERSATIONAL;
  assert.equal(conv.prospectPresent, 'NO');
  assert.deepEqual(
    [...conv.businessesSurfaced].sort(),
    ['Limartra Tiling and Restoration', 'SDB Tiling', 'Signature Tiling & Carpentry'],
  );
  assert.equal(conv.turns.length, 2, 'the follow-up that produced the recommendations still ran');
});

test('LS-Tiling: mapbox.com and other infrastructure are never competitors', async () => {
  const record = await runLsTiling();
  const all = ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'].flatMap((l) => record.layers[l as 'VISIBLE'].entities);
  const competitorNames = all.filter((e) => e.kind === 'competitor').map((e) => e.name.toLowerCase());
  for (const bad of ['mapbox', 'openstreetmap', 'google', 'chatgpt', 'openai', 'checkatrade', 'rated people', 'improve this map', 'open in google maps', 'sources']) {
    assert.ok(!competitorNames.some((n) => n.includes(bad)), `${bad} leaked into competitors: ${competitorNames.join(', ')}`);
  }
  assert.ok(!record.topCompetitors.some((c) => /mapbox|\.com|\.org|\.co\.uk/i.test(c.name)), JSON.stringify(record.topCompetitors));
  assert.deepEqual(
    record.topCompetitors.map((c) => c.name).sort(),
    ['Limartra Tiling and Restoration', 'SDB Tiling', 'Signature Tiling & Carpentry'],
  );
  assert.equal(record.topCompetitors[0]?.name, 'Limartra Tiling and Restoration', 'appears Recommended + Conversational + Visible');
});

test('LS-Tiling is never inferred from generic tiling terminology', async () => {
  const p = await prospect();
  assert.deepEqual(p.serviceTerms?.includes('tiling'), true);
  for (const generic of ['Tiling', 'Tiler', 'tilers', 'Local tilers', 'Wendover Tiling', 'Wendover Tilers', 'Tiling Services', 'LS', 'L S', 'Tiling Ltd']) {
    for (const source of ['bold', 'heading', 'list', 'text'] as const) {
      assert.equal(matchProspect(cand(generic, source), p), undefined, `"${generic}" (${source}) must not match LS-Tiling`);
    }
  }
  assert.equal(matchProspect(cand('LS Plumbing', 'bold'), p), undefined, 'same initials, different trade');
  assert.equal(matchProspect(cand('SDB Tiling', 'bold'), p), undefined);
  // A hidden href to the prospect's site behind generic anchor text is not visible evidence.
  assert.equal(matchProspect(cand('Website', 'link', 'ls-tiling.co.uk'), p), undefined);
  assert.equal(matchProspect(cand('Tiling', 'link', 'ls-tiling.co.uk'), p), undefined);
});

test('LS-Tiling: genuine visible evidence does match, with the snippet recorded', async () => {
  const p = await prospect();
  const byName = matchProspect(cand('LS-Tiling', 'bold'), p, 1);
  assert.equal(byName?.matchedBy, 'business_name');
  assert.equal(byName?.snippet, 'LS-Tiling');
  assert.equal(byName?.turnIndex, 1);
  assert.equal(matchProspect(cand('LS Tiling Ltd', 'list'), p)?.matchedBy, 'business_name');
  assert.equal(matchProspect(cand('LS Tiling Wendover', 'list'), p)?.matchedBy, 'business_name');
  assert.equal(matchProspect(cand('ls-tiling.co.uk', 'link', 'ls-tiling.co.uk'), p)?.matchedBy, 'visible_domain');
  assert.equal(matchProspect(cand('LSTiling', 'text'), p)?.matchedBy, 'name_alias');

  // Through the whole pipeline: a response that visibly names the prospect yields YES with evidence.
  const response = {
    text: 'Two local options:\nLS-Tiling – Wendover based tiler with good reviews.\nSDB Tiling – Aylesbury.',
    html: '<p>Two local options:</p><ul><li><p><strong>LS-Tiling</strong> – Wendover based tiler with good reviews.</p></li><li><p><strong>SDB Tiling</strong> – Aylesbury.</p></li></ul>',
    links: [],
  };
  const mentions = toMentions(extractCandidates(response), p, 'RECOMMENDED', 0);
  const prospectMention = mentions.find((m) => m.kind === 'prospect');
  assert.ok(prospectMention?.evidence);
  assert.match(prospectMention.evidence.context, /LS-Tiling – Wendover based tiler/);
});

test('href/domain candidates: only a visibly named genuine business is competitor-eligible', async () => {
  const p = await prospect();
  const infra: [string, Candidate['source'], string][] = [
    ['mapbox.com', 'link', 'mapbox.com'],
    ['© Mapbox', 'link', 'mapbox.com'],
    ['© OpenStreetMap', 'link', 'openstreetmap.org'],
    ['Open in Google Maps', 'link', 'google.com'],
    ['maps.google.com', 'link', 'maps.google.com'],
    ['bit.ly', 'link', 'bit.ly'],
    ['utm.io', 'link', 'utm.io'],
    ['chatgpt.com', 'link', 'chatgpt.com'],
    ['OpenAI', 'link', 'openai.com'],
  ];
  for (const [raw, source, domain] of infra) {
    const kind = classifyCandidate(cand(raw, source, domain), p);
    assert.equal(kind, 'unrelated', `${raw} -> ${kind}`);
  }
  assert.equal(classifyCandidate(cand('Checkatrade', 'link', 'checkatrade.com'), p), 'directory');
  assert.equal(classifyCandidate(cand('checkatrade.com', 'link', 'checkatrade.com'), p), 'directory');
  assert.equal(classifyCandidate(cand('Trustpilot', 'link', 'uk.trustpilot.com'), p), 'review_site');
  assert.equal(classifyCandidate(cand('Rated People', 'link', 'ratedpeople.com'), p), 'marketplace');
  // A bare unknown domain is not a named business; the visible business name linking to it is.
  assert.equal(classifyCandidate(cand('sdbtiling.co.uk', 'link', 'sdbtiling.co.uk'), p), 'uncertain');
  assert.equal(classifyCandidate(cand('SDB Tiling', 'link', 'sdbtiling.co.uk'), p), 'competitor');
  assert.equal(classifyCandidate(cand('Signature Tiling & Carpentry', 'bold'), p), 'competitor');

  // Raw hrefs in response.links never become candidates at all.
  const cands = extractCandidates({ text: 'Nothing named here.', html: '<p>Nothing named here.</p>', links: ['https://www.mapbox.com/', 'https://www.sdbtiling.co.uk/'] });
  assert.deepEqual(cands, []);
  // Anchor text that is not in the visible text (hidden element) is dropped.
  const hidden = extractCandidates({ text: 'Visible prose only.', html: '<p>Visible prose only.</p><div hidden><a href="https://ls-tiling.co.uk">LS-Tiling</a></div>', links: ['https://ls-tiling.co.uk'] });
  assert.deepEqual(hidden, []);
  assert.deepEqual(rankCompetitors([{ raw: 'mapbox.com', key: 'mapbox com', name: 'mapbox.com', kind: 'competitor', layer: 'CONVERSATIONAL', turnIndex: 1, domain: 'mapbox.com' }], 'Wendover'), []);
});

test('reanalyse: re-interpreting a stored audit corrects the old verdict without touching the browser', async () => {
  const record = await runLsTiling();
  // Simulate the defective stored verdict from the live run.
  record.layers.CONVERSATIONAL.state = 'YES';
  record.layers.CONVERSATIONAL.prospectPresent = 'YES';
  record.topCompetitors = [{ name: 'mapbox.com', layers: ['CONVERSATIONAL'], mentions: 2, score: 9, domain: 'mapbox.com' }];
  record.outreachMessage = 'stale';
  reanalyseRecord(record);
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.prospectPresent, 'NO');
  assert.ok(!record.topCompetitors.some((c) => /mapbox/i.test(c.name)));
  assert.match(record.outreachMessage ?? '', /Limartra Tiling and Restoration/);
  assert.doesNotMatch(record.outreachMessage ?? '', /stale/);
});

/**
 * Optional: if real captured audit records are dropped into test/fixtures/live/*.json
 * (copied from audit/.data/audits/), re-interpret them and assert the invariants.
 */
test('live fixtures (if present) satisfy the invariants', async () => {
  const dir = path.join(import.meta.dirname, 'fixtures', 'live');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return; // none captured yet
  }
  for (const f of files) {
    const record = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as AuditRecord;
    reanalyseRecord(record);
    for (const l of ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'] as const) {
      const layer = record.layers[l];
      if (layer.state === 'YES') assert.ok(layer.prospectMatchEvidence && layer.prospectMatchEvidence.length > 0, `${f} ${l}: YES without evidence`);
      for (const e of layer.prospectMatchEvidence ?? []) {
        const visible = layer.turns.some((t) => t.response.text.toLowerCase().includes(e.snippet.toLowerCase().replace(/\s+/g, ' ')));
        assert.ok(visible, `${f} ${l}: evidence "${e.snippet}" is not in the visible response text`);
      }
    }
    assert.ok(!record.topCompetitors.some((c) => /mapbox|openstreetmap|google|chatgpt|openai|\.com$|\.org$|\.co\.uk$/i.test(c.name)), `${f}: infrastructure in competitors`);
  }
});
