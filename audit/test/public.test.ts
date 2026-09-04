/** Prospect-facing public report: token issue, tracking, exposure and evidence access, over real HTTP. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AuditEngine, newAuditRecord, reanalyseRecord } from '../src/audit/engine.ts';
import { createApp } from '../src/app.ts';
import { MockChatGptProvider, type MockOptions } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import type { AuditRecord } from '../src/domain/types.ts';
import { ensurePublicReport, issuePublicToken } from '../src/public/tracking.ts';
import { LS_TILING, conversationalTurn1, conversationalTurn2, lsTilingSite, recommendedResponse, visibleResponse } from './fixtures/lsTiling.ts';

let server: http.Server;
let base: string;
let store: AuditStore;
let evidence: EvidenceStore;
let clock = new Date('2026-09-04T10:00:00.000Z');
const now = () => clock;
const CTA_URL = 'https://packages.ailistings.co.uk/?src=report';
const PUBLIC_BASE = 'https://reports.example.test';

function fixtureMock(): MockOptions {
  return { conversations: [{ answers: [visibleResponse] }, { answers: [recommendedResponse] }, { answers: [conversationalTurn1, conversationalTurn2] }] };
}

async function runAudit(mock: MockOptions): Promise<AuditRecord> {
  const provider = new MockChatGptProvider(mock);
  const engine = new AuditEngine({ provider, evidence, store, fetcher: async () => lsTilingSite, now });
  const record = newAuditRecord(LS_TILING, provider.name, now());
  await store.save(record);
  await engine.run(record);
  return record;
}

async function get(pathname: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`${base}${pathname}`, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

before(async () => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-public-'));
  store = new AuditStore(path.join(dir, 'audits'));
  evidence = new EvidenceStore(path.join(dir, 'evidence'));
  const provider = new MockChatGptProvider({ conversations: [] });
  const engine = new AuditEngine({ provider, evidence, store, now });
  server = http.createServer(
    createApp({ provider, engine, store, evidence, uiFile: path.join(import.meta.dirname, '..', 'src', 'ui', 'index.html'), publicBaseUrl: PUBLIC_BASE, ctaUrl: CTA_URL, now }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test('a COMPLETE audit gets a random public token and a publicUrl in its summary', async () => {
  const record = await runAudit(fixtureMock());
  assert.equal(record.status, 'COMPLETE');
  const token = record.publicReport?.token ?? '';
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.ok(!token.toLowerCase().includes('tiling'));
  assert.ok(!token.includes(record.id) && !record.id.includes(token));
  assert.equal(record.publicReport?.viewCount, 0);
  assert.equal(record.publicReport?.ctaClickCount, 0);
  const api = await get(`/api/audits/${record.id}`);
  assert.equal(JSON.parse(api.body).summary.publicUrl, `${PUBLIC_BASE}/a/${token}`);
  // Tokens are unique and unpredictable.
  const other = await runAudit(fixtureMock());
  assert.notEqual(other.publicReport?.token, token);
  const many = new Set(Array.from({ length: 50 }, () => issuePublicToken()));
  assert.equal(many.size, 50);
});

test('an INCOMPLETE audit never gets a public report or URL', async () => {
  const record = await runAudit({ ...fixtureMock(), openErrors: { 1: new Error('net::ERR_TUNNEL_CONNECTION_FAILED') } });
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.publicReport, undefined);
  const api = await get(`/api/audits/${record.id}`);
  assert.equal(JSON.parse(api.body).summary.publicUrl, undefined);
  assert.equal(ensurePublicReport(record), undefined);
  const signedOut = await runAudit({ conversations: [], signedOut: true });
  assert.equal(signedOut.publicReport, undefined);
  const tracking = JSON.parse((await get(`/api/audits/${record.id}/tracking`)).body);
  assert.equal(tracking.publicUrl, null);
});

test('an invalid token returns 404 without leaking anything', async () => {
  for (const bad of [issuePublicToken(), 'abc', 'x'.repeat(43), '..%2F..%2Fetc%2Fpasswd', 'token%00', issuePublicToken().slice(0, 42)]) {
    const r = await get(`/a/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.ok(!/audit|provider|stack|error:/i.test(r.body), bad);
  }
  assert.equal((await get(`/a/${issuePublicToken()}/cta`)).status, 404);
  assert.equal((await get(`/a/${issuePublicToken()}/evidence/visible-1-1.png`)).status, 404);
});

test('first view sets firstViewedAt; repeat views increment the count and keep the first timestamp', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  clock = new Date('2026-09-05T09:00:00.000Z');
  const first = await get(`/a/${token}`);
  assert.equal(first.status, 200);
  let stored = (await store.get(record.id))!.publicReport!;
  assert.equal(stored.firstViewedAt, '2026-09-05T09:00:00.000Z');
  assert.equal(stored.lastViewedAt, '2026-09-05T09:00:00.000Z');
  assert.equal(stored.viewCount, 1);

  clock = new Date('2026-09-06T18:30:00.000Z');
  await get(`/a/${token}`);
  await get(`/a/${token}`);
  stored = (await store.get(record.id))!.publicReport!;
  assert.equal(stored.firstViewedAt, '2026-09-05T09:00:00.000Z', 'first view is never replaced');
  assert.equal(stored.lastViewedAt, '2026-09-06T18:30:00.000Z');
  assert.equal(stored.viewCount, 3);
  assert.equal(stored.ctaClickCount, 0, 'viewing is not clicking');
});

test('CTA click is tracked and redirects to the configured destination', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  clock = new Date('2026-09-07T12:00:00.000Z');
  const r = await get(`/a/${token}/cta`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), CTA_URL);
  clock = new Date('2026-09-08T12:00:00.000Z');
  await get(`/a/${token}/cta`);
  const stored = (await store.get(record.id))!.publicReport!;
  assert.equal(stored.ctaClickedAt, '2026-09-07T12:00:00.000Z', 'first click timestamp kept');
  assert.equal(stored.ctaClickCount, 2);
  assert.equal(stored.viewCount, 0, 'clicking the CTA is not a page view');

  const tracking = JSON.parse((await get(`/api/audits/${record.id}/tracking`)).body);
  assert.equal(tracking.publicUrl, `${PUBLIC_BASE}/a/${token}`);
  assert.equal(tracking.ctaClickCount, 2);
  assert.equal(tracking.ctaClickedAt, '2026-09-07T12:00:00.000Z');
  assert.equal(tracking.lead_id, null);
  assert.equal(tracking.business_name, 'LS-Tiling');
});

test('public HTML shows the sales content and no internal or debug information', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  const { status, body, headers } = await get(`/a/${token}`);
  assert.equal(status, 200);
  assert.match(headers.get('x-robots-tag') ?? '', /noindex/);
  // Required content
  assert.match(body, /LS-Tiling/);
  assert.match(body, /What we tested/);
  assert.match(body, /Visible<\/div><div class="v">NO/);
  assert.match(body, /Recommended<\/div><div class="v">NO/);
  assert.match(body, /Conversational<\/div><div class="v">NO/);
  for (const c of ['Limartra Tiling and Restoration', 'SDB Tiling', 'Signature Tiling &amp; Carpentry']) assert.match(body, new RegExp(c));
  assert.match(body, /Why visible is not the same as recommended/);
  assert.match(body, /<details>/);
  assert.match(body, /Talk to us about improving your AI visibility/);
  assert.match(body, new RegExp(`href="/a/${token}/cta"`));
  assert.match(body, new RegExp(`src="/a/${token}/evidence/`));
  // Nothing internal
  assert.ok(!body.includes(record.id), 'internal audit id');
  assert.ok(!/mock|playwright|provider|chromium|headless/i.test(body), 'provider info');
  assert.ok(!/prospectPresent|businessesSurfaced|entities|\bkind\b|uncertain|competitor:|classif|debug|"key"/i.test(body), 'classification/debug');
  assert.ok(!/\/evidence\/[0-9a-f-]{36}\//.test(body) && !/\.data|\/home\/|C:\\/.test(body), 'filesystem/internal paths');
  assert.ok(!/ERROR|SIGN_IN_REQUIRED|INCOMPLETE|stack|exception/i.test(body), 'internal errors/states');
  // No transcripts: the ChatGPT responses are not reproduced, only the questions we asked.
  assert.ok(!body.includes('Loose or cracked tiles usually mean the adhesive has failed'), 'full response text');
  assert.ok(!body.includes('Pound Street'), 'response fragments');
  assert.match(body, /We asked: <em>“Tiling companies in Wendover”/);
  assert.ok(!/lead_id|mapbox|openstreetmap/i.test(body));
});

test('screenshots are reachable only through the valid public audit relationship', async () => {
  const a = await runAudit(fixtureMock());
  const b = await runAudit(fixtureMock());
  const fileA = decodeURIComponent(a.evidence.visibleScreenshots[0]!.split('/').at(-1)!);
  const fileB = decodeURIComponent(b.evidence.recommendedScreenshots[0]!.split('/').at(-1)!);
  const ok = await get(`/a/${a.publicReport!.token}/evidence/${encodeURIComponent(fileA)}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /image\/png/);
  // Same file name under another audit's token: 404 (file belongs to A, not B).
  assert.equal((await get(`/a/${b.publicReport!.token}/evidence/${encodeURIComponent(fileA)}`)).status, 404);
  // B's own file under A's token: 404.
  assert.equal((await get(`/a/${a.publicReport!.token}/evidence/${encodeURIComponent(fileB)}`)).status, 404);
  // Random token: 404. Traversal: 404.
  assert.equal((await get(`/a/${issuePublicToken()}/evidence/${encodeURIComponent(fileA)}`)).status, 404);
  assert.equal((await get(`/a/${a.publicReport!.token}/evidence/..%2F..%2Fx.png`)).status, 404);
  // Brand diagnostic screenshots are internal and never served publicly.
  assert.equal((await get(`/a/${a.publicReport!.token}/evidence/brand_diagnostic-1-1.png`)).status, 404);
});

test('reanalysis keeps an existing token and only issues one when the audit is COMPLETE', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  reanalyseRecord(record);
  assert.equal(record.publicReport?.token, token);
  const broken = await runAudit({ ...fixtureMock(), openErrors: { 0: new Error('boom') } });
  reanalyseRecord(broken);
  assert.equal(broken.publicReport, undefined);
});
