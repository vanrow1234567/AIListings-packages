import type { ChatGptResponse } from '../domain/types.ts';
import { hostOf } from './normalise.ts';

/** A candidate business name pulled out of a displayed ChatGPT response. */
export interface Candidate {
  raw: string;
  /** Where it came from; used to weigh confidence. */
  source: 'bold' | 'heading' | 'link' | 'list' | 'text';
  domain?: string;
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

/**
 * Extract candidate business names from a rendered ChatGPT response.
 * Uses the HTML for bold names, headings, list items and links, then a
 * conservative regex over the visible text as a fallback.
 */
export function extractCandidates(response: ChatGptResponse): Candidate[] {
  const out: Candidate[] = [];
  const html = response.html || '';

  for (const m of html.matchAll(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    pushName(out, clean(m[2] ?? ''), 'bold');
  }
  for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    pushName(out, clean(m[1] ?? ''), 'heading');
  }
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = clean(m[1] ?? '');
    const lead = text.split(/\s[–—-]\s|:\s|\s\(|,\s|\.\s/)[0] ?? '';
    pushName(out, lead, 'list');
  }
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1] ?? '';
    const anchor = clean(m[2] ?? '');
    const domain = hostOf(href);
    if (anchor && domain && !/^https?:\/\//i.test(anchor)) {
      pushName(out, anchor, 'link', domain);
    }
  }
  for (const href of response.links) {
    const domain = hostOf(href);
    if (domain) out.push({ raw: domain, source: 'link', domain });
  }

  // Visible-text fallback: Capitalised runs of 1–5 words ending in a trade/legal word, e.g. "Solent Roofing Ltd".
  const textRe =
    /\b([A-Z][A-Za-z0-9&'’.-]*(?:[ \t]+(?:[A-Z][A-Za-z0-9&'’.-]*|&|and|of))*[ \t]+(?:Roofing|Roofers|Roofer|Roofs|Plumbing|Plumbers|Heating|Electrical|Electricians|Builders|Building|Construction|Landscapes|Landscaping|Gardens|Cleaning|Cleaners|Locksmiths|Dental|Dentists|Accountants|Solicitors|Estate Agents|Motors|Garage|Removals|Services|Contractors|Ltd|Limited|Group|Co\.?))\b/g;
  const text = response.text || '';
  for (const m of text.matchAll(textRe)) {
    pushName(out, m[1] ?? '', 'text');
  }
  return out;
}

function pushName(out: Candidate[], raw: string, source: Candidate['source'], domain?: string): void {
  const name = raw.replace(/[*_`"“”]+/g, '').replace(/\s+/g, ' ').replace(/[:.,;–—-]+$/, '').trim();
  if (!looksLikeName(name)) return;
  const c: Candidate = { raw: name, source };
  if (domain) c.domain = domain;
  out.push(c);
}

export function looksLikeName(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  if (!/^[A-Z0-9]/.test(name)) return false;
  const first = words[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (STOP_STARTS.has(first) && words.length <= 2) return false;
  if (GENERIC_HEADINGS.test(name)) return false;
  // Sentences are not names.
  if (/\b(is|are|should|can|will|your|you|the|a)\b/i.test(name) && words.length > 3) return false;
  if (/[?!]/.test(name)) return false;
  return true;
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
