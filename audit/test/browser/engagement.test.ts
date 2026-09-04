/**
 * Real-browser proof of the engagement beacon: the page must be loaded and visible
 * for ~2s before it reports; a page closed early never counts; a reload counts again;
 * the same rendered page never counts twice.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { AuditEngine, newAuditRecord } from '../../src/audit/engine.ts';
import { createApp } from '../../src/app.ts';
import { MockChatGptProvider } from '../../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../../src/evidence/capture.ts';
import { AuditStore } from '../../src/persistence/store.ts';
import { LS_TILING, conversationalTurn1, conversationalTurn2, lsTilingSite, recommendedResponse, visibleResponse } from '../fixtures/lsTiling.ts';

let server: http.Server;
let base: string;
let store: AuditStore;
let browser: Browser;
let auditId: string;
let token: string;

before(async () => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-engage-'));
  store = new AuditStore(path.join(dir, 'audits'));
  const evidence = new EvidenceStore(path.join(dir, 'evidence'));
  const provider = new MockChatGptProvider({ conversations: [{ answers: [visibleResponse] }, { answers: [recommendedResponse] }, { answers: [conversationalTurn1, conversationalTurn2] }] });
  const engine = new AuditEngine({ provider, evidence, store, fetcher: async () => lsTilingSite });
  const record = newAuditRecord(LS_TILING, provider.name);
  await store.save(record);
  await engine.run(record);
  auditId = record.id;
  token = record.publicReport!.token;
  server = http.createServer(createApp({ provider, engine, store, evidence, uiFile: path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'index.html'), publicBaseUrl: 'http://localhost', ctaUrl: 'https://packages.ailistings.co.uk/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function report() {
  return (await store.get(auditId))!.publicReport!;
}

test('a page closed before two seconds is a request, not an engagement', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/a/${token}`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.close();
  await new Promise((r) => setTimeout(r, 2200));
  const r = await report();
  assert.equal(r.pageRequestCount, 1);
  assert.equal(r.engagedViewCount, 0);
  assert.equal(r.firstEngagedAt, undefined);
});

test('a page that stays visible for two seconds reports engagement exactly once', async () => {
  const page = await browser.newPage();
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/engaged')) posts.push(req.url());
  });
  await page.goto(`${base}/a/${token}`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  assert.equal(posts.length, 0, 'nothing sent before the delay');
  await page.waitForTimeout(2000);
  assert.equal(posts.length, 1, 'beacon sent once after the delay');
  // Extra time and visibility changes on the same page do not send again.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(2500);
  assert.equal(posts.length, 1);
  const r = await report();
  assert.equal(r.pageRequestCount, 2);
  assert.equal(r.engagedViewCount, 1);
  assert.ok(r.firstEngagedAt);
  assert.equal(r.firstEngagedAt, r.lastEngagedAt);

  // A reload is a new page session and counts again.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3200);
  const r2 = await report();
  assert.equal(r2.pageRequestCount, 3);
  assert.equal(r2.engagedViewCount, 2);
  assert.equal(r2.firstEngagedAt, r.firstEngagedAt, 'first engagement is never replaced');
  await page.close();
});
