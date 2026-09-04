import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AuditEngine, newAuditRecord, summarise } from './audit/engine.ts';
import { validateRequest } from './api/validate.ts';
import { PROJECT_ROOT, createProvider, createStores } from './config.ts';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const provider = createProvider(log);
const { evidence, store } = createStores();
const engine = new AuditEngine({ provider, evidence, store, log });

/** One live browser, one audit at a time. */
let queue: Promise<unknown> = Promise.resolve();
const connectState: { running: boolean; result?: boolean; startedAt?: string } = { running: false };

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile(path.join(PROJECT_ROOT, 'src', 'ui', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'POST' && url.pathname === '/api/audits') {
      const parsed = validateRequest(await readJson(req));
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const record = newAuditRecord(parsed.value, provider.name);
      await store.save(record);
      void enqueue(async () => {
        try {
          await engine.run(record);
        } catch (err) {
          log(`[${record.id}] engine failure: ${(err as Error).stack ?? err}`);
          record.status = 'INCOMPLETE';
          record.incompleteReason = `Unexpected failure: ${(err as Error).message}`;
          await store.save(record);
        }
      });
      return json(res, 202, { id: record.id, status: record.status });
    }
    if (req.method === 'GET' && url.pathname === '/api/audits') {
      const all = await store.list();
      return json(res, 200, all.map(summarise));
    }
    const auditMatch = url.pathname.match(/^\/api\/audits\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && auditMatch) {
      const record = await store.get(auditMatch[1] ?? '');
      if (!record) return json(res, 404, { error: 'Not found' });
      return json(res, 200, { summary: summarise(record), record });
    }
    if (req.method === 'GET' && url.pathname === '/api/chatgpt/status') {
      if (url.searchParams.get('check') === '1' && !connectState.running) {
        const signedIn = await enqueue(() => provider.isSignedIn());
        return json(res, 200, { signedIn, connect: connectState });
      }
      return json(res, 200, { connect: connectState });
    }
    if (req.method === 'POST' && url.pathname === '/api/chatgpt/connect') {
      if (!connectState.running) {
        connectState.running = true;
        connectState.startedAt = new Date().toISOString();
        delete connectState.result;
        void enqueue(async () => {
          try {
            connectState.result = await provider.connectForSignIn();
          } catch (err) {
            log(`connect failed: ${(err as Error).message}`);
            connectState.result = false;
          } finally {
            connectState.running = false;
          }
        });
      }
      return json(res, 202, { connect: connectState });
    }
    const evidenceMatch = url.pathname.match(/^\/evidence\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+\.png)$/);
    if (req.method === 'GET' && evidenceMatch) {
      const file = path.join(evidence.dir(evidenceMatch[1] ?? ''), evidenceMatch[2] ?? '');
      try {
        await stat(file);
      } catch {
        return json(res, 404, { error: 'Not found' });
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(await readFile(file));
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    log(`request failed: ${(err as Error).stack ?? err}`);
    json(res, 500, { error: (err as Error).message });
  }
});

const port = Number(process.env.PORT ?? 3210);
server.listen(port, () => log(`AIListings audit listening on http://localhost:${port} (provider: ${provider.name})`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await provider.dispose();
    process.exit(0);
  });
}
