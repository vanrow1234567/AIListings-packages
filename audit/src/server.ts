import http from 'node:http';
import path from 'node:path';
import { AuditEngine } from './audit/engine.ts';
import { createApp } from './app.ts';
import { PROJECT_ROOT, createGhlIntakeResolver, createIdentityProvider, createProvider, createSemanticQaProvider, createStores } from './config.ts';
import { createGhlIngress } from './ghl/ingress.ts';
import { createPublicBoundary } from './public/boundary.ts';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const internalPort = Number(process.env.PORT ?? 3210);
const publicPort = Number(process.env.PUBLIC_PORT ?? 3211);
const ghlPort = Number(process.env.GHL_PORT ?? 3212);

const provider = createProvider(log);
const { evidence, store, evaluation } = createStores();

const semanticQa = createSemanticQaProvider(log);

const engine = new AuditEngine({
  provider,
  evidence,
  store,
  identity: createIdentityProvider(log),
  ...(semanticQa ? { semanticQa } : {}),
  semanticQaRequired: process.env.SEMANTIC_QA_REQUIRED !== '0',
  visualQaRequired: process.env.VISION_QA_REQUIRED !== '0',
  evaluation,
  log,
});

const app = createApp({
  provider,
  engine,
  store,
  evidence,
  uiFile: path.join(PROJECT_ROOT, 'src', 'ui', 'index.html'),
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${publicPort}`,
  ctaUrl:
    process.env.PUBLIC_CTA_URL ?? 'https://packages.ailistings.co.uk/',
  log,
  resolveGhlIntake: createGhlIntakeResolver(log),
});

const internalServer = http.createServer(app);
const publicServer = http.createServer(createPublicBoundary(app));

internalServer.listen(internalPort, '127.0.0.1', () =>
  log(
    `AIListings internal audit listening on http://127.0.0.1:${internalPort} (provider: ${provider.name})`,
  ),
);

publicServer.listen(publicPort, '127.0.0.1', () =>
  log(
    `AIListings public reports listening on http://127.0.0.1:${publicPort}`,
  ),
);

const ghlToken = process.env.GHL_INGRESS_TOKEN;

if (ghlToken) {
  const ghlServer = http.createServer(createGhlIngress(app, ghlToken));

  ghlServer.listen(ghlPort, '127.0.0.1', () =>
    log(
      `AIListings GHL ingress listening on http://127.0.0.1:${ghlPort}`,
    ),
  );
} else {
  log('[ghl] GHL_INGRESS_TOKEN missing; GHL ingress disabled');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await provider.dispose();
    process.exit(0);
  });
}