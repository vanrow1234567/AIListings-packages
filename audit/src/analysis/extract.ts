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

/** Verbs that open an instruction or piece of advice rather than a business name. */
const INSTRUCTION_STARTS = new Set([
  'work', 'get', 'ask', 'check', 'look', 'make', 'call', 'contact', 'consider', 'use', 'try', 'choose', 'find',
  'compare', 'confirm', 'agree', 'measure', 'budget', 'plan', 'prepare', 'book', 'hire', 'avoid', 'keep', 'allow',
  'expect', 'request', 'read', 'take', 'start', 'decide', 'think', 'remember', 'ensure', 'dont', 'do', 'be', 'set',
  'give', 'let', 'pay', 'put', 'see', 'send', 'speak', 'talk', 'tell', 'walk', 'watch', 'write', 'go', 'have',
  'know', 'learn', 'leave', 'note', 'pick', 'shop', 'visit', 'wait', 'want', 'search', 'ring', 'phone', 'email',
]);
/** Prepositions / determiners that open a phrase ("For tiles themselves", "If the grout...") rather than a name. */
const PHRASE_STARTS = new Set(['for', 'if', 'when', 'your', 'a', 'an', 'in', 'on', 'at', 'with', 'about', 'before', 'after', 'while', 'once', 'because', 'why', 'what', 'how', 'where', 'who', 'which', 'whether', 'unless', 'until', 'although', 'though', 'as', 'to', 'from', 'by', 'of', 'this', 'that', 'these', 'those', 'there', 'here', 'it', 'its', 'my', 'our', 'their', 'his', 'her', 'some', 'any', 'no', 'not', 'most', 'many', 'more', 'less', 'all', 'each', 'every', 'both', 'either', 'neither', 'other', 'another', 'such', 'then', 'so', 'yes', 'ok', 'okay', 'also', 'always', 'never', 'usually', 'often', 'sometimes', 'typically', 'generally']);
/** Lowercase words that legitimately appear inside a business name. */
const NAME_JOINERS = new Set(['and', 'of', 'the', '&', 'for', 'at', 'in', 'on', 'by', 'to', 'de', 'du', 'la', 'le', 'von', 'van']);

/** "Get 2–3 quotes", "4.9 stars", "(120 reviews)", "3 quotes" ... counts and ratings are not names. */
export function looksLikeCountOrRating(name: string): boolean {
  return (
    /\d\s*[–—-]\s*\d/.test(name) ||
    /\b\d+(?:\.\d+)?\s*(?:stars?|reviews?|ratings?|quotes?|years?|days?|hours?|weeks?|months?|%|£|\$|★|⭐)/i.test(name) ||
    /^\(?\d+(?:\.\d+)?\)?$/.test(name) ||
    /[★⭐]/.test(name)
  );
}

/** Instructions and advice ("Work out exactly what needs tiling") and prose fragments ("For tiles themselves"). */
export function looksLikeInstructionOrPhrase(name: string): boolean {
  const words = name.split(/\s+/);
  const first = words[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (INSTRUCTION_STARTS.has(first)) return true;
  if (PHRASE_STARTS.has(first) && !(first === 'the' && words.length <= 4)) return true;
  // Business names are Title Case apart from joiners; two or more other lowercase words make it a phrase.
  const lowercaseWords = words.slice(1).filter((w) => /^[a-z]/.test(w) && !NAME_JOINERS.has(w.toLowerCase()));
  if (lowercaseWords.length >= 2) return true;
  if (lowercaseWords.length === 1 && words.length <= 3 && !/\b(ltd|limited|plc|llp|co)\b/i.test(name)) {
    // "For tiles themselves" is caught above; "SDB tiling" (one lowercase trade word) stays a plausible name.
    const w = lowercaseWords[0]?.toLowerCase() ?? '';
    if (/^(themselves|yourself|itself|needs|need|quotes|quote|first|only|too|also|again|now|later|here|there)$/.test(w)) return true;
  }
  if (/\b(you|your|we|our|i|me|us|they|them|should|must|need|needs|will|would|could|can|may|might|shall|exactly|whether|what|how|why)\b/i.test(name)) return true;
  return false;
}

/** Section headings ChatGPT uses to organise advice ("Tiler recommendations", "Cost guide", "Next steps"). */
const SECTION_WORDS =
  /\b(recommendations?|options?|guide|guides|tips?|advice|checklist|summary|overview|faqs?|notes?|steps?|questions?|considerations?|factors?|signs?|causes?|pros|cons|verdict|conclusion|takeaways?|alternatives?|approach|approaches|comparison|examples?|sources?|references?|disclaimer|caveats?)\b/i;

export function looksLikeName(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  if (looksLikeCountOrRating(name)) return false;
  if (SECTION_WORDS.test(name) && !/\b(ltd|limited|plc|llp|co|company|group)\b/i.test(name)) return false;
  if (!isBareDomain(name) && looksLikeInstructionOrPhrase(name)) return false;
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
