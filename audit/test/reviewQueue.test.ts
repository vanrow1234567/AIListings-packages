import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AuditEngine } from '../src/audit/engine.ts';
import { newAuditRecord } from '../src/audit/engine.ts';
import { createApp } from '../src/app.ts';
import { MockChatGptProvider } from '../src/chatgpt/mockProvider.ts';
import type { AuditRecord } from '../src/domain/types.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import {
  approveOutreachReview,
  confirmOutreachSent,
  refreshOutreachReview,
} from '../src/outreach/review.ts';
import { AuditStore } from '../src/persistence/store.ts';

const fixed = (iso: string) => () => iso;

test('review draft prefers a released COMPLETE prospect message and preserves the exact sent SMS', () => {
  const record = newAuditRecord(
    {
      business_name: 'Example Roofing Ltd',
      website: 'https://example.test',
      location: 'Southampton',
      phone: '+447700900123',
    },
    'mock',
    new Date('2026-09-06T20:00:00Z'),
  );
  record.status = 'COMPLETE';
  record.outreachMessage = 'Generated prospect message';
  record.competitorOutreachMessage = 'Alternative competitor-first message';

  refreshOutreachReview(record, fixed('2026-09-06T20:01:00.000Z'));
  assert.equal(record.outreachReview?.status, 'PENDING_REVIEW');
  assert.equal(record.outreachReview?.source, 'PROSPECT_AUDIT');
  assert.equal(record.outreachReview?.generatedMessage, 'Generated prospect message');
  assert.equal(record.outreachReview?.recipientPhone, '+447700900123');

  approveOutreachReview(
    record,
    'Operator edited exact SMS',
    '+447700900999',
    fixed('2026-09-06T20:02:00.000Z'),
  );
  assert.equal(record.outreachReview?.status, 'APPROVED');
  assert.equal(record.outreachReview?.approvedMessage, 'Operator edited exact SMS');
  assert.equal(record.outreachReview?.recipientPhone, '+447700900999');

  confirmOutreachSent(record, fixed('2026-09-06T20:03:00.000Z'));
  assert.equal(record.outreachReview?.status, 'SENT');
  assert.equal(record.outreachReview?.sentMessage, 'Operator edited exact SMS');
  assert.equal(record.outreachReview?.channel, 'SMS');

  record.outreachMessage = 'A later changed audit message';
  refreshOutreachReview(record, fixed('2026-09-06T20:04:00.000Z'));
  assert.equal(record.outreachReview?.status, 'SENT');
  assert.equal(record.outreachReview?.sentMessage, 'Operator edited exact SMS');
});

test('an incomplete audit may enter review only through its safe competitor-first message', () => {
  const record = newAuditRecord(
    {
      business_name: 'Example Ltd',
      website: 'https://example.test',
      location: 'Warrington',
    },
    'mock',
  );
  record.status = 'INCOMPLETE';
  record.competitorOutreachMessage = 'Safe competitor-only message';

  refreshOutreachReview(record, fixed('2026-09-06T20:05:00.000Z'));
  assert.equal(record.outreachReview?.source, 'COMPETITOR_FIRST');
  assert.equal(record.outreachReview?.generatedMessage, 'Safe competitor-only message');
});

let server: http.Server;
let base: string;
let store: AuditStore;

async function jsonFetch(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(base + pathname, init);
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

before(async () => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-review-'));
  store = new AuditStore(path.join(dir, 'audits'));
  const evidence = new EvidenceStore(path.join(dir, 'evidence'));
  const provider = new MockChatGptProvider({ conversations: [] });

  const fakeEngine = {
    run: async (record: AuditRecord) => record,
  } as unknown as AuditEngine;

  server = http.createServer(
    createApp({
      provider,
      engine: fakeEngine,
      store,
      evidence,
      uiFile: path.join(import.meta.dirname, '..', 'src', 'ui', 'index.html'),
      publicBaseUrl: 'https://reports.example.test',
      ctaUrl: 'https://packages.ailistings.co.uk/',
      now: () => new Date('2026-09-06T21:00:00.000Z'),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('HTTP review queue approves and manually records the exact sent payload', async () => {
  const record = newAuditRecord(
    {
      business_name: 'Queue Roofing Ltd',
      website: 'https://queue.example',
      location: 'Southampton',
      phone: '+447700900111',
    },
    'mock',
    new Date('2026-09-06T20:30:00.000Z'),
  );
  record.status = 'COMPLETE';
  record.outreachMessage = 'Generated queue message';
  refreshOutreachReview(record, fixed('2026-09-06T20:31:00.000Z'));
  await store.save(record);

  const queue = await jsonFetch('/api/review-queue');
  assert.equal(queue.status, 200);
  const item = queue.body.items.find((x: any) => x.id === record.id);
  assert.equal(item.review.status, 'PENDING_REVIEW');
  assert.equal(item.review.generatedMessage, 'Generated queue message');

  const approved = await jsonFetch(`/api/audits/${record.id}/review/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'Exact approved SMS',
      recipient_phone: '+447700900222',
    }),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.review.status, 'APPROVED');

  const sent = await jsonFetch(`/api/audits/${record.id}/review/confirm-sent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.review.status, 'SENT');
  assert.equal(sent.body.review.sentMessage, 'Exact approved SMS');
  assert.equal(sent.body.review.recipientPhone, '+447700900222');

  const stored = await store.get(record.id);
  assert.equal(stored?.outreachReview?.sentMessage, 'Exact approved SMS');
});

test('SMS cannot be marked sent without an approved recipient phone', async () => {
  const record = newAuditRecord(
    {
      business_name: 'No Phone Ltd',
      website: 'https://no-phone.example',
      location: 'Warrington',
    },
    'mock',
  );
  record.status = 'COMPLETE';
  record.outreachMessage = 'Message with no phone';
  refreshOutreachReview(record);
  await store.save(record);

  const approved = await jsonFetch(`/api/audits/${record.id}/review/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Message with no phone' }),
  });
  assert.equal(approved.status, 200);

  const sent = await jsonFetch(`/api/audits/${record.id}/review/confirm-sent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(sent.status, 400);
  assert.match(sent.body.error, /Recipient phone/i);
});

test('batch endpoint accepts up to 25 validated audits and preserves outreach recipient details', async () => {
  const response = await jsonFetch('/api/audits/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audits: [
        {
          business_name: 'Batch One Ltd',
          website: 'https://one.example',
          location: 'Manchester',
          phone: '+447700900001',
          contact_name: 'John',
        },
        {
          business_name: 'Batch Two Ltd',
          website: 'https://two.example',
          location: 'Liverpool',
          phone: '+447700900002',
        },
      ],
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.audits.length, 2);

  const first = await store.get(response.body.audits[0].id);
  assert.equal(first?.request.phone, '+447700900001');
  assert.equal(first?.request.contact_name, 'John');

  const tooMany = await jsonFetch('/api/audits/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audits: Array.from({ length: 26 }, (_, i) => ({
        business_name: `Business ${i}`,
        website: `https://business-${i}.example`,
        location: 'London',
      })),
    }),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /maximum of 25/i);
});
