import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEngine } from './audit/engine.ts';
import type { AuditRequest } from './domain/types.ts';
import type { IntakeResult } from './intake/resolve.ts';
import { newAuditRecord, summarise } from './audit/engine.ts';
import { validateRequest } from './api/validate.ts';
import type { ChatGptProvider } from './chatgpt/provider.ts';
import type { PlaywrightChatGptProvider } from './chatgpt/playwrightProvider.ts';
import type { EvidenceStore } from './evidence/capture.ts';
import type { AuditStore } from './persistence/store.ts';
import { publicEvidenceFiles, renderPublicReport } from './public/report.ts';
import { isPubliclyAvailable, recordCtaClick, recordEngagement, recordPageRequest, trackingState } from './public/tracking.ts';

export interface AppDeps {
  provider: ChatGptProvider & Partial<Pick<PlaywrightChatGptProvider, 'connectForSignIn'>>;
  engine: AuditEngine;
  store: AuditStore;
  evidence: EvidenceStore;
  uiFile: string;
  /** Absolute base used to build public report URLs, e.g. https://audit.ailistings.co.uk */
  publicBaseUrl: string;
  /** Where the public CTA sends the prospect. */
  ctaUrl: string;
  now?: () => Date;
  log?: (m: string) => void;
  /** Used only for requests authenticated through the GHL ingress. */
  resolveGhlIntake?: (body: unknown) => Promise<IntakeResult>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, status: number, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const NOT_FOUND_HTML = '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;margin:40px">This report link is not valid.</p>';

/** Builds the request listener. Internal routes under /api and /, prospect-facing routes under /a/:token. */
export function createApp(deps: AppDeps): http.RequestListener {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  const connectState: { running: boolean; result?: boolean; startedAt?: string } = { running: false };

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  const summary = (record: Parameters<typeof summarise>[0]) => summarise(record, deps.publicBaseUrl);

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      // ---------- prospect-facing public report ----------
      const engaged = url.pathname.match(/^\/a\/([A-Za-z0-9_-]+)\/engaged$/);
      if (engaged && req.method === 'POST') {
        const record = await deps.store.findByPublicToken(engaged[1] ?? '');
        if (!isPubliclyAvailable(record)) return json(res, 404, { ok: false });
        let session = '';
        try {
          const body = (await readJson(req)) as { session?: unknown };
          session = typeof body.session === 'string' ? body.session : '';
        } catch {
          return json(res, 400, { ok: false });
        }
        const outcome = recordEngagement(record.publicReport, session, now);
        if (outcome === 'counted') await deps.store.save(record);
        return json(res, outcome === 'unknown_session' ? 400 : 200, { ok: outcome !== 'unknown_session', outcome });
      }
      const pub = url.pathname.match(/^\/a\/([A-Za-z0-9_-]+)(?:\/(cta|evidence\/([A-Za-z0-9_.-]+\.png)))?$/);
      if (pub && req.method === 'GET') {
        const record = await deps.store.findByPublicToken(pub[1] ?? '');
        if (!isPubliclyAvailable(record)) return html(res, 404, NOT_FOUND_HTML);
        const action = pub[2];
        if (!action) {
          const session = recordPageRequest(record.publicReport, now);
          await deps.store.save(record);
          return html(res, 200, renderPublicReport(record, { token: record.publicReport.token, session }));
        }
        if (action === 'cta') {
          recordCtaClick(record.publicReport, now);
          await deps.store.save(record);
          res.writeHead(302, { location: deps.ctaUrl, 'cache-control': 'no-store' });
          return res.end();
        }
        const file = pub[3] ?? '';
        if (!publicEvidenceFiles(record).includes(file)) return html(res, 404, NOT_FOUND_HTML);
        const full = path.join(deps.evidence.dir(record.id), file);
        try {
          await stat(full);
        } catch {
          return html(res, 404, NOT_FOUND_HTML);
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' });
        return res.end(await readFile(full));
      }

      // ---------- internal UI + API ----------
      if (req.method === 'GET' && url.pathname === '/') {
        return html(res, 200, await readFile(deps.uiFile));
      }
      if (req.method === 'POST' && url.pathname === '/api/audits') {
        const body = await readJson(req);
        let auditRequest: AuditRequest;

        if (
          req.headers['x-ailistings-ghl-ingress'] === '1' &&
          deps.resolveGhlIntake
        ) {
          const resolved = await deps.resolveGhlIntake(body);

          if (!resolved.ok) {
            return json(res, resolved.status, {
              error: resolved.error,
              message: resolved.message,
            });
          }

          auditRequest = resolved.value;
        } else {
          const parsed = validateRequest(body);

          if (!parsed.ok) {
            return json(res, 400, { error: parsed.error });
          }

          auditRequest = parsed.value;
        }

        const record = newAuditRecord(auditRequest, deps.provider.name, now());
        await deps.store.save(record);
        void enqueue(async () => {
          try {
            await deps.engine.run(record);
          } catch (err) {
            log(`[${record.id}] engine failure: ${(err as Error).stack ?? err}`);
            record.status = 'INCOMPLETE';
            record.incompleteReason = `Unexpected failure: ${(err as Error).message}`;
            await deps.store.save(record);
          }
        });
        return json(res, 202, { id: record.id, status: record.status });
      }
      if (req.method === 'GET' && url.pathname === '/api/audits') {
        return json(res, 200, (await deps.store.list()).map(summary));
      }
      const tracking = url.pathname.match(/^\/api\/audits\/([a-zA-Z0-9_-]+)\/tracking$/);
      if (req.method === 'GET' && tracking) {
        const record = await deps.store.get(tracking[1] ?? '');
        if (!record) return json(res, 404, { error: 'Not found' });
        return json(res, 200, trackingState(record, deps.publicBaseUrl));
      }
      const auditMatch = url.pathname.match(/^\/api\/audits\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && auditMatch) {
        const record = await deps.store.get(auditMatch[1] ?? '');
        if (!record) return json(res, 404, { error: 'Not found' });
        return json(res, 200, { summary: summary(record), record });
      }
      if (req.method === 'GET' && url.pathname === '/api/chatgpt/status') {
        if (url.searchParams.get('check') === '1' && !connectState.running) {
          const signedIn = await enqueue(() => deps.provider.isSignedIn());
          return json(res, 200, { signedIn, connect: connectState });
        }
        return json(res, 200, { connect: connectState });
      }
      if (req.method === 'POST' && url.pathname === '/api/chatgpt/connect') {
        if (!connectState.running) {
          connectState.running = true;
          connectState.startedAt = now().toISOString();
          delete connectState.result;
          void enqueue(async () => {
            try {
              connectState.result = deps.provider.connectForSignIn ? await deps.provider.connectForSignIn() : await deps.provider.isSignedIn();
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
        const file = path.join(deps.evidence.dir(evidenceMatch[1] ?? ''), evidenceMatch[2] ?? '');
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
      if (url.pathname.startsWith('/a/')) return html(res, 500, '<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;margin:40px">Something went wrong loading this report. Please try again shortly.</p>');
      json(res, 500, { error: (err as Error).message });
    }
  };
}
