import type { ChatGptResponse } from '../domain/types.ts';
import { TRADE_WORDS } from '../business/catalogue.ts';
import { hostOf } from './normalise.ts';

/** A candidate business name pulled out of a displayed ChatGPT response. */
export interface Candidate {
  raw: string;
  /** Where it came from; used to weigh confidence. */
  source: 'bold' | 'heading' | 'link' | 'list' | 'text';
  /** Domain of the anchor this visible name linked to, if any. Supporting information only. */
  domain?: string;
  /** Surrounding visible text, for human verification against the screenshot. */
  context: string;
}

const STOP_STARTS = new Set(
  [
    'if', 'when', 'the', 'you', 'your', 'here', 'these', 'those', 'what', 'why', 'how', 'it', 'this', 'that',
    'for', 'in', 'on', 'get', 'check', 'ask', 'look', 'make', 'call', 'contact', 'consider', 'use', 'try',
    'step', 'option', 'pros', 'cons', 'tip', 'tips', 'note', 'important', 'yes', 'no', 'first', 'second',
    'third', 'next', 'then', 'finally', 'also', 'i', 'we', 'my', 'our', 'a', 'an', 'to', 'do', 'don', 'be',
    'sure', 'always', 'never', 'before', 'after', 'while', 'once', 'because', 'however', 'or', 'and', 'but',
    'short', 'long', 'quick', 'summary', 'bottom', 'key', 'main', 'common', 'typical', 'good', 'bad',
    'red', 'green', 'warning', 'signs', 'sign', 'cost', 'costs', 'price', 'prices', 'why', 'where',
    'temporary', 'chatgpt', 'openai', 'google', 'search', 'searching',
  ],
);

const GENERIC_HEADINGS =
  /^(what|why|how|when|where|who|should|can|could|do|does|is|are|will|would|repair|replace|replacement|repairs|leak|leaking|chimney|flashing|roof|roofing|tiles|felt|gutter|guttering|options?|summary|conclusion|next steps?|step \d+|\d+\.?|pros?|cons?|costs?|red flags?|questions? to ask|things to (check|look for)|checklist|final (thoughts?|tip)|bottom line|tl;?dr|in short|quick (answer|take)|my (advice|recommendation|take)|recommendation|recommendations|local (options|roofers|companies|tradespeople|businesses)|how to (choose|find|pick)|what to (do|expect)|immediate (steps|actions)|likely causes?|possible causes?|diagnosis|urgency|safety first)\b/i;

const TRADE_ALTERNATION = [...new Set([...TRADE_WORDS, 'services', 'contractors', 'ltd', 'limited', 'group', 'co'])]
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join('|');
const TEXT_NAME_RE = new RegExp(
  `\\b([A-Z][A-Za-z0-9&'’.-]*(?:[ \\t]+(?:[A-Z][A-Za-z0-9&'’.-]*|&|and|of))*[ \\t]+(?:${TRADE_ALTERNATION}|Co\\.))\\b`,
  'g',
);

/**
 * Extract candidate business names from a rendered ChatGPT response.
 *
 * Evidence rule: a candidate must be user-visible. Bold names, headings, list
 * leads and link anchor TEXT are taken from the HTML, then every candidate is
 * checked against the visible text (innerText). Raw hrefs are never candidates:
 * map tiles, citations and tracking links are infrastructure the user does not
 * read as a business.
 */
export function extractCandidates(response: ChatGptResponse): Candidate[] {
  const out: Candidate[] = [];
  const html = response.html || '';
  const text = response.text || '';

  for (const m of html.matchAll(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    pushName(out, clean(m[2] ?? ''), 'bold', text);
  }
  for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    pushName(out, clean(m[1] ?? ''), 'heading', text);
  }
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const liText = clean(m[1] ?? '');
    const lead = liText.split(/\s[–—-]\s|:\s|\s\(|,\s|\.\s/)[0] ?? '';
    pushName(out, lead, 'list', text);
  }
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1] ?? '';
    const anchor = clean(m[2] ?? '');
    const domain = hostOf(href);
    if (!anchor || /^https?:\/\//i.test(anchor)) continue;
    pushName(out, anchor, 'link', text, domain);
  }
  for (const m of text.matchAll(TEXT_NAME_RE)) {
    pushName(out, m[1] ?? '', 'text', text);
  }
  return out;
}

function pushName(out: Candidate[], raw: string, source: Candidate['source'], visibleText: string, domain?: string): void {
  const name = raw.replace(/[*_`"“”]+/g, '').replace(/\s+/g, ' ').replace(/[:.,;–—-]+$/, '').trim();
  if (!looksLikeName(name)) return;
  const context = visibleContext(visibleText, name);
  // Not in the visible text (hidden element, alt text, tooltip): not evidence the user saw it.
  if (context === undefined) return;
  const c: Candidate = { raw: name, source, context };
  if (domain) c.domain = domain;
  out.push(c);
}

/** Case-insensitive, whitespace-tolerant lookup of `name` in the visible text; returns surrounding context. */
export function visibleContext(visibleText: string, name: string): string | undefined {
  if (!visibleText) return undefined;
  const pattern = name
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const m = new RegExp(pattern, 'i').exec(visibleText);
  if (!m) return undefined;
  const start = Math.max(0, m.index - 60);
  const end = Math.min(visibleText.length, m.index + m[0].length + 60);
  return visibleText.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function looksLikeName(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  // Names start with a capital or digit; bare domains ("ls-tiling.co.uk") are allowed because a
  // visibly presented website is admissible prospect evidence (they are never competitors, see classify).
  if (!/^[A-Z0-9]/.test(name) && !isBareDomain(name)) return false;
  const first = words[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (STOP_STARTS.has(first) && words.length <= 2) return false;
  if (GENERIC_HEADINGS.test(name)) return false;
  if (/\b(is|are|should|can|will|your|you|the|a)\b/i.test(name) && words.length > 3) return false;
  if (/[?!]/.test(name)) return false;
  return true;
}

export function isBareDomain(s: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(s.trim());
}

function clean(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
