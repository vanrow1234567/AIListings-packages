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
import { ensurePublicReport, issuePublicToken, issueSessionNonce } from '../src/public/tracking.ts';
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
  assert.equal(record.publicReport?.pageRequestCount, 0);
  assert.equal(record.publicReport?.engagedViewCount, 0);
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

const NONCE_RE = /\{session:"([A-Za-z0-9_-]{22})"\}/;
function sessionOf(body: string): string {
  const m = body.match(NONCE_RE);
  assert.ok(m, 'rendered page carries a session nonce');
  return m![1]!;
}
async function postEngaged(token: string, session: unknown): Promise<{ status: number; body: { ok: boolean; outcome?: string } }> {
  const res = await fetch(`${base}/a/${token}/engaged`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }) });
  return { status: res.status, body: (await res.json()) as { ok: boolean; outcome?: string } };
}

test('1. GET alone increases pageRequestCount but never engagedViewCount', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  clock = new Date('2026-09-05T09:00:00.000Z');
  await get(`/a/${token}`);
  clock = new Date('2026-09-05T09:05:00.000Z');
  await get(`/a/${token}`);
  await get(`/a/${token}`);
  const r = (await store.get(record.id))!.publicReport!;
  assert.equal(r.pageRequestCount, 3);
  assert.equal(r.firstRequestedAt, '2026-09-05T09:00:00.000Z');
  assert.equal(r.lastRequestedAt, '2026-09-05T09:05:00.000Z');
  assert.equal(r.engagedViewCount, 0, 'a bot fetching the HTML is not engagement');
  assert.equal(r.firstEngagedAt, undefined);
  assert.equal(r.lastEngagedAt, undefined);
  assert.equal(r.ctaClickCount, 0);
  const tracking = JSON.parse((await get(`/api/audits/${record.id}/tracking`)).body);
  assert.equal(tracking.pageRequestCount, 3);
  assert.equal(tracking.engagedViewCount, 0);
  assert.equal(tracking.firstEngagedAt, null);
});

test('2. POST engaged with the rendered session creates firstEngagedAt', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  clock = new Date('2026-09-05T10:00:00.000Z');
  const page = await get(`/a/${token}`);
  const session = sessionOf(page.body);
  assert.ok(!page.body.includes(record.id));
  clock = new Date('2026-09-05T10:00:02.000Z');
  const res = await postEngaged(token, session);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, outcome: 'counted' });
  const r = (await store.get(record.id))!.publicReport!;
  assert.equal(r.firstEngagedAt, '2026-09-05T10:00:02.000Z');
  assert.equal(r.lastEngagedAt, '2026-09-05T10:00:02.000Z');
  assert.equal(r.engagedViewCount, 1);
  assert.equal(r.pageRequestCount, 1);
  assert.deepEqual(r.issuedSessions, [], 'a used session cannot be replayed');
});

test('3. duplicate engagement from the same rendered page counts once', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  clock = new Date('2026-09-05T11:00:00.000Z');
  const session = sessionOf((await get(`/a/${token}`)).body);
  clock = new Date('2026-09-05T11:00:02.000Z');
  assert.equal((await postEngaged(token, session)).body.outcome, 'counted');
  clock = new Date('2026-09-05T11:00:09.000Z');
  for (let i = 0; i < 5; i++) assert.equal((await postEngaged(token, session)).body.outcome, 'duplicate');
  const r = (await store.get(record.id))!.publicReport!;
  assert.equal(r.engagedViewCount, 1);
  assert.equal(r.firstEngagedAt, '2026-09-05T11:00:02.000Z');
  assert.equal(r.lastEngagedAt, '2026-09-05T11:00:02.000Z', 'a duplicate does not move lastEngagedAt');
});

test('4. a fresh page session counts again and keeps the first engagement timestamp', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  clock = new Date('2026-09-06T08:00:00.000Z');
  const s1 = sessionOf((await get(`/a/${token}`)).body);
  await postEngaged(token, s1);
  clock = new Date('2026-09-07T08:00:00.000Z');
  const s2 = sessionOf((await get(`/a/${token}`)).body);
  assert.notEqual(s1, s2, 'each render gets its own session');
  clock = new Date('2026-09-07T08:00:02.000Z');
  assert.equal((await postEngaged(token, s2)).body.outcome, 'counted');
  const r = (await store.get(record.id))!.publicReport!;
  assert.equal(r.engagedViewCount, 2);
  assert.equal(r.pageRequestCount, 2);
  assert.equal(r.firstEngagedAt, '2026-09-06T08:00:00.000Z');
  assert.equal(r.lastEngagedAt, '2026-09-07T08:00:02.000Z');
});

test('5. invalid tokens and forged sessions cannot create engagement', async () => {
  const record = await runAudit(fixtureMock());
  const token = record.publicReport!.token;
  const session = sessionOf((await get(`/a/${token}`)).body);
  // Wrong token, real session
  assert.equal((await postEngaged(issuePublicToken(), session)).status, 404);
  // Right token, session never issued by the server
  const forged = await postEngaged(token, issueSessionNonce());
  assert.equal(forged.status, 400);
  assert.equal(forged.body.outcome, 'unknown_session');
  // Garbage bodies
  for (const bad of [undefined, null, 42, '', 'x', '<script>', 'a'.repeat(200)]) assert.equal((await postEngaged(token, bad)).status, 400, String(bad));
  const raw = await fetch(`${base}/a/${token}/engaged`, { method: 'POST', body: 'not json' });
  assert.equal(raw.status, 400);
  const r = (await store.get(record.id))!.publicReport!;
  assert.equal(r.engagedViewCount, 0);
  assert.equal(r.firstEngagedAt, undefined);
  // GET on the engaged route is not a thing; the issued session is still valid afterwards.
  assert.equal((await get(`/a/${token}/engaged`)).status, 404);
  assert.equal((await postEngaged(token, session)).body.outcome, 'counted');
  // An INCOMPLETE audit has no token at all, so nothing can be posted for it.
  const broken = await runAudit({ ...fixtureMock(), openErrors: { 0: new Error('boom') } });
  assert.equal(broken.publicReport, undefined);
});

test('6. CTA click is still tracked and redirects to the configured destination', async () => {
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
  assert.equal(stored.pageRequestCount, 0, 'clicking the CTA is not a page request');
  assert.equal(stored.engagedViewCount, 0, 'clicking the CTA is not an engaged view');

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
  assert.match(body, /Business details used for this audit/);
  assert.match(body, /Not quite right\?/);
  assert.match(body, /publicly available information/);
  assert.match(body, /incorrect or missing/);
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
  // First-party beacon only: same-origin engaged endpoint, no third-party analytics.
  assert.match(body, new RegExp(`"/a/${token}/engaged"`));
  assert.ok(!/googletagmanager|google-analytics|gtag\(|fbq\(|hotjar|segment\.com|plausible|matomo|https?:\/\/[^"']+\.js/i.test(body), 'third-party scripts');
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
