/**
 * Strongly typed domain model for the AI visibility audit.
 *
 * The three commercial layers and their names are fixed by the business and
 * must not be renamed: VISIBLE, RECOMMENDED, CONVERSATIONAL.
 */

export const LAYERS = ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'] as const;
export type Layer = (typeof LAYERS)[number];

/** Result state for a single layer (and for diagnostics). */
export type LayerState = 'YES' | 'NO' | 'NOT_TESTED' | 'ERROR' | 'SIGN_IN_REQUIRED';

export type AuditStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'SIGN_IN_REQUIRED';

export const PROGRESS_STEPS = [
  'Understanding business',
  'Testing Visible',
  'Testing Recommended',
  'Testing Conversational',
  'Identifying competitors',
  'Preparing message',
] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export interface AuditRequest {
  business_name: string;
  website: string;
  location: string;
  /** Reserved for the future CRM (GoHighLevel) integration. */
  lead_id?: string;
  /** Optional: also ask the brand-specific diagnostic question after the unbiased tests. */
  include_brand_diagnostic?: boolean;
}

export interface Prospect {
  name: string;
  website: string;
  /** Registrable domain without protocol / www, e.g. "spproofing.co.uk". */
  domain: string;
  location: string;
  /** Words describing what the prospect does (e.g. "tiling"). Never identity evidence on their own. */
  serviceTerms?: string[];
}

/** What the business sells, derived from name + website + location. */
export interface BusinessUnderstanding {
  prospect: Prospect;
  /** Main commercial service, e.g. "roofing". */
  service: string;
  /** Plural provider noun used in discovery requests, e.g. "roofing companies". */
  providerNoun: string;
  /** Specific job the customer needs, e.g. "roof repairs". */
  customerRequirement: string;
  /** Natural first-person description of a real problem. */
  customerProblem: string;
  /** Geographic market, usually the supplied location. */
  market: string;
  /** How the service was determined. */
  source: 'website' | 'name' | 'fallback';
  /** Free-text notes from the website fetch (title etc.) for evidence. */
  notes: string[];
}

export interface LayerPrompt {
  layer: Layer;
  /** The opening message for a clean conversation. */
  opening: string;
}

/** A single assistant response as displayed on chatgpt.com. */
export interface ChatGptResponse {
  /** Visible text of the assistant message. */
  text: string;
  /** Rendered HTML of the assistant message (used to pick out bold names / links). */
  html: string;
  /** Absolute hrefs found in the message. */
  links: string[];
}

export interface ConversationTurn {
  index: number;
  prompt: string;
  response: ChatGptResponse;
  screenshotPath?: string;
  screenshotError?: string;
  conversationUrl?: string;
  askedAt: string;
  answeredAt: string;
}

export type EntityKind =
  | 'prospect'
  | 'competitor'
  | 'directory'
  | 'review_site'
  | 'marketplace'
  | 'informational'
  | 'unrelated'
  | 'uncertain';

/** Why a layer was marked YES: the exact user-visible snippet that named the prospect. */
export interface ProspectMatchEvidence {
  /** Exact visible text that matched (e.g. "LS-Tiling" or "ls-tiling.co.uk"). */
  snippet: string;
  /** Surrounding visible text for human verification against the screenshot. */
  context: string;
  /** Where in the rendered answer the snippet was found. */
  source: 'bold' | 'heading' | 'link' | 'list' | 'text';
  matchedBy: 'business_name' | 'name_alias' | 'visible_domain';
  turnIndex: number;
}

export interface EntityMention {
  /** Name as it appeared. */
  raw: string;
  /** Normalized key used to merge variants. */
  key: string;
  /** Display name (first / cleanest variant seen). */
  name: string;
  kind: EntityKind;
  layer: Layer | 'BRAND_DIAGNOSTIC';
  turnIndex: number;
  /** Domain if the mention came with a link. */
  domain?: string;
  /** Present only on kind === 'prospect'. */
  evidence?: ProspectMatchEvidence;
}

export interface LayerResult {
  layer: Layer;
  state: LayerState;
  prompt?: string;
  turns: ConversationTurn[];
  /** Entities identified in this layer's responses. */
  entities: EntityMention[];
  /**
   * Whether the PROSPECT itself was visibly surfaced. Independent of businessesSurfaced:
   * a layer can surface three competitors and still be prospectPresent = NO.
   */
  prospectPresent?: 'YES' | 'NO';
  /** Every genuine, user-visible named business surfaced in this layer (prospect included when present). */
  businessesSurfaced: string[];
  /** Required whenever state === 'YES': the visible text that proved the prospect was there. */
  prospectMatchEvidence?: ProspectMatchEvidence[];
  /** Names of businesses (genuine competitors) mentioned/recommended in this layer. */
  competitorsMentioned: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface BrandDiagnostic {
  state: LayerState;
  prompt: string;
  turn?: ConversationTurn;
  error?: string;
  note: 'Brand-specific diagnostic. Never counted as RECOMMENDED evidence.';
}

export interface Competitor {
  name: string;
  /** Layers in which this competitor appeared. */
  layers: Layer[];
  /** Number of distinct responses that mentioned it. */
  mentions: number;
  score: number;
  domain?: string;
}

export interface Evidence {
  visibleScreenshots: string[];
  recommendedScreenshots: string[];
  conversationalScreenshots: string[];
  brandDiagnosticScreenshots: string[];
}

export interface AuditRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  request: AuditRequest;
  status: AuditStatus;
  currentStep?: ProgressStep;
  completedSteps: ProgressStep[];
  understanding?: BusinessUnderstanding;
  layers: Record<Layer, LayerResult>;
  brandDiagnostic?: BrandDiagnostic;
  topCompetitors: Competitor[];
  outreachMessage?: string;
  evidence: Evidence;
  /** Human readable explanation when the audit is INCOMPLETE / SIGN_IN_REQUIRED. */
  incompleteReason?: string;
  provider: string;
}

/** Summary shape used by the UI / API. Mirrors the required structured output. */
export interface AuditSummary {
  id: string;
  status: AuditStatus;
  prospect: { name: string; location: string; service: string };
  VISIBLE: LayerState;
  RECOMMENDED: LayerState;
  CONVERSATIONAL: LayerState;
  topCompetitors: string[];
  outreachMessage?: string;
  evidence: Evidence;
  incompleteReason?: string;
}
