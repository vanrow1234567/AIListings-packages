/**
 * Strongly typed domain model for the AI visibility audit.
 *
 * The three commercial layers and their names are fixed by the business and
 * must not be renamed: VISIBLE, RECOMMENDED, CONVERSATIONAL.
 */

export const LAYERS = ['VISIBLE', 'RECOMMENDED', 'CONVERSATIONAL'] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Result state for a single layer (and for diagnostics).
 * IDENTITY_UNRESOLVED: ChatGPT answered, the prospect was not proven present, but a surfaced
 * result that could plausibly be the prospect could not be proven either way. Non-conclusive:
 * it is never reported as NO and makes the audit INCOMPLETE.
 */
export type LayerState = 'YES' | 'NO' | 'NOT_TESTED' | 'ERROR' | 'SIGN_IN_REQUIRED' | 'IDENTITY_UNRESOLVED' | 'EVIDENCE_DISPUTED';

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
  /** Optional hint from CRM/lead form. Never treated as proof; semantic QA verifies it against the website. */
  industry_hint?: string;
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
  /** Facts extracted independently from the prospect's own website; source of truth for identity checks. */
  identityFacts?: ProspectIdentityFacts;
}

/** What the prospect's supplied website says about itself. Nothing here is inferred. */
export interface ProspectIdentityFacts {
  /** Where the facts came from: the fetched website, or nothing (fetch failed / no website). */
  source: 'website' | 'none';
  canonicalDomain: string;
  businessName?: string;
  /** Normalised UK phone numbers (digits, national format e.g. 07700900123). */
  phones: string[];
  streetAddress?: string;
  locality?: string;
  postcode?: string;
  /** schema.org types found in JSON-LD, e.g. ["LocalBusiness", "HomeAndConstructionBusiness"]. */
  schemaTypes: string[];
  fetchedAt: string;
  error?: string;
}

/** Evidence recorded when a public local-business / Google Business / Maps lookup was used. */
export interface LocalBusinessLookupEvidence {
  lookupQuery: string;
  provider: string;
  returnedBusinessName?: string;
  returnedWebsite?: string;
  returnedPhone?: string;
  returnedAddress?: string;
  returnedLocation?: string;
  providerBusinessId?: string;
  prospectPhone?: string[];
  prospectAddress?: string;
  /** Which fields proved (or disproved) identity: website | phone | address. Empty when nothing did. */
  matchedFields: string[];
  /** Listings the provider returned whose name did not correspond to the candidate (ignored). */
  ignoredListings?: number;
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
  source: 'website' | 'name' | 'fallback' | 'semantic';
  /** Free-text notes from the website fetch (title etc.) for evidence. */
  notes: string[];
  /** Present when a semantic model verified the classification. */
  semanticConfidence?: number;
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
  /** Internal evidence crop of the latest assistant response used by the visual witness. */
  visualScreenshotPath?: string;
  /** Independent multimodal reading of what a human sees in the ChatGPT screenshot. */
  visualReview?: SemanticVisualReview;
  /** A missing / failed visual witness is non-conclusive when visual QA is required. */
  visualReviewError?: string;
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
  source: 'bold' | 'heading' | 'link' | 'list' | 'text' | 'map';
  matchedBy: 'business_name' | 'name_with_domain' | 'name_alias' | 'visible_domain' | 'resolved_destination';
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
  /** Full href of the visible link, when there was one. */
  href?: string;
  /** Present only on kind === 'prospect'. */
  evidence?: ProspectMatchEvidence;
}

/**
 * Identity resolution: "can we PROVE this surfaced result belongs to the prospect?"
 * UNRESOLVED never becomes prospectPresent = YES.
 */
export type ResolutionState = 'CONFIRMED_PROSPECT' | 'CONFIRMED_OTHER_BUSINESS' | 'UNRESOLVED';

export type ResolutionMethod =
  | 'name_variant' // accepted business-name variant / alias
  | 'visible_domain' // the prospect's domain shown as text
  | 'captured_link' // the visible link's own host already matched (or clearly did not)
  | 'redirect_follow' // followed redirects / tracking URL to a final host
  | 'canonical' // rel=canonical on the final page named the host
  | 'no_link' // nothing to resolve against
  | 'fetch_failed' // network error, timeout, blocked destination
  | 'local_business_website' // Google Business / Maps listing website compared with the prospect domain
  | 'local_business_phone' // listing phone matched a phone taken independently from the prospect website
  | 'local_business_address' // listing address uniquely matched the prospect website address
  | 'local_business_lookup' // lookup ran but proved nothing (no match / conflict / failure)
  | 'external_provider'; // reserved for other identity providers

export interface IdentityResolution {
  candidateName: string;
  candidateContext: string;
  sourceUrl?: string;
  finalUrl?: string;
  canonicalUrl?: string;
  prospectDomain: string;
  matchedDomain?: string;
  resolutionMethod: ResolutionMethod;
  resolutionState: ResolutionState;
  layer: Layer | 'BRAND_DIAGNOSTIC';
  turnIndex: number;
  provider: string;
  error?: string;
  resolvedAt: string;
  /** Present when a local-business lookup was consulted. */
  lookup?: LocalBusinessLookupEvidence;
  /** Earlier providers in the chain that could not resolve this candidate. */
  previousAttempts?: { provider: string; resolutionMethod: ResolutionMethod; resolutionState: ResolutionState; error?: string }[];
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
  prospectPresent?: 'YES' | 'NO' | 'UNRESOLVED';
  /** Every genuine, user-visible named business surfaced in this layer (prospect included when present). */
  businessesSurfaced: string[];
  /** Required whenever state === 'YES': the visible text that proved the prospect was there. */
  prospectMatchEvidence?: ProspectMatchEvidence[];
  /** Identity checks run on ambiguous candidates (name resembles the prospect but is not an accepted variant). */
  identityResolutions?: IdentityResolution[];
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

/**
 * Prospect-facing report. Issued only for COMPLETE audits. The token is random and
 * carries no information about the business, the audit id or any storage id.
 */
export interface PublicReport {
  token: string;
  createdAt: string;
  /** Diagnostics: every valid GET of the report, including link-preview bots and scanners. */
  pageRequestCount: number;
  firstRequestedAt?: string;
  lastRequestedAt?: string;
  /** Confirmed engagement: the rendered page stayed visible for ~2s and reported back. Use these for CRM. */
  firstEngagedAt?: string;
  lastEngagedAt?: string;
  engagedViewCount: number;
  ctaClickedAt?: string;
  ctaClickCount: number;
  /** Session nonces embedded in rendered pages that have not yet reported engagement (most recent last). */
  issuedSessions: string[];
  /** Session nonces that have already counted, so a repeat event from the same page counts once. */
  engagedSessions: string[];
}

export interface SemanticBusinessReview {
  approved: boolean;
  confidence: number;
  businessType: string;
  primaryService: string;
  providerNoun: string;
  customerRequirement: string;
  customerProblem: string;
  serviceTerms: string[];
  evidence: string[];
  concerns: string[];
  model: string;
}

export interface SemanticFinalReview {
  approved: boolean;
  confidence: number;
  reason: string;
  concerns: string[];
  model: string;
}

export type VisualProspectState = 'YES' | 'NO' | 'UNRESOLVED';

/**
 * Independent visual witness for one captured ChatGPT turn.
 * It never receives the parser's conclusion, so agreement is meaningful.
 */
export interface SemanticVisualReview {
  prospectPresent: VisualProspectState;
  confidence: number;
  businessesSurfaced: string[];
  businessesRecommended: string[];
  citationsOrSources: string[];
  evidence: string[];
  reason: string;
  concerns: string[];
  model: string;
}

export interface LayerEvidenceReconciliation {
  layer: Layer;
  deterministicProspectPresent: 'YES' | 'NO' | 'UNRESOLVED';
  visualProspectPresent: VisualProspectState;
  /** Parser/DOM business set used for this layer's commercial conclusion. */
  deterministicBusinesses: string[];
  /** Businesses the visual witness says are actually surfaced/recommended for this layer. */
  visualBusinesses: string[];
  /** Publications/citations/sources the visual witness says are not provider recommendations. */
  visualSources: string[];
  /** Parser businesses absent from the visual provider set. */
  parserOnlyBusinesses: string[];
  /** Visual provider businesses absent from the parser set. */
  visionOnlyBusinesses: string[];
  /** Parser competitors that vision explicitly classified as citation/source material. */
  sourceConflicts: string[];
  prospectAgreed: boolean;
  businessesAgreed: boolean;
  agreed: boolean;
  confidence: number;
  reason: string;
}

export interface AuditQuality {
  required: boolean;
  /** Production belt-and-braces mode: DOM/parser and screenshot vision must agree. */
  visualRequired?: boolean;
  preflight?: SemanticBusinessReview;
  visual?: Partial<Record<Layer, LayerEvidenceReconciliation>>;
  final?: SemanticFinalReview;
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
  /** Mandatory semantic safety gates for production audits. */
  quality?: AuditQuality;
  publicReport?: PublicReport;
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
  /** Prospect-facing report URL. Present only for COMPLETE audits. */
  publicUrl?: string;
}
