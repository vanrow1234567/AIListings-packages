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
import { classifyCandidate, looksLikePlaceOrAddress, matchProspect, rankCompetitors, toMentions } from '../src/competitors/classify.ts';
import { looksLikeName } from '../src/analysis/extract.ts';
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

const FALSE_BUSINESSES = [
  'Wendover, Buckinghamshire',
  'Pound Street, Wendover',
  'London Road, Wendover',
  'Work out exactly what needs tiling',
  'Get 2–3 quotes',
  'For tiles themselves',
];
const GENUINE_SUPPLIERS = ['Limartra Tiling and Restoration', 'SDB Tiling', 'Signature Tiling & Carpentry'];

test('LS-Tiling: businessesSurfaced contains actual named suppliers only, in every layer', async () => {
  const record = await runLsTiling();
  assert.deepEqual([...record.layers.VISIBLE.businessesSurfaced].sort(), GENUINE_SUPPLIERS);
  // The Recommended answer names two firms in prose and all three on its visible map card.
  assert.deepEqual([...record.layers.RECOMMENDED.businessesSurfaced].sort(), GENUINE_SUPPLIERS);
  assert.deepEqual([...record.layers.CONVERSATIONAL.businessesSurfaced].sort(), GENUINE_SUPPLIERS);
  for (const l of ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'] as const) {
    const surfaced = record.layers[l].businessesSurfaced;
    for (const bad of FALSE_BUSINESSES) assert.ok(!surfaced.includes(bad), `${l} surfaced "${bad}"`);
    for (const s of surfaced) {
      assert.ok(!/,/.test(s), `${l}: "${s}" looks like a place/address`);
      assert.ok(!/\d\s*[–-]\s*\d|reviews?|★/.test(s), `${l}: "${s}" looks like a count/rating`);
      assert.ok(!/^(how|what|for|get|work|check|ask|look)\b/i.test(s), `${l}: "${s}" looks like advice`);
    }
    // Directories / marketplaces / review sites never enter businessesSurfaced.
    for (const kind of ['directory', 'marketplace', 'review_site', 'informational', 'unrelated', 'uncertain'] as const) {
      for (const e of record.layers[l].entities.filter((x) => x.kind === kind)) assert.ok(!surfaced.includes(e.name), `${l}: ${kind} "${e.name}" in businessesSurfaced`);
    }
  }
  assert.deepEqual(record.topCompetitors.map((c) => c.name).sort(), GENUINE_SUPPLIERS);
  // Layer verdicts unchanged by the hardening.
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
});

test('LS-Tiling: each false example is rejected at extraction or classified as non-business', async () => {
  const p = await prospect();
  for (const bad of FALSE_BUSINESSES) {
    for (const source of ['bold', 'heading', 'list', 'link', 'text'] as const) {
      if (!looksLikeName(bad)) continue; // rejected before it can ever become a candidate
      const kind = classifyCandidate(cand(bad, source, source === 'link' ? 'www.google.com' : undefined), p);
      assert.notEqual(kind, 'competitor', `"${bad}" (${source}) classified as competitor`);
      assert.notEqual(kind, 'prospect', `"${bad}" (${source}) classified as prospect`);
    }
  }
  assert.equal(looksLikeName('Work out exactly what needs tiling'), false);
  assert.equal(looksLikeName('Get 2–3 quotes'), false);
  assert.equal(looksLikeName('For tiles themselves'), false);
  assert.equal(looksLikeName('4.9 ★ (37 reviews)'), false);
  assert.equal(looksLikeName('Check reviews and insurance'), false);
  assert.ok(looksLikePlaceOrAddress('Wendover, Buckinghamshire', 'Wendover'));
  assert.ok(looksLikePlaceOrAddress('Pound Street, Wendover', 'Wendover'));
  assert.ok(looksLikePlaceOrAddress('London Road, Wendover', 'Wendover'));
  assert.ok(looksLikePlaceOrAddress('12 High Street', 'Wendover'));
  assert.ok(looksLikePlaceOrAddress('HP22 6EJ', 'Wendover'));
  assert.ok(!looksLikePlaceOrAddress('Wendover Tiling Ltd', 'Wendover'), 'a company named after its town is not an address');
  assert.ok(!looksLikePlaceOrAddress('Signature Tiling & Carpentry', 'Wendover'));
  // Genuine suppliers still pass every gate.
  for (const good of GENUINE_SUPPLIERS) {
    assert.ok(looksLikeName(good), good);
    assert.equal(classifyCandidate(cand(good, 'bold'), p), 'competitor', good);
  }
  assert.equal(classifyCandidate(cand('Stone & Slate Co', 'bold'), p), 'competitor');
  assert.equal(classifyCandidate(cand('Wendover Interiors', 'link', 'wendoverinteriors.co.uk'), p), 'competitor', 'visible name linking to its own site');
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
  assert.match(record.outreachMessage ?? '', /In the ChatGPT searches we ran/);
  assert.doesNotMatch(record.outreachMessage ?? '', /stale|doesn't surface|when people search|currently putting/);
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
