import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightChatGptProvider } from './chatgpt/playwrightProvider.ts';
import { EvidenceStore } from './evidence/capture.ts';
import { AuditStore } from './persistence/store.ts';
import { HttpDestinationResolver } from './identity/destination.ts';
import { LinkIdentityResolver } from './identity/resolver.ts';
import type { IdentityProvider } from './identity/provider.ts';
import { ChainedIdentityProvider } from './identity/chain.ts';
import { LocalBusinessIdentityProvider } from './identity/localBusiness.ts';
import { DataForSeoMapsProvider } from './identity/dataforseo.ts';
import { prospectFactsSource } from './identity/prospectFacts.ts';
import { resolveAuditIntake } from './intake/resolve.ts';
import { OpenAiSemanticQaProvider } from './quality/semanticQa.ts';

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

/**
 * Identity chain: captured-link resolution first; a Google Business / Maps lookup only for
 * ambiguous candidates the link resolver left UNRESOLVED, and only when a vendor is configured
 * (AUDIT_LOCAL_BUSINESS_PROVIDER=dataforseo with DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).
 */
export function createIdentityProvider(log: (m: string) => void = () => undefined): IdentityProvider {
  const link = new LinkIdentityResolver(new HttpDestinationResolver({ timeoutMs: Number(process.env.AUDIT_IDENTITY_TIMEOUT_MS ?? 6000) }));
  const vendor = (process.env.AUDIT_LOCAL_BUSINESS_PROVIDER ?? '').toLowerCase();
  if (vendor === 'dataforseo') {
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    if (login && password) {
      const lookup = new DataForSeoMapsProvider({
        login,
        password,
        ...(process.env.DATAFORSEO_ENDPOINT ? { endpoint: process.env.DATAFORSEO_ENDPOINT } : {}),
        ...(process.env.DATAFORSEO_LOCATION_NAME ? { locationName: process.env.DATAFORSEO_LOCATION_NAME } : {}),
      });
      log('[identity] link resolver + DataForSEO Google Maps fallback enabled');
      return new ChainedIdentityProvider([link, new LocalBusinessIdentityProvider(lookup, prospectFactsSource())]);
    }
    log('[identity] AUDIT_LOCAL_BUSINESS_PROVIDER=dataforseo but DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD missing; link resolver only');
  } else if (vendor) {
    log(`[identity] unknown AUDIT_LOCAL_BUSINESS_PROVIDER "${vendor}"; link resolver only`);
  }
  return link;
}

export function createSemanticQaProvider(
  log: (m: string) => void = () => undefined,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log('[semantic-qa] OPENAI_API_KEY missing; production audits will fail closed before ChatGPT testing');
    return undefined;
  }
  const provider = new OpenAiSemanticQaProvider({
    apiKey,
    primaryModel: process.env.SEMANTIC_QA_PRIMARY_MODEL ?? 'gpt-5.6-luna',
    reviewModel: process.env.SEMANTIC_QA_REVIEW_MODEL ?? 'gpt-5.6-sol',
    ...(process.env.OPENAI_RESPONSES_ENDPOINT
      ? { endpoint: process.env.OPENAI_RESPONSES_ENDPOINT }
      : {}),
    log,
  });
  log('[semantic-qa] mandatory preflight + final release gates enabled');
  return provider;
}

export function createStores(): { evidence: EvidenceStore; store: AuditStore } {
  return {
    evidence: new EvidenceStore(path.join(DATA_DIR, 'evidence')),
    store: new AuditStore(path.join(DATA_DIR, 'audits')),
  };
}
/**
 * Resolves GHL audit intake into the strict AuditRequest expected by the core audit.
 * Supplied location wins; otherwise website facts are checked; DataForSEO Maps is
 * used only when configured. Failure to resolve location remains fail-closed.
 */
export function createGhlIntakeResolver(
  log: (m: string) => void = () => undefined,
) {
  const facts = prospectFactsSource();
  const vendor = (process.env.AUDIT_LOCAL_BUSINESS_PROVIDER ?? '').toLowerCase();

  if (vendor === 'dataforseo') {
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;

    if (login && password) {
      const maps = new DataForSeoMapsProvider({
        login,
        password,
        ...(process.env.DATAFORSEO_ENDPOINT
          ? { endpoint: process.env.DATAFORSEO_ENDPOINT }
          : {}),
        ...(process.env.DATAFORSEO_LOCATION_NAME
          ? { locationName: process.env.DATAFORSEO_LOCATION_NAME }
          : {}),
      });

      log('[ghl-intake] website facts + DataForSEO Maps location resolution enabled');

      return (body: unknown) =>
        resolveAuditIntake(body, {
          facts,
          maps,
        });
    }

    log(
      '[ghl-intake] DataForSEO configured but credentials missing; website-only location resolution',
    );
  } else if (vendor) {
    log(
      `[ghl-intake] unknown local-business provider "${vendor}"; website-only location resolution`,
    );
  }

  return (body: unknown) =>
    resolveAuditIntake(body, {
      facts,
    });
}