import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPublicBoundary,
  isAllowedPublicRequest,
} from '../src/public/boundary.ts';

const TOKEN = 'A'.repeat(43);

test('public boundary allows only tokenised prospect-report request shapes', () => {
  assert.equal(isAllowedPublicRequest('GET', `/a/${TOKEN}`), true);
  assert.equal(isAllowedPublicRequest('GET', `/a/${TOKEN}/cta`), true);
  assert.equal(
    isAllowedPublicRequest(
      'GET',
      `/a/${TOKEN}/evidence/visible-1-1.png`,
    ),
    true,
  );
  assert.equal(
    isAllowedPublicRequest('POST', `/a/${TOKEN}/engaged`),
    true,
  );

  for (const pathname of [
    '/',
    '/api/audits',
    '/api/chatgpt/status',
    '/api/chatgpt/connect',
    '/evidence/some-audit/visible-1-1.png',
    `/a/${'A'.repeat(42)}`,
    `/a/${'A'.repeat(44)}`,
  ]) {
    assert.equal(
      isAllowedPublicRequest('GET', pathname),
      false,
      pathname,
    );
  }

  assert.equal(
    isAllowedPublicRequest('POST', `/a/${TOKEN}`),
    false,
  );
  assert.equal(
    isAllowedPublicRequest('GET', `/a/${TOKEN}/engaged`),
    false,
  );
});

test('public listener rejects internal routes before they reach the app', async () => {
  let forwarded = 0;

  const app: http.RequestListener = (_req, res) => {
    forwarded += 1;
    res.writeHead(204);
    res.end();
  };

  const server = http.createServer(createPublicBoundary(app));

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );

  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    for (const pathname of [
      '/',
      '/api/audits',
      '/api/chatgpt/status',
      '/api/chatgpt/connect',
      '/evidence/audit/file.png',
    ]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 404, pathname);
    }

    assert.equal(
      forwarded,
      0,
      'no internal request reached the application handler',
    );

    const publicReport = await fetch(`${base}/a/${TOKEN}`);
    assert.equal(publicReport.status, 204);
    assert.equal(forwarded, 1);
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
  }
});