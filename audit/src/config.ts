import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightChatGptProvider } from './chatgpt/playwrightProvider.ts';
import { EvidenceStore } from './evidence/capture.ts';
import { AuditStore } from './persistence/store.ts';
import { HttpDestinationResolver } from './identity/destination.ts';
import { LinkIdentityResolver } from './identity/resolver.ts';
import type { IdentityProvider } from './identity/provider.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Project root (audit/) regardless of running from src/ or dist/. */
export const PROJECT_ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.AUDIT_DATA_DIR ?? path.join(PROJECT_ROOT, '.data');

export function createProvider(log: (m: string) => void): PlaywrightChatGptProvider {
  const channelEnv = process.env.AUDIT_BROWSER_CHANNEL ?? 'chrome';
  const channel = channelEnv === 'chrome' || channelEnv === 'msedge' ? channelEnv : undefined;
  return new PlaywrightChatGptProvider({
    userDataDir: process.env.AUDIT_PROFILE_DIR ?? path.join(DATA_DIR, 'chrome-profile'),
    headless: process.env.AUDIT_HEADLESS === '1',
    ...(channel ? { channel } : {}),
    temporaryChat: process.env.AUDIT_TEMPORARY_CHAT !== '0',
    responseTimeoutMs: Number(process.env.AUDIT_RESPONSE_TIMEOUT_MS ?? 180_000),
    navigationTimeoutMs: Number(process.env.AUDIT_NAV_TIMEOUT_MS ?? 60_000),
    log,
  });
}

export function createIdentityProvider(): IdentityProvider {
  return new LinkIdentityResolver(
    new HttpDestinationResolver({ timeoutMs: Number(process.env.AUDIT_IDENTITY_TIMEOUT_MS ?? 6000) }),
  );
}

export function createStores(): { evidence: EvidenceStore; store: AuditStore } {
  return {
    evidence: new EvidenceStore(path.join(DATA_DIR, 'evidence')),
    store: new AuditStore(path.join(DATA_DIR, 'audits')),
  };
}
