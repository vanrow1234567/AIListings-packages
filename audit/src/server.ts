import http from 'node:http';
import path from 'node:path';
import { AuditEngine } from './audit/engine.ts';
import { createApp } from './app.ts';
import { PROJECT_ROOT, createIdentityProvider, createProvider, createStores } from './config.ts';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const port = Number(process.env.PORT ?? 3210);
const provider = createProvider(log);
const { evidence, store } = createStores();
const engine = new AuditEngine({ provider, evidence, store, identity: createIdentityProvider(), log });

const server = http.createServer(
  createApp({
    provider,
    engine,
    store,
    evidence,
    uiFile: path.join(PROJECT_ROOT, 'src', 'ui', 'index.html'),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    ctaUrl: process.env.PUBLIC_CTA_URL ?? 'https://packages.ailistings.co.uk/',
    log,
  }),
);

server.listen(port, () => log(`AIListings audit listening on http://localhost:${port} (provider: ${provider.name})`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await provider.dispose();
    process.exit(0);
  });
}
