import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGhlIngress } from '../src/ghl/ingress.ts';

const TOKEN = 'test-secret-token';

async function startServer() {
  let forwarded = 0;
  let forwardedUrl = '';

  const app: http.RequestListener = (req, res) => {
    forwarded += 1;
    forwardedUrl = req.url ?? '';
    res.writeHead(202, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
  };

  const server = http.createServer(
    createGhlIngress(app, TOKEN),
  );

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );

  const port = (server.address() as AddressInfo).port;

  return {
    server,
    base: `http://127.0.0.1:${port}`,
    forwarded: () => forwarded,
    forwardedUrl: () => forwardedUrl,
  };
}

test('GHL ingress rejects everything except POST /ghl/audits', async () => {
  const ctx = await startServer();

  try {
    for (const [method, path] of ([
      ['GET', '/ghl/audits'],
      ['POST', '/'],
      ['POST', '/api/audits'],
      ['POST', '/ghl/other'],
    ] as const)) {
      const response = await fetch(`${ctx.base}${path}`, {
        method,
      });

      assert.equal(response.status, 404, `${method} ${path}`);
    }

    assert.equal(ctx.forwarded(), 0);
  } finally {
    await new Promise<void>((resolve) =>
      ctx.server.close(() => resolve()),
    );
  }
});

test('GHL ingress rejects missing and incorrect bearer tokens', async () => {
  const ctx = await startServer();

  try {
    const missing = await fetch(`${ctx.base}/ghl/audits`, {
      method: 'POST',
    });

    assert.equal(missing.status, 401);

    const wrong = await fetch(`${ctx.base}/ghl/audits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
      },
    });

    assert.equal(wrong.status, 401);
    assert.equal(ctx.forwarded(), 0);
  } finally {
    await new Promise<void>((resolve) =>
      ctx.server.close(() => resolve()),
    );
  }
});

test('valid bearer token forwards only to internal audit creation route', async () => {
  const ctx = await startServer();

  try {
    const response = await fetch(`${ctx.base}/ghl/audits`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        business_name: 'Example Ltd',
        website: 'https://example.com',
        location: 'London',
        lead_id: 'lead-123',
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(ctx.forwarded(), 1);
    assert.equal(ctx.forwardedUrl(), '/api/audits');
  } finally {
    await new Promise<void>((resolve) =>
      ctx.server.close(() => resolve()),
    );
  }
});