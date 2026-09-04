/**
 * Identity resolution: "can we PROVE this surfaced result belongs to the prospect?"
 * Scenarios A–G from the specification, the HTTP destination resolver against a local
 * server, and end-to-end engine integration with stored resolution evidence.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AuditEngine, newAuditRecord, reanalyseRecord, reanalyseRecordWithIdentity } from '../src/audit/engine.ts';
import { MockChatGptProvider, type MockOptions } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import type { AuditRecord, Prospect } from '../src/domain/types.ts';
import { HttpDestinationResolver, unwrapRedirector } from '../src/identity/destination.ts';
import type { DestinationResolver, DestinationResult, IdentityCandidate, IdentityProvider } from '../src/identity/provider.ts';
import { LinkIdentityResolver, NullIdentityProvider, ambiguousMentions } from '../src/identity/resolver.ts';
import { isAmbiguousProspectCandidate } from '../src/competitors/classify.ts';
import { LS_TILING, conversationalTurn1, lsTilingSite, recommendedResponse, visibleResponse } from './fixtures/lsTiling.ts';

const LS: Prospect = { name: 'LS-Tiling', website: 'https://ls-tiling.co.uk', domain: 'ls-tiling.co.uk', location: 'Wendover', serviceTerms: ['tiling', 'tilings', 'tiler', 'tilers'] };
const SPP: Prospect = { name: 'SPP Roofing', website: 'https://www.spproofing.co.uk/', domain: 'spproofing.co.uk', location: 'Southampton', serviceTerms: ['roofing', 'roofers', 'roofer', 'roof', 'roofs', 'guttering'] };
const clock = () => new Date('2026-09-05T12:00:00.000Z');

/** Scripted destination resolver: maps a source URL to where it "lands". */
function fakeDestinations(map: Record<string, DestinationResult | ((url: string) => DestinationResult)>): DestinationResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(url) {
      calls.push(url);
      const hit = map[url];
      if (!hit) return { ok: false, sourceUrl: url, error: 'ENOTFOUND', hops: [] };
      return typeof hit === 'function' ? hit(url) : hit;
    },
  };
}
const lands = (sourceUrl: string, finalUrl: string, extra: Partial<Extract<DestinationResult, { ok: true }>> = {}): DestinationResult => ({
  ok: true,
  sourceUrl,
  finalUrl,
  finalHost: new URL(finalUrl).hostname,
  hops: finalUrl === sourceUrl ? [] : [sourceUrl],
  ...extra,
});
const cand = (name: string, href?: string, context = `${name} — flooring contractor in Aylesbury`): IdentityCandidate => ({ name, context, layer: 'CONVERSATIONAL', turnIndex: 1, ...(href ? { href } : {}) });

test('A. "Ls tiling & Patios" with no link is UNRESOLVED and not the prospect', async () => {
  const dest = fakeDestinations({});
  const r = await new LinkIdentityResolver(dest, clock).resolve(cand('Ls tiling & Patios'), LS);
  assert.equal(r.resolutionState, 'UNRESOLVED');
  assert.equal(r.resolutionMethod, 'no_link');
  assert.equal(r.sourceUrl, undefined);
  assert.equal(r.matchedDomain, undefined);
  assert.equal(r.prospectDomain, 'ls-tiling.co.uk');
  assert.equal(r.candidateName, 'Ls tiling & Patios');
  assert.match(r.candidateContext, /flooring contractor in Aylesbury/);
  assert.deepEqual(dest.calls, [], 'nothing to fetch');
  assert.ok(isAmbiguousProspectCandidate({ raw: 'Ls tiling & Patios' }, LS), 'it is ambiguous, so it is worth checking');
  assert.ok(!isAmbiguousProspectCandidate({ raw: 'SDB Tiling' }, LS), 'unrelated names are never checked');
});

test('B. the same candidate linking to https://ls-tiling.co.uk/ is CONFIRMED_PROSPECT', async () => {
  const dest = fakeDestinations({ 'https://ls-tiling.co.uk/': lands('https://ls-tiling.co.uk/', 'https://ls-tiling.co.uk/') });
  const r = await new LinkIdentityResolver(dest, clock).resolve(cand('Ls tiling & Patios', 'https://ls-tiling.co.uk/'), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'captured_link');
  assert.equal(r.matchedDomain, 'ls-tiling.co.uk');
  assert.equal(r.sourceUrl, 'https://ls-tiling.co.uk/');
  assert.deepEqual(dest.calls, [], 'the captured host already matched; no request needed');
});

test('C. a tracking URL that redirects to https://www.ls-tiling.co.uk/ is CONFIRMED_PROSPECT', async () => {
  const src = 'https://www.google.com/url?sa=t&q=https%3A%2F%2Ftrk.example%2Fabc';
  const dest = fakeDestinations({ [src]: lands(src, 'https://www.ls-tiling.co.uk/') });
  const r = await new LinkIdentityResolver(dest, clock).resolve(cand('Ls tiling & Patios', src), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'redirect_follow');
  assert.equal(r.matchedDomain, 'ls-tiling.co.uk', 'www and non-www are the same domain');
  assert.equal(r.finalUrl, 'https://www.ls-tiling.co.uk/');
  assert.equal(r.sourceUrl, src);
  assert.deepEqual(dest.calls, [src]);
});

test('D. rel=canonical on the landing page pointing at the prospect domain is CONFIRMED_PROSPECT (not on intermediaries)', async () => {
  const src = 'https://lstilingandpatios.co.uk/';
  const dest = fakeDestinations({ [src]: lands(src, src, { canonicalUrl: 'https://ls-tiling.co.uk/services/patios', canonicalHost: 'ls-tiling.co.uk' }) });
  const r = await new LinkIdentityResolver(dest, clock).resolve(cand('Ls tiling & Patios', src), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(r.resolutionMethod, 'canonical');
  assert.equal(r.canonicalUrl, 'https://ls-tiling.co.uk/services/patios');
  assert.equal(r.matchedDomain, 'ls-tiling.co.uk');
  // A directory listing whose canonical happens to name the prospect is still not proof: intermediaries are not identity.
  const dir = 'https://www.checkatrade.com/trades/lstiling';
  const dest2 = fakeDestinations({ [dir]: lands(dir, dir, { canonicalUrl: 'https://ls-tiling.co.uk/', canonicalHost: 'ls-tiling.co.uk' }) });
  const r2 = await new LinkIdentityResolver(dest2, clock).resolve(cand('Ls tiling & Patios', dir), LS);
  assert.equal(r2.resolutionState, 'UNRESOLVED');
  assert.equal(r2.matchedDomain, 'checkatrade.com');
});

test('E. a candidate resolving to https://different-tiler.co.uk/ is CONFIRMED_OTHER_BUSINESS', async () => {
  const src = 'https://t.co/x1';
  const dest = fakeDestinations({ [src]: lands(src, 'https://different-tiler.co.uk/') });
  const r = await new LinkIdentityResolver(dest, clock).resolve(cand('Ls tiling & Patios', src), LS);
  assert.equal(r.resolutionState, 'CONFIRMED_OTHER_BUSINESS');
  assert.equal(r.resolutionMethod, 'redirect_follow');
  assert.equal(r.matchedDomain, 'different-tiler.co.uk');
  assert.equal(r.finalUrl, 'https://different-tiler.co.uk/');
  // Landing on maps / search / a directory is neither: UNRESOLVED.
  const maps = 'https://maps.google.com/?cid=1';
  const dest2 = fakeDestinations({ [maps]: lands(maps, maps) });
  assert.equal((await new LinkIdentityResolver(dest2, clock).resolve(cand('Ls tiling & Patios', maps), LS)).resolutionState, 'UNRESOLVED');
});

test('F. SPP Roofing & Guttering: unresolved by name, confirmed when it resolves to spproofing.co.uk', async () => {
  const byName = await new LinkIdentityResolver(fakeDestinations({}), clock).resolve(cand('SPP Roofing & Guttering', undefined, 'SPP Roofing & Guttering – Southampton roofers'), SPP);
  assert.equal(byName.resolutionState, 'UNRESOLVED');
  assert.equal(byName.resolutionMethod, 'no_link');
  const src = 'https://bit.ly/spp-roof';
  const dest = fakeDestinations({ [src]: lands(src, 'https://www.spproofing.co.uk/guttering') });
  const linked = await new LinkIdentityResolver(dest, clock).resolve(cand('SPP Roofing & Guttering', src), SPP);
  assert.equal(linked.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(linked.matchedDomain, 'spproofing.co.uk');
  // Existing strong evidence resolves without any request.
  const variant = await new LinkIdentityResolver(fakeDestinations({}), clock).resolve(cand('SPP Roofing Ltd'), SPP);
  assert.equal(variant.resolutionState, 'CONFIRMED_PROSPECT');
  assert.equal(variant.resolutionMethod, 'name_variant');
});

test('G. network error / blocked destination / timeout is UNRESOLVED, never YES, never NO-evidence', async () => {
  const src = 'https://trk.example/ls';
  for (const error of ['ENOTFOUND', 'Timed out after 6000ms', 'HTTP 403', 'Destination is a private or local address', 'Too many redirects']) {
    const dest = fakeDestinations({ [src]: { ok: false, sourceUrl: src, error, hops: [src] } });
    const r = await new LinkIdentityResolver(dest, clock).resolve(cand('Ls tiling & Patios', src), LS);
    assert.equal(r.resolutionState, 'UNRESOLVED', error);
    assert.equal(r.resolutionMethod, 'fetch_failed');
    assert.equal(r.error, error);
    assert.equal(r.matchedDomain, undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// HttpDestinationResolver against a local server: redirects, redirector unwrapping, canonical,
// meta refresh, timeouts, error statuses, private-host refusal.
// ---------------------------------------------------------------------------------------------
let local: http.Server;
let origin: string;
before(async () => {
  local = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    switch (u.pathname) {
      case '/track':
        res.writeHead(302, { location: '/hop2' });
        return res.end();
      case '/hop2':
        res.writeHead(301, { location: `${origin}/final` });
        return res.end();
      case '/final':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><title>x</title><link rel="canonical" href="https://ls-tiling.co.uk/patios/"></head><body>hi</body></html>');
      case '/refresh':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html><head><meta http-equiv="refresh" content="0; url=/final"></head></html>');
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        return res.end();
      case '/slow':
        return setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 3000);
      case '/gone':
        res.writeHead(404);
        return res.end('nope');
      case '/nolocation':
        res.writeHead(302);
        return res.end();
      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('plain');
    }
  });
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => local.close(() => r()));
});

test('HTTP resolver follows redirects and reads rel=canonical', async () => {
  const resolver = new HttpDestinationResolver({ allowPrivateHosts: true, timeoutMs: 2000 });
  const r = await resolver.resolve(`${origin}/track`);
  assert.ok(r.ok);
  assert.equal(r.finalUrl, `${origin}/final`);
  assert.equal(r.finalHost, '127.0.0.1');
  assert.equal(r.canonicalUrl, 'https://ls-tiling.co.uk/patios/');
  assert.equal(r.canonicalHost, 'ls-tiling.co.uk');
  assert.deepEqual(r.hops, [`${origin}/track`, `${origin}/hop2`]);
  const plain = await resolver.resolve(`${origin}/plain`);
  assert.ok(plain.ok && plain.canonicalUrl === undefined);
  const refresh = await resolver.resolve(`${origin}/refresh`);
  assert.ok(refresh.ok && refresh.finalUrl === `${origin}/final`);
});

test('HTTP resolver unwraps redirectors without fetching them', () => {
  assert.equal(unwrapRedirector('https://www.google.com/url?sa=t&q=https%3A%2F%2Fwww.ls-tiling.co.uk%2F'), 'https://www.ls-tiling.co.uk/');
  assert.equal(unwrapRedirector('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fls-tiling.co.uk%2F'), 'https://ls-tiling.co.uk/');
  assert.equal(unwrapRedirector('https://ls-tiling.co.uk/?q=https://evil.example/'), undefined, 'only known redirector hosts are unwrapped');
  assert.equal(unwrapRedirector('https://www.google.com/maps/search/tilers'), undefined);
});

test('HTTP resolver fails closed: timeouts, loops, errors, missing Location, private hosts, bad schemes', async () => {
  const fast = new HttpDestinationResolver({ allowPrivateHosts: true, timeoutMs: 500, maxHops: 4 });
  const slow = await fast.resolve(`${origin}/slow`);
  assert.ok(!slow.ok && /Timed out/.test(slow.error));
  const loop = await fast.resolve(`${origin}/loop`);
  assert.ok(!loop.ok && /Too many redirects/.test(loop.error));
  const gone = await fast.resolve(`${origin}/gone`);
  assert.ok(!gone.ok && gone.error === 'HTTP 404');
  const noloc = await fast.resolve(`${origin}/nolocation`);
  assert.ok(!noloc.ok && /without Location/.test(noloc.error));
  const strict = new HttpDestinationResolver({ timeoutMs: 500 });
  const priv = await strict.resolve(`${origin}/final`);
  assert.ok(!priv.ok && /private or local/.test(priv.error), 'production resolver never touches private networks');
  const scheme = await strict.resolve('file:///etc/passwd');
  assert.ok(!scheme.ok && /Unsupported scheme/.test(scheme.error));
  const garbage = await strict.resolve('not a url');
  assert.ok(!garbage.ok);
});

// ---------------------------------------------------------------------------------------------
// Engine integration: resolutions are stored on the layer and only CONFIRMED_PROSPECT flips it.
// ---------------------------------------------------------------------------------------------
function conversationalWithLink(href?: string) {
  const anchor = href ? `<a href="${href}">Ls tiling &amp; Patios</a>` : '<strong>Ls tiling &amp; Patios</strong>';
  return {
    text: 'Tilers people mention locally:\nLs tiling & Patios — flooring contractor in Aylesbury.\nSDB Tiling – Aylesbury.\nKitchen splashback – £250–£450',
    html: `<p>Tilers people mention locally:</p><ul><li><p>${anchor} — flooring contractor in Aylesbury.</p></li><li><p><strong>SDB Tiling</strong> – Aylesbury.</p></li><li><p><strong>Kitchen splashback</strong> – £250–£450</p></li></ul>`,
    links: href ? [href] : [],
  };
}

async function runWithIdentity(href: string | undefined, identity: IdentityProvider): Promise<{ record: AuditRecord; store: AuditStore }> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-identity-'));
  const store = new AuditStore(path.join(dir, 'audits'));
  const mock: MockOptions = { conversations: [{ answers: [visibleResponse] }, { answers: [recommendedResponse] }, { answers: [conversationalTurn1, conversationalWithLink(href)] }] };
  const provider = new MockChatGptProvider(mock);
  const engine = new AuditEngine({ provider, evidence: new EvidenceStore(path.join(dir, 'evidence')), store, fetcher: async () => lsTilingSite, identity, now: clock });
  const record = newAuditRecord(LS_TILING, provider.name, clock());
  await store.save(record);
  await engine.run(record);
  return { record, store };
}

test('engine: no link -> UNRESOLVED stored, Conversational is non-conclusive, name stays a surfaced business', async () => {
  const { record } = await runWithIdentity(undefined, new LinkIdentityResolver(fakeDestinations({}), clock));
  const conv = record.layers.CONVERSATIONAL;
  assert.equal(conv.state, 'IDENTITY_UNRESOLVED');
  assert.equal(conv.prospectPresent, 'UNRESOLVED');
  assert.equal(conv.prospectMatchEvidence, undefined);
  assert.match(conv.error ?? '', /Could not prove whether "Ls tiling & Patios" is the prospect/);
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(conv.identityResolutions?.length, 1);
  const r = conv.identityResolutions![0]!;
  assert.equal(r.candidateName, 'Ls tiling & Patios');
  assert.match(r.candidateContext, /flooring contractor in Aylesbury/);
  assert.equal(r.resolutionState, 'UNRESOLVED');
  assert.equal(r.resolutionMethod, 'no_link');
  assert.equal(r.prospectDomain, 'ls-tiling.co.uk');
  assert.equal(r.layer, 'CONVERSATIONAL');
  assert.equal(r.turnIndex, 1);
  assert.ok(conv.businessesSurfaced.includes('Ls tiling & Patios'));
  assert.ok(!conv.businessesSurfaced.includes('Kitchen splashback'), 'job-description fix preserved');
  assert.equal(record.layers.VISIBLE.identityResolutions?.length, 0, 'no ambiguous names in the other layers');
});

test('engine: tracking link resolving to the prospect -> CONFIRMED_PROSPECT, Conversational YES with resolved evidence', async () => {
  const src = 'https://www.google.com/url?q=https%3A%2F%2Ftrk.example%2Fls';
  const dest = fakeDestinations({ [src]: lands(src, 'https://www.ls-tiling.co.uk/') });
  const { record, store } = await runWithIdentity(src, new LinkIdentityResolver(dest, clock));
  const conv = record.layers.CONVERSATIONAL;
  assert.equal(conv.state, 'YES');
  assert.equal(conv.prospectPresent, 'YES');
  assert.equal(conv.prospectMatchEvidence?.[0]?.matchedBy, 'resolved_destination');
  assert.equal(conv.prospectMatchEvidence?.[0]?.snippet, 'Ls tiling & Patios');
  const r = conv.identityResolutions![0]!;
  assert.deepEqual(
    { state: r.resolutionState, method: r.resolutionMethod, source: r.sourceUrl, final: r.finalUrl, matched: r.matchedDomain, prospect: r.prospectDomain },
    { state: 'CONFIRMED_PROSPECT', method: 'redirect_follow', source: src, final: 'https://www.ls-tiling.co.uk/', matched: 'ls-tiling.co.uk', prospect: 'ls-tiling.co.uk' },
  );
  assert.deepEqual([...conv.businessesSurfaced].sort(), ['LS-Tiling', 'SDB Tiling']);
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.ok(!record.topCompetitors.some((c) => /Ls tiling/i.test(c.name)), 'the prospect is not its own competitor');
  // Sync reanalysis re-applies the stored resolution without any network.
  const stored = (await store.get(record.id))!;
  reanalyseRecord(stored);
  assert.equal(stored.layers.CONVERSATIONAL.state, 'YES');
  assert.equal(stored.layers.CONVERSATIONAL.prospectMatchEvidence?.[0]?.matchedBy, 'resolved_destination');
});

test('engine: link resolving elsewhere -> CONFIRMED_OTHER_BUSINESS, NO; failure -> UNRESOLVED, non-conclusive', async () => {
  const other = 'https://different-tiler.co.uk/';
  const a = await runWithIdentity(other, new LinkIdentityResolver(fakeDestinations({ [other]: lands(other, other) }), clock));
  assert.equal(a.record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(a.record.layers.CONVERSATIONAL.identityResolutions?.[0]?.resolutionState, 'CONFIRMED_OTHER_BUSINESS');
  assert.equal(a.record.layers.CONVERSATIONAL.identityResolutions?.[0]?.matchedDomain, 'different-tiler.co.uk');
  assert.ok(a.record.layers.CONVERSATIONAL.businessesSurfaced.includes('Ls tiling & Patios'));

  const blocked = 'https://trk.example/blocked';
  const b = await runWithIdentity(blocked, new LinkIdentityResolver(fakeDestinations({ [blocked]: { ok: false, sourceUrl: blocked, error: 'net::ERR_TUNNEL_CONNECTION_FAILED', hops: [] } }), clock));
  const conv = b.record.layers.CONVERSATIONAL;
  assert.equal(conv.state, 'IDENTITY_UNRESOLVED', 'we can prove neither that it is the prospect nor that it is not');
  assert.equal(conv.identityResolutions?.[0]?.resolutionState, 'UNRESOLVED');
  assert.equal(conv.identityResolutions?.[0]?.resolutionMethod, 'fetch_failed');
  assert.match(conv.identityResolutions?.[0]?.error ?? '', /ERR_TUNNEL/);
  assert.equal(b.record.status, 'INCOMPLETE', 'fail closed: an unresolved plausible prospect never becomes a NO');
  assert.equal(a.record.status, 'COMPLETE', 'a proven other business does not block completion');
});

test('engine: reanalyseRecordWithIdentity re-runs resolution and a later provider can change the outcome', async () => {
  const src = 'https://trk.example/ls';
  const first = await runWithIdentity(src, new LinkIdentityResolver(fakeDestinations({ [src]: { ok: false, sourceUrl: src, error: 'Timed out after 6000ms', hops: [] } }), clock));
  assert.equal(first.record.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED');
  assert.equal(first.record.status, 'INCOMPLETE');
  // Later, the destination is reachable (or an external identity provider answers): the stored audit is re-checked.
  const again = await reanalyseRecordWithIdentity(first.record, new LinkIdentityResolver(fakeDestinations({ [src]: lands(src, 'https://ls-tiling.co.uk/') }), clock));
  assert.equal(again.layers.CONVERSATIONAL.state, 'YES');
  assert.equal(again.status, 'COMPLETE');
  assert.equal(again.layers.CONVERSATIONAL.identityResolutions?.[0]?.resolutionState, 'CONFIRMED_PROSPECT');
  // The null provider (identity checks disabled) leaves everything UNRESOLVED, hence non-conclusive.
  const off = await reanalyseRecordWithIdentity(first.record, new NullIdentityProvider());
  assert.equal(off.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED');
  assert.equal(off.status, 'INCOMPLETE');
  assert.equal(off.layers.CONVERSATIONAL.identityResolutions?.[0]?.resolutionState, 'UNRESOLVED');
  assert.equal(ambiguousMentions(off.layers.CONVERSATIONAL, LS).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Verdict invariant: an UNRESOLVED plausible prospect can never become a false NO.
// ---------------------------------------------------------------------------------------------
import { summarise } from '../src/audit/engine.ts';
import { ensurePublicReport, isPubliclyAvailable } from '../src/public/tracking.ts';

function conversationalWithoutAmbiguity() {
  return {
    text: 'Tilers people mention locally:\nSDB Tiling – Aylesbury.\nLimartra Tiling and Restoration – Aylesbury.',
    html: '<p>Tilers people mention locally:</p><ul><li><p><strong>SDB Tiling</strong> – Aylesbury.</p></li><li><p><strong>Limartra Tiling and Restoration</strong> – Aylesbury.</p></li></ul>',
    links: [],
  };
}

test('invariant A. ambiguous candidate + CONFIRMED_PROSPECT => YES / COMPLETE', async () => {
  const src = 'https://ls-tiling.co.uk/';
  const { record } = await runWithIdentity(src, new LinkIdentityResolver(fakeDestinations({ [src]: lands(src, src) }), clock));
  assert.equal(record.layers.CONVERSATIONAL.state, 'YES');
  assert.equal(record.layers.CONVERSATIONAL.prospectPresent, 'YES');
  assert.equal(record.status, 'COMPLETE');
  assert.ok(record.publicReport, 'a complete audit gets its report');
  assert.match(record.outreachMessage ?? '', /recommended you when we described a real customer problem/);
});

test('invariant B. ambiguous candidate + CONFIRMED_OTHER_BUSINESS => NO / COMPLETE', async () => {
  const src = 'https://different-tiler.co.uk/';
  const { record } = await runWithIdentity(src, new LinkIdentityResolver(fakeDestinations({ [src]: lands(src, src) }), clock));
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.prospectPresent, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.identityResolutions?.[0]?.resolutionState, 'CONFIRMED_OTHER_BUSINESS');
  assert.equal(record.status, 'COMPLETE');
  assert.match(record.outreachMessage ?? '', /LS-Tiling didn't appear at any point/, 'a proven-different business legitimately supports the NO claim');
});

test('invariant C. ambiguous candidate + UNRESOLVED (no link) => IDENTITY_UNRESOLVED / INCOMPLETE', async () => {
  const { record } = await runWithIdentity(undefined, new LinkIdentityResolver(fakeDestinations({}), clock));
  assert.equal(record.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED');
  assert.notEqual(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.prospectPresent, 'UNRESOLVED');
  assert.equal(record.status, 'INCOMPLETE');
  assert.match(record.incompleteReason ?? '', /CONVERSATIONAL: IDENTITY_UNRESOLVED/);
  assert.match(record.incompleteReason ?? '', /Ls tiling & Patios/);
  // The other layers are unaffected and still conclusive.
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
});

test('invariant D. ambiguous candidate + network timeout / bot block => IDENTITY_UNRESOLVED / INCOMPLETE', async () => {
  const src = 'https://trk.example/ls';
  for (const error of ['Timed out after 6000ms', 'HTTP 403', 'ENOTFOUND', 'Destination is a private or local address', 'Too many redirects']) {
    const { record } = await runWithIdentity(src, new LinkIdentityResolver(fakeDestinations({ [src]: { ok: false, sourceUrl: src, error, hops: [] } }), clock));
    assert.equal(record.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED', error);
    assert.equal(record.status, 'INCOMPLETE', error);
    assert.equal(record.layers.CONVERSATIONAL.identityResolutions?.[0]?.error, error);
  }
  // An intermediary landing (maps / directory) is UNRESOLVED as well.
  const maps = 'https://maps.google.com/?cid=1';
  const { record } = await runWithIdentity(maps, new LinkIdentityResolver(fakeDestinations({ [maps]: lands(maps, maps) }), clock));
  assert.equal(record.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED');
  assert.equal(record.status, 'INCOMPLETE');
});

test('invariant E. no ambiguous candidate + prospect absent => NO / COMPLETE (ordinary competitors need no resolution)', async () => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-identity-e-'));
  const store = new AuditStore(path.join(dir, 'audits'));
  const destinations = fakeDestinations({});
  const provider = new MockChatGptProvider({ conversations: [{ answers: [visibleResponse] }, { answers: [recommendedResponse] }, { answers: [conversationalTurn1, conversationalWithoutAmbiguity()] }] });
  const engine = new AuditEngine({ provider, evidence: new EvidenceStore(path.join(dir, 'evidence')), store, fetcher: async () => lsTilingSite, identity: new LinkIdentityResolver(destinations, clock), now: clock });
  const record = newAuditRecord(LS_TILING, provider.name, clock());
  await store.save(record);
  await engine.run(record);
  for (const l of ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'] as const) {
    assert.equal(record.layers[l].state, 'NO', l);
    assert.deepEqual(record.layers[l].identityResolutions, [], `${l}: nothing plausible to resolve`);
  }
  assert.deepEqual(destinations.calls, [], 'no network requests for ordinary competitors');
  assert.equal(record.status, 'COMPLETE');
  assert.deepEqual([...record.layers.CONVERSATIONAL.businessesSurfaced].sort(), ['Limartra Tiling and Restoration', 'SDB Tiling']);
});

test('invariant F. unresolved identity never produces outreach saying the prospect did not appear', async () => {
  const { record } = await runWithIdentity(undefined, new LinkIdentityResolver(fakeDestinations({}), clock));
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.outreachMessage, undefined);
  const stored = reanalyseRecord(record);
  assert.equal(stored.outreachMessage, undefined, 'reanalysis does not manufacture a claim either');
  assert.equal(stored.layers.CONVERSATIONAL.state, 'IDENTITY_UNRESOLVED');
});

test('invariant G. unresolved identity never creates a public prospect report', async () => {
  const { record } = await runWithIdentity(undefined, new LinkIdentityResolver(fakeDestinations({}), clock));
  assert.equal(record.publicReport, undefined);
  assert.equal(ensurePublicReport(record), undefined);
  assert.equal(isPubliclyAvailable(record), false);
  assert.equal(summarise(record, 'https://reports.example.test').publicUrl, undefined);
});
