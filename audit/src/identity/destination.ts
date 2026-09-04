import type { DestinationResolver, DestinationResult } from './provider.ts';

export interface HttpDestinationResolverOptions {
  timeoutMs?: number;
  maxHops?: number;
  /** Allow loopback / private hosts (tests only). */
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
}

/** Query parameters that well-known redirectors use to carry the real destination. */
const REDIRECT_PARAMS = ['url', 'q', 'u', 'uddg', 'target', 'dest', 'destination', 'redirect', 'redirect_url', 'r', 'to'];
const REDIRECTOR_HOSTS = ['google.com', 'google.co.uk', 'bing.com', 'duckduckgo.com', 'chatgpt.com', 'openai.com', 'l.facebook.com', 'lm.facebook.com', 'linkedin.com', 't.co', 'bit.ly'];

export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || h.startsWith('[') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

/** Unwrap a redirector such as google.com/url?q=... without fetching it. */
export function unwrapRedirector(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = stripWww(u.hostname);
    if (!REDIRECTOR_HOSTS.some((r) => host === r || host.endsWith(`.${r}`))) return undefined;
    for (const key of REDIRECT_PARAMS) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch {
    /* not a URL */
  }
  return undefined;
}

function parseCanonical(html: string, baseUrl: string): string | undefined {
  const link = html.match(/<link\b[^>]*rel=["']?canonical["']?[^>]*>/i)?.[0] ?? html.match(/<link\b[^>]*href=["'][^"']+["'][^>]*rel=["']?canonical["']?[^>]*>/i)?.[0];
  const href = link?.match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function parseMetaRefresh(html: string, baseUrl: string): string | undefined {
  const m = html.match(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
  if (!m?.[1]) return undefined;
  try {
    return new URL(m[1], baseUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Follows a captured link to its real destination with an isolated HTTP request:
 * manual redirect handling (max hops), redirector unwrapping, a short timeout, a
 * bounded body read for rel=canonical / meta refresh, and no private-network access.
 * Never uses the ChatGPT browser session.
 */
export class HttpDestinationResolver implements DestinationResolver {
  private readonly timeoutMs: number;
  private readonly maxHops: number;
  private readonly allowPrivate: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpDestinationResolverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.maxHops = options.maxHops ?? 6;
    this.allowPrivate = options.allowPrivateHosts ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolve(url: string): Promise<DestinationResult> {
    const hops: string[] = [];
    let current = url;
    try {
      for (let i = 0; i <= this.maxHops; i++) {
        const unwrapped = unwrapRedirector(current);
        if (unwrapped && unwrapped !== current) {
          hops.push(current);
          current = unwrapped;
          continue;
        }
        const parsed = new URL(current);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, sourceUrl: url, error: `Unsupported scheme ${parsed.protocol}`, hops };
        if (!this.allowPrivate && isPrivateHost(parsed.hostname)) return { ok: false, sourceUrl: url, error: 'Destination is a private or local address', hops };
        if (i === this.maxHops) return { ok: false, sourceUrl: url, error: 'Too many redirects', hops };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res: Response;
        try {
          res = await this.fetchImpl(current, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': 'Mozilla/5.0 AIListingsAudit/0.1 identity-check', accept: 'text/html,*/*;q=0.8' },
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) return { ok: false, sourceUrl: url, error: `Redirect ${res.status} without Location`, hops };
          hops.push(current);
          current = new URL(loc, current).toString();
          await res.body?.cancel().catch(() => undefined);
          continue;
        }
        if (res.status >= 400) return { ok: false, sourceUrl: url, error: `HTTP ${res.status}`, hops };

        const type = res.headers.get('content-type') ?? '';
        let canonicalUrl: string | undefined;
        if (/text\/html|application\/xhtml/i.test(type) && res.body) {
          const html = await readHead(res, 131_072);
          const refresh = parseMetaRefresh(html, current);
          if (refresh && refresh !== current && i < this.maxHops) {
            hops.push(current);
            current = refresh;
            continue;
          }
          canonicalUrl = parseCanonical(html, current);
        } else {
          await res.body?.cancel().catch(() => undefined);
        }
        const finalHost = new URL(current).hostname.toLowerCase();
        const result: DestinationResult = { ok: true, sourceUrl: url, finalUrl: current, finalHost, hops };
        if (canonicalUrl) {
          result.canonicalUrl = canonicalUrl;
          const ch = hostOfUrl(canonicalUrl);
          if (ch) result.canonicalHost = ch;
        }
        return result;
      }
      return { ok: false, sourceUrl: url, error: 'Too many redirects', hops };
    } catch (err) {
      const e = err as Error;
      const msg = e.name === 'AbortError' ? `Timed out after ${this.timeoutMs}ms` : e.message || String(err);
      return { ok: false, sourceUrl: url, error: msg, hops };
    }
  }
}

async function readHead(res: Response, limit: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}
