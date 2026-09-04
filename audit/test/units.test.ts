import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understandBusiness, toDomain, parseHtml } from '../src/business/understand.ts';
import { generateLayerPrompts, nextConversationalFollowUp, brandDiagnosticPrompt } from '../src/prompts/generate.ts';
import { extractCandidates, looksLikeName, looksLikeScopePhrase, splitJoinedNames } from '../src/analysis/extract.ts';
import { sameBusiness, nameKey } from '../src/analysis/normalise.ts';
import { classifyCandidate, rankCompetitors, toMentions } from '../src/competitors/classify.ts';
import { decideAuditStatus } from '../src/audit/decide.ts';
import { generateOutreach } from '../src/outreach/generate.ts';
import { validateRequest } from '../src/api/validate.ts';
import type { EntityMention, LayerResult, Prospect } from '../src/domain/types.ts';
import type { Candidate } from '../src/analysis/extract.ts';
import { SPP, roofingSite } from './helpers.ts';

const prospect: Prospect = { name: 'SPP Roofing', website: 'https://www.spproofing.co.uk/', domain: 'spproofing.co.uk', location: 'Southampton', serviceTerms: ['roofing', 'roofers', 'roofer', 'roof'] };
const cand = (raw: string, source: Candidate['source'], domain?: string): Candidate => ({ raw, source, context: raw, ...(domain ? { domain } : {}) });

test('business understanding: roofing from name, market from location', async () => {
  const u = await understandBusiness(SPP, { fetcher: async () => roofingSite });
  assert.equal(u.service, 'roofing');
  assert.equal(u.providerNoun, 'roofing companies');
  assert.equal(u.market, 'Southampton');
  assert.equal(u.prospect.domain, 'spproofing.co.uk');
  assert.equal(u.source, 'name');
});

test('business understanding: falls back to website when the name is opaque', async () => {
  const u = await understandBusiness(
    { business_name: 'Harrison & Sons', website: 'harrisonandsons.example', location: 'Winchester' },
    { fetcher: async () => ({ title: 'Harrison & Sons | Plumbing and Heating Winchester', description: 'Gas Safe plumbers', headings: [], text: '' }) },
  );
  assert.equal(u.service, 'plumbing');
  assert.equal(u.source, 'website');
});

test('business understanding: unreachable website falls back gracefully', async () => {
  const u = await understandBusiness({ business_name: 'Bluewave Carpentry', website: 'https://example.invalid', location: 'Poole' }, { fetcher: async () => undefined });
  assert.equal(u.service, 'carpentry');
  assert.equal(u.source, 'fallback');
  assert.match(u.notes.join(' '), /could not be fetched/);
});

test('toDomain / parseHtml', () => {
  assert.equal(toDomain('https://www.spproofing.co.uk/'), 'spproofing.co.uk');
  assert.equal(toDomain('spproofing.co.uk'), 'spproofing.co.uk');
  const snap = parseHtml('<html><head><title>SPP Roofing</title><meta name="description" content="Roofers &amp; more"></head><body><h1>Roof Repairs</h1><script>x()</script></body></html>');
  assert.equal(snap.title, 'SPP Roofing');
  assert.equal(snap.description, 'Roofers & more');
  assert.deepEqual(snap.headings, ['Roof Repairs']);
});

test('prompts: one per layer, prospect never named, follow-ups adapt', async () => {
  const u = await understandBusiness(SPP, { fetcher: async () => roofingSite });
  const p = generateLayerPrompts(u);
  assert.equal(p.VISIBLE.opening, 'Roofing companies in Southampton');
  assert.equal(p.RECOMMENDED.opening, 'Who would you recommend for roof repairs in Southampton?');
  assert.match(p.CONVERSATIONAL.opening, /leaking around the chimney/);
  assert.match(p.CONVERSATIONAL.opening, /I'm in Southampton/);
  for (const x of Object.values(p)) assert.doesNotMatch(x.opening, /SPP/);
  assert.equal(nextConversationalFollowUp(u, 'Check the flashing.', 0, 0), 'Who would you recommend I speak to?');
  assert.equal(nextConversationalFollowUp(u, 'Where are you based?', 0, 0), "I'm in Southampton. Who would you recommend I speak to?");
  assert.equal(nextConversationalFollowUp(u, 'Try Solent Roofing.', 1, 1), undefined, 'stop once businesses have been named');
  assert.equal(nextConversationalFollowUp(u, 'x', 3, 0), undefined, 'never more than three follow-ups');
  assert.equal(brandDiagnosticPrompt(u), 'Would you recommend SPP Roofing for roof repairs in Southampton?');
});

test('extraction: bold names, links, list leads and text patterns', () => {
  const html =
    '<h3>Local options</h3><ul><li><p><strong>Solent Roofing</strong> – 4.9 stars</p></li>' +
    '<li><p><a href="https://www.stormguardroofing.co.uk/">Stormguard Roofing</a> covers Hampshire</p></li>' +
    '<li><p><strong>Checkatrade</strong> lists vetted roofers</p></li></ul><p>If your roof is leaking, act quickly.</p>';
  const cands = extractCandidates({ text: 'Local options\nSolent Roofing – 4.9 stars\nStormguard Roofing covers Hampshire\nRoofCare Ltd is another.', html, links: ['https://www.stormguardroofing.co.uk/'] });
  const raws = cands.map((c) => c.raw);
  assert.ok(raws.includes('Solent Roofing'));
  assert.ok(raws.includes('Stormguard Roofing'));
  assert.ok(raws.includes('RoofCare Ltd'));
  assert.ok(!raws.includes('Local options'), 'generic headings are not names');
  assert.ok(!raws.some((r) => /^If your roof/.test(r)));
  assert.equal(cands.find((c) => c.raw === 'Stormguard Roofing')?.domain, 'stormguardroofing.co.uk');
});

test('normalisation: variants merge, different businesses do not', () => {
  assert.equal(nameKey('ABC Roofing Ltd', 'Southampton'), 'abc roofing');
  assert.ok(sameBusiness('ABC Roofing Ltd', 'ABC Roofing', 'Southampton'));
  assert.ok(sameBusiness('ABC Roofing Southampton', 'ABC Roofing', 'Southampton'));
  assert.ok(sameBusiness('Solent Roofing & Building', 'Solent Roofing', 'Southampton'));
  assert.ok(!sameBusiness('Solent Roofing', 'Solent Plumbing', 'Southampton'));
  assert.ok(!sameBusiness('Southampton Roofing', 'Southampton Plumbing', 'Southampton'));
  assert.ok(!sameBusiness('Solent Roofing', 'Roofing', 'Southampton'), 'a bare service word never merges');
});

test('classification: prospect by name variant and by domain; directories are not competitors', () => {
  assert.equal(classifyCandidate(cand('SPP Roofing Ltd', 'bold'), prospect), 'prospect');
  assert.equal(classifyCandidate(cand('spproofing.co.uk', 'link', 'spproofing.co.uk'), prospect), 'prospect');
  assert.equal(classifyCandidate(cand('Checkatrade', 'bold'), prospect), 'directory');
  assert.equal(classifyCandidate(cand('Rated People', 'bold'), prospect), 'marketplace');
  assert.equal(classifyCandidate(cand('NFRC', 'bold'), prospect), 'informational');
  assert.equal(classifyCandidate(cand('Solent Roofing', 'text'), prospect), 'competitor');
  assert.equal(classifyCandidate(cand('Southampton', 'bold'), prospect), 'unrelated');
  assert.equal(classifyCandidate(cand('Southampton Roofers', 'bold'), prospect), 'uncertain');
  assert.equal(classifyCandidate(cand('Southampton Roofing Ltd', 'bold'), prospect), 'competitor');
  assert.equal(classifyCandidate(cand('Stormguard', 'bold'), prospect), 'uncertain', 'single bare word is uncertain');
});

test('ranking prefers Conversational, then Recommended, then recurrence; never pads', () => {
  const m = (name: string, layer: EntityMention['layer'], turnIndex = 0): EntityMention => ({ raw: name, key: nameKey(name, 'Southampton'), name, kind: 'competitor', layer, turnIndex });
  const ranked = rankCompetitors(
    [m('A Roofing', 'VISIBLE'), m('B Roofing', 'RECOMMENDED'), m('C Roofing', 'CONVERSATIONAL', 1), m('A Roofing Ltd', 'RECOMMENDED'), m('D Roofing', 'VISIBLE'), m('E Roofing', 'VISIBLE')],
    'Southampton',
  );
  assert.deepEqual(ranked.map((c) => c.name), ['A Roofing', 'C Roofing', 'B Roofing']);
  assert.equal(ranked.length, 3);
  assert.deepEqual(rankCompetitors([m('Only Roofing', 'VISIBLE')], 'Southampton').map((c) => c.name), ['Only Roofing']);
  assert.deepEqual(rankCompetitors([], 'Southampton'), []);
});

test('toMentions merges variants inside one response', () => {
  const mentions = toMentions(
    [cand('ABC Roofing Ltd', 'bold'), cand('ABC Roofing', 'text'), cand('ABC Roofing Southampton', 'list')],
    prospect,
    'VISIBLE',
    0,
  );
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]?.name, 'ABC Roofing');
});

test('decision: any non-conclusive layer makes the audit INCOMPLETE; sign-in wins', () => {
  const lr = (layer: LayerResult['layer'], state: LayerResult['state']): LayerResult => ({ layer, state, turns: [], entities: [], businessesSurfaced: [], competitorsMentioned: [] });
  assert.equal(decideAuditStatus({ VISIBLE: lr('VISIBLE', 'YES'), RECOMMENDED: lr('RECOMMENDED', 'NO'), CONVERSATIONAL: lr('CONVERSATIONAL', 'NO') }).status, 'COMPLETE');
  assert.equal(decideAuditStatus({ VISIBLE: lr('VISIBLE', 'YES'), RECOMMENDED: lr('RECOMMENDED', 'ERROR'), CONVERSATIONAL: lr('CONVERSATIONAL', 'NO') }).status, 'INCOMPLETE');
  assert.equal(decideAuditStatus({ VISIBLE: lr('VISIBLE', 'SIGN_IN_REQUIRED'), RECOMMENDED: lr('RECOMMENDED', 'NOT_TESTED'), CONVERSATIONAL: lr('CONVERSATIONAL', 'NOT_TESTED') }).status, 'SIGN_IN_REQUIRED');
});

test('outreach: evidence-bound wording and no message for incomplete audits', () => {
  const base = { prospect, service: 'roofing' };
  const comps = [{ name: 'Solent Roofing', layers: ['RECOMMENDED' as const], mentions: 1, score: 2 }, { name: 'Stormguard', layers: ['CONVERSATIONAL' as const], mentions: 1, score: 3 }];
  const visibleOnly = generateOutreach({ ...base, status: 'COMPLETE', states: { VISIBLE: 'YES', RECOMMENDED: 'NO', CONVERSATIONAL: 'NO' }, competitors: comps });
  assert.match(visibleOnly ?? '', /we ran a set of ChatGPT searches/);
  assert.match(visibleOnly ?? '', /In the searches we ran you're visible, which is good\. The issue is that when we asked ChatGPT who it would actually recommend, it put Solent Roofing and Stormguard forward instead\./);
  assert.doesNotMatch(visibleOnly ?? '', /thousands|every|all customers|doesn't surface|when people search|currently putting/i);
  const none = generateOutreach({ ...base, status: 'COMPLETE', states: { VISIBLE: 'NO', RECOMMENDED: 'NO', CONVERSATIONAL: 'NO' }, competitors: comps });
  assert.match(none ?? '', /In the ChatGPT searches we ran, SPP Roofing didn't appear at any point\./);
  assert.equal(generateOutreach({ ...base, status: 'INCOMPLETE', states: { VISIBLE: 'YES', RECOMMENDED: 'ERROR', CONVERSATIONAL: 'NO' }, competitors: comps }), undefined);
  const all = generateOutreach({ ...base, status: 'COMPLETE', states: { VISIBLE: 'YES', RECOMMENDED: 'YES', CONVERSATIONAL: 'YES' }, competitors: [] });
  assert.match(all ?? '', /Good news/);
});

test('API validation mirrors the future CRM contract', () => {
  const ok = validateRequest({ business_name: ' SPP Roofing ', website: 'spproofing.co.uk', location: 'Southampton', lead_id: 'ghl_123' });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.value, { business_name: 'SPP Roofing', website: 'spproofing.co.uk', location: 'Southampton', lead_id: 'ghl_123' });
  const bad = validateRequest({ business_name: 'X', website: '', location: 'Y' });
  assert.ok(!bad.ok && /website/.test(bad.error));
});

test('extraction: scope phrases are rejected; joined names split only when both sides are multi-word names', () => {
  // A. "Whole room" and equivalents are price-guide scope descriptions, not businesses.
  for (const scope of ['Whole room', 'Entire room', 'Full room', 'Single room', 'One room', 'Whole house', 'Entire bathroom']) {
    assert.ok(looksLikeScopePhrase(scope), scope);
    assert.equal(looksLikeName(scope), false, scope);
  }
  // Company names that merely start with one of those words are untouched.
  for (const ok of ['Whole Room Interiors Ltd', 'Complete Tiling Solutions', 'Single Malt Bar', 'One Stop Tiles']) {
    assert.equal(looksLikeScopePhrase(ok), false, ok);
    assert.ok(looksLikeName(ok), ok);
  }
  const jobs = extractCandidates({
    text: 'Whole room – £1,500\nSignature Tiling & Carpentry – Chesham.',
    html: '<ul><li><p><strong>Whole room</strong> – £1,500</p></li><li><p><strong>Signature Tiling &amp; Carpentry</strong> – Chesham.</p></li></ul>',
    links: [],
  });
  assert.ok(!jobs.some((c) => c.raw === 'Whole room'));
  assert.ok(jobs.some((c) => c.raw === 'Signature Tiling & Carpentry'));

  // B. Two businesses joined by "and" are split; one business containing "and" is not.
  assert.deepEqual(splitJoinedNames('Cedar Ceramics and Lewis Cowburn Tiling'), ['Cedar Ceramics', 'Lewis Cowburn Tiling']);
  assert.deepEqual(splitJoinedNames('Signature Tiling and Carpentry'), ['Signature Tiling and Carpentry']);
  assert.deepEqual(splitJoinedNames('Limartra Tiling and Restoration'), ['Limartra Tiling and Restoration']);
  assert.deepEqual(splitJoinedNames('Stone and Slate Co'), ['Stone and Slate Co']);
  assert.deepEqual(splitJoinedNames('Ls tiling & Patios'), ['Ls tiling & Patios'], '& never splits');
  assert.deepEqual(splitJoinedNames('Cedar Ceramics & Lewis Cowburn Tiling'), ['Cedar Ceramics & Lewis Cowburn Tiling'], '& never splits');
  assert.deepEqual(splitJoinedNames('Cedar Ceramics and the best tilers'), ['Cedar Ceramics and the best tilers'], 'a lowercase phrase is not a business name');

  const joined = extractCandidates({
    text: 'Local tilers people recommend include Cedar Ceramics and Lewis Cowburn Tiling in Aylesbury. Signature Tiling and Carpentry covers Chesham. Ls tiling & Patios is in Wendover.',
    html: '<p>Local tilers people recommend include <strong>Cedar Ceramics and Lewis Cowburn Tiling</strong> in Aylesbury. <strong>Signature Tiling and Carpentry</strong> covers Chesham. <strong>Ls tiling &amp; Patios</strong> is in Wendover.</p>',
    links: [],
  });
  const raws = joined.map((c) => c.raw);
  assert.ok(raws.includes('Cedar Ceramics'), raws.join(' | '));
  assert.ok(raws.includes('Lewis Cowburn Tiling'), raws.join(' | '));
  assert.ok(!raws.includes('Cedar Ceramics and Lewis Cowburn Tiling'), 'merged candidate must never survive');
  assert.ok(raws.includes('Signature Tiling and Carpentry'));
  assert.ok(raws.includes('Ls tiling & Patios'));
  assert.equal(raws.filter((r) => /Ls tiling/.test(r)).length, raws.filter((r) => r === 'Ls tiling & Patios').length, 'Ls tiling & Patios stays a single candidate');
  // Each split candidate keeps its own visible-text evidence.
  const cedar = joined.find((c) => c.raw === 'Cedar Ceramics');
  const lewis = joined.find((c) => c.raw === 'Lewis Cowburn Tiling');
  assert.match(cedar?.context ?? '', /Cedar Ceramics and Lewis Cowburn Tiling/);
  assert.match(lewis?.context ?? '', /Lewis Cowburn Tiling in Aylesbury/);
});
