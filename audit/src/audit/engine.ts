import { randomUUID } from 'node:crypto';
import type {
  AuditRecord,
  AuditRequest,
  BrandDiagnostic,
  BusinessUnderstanding,
  ConversationTurn,
  EntityMention,
  Layer,
  LayerResult,
  ProgressStep,
  SemanticBusinessReview,
} from '../domain/types.ts';
import { LAYERS } from '../domain/types.ts';
import { SignInRequiredError } from '../domain/errors.ts';
import type { ChatGptConversation, ChatGptProvider } from '../chatgpt/provider.ts';
import { understandBusiness, type WebsiteFetcher } from '../business/understand.ts';
import { brandDiagnosticPrompt, generateLayerPrompts, nextConversationalFollowUp } from '../prompts/generate.ts';
import { extractCandidates } from '../analysis/extract.ts';
import { rankCompetitors, toMentions } from '../competitors/classify.ts';
import { businessesSurfaced, competitorNames, decideAuditStatus, decideLayerState, hasUsableResponse, prospectEvidence, unresolvedIdentities } from './decide.ts';
import { generateOutreach } from '../outreach/generate.ts';
import type { EvidenceStore } from '../evidence/capture.ts';
import type { AuditStore } from '../persistence/store.ts';
import { ensurePublicReport, isPubliclyAvailable, publicUrl } from '../public/tracking.ts';
import type { IdentityProvider } from '../identity/provider.ts';
import { NullIdentityProvider, applyStoredResolutions, resolveLayerIdentity } from '../identity/resolver.ts';
import type { SemanticQaProvider } from '../quality/semanticQa.ts';
import { collectWebsiteEvidence, type WebsiteEvidence } from '../quality/websiteEvidence.ts';
import { reconcileLayerVisualEvidence } from '../quality/reconcile.ts';
import type { EvaluationStore } from '../quality/evaluationStore.ts';

export interface EngineDeps {
  provider: ChatGptProvider;
  evidence: EvidenceStore;
  store: AuditStore;
  /** Proves whether an ambiguous surfaced result belongs to the prospect. Defaults to no resolution (UNRESOLVED). */
  identity?: IdentityProvider;
  fetcher?: WebsiteFetcher;
  /** Required in production: semantic business classification and final release review. */
  semanticQa?: SemanticQaProvider;
  semanticQaRequired?: boolean;
  /** Independent screenshot witness. When required, missing/low-confidence/disagreeing evidence fails closed. */
  visualQaRequired?: boolean;
  /** Stores real disagreement/rejection cases for regression/evaluation work. */
  evaluation?: EvaluationStore;
  websiteEvidenceCollector?: (url: string) => Promise<WebsiteEvidence>;
  now?: () => Date;
  log?: (msg: string) => void;
}

const MAX_FOLLOW_UPS = 3;

function emptyLayer(layer: Layer): LayerResult {
  return { layer, state: 'NOT_TESTED', turns: [], entities: [], businessesSurfaced: [], competitorsMentioned: [] };
}

export function newAuditRecord(request: AuditRequest, providerName: string, now = new Date()): AuditRecord {
  const iso = now.toISOString();
  return {
    id: randomUUID(),
    createdAt: iso,
    updatedAt: iso,
    request,
    status: 'QUEUED',
    completedSteps: [],
    layers: { VISIBLE: emptyLayer('VISIBLE'), RECOMMENDED: emptyLayer('RECOMMENDED'), CONVERSATIONAL: emptyLayer('CONVERSATIONAL') },
    topCompetitors: [],
    evidence: { visibleScreenshots: [], recommendedScreenshots: [], conversationalScreenshots: [], brandDiagnosticScreenshots: [] },
    provider: providerName,
  };
}

/**
 * Runs a full audit. Commercial logic lives in the analysis/competitors/audit/outreach
 * modules; this class only sequences the work and records evidence.
 */
export class AuditEngine {
  private readonly deps: EngineDeps;
  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private async step(record: AuditRecord, step: ProgressStep): Promise<void> {
    record.currentStep = step;
    record.updatedAt = this.now();
    this.deps.log?.(`[${record.id}] ${step}`);
    await this.deps.store.save(record);
  }

  private async done(record: AuditRecord, step: ProgressStep): Promise<void> {
    if (!record.completedSteps.includes(step)) record.completedSteps.push(step);
    record.updatedAt = this.now();
    await this.deps.store.save(record);
  }

  private async failQuality(record: AuditRecord, reason: string): Promise<AuditRecord> {
    record.status = 'INCOMPLETE';
    record.incompleteReason = reason;
    delete record.outreachMessage;
    for (const layer of LAYERS) {
      if (record.layers[layer].state === 'NOT_TESTED') {
        record.layers[layer].error = `Skipped: ${reason}`;
      }
    }
    delete record.currentStep;
    record.updatedAt = this.now();
    await this.deps.store.save(record);
    return record;
  }

  private semanticUnderstanding(
    deterministic: BusinessUnderstanding,
    review: SemanticBusinessReview,
  ): BusinessUnderstanding {
    deterministic.prospect.serviceTerms = [
      ...new Set(review.serviceTerms.map((term) => term.trim().toLowerCase()).filter(Boolean)),
    ];
    return {
      ...deterministic,
      service: review.primaryService,
      providerNoun: review.providerNoun,
      customerRequirement: review.customerRequirement,
      customerProblem: review.customerProblem,
      source: 'semantic',
      semanticConfidence: review.confidence,
      notes: [
        ...deterministic.notes,
        `Semantic business type: ${review.businessType}`,
        ...review.evidence.map((e) => `Semantic evidence: ${e}`),
      ],
    };
  }

  async run(record: AuditRecord): Promise<AuditRecord> {
    record.status = 'RUNNING';
    const qualityRequired = this.deps.semanticQaRequired === true;
    const visualRequired = this.deps.visualQaRequired === true;
    if (qualityRequired || visualRequired) {
      record.quality = { required: qualityRequired, visualRequired };
    }

    await this.step(record, 'Understanding business');
    const deterministic = await understandBusiness(
      record.request,
      this.deps.fetcher ? { fetcher: this.deps.fetcher } : {},
    );

    let websiteEvidence: WebsiteEvidence | undefined;
    let understanding = deterministic;

    if (qualityRequired) {
      if (!this.deps.semanticQa) {
        record.understanding = deterministic;
        await this.done(record, 'Understanding business');
        return this.failQuality(
          record,
          'Semantic business verification is unavailable. Audit was not run and no prospect report was released.',
        );
      }
      try {
        const collector = this.deps.websiteEvidenceCollector ?? collectWebsiteEvidence;
        websiteEvidence = await collector(record.request.website);
        const review = await this.deps.semanticQa.preflight({
          request: record.request,
          deterministic,
          website: websiteEvidence,
        });
        record.quality = { required: true, visualRequired, preflight: review };
        if (!review.approved || review.confidence < 0.9) {
          record.understanding = deterministic;
          await this.done(record, 'Understanding business');
          return this.failQuality(
            record,
            `Semantic business verification rejected the audit (${review.model}, confidence ${review.confidence.toFixed(2)}). ${review.concerns.join(' ')}`.trim(),
          );
        }
        understanding = this.semanticUnderstanding(deterministic, review);
      } catch (err) {
        record.understanding = deterministic;
        await this.done(record, 'Understanding business');
        return this.failQuality(
          record,
          `Semantic business verification failed: ${(err as Error).message}. Audit was not run and no prospect report was released.`,
        );
      }
    }

    record.understanding = understanding;
    await this.done(record, 'Understanding business');

    const prompts = generateLayerPrompts(understanding);
    const stepFor: Record<Layer, ProgressStep> = {
      VISIBLE: 'Testing Visible',
      RECOMMENDED: 'Testing Recommended',
      CONVERSATIONAL: 'Testing Conversational',
    };

    let signInRequired = false;
    for (const layer of LAYERS) {
      const result = record.layers[layer];
      result.prompt = prompts[layer].opening;
      if (signInRequired) {
        result.state = 'NOT_TESTED';
        result.error = 'Skipped: ChatGPT sign-in required.';
        continue;
      }
      await this.step(record, stepFor[layer]);
      // Each layer starts from its own clean conversation.
      await this.runLayer(record, understanding, layer, prompts[layer].opening);
      if (result.state === 'SIGN_IN_REQUIRED') signInRequired = true;
      await this.done(record, stepFor[layer]);
    }

    if (record.request.include_brand_diagnostic && !signInRequired) {
      await this.runBrandDiagnostic(record, understanding);
    }

    await this.step(record, 'Identifying competitors');
    const all: EntityMention[] = LAYERS.flatMap((l) => record.layers[l].entities);
    record.topCompetitors = rankCompetitors(all, understanding.prospect.location);
    await this.done(record, 'Identifying competitors');

    await this.step(record, 'Preparing message');
    const decision = decideAuditStatus(record.layers);
    record.status = decision.status;
    if (decision.reason) record.incompleteReason = decision.reason;
    else delete record.incompleteReason;

    const candidateMessage = generateOutreach({
      prospect: understanding.prospect,
      service: understanding.service,
      status: record.status,
      states: {
        VISIBLE: record.layers.VISIBLE.state,
        RECOMMENDED: record.layers.RECOMMENDED.state,
        CONVERSATIONAL: record.layers.CONVERSATIONAL.state,
      },
      competitors: record.topCompetitors,
    });

    if (record.status === 'COMPLETE' && qualityRequired) {
      if (!this.deps.semanticQa || !websiteEvidence) {
        return this.failQuality(
          record,
          'Final semantic release review was unavailable. No prospect report was released.',
        );
      }
      try {
        const layerScreenshots = visualRequired
          ? await this.layerScreenshotInputs(record)
          : [];

        const finalReview = await this.deps.semanticQa.finalReview({
          request: record.request,
          understanding,
          website: websiteEvidence,
          layers: record.layers,
          ...(record.quality?.visual
            ? { reconciliations: record.quality.visual }
            : {}),
          layerScreenshots,
          competitors: record.topCompetitors,
          candidateOutreach: candidateMessage ?? '',
        });
        record.quality = {
          ...(record.quality ?? { required: true }),
          required: true,
          visualRequired,
          final: finalReview,
        };
        if (!finalReview.approved || finalReview.confidence < 0.9) {
          if (this.deps.evaluation) {
            await this.deps.evaluation.saveFinalRejection(
              record,
              finalReview,
              candidateMessage ?? '',
            ).catch((err) => {
              this.deps.log?.(`[${record.id}] failed to save final rejection evaluation: ${(err as Error).message}`);
            });
          }
          return this.failQuality(
            record,
            `Final semantic release review rejected the audit (${finalReview.model}, confidence ${finalReview.confidence.toFixed(2)}): ${finalReview.reason}`,
          );
        }
      } catch (err) {
        return this.failQuality(
          record,
          `Final semantic release review failed: ${(err as Error).message}. No prospect report was released.`,
        );
      }
    }

    if (candidateMessage) record.outreachMessage = candidateMessage;
    ensurePublicReport(record, this.deps.now); // COMPLETE + semantic release approval when required
    await this.done(record, 'Preparing message');
    delete record.currentStep;
    record.updatedAt = this.now();
    await this.deps.store.save(record);
    return record;
  }

  private async runLayer(record: AuditRecord, u: BusinessUnderstanding, layer: Layer, opening: string): Promise<void> {
    const result = record.layers[layer];
    result.startedAt = this.now();
    let conversation: ChatGptConversation | undefined;
    try {
      conversation = await this.deps.provider.newConversation();
      const turn = await this.askAndRecord(record, conversation, layer, 0, opening);
      result.turns.push(turn);
      result.entities.push(...this.analyse(turn, u, layer));

      if (layer === 'CONVERSATIONAL') {
        // Continue the SAME conversation with natural buying-intent follow-ups.
        let followUps = 0;
        let last = turn;
        while (followUps < MAX_FOLLOW_UPS) {
          const named = result.entities.filter((e) => e.kind === 'competitor' || e.kind === 'prospect').length;
          const followUp = nextConversationalFollowUp(u, last.response.text, followUps, named);
          if (!followUp) break;
          followUps++;
          last = await this.askAndRecord(record, conversation, layer, followUps, followUp);
          result.turns.push(last);
          result.entities.push(...this.analyse(last, u, layer));
        }
      }
      // Identity resolution for names that resemble the prospect but are not accepted variants.
      // Uses captured hrefs with isolated requests; the ChatGPT conversation is never touched.
      await resolveLayerIdentity(result, u.prospect, this.deps.identity ?? new NullIdentityProvider(), '');
      finaliseLayer(result);
      await this.reconcileVisualEvidence(record, result, u);
    } catch (err) {
      if (err instanceof SignInRequiredError) {
        result.state = 'SIGN_IN_REQUIRED';
        result.error = err.message;
      } else {
        // A technical failure must never become NO.
        result.state = 'ERROR';
        result.error = (err as Error).message || String(err);
        if (result.turns.length > 0) result.competitorsMentioned = competitorNames(result.entities);
      }
      this.deps.log?.(`[${record.id}] ${layer} -> ${result.state}: ${result.error}`);
    } finally {
      result.finishedAt = this.now();
      await conversation?.close().catch(() => undefined);
    }
  }

  private async reconcileVisualEvidence(
    record: AuditRecord,
    result: LayerResult,
    understanding: BusinessUnderstanding,
  ): Promise<void> {
    if (this.deps.visualQaRequired !== true) return;

    const reconciliation = reconcileLayerVisualEvidence(
      result,
      understanding.prospect.location,
      understanding.prospect.serviceTerms ?? [],
    );
    record.quality = {
      ...(record.quality ?? { required: this.deps.semanticQaRequired === true }),
      visualRequired: true,
      visual: {
        ...(record.quality?.visual ?? {}),
        [result.layer]: reconciliation,
      },
    };

    const hasCoverageGap =
      reconciliation.parserOnlyBusinesses.length > 0 ||
      reconciliation.visionOnlyBusinesses.length > 0;

    if (reconciliation.agreed && hasCoverageGap && this.deps.evaluation) {
      await this.deps.evaluation.saveLayerCoverageGap(record, reconciliation).catch((err) => {
        this.deps.log?.(`[${record.id}] failed to save visual coverage gap: ${(err as Error).message}`);
      });
    }

    if (reconciliation.agreed) return;

    // Persist the original parser conclusion before the public/commercial layer is
    // deliberately converted to a non-conclusive dispute state.
    if (this.deps.evaluation) {
      await this.deps.evaluation.saveLayerDispute(record, reconciliation).catch((err) => {
        this.deps.log?.(`[${record.id}] failed to save evaluation dispute: ${(err as Error).message}`);
      });
    }

    result.state = 'EVIDENCE_DISPUTED';
    result.prospectPresent = 'UNRESOLVED';
    result.error = `Independent DOM/parser and screenshot evidence did not agree. ${reconciliation.reason}`;
  }

  private async layerScreenshotInputs(record: AuditRecord): Promise<{ layer: Layer; screenshotDataUrl: string }[]> {
    const inputs: { layer: Layer; screenshotDataUrl: string }[] = [];
    for (const layer of LAYERS) {
      const turns = record.layers[layer].turns;
      const latest = [...turns].reverse().find((t) => t.visualScreenshotPath || t.screenshotPath);
      const screenshotPath = latest?.visualScreenshotPath ?? latest?.screenshotPath;
      if (!screenshotPath) {
        throw new Error(`${layer} has no screenshot for final multimodal review.`);
      }
      inputs.push({
        layer,
        screenshotDataUrl: await this.deps.evidence.dataUrlForPublicPath(record.id, screenshotPath),
      });
    }
    return inputs;
  }

  private async runBrandDiagnostic(record: AuditRecord, u: BusinessUnderstanding): Promise<void> {
    const prompt = brandDiagnosticPrompt(u);
    const diag: BrandDiagnostic = {
      state: 'NOT_TESTED',
      prompt,
      note: 'Brand-specific diagnostic. Never counted as RECOMMENDED evidence.',
    };
    record.brandDiagnostic = diag;
    let conversation: ChatGptConversation | undefined;
    try {
      conversation = await this.deps.provider.newConversation();
      const turn = await this.askAndRecord(record, conversation, 'BRAND_DIAGNOSTIC', 0, prompt);
      diag.turn = turn;
      const mentions = toMentions(extractCandidates(turn.response), u.prospect, 'BRAND_DIAGNOSTIC', 0);
      diag.state = decideLayerState(mentions);
    } catch (err) {
      diag.state = err instanceof SignInRequiredError ? 'SIGN_IN_REQUIRED' : 'ERROR';
      diag.error = (err as Error).message;
    } finally {
      await conversation?.close().catch(() => undefined);
      await this.deps.store.save(record);
    }
  }

  private analyse(turn: ConversationTurn, u: BusinessUnderstanding, layer: Layer): EntityMention[] {
    return toMentions(extractCandidates(turn.response), u.prospect, layer, turn.index);
  }

  private async askAndRecord(
    record: AuditRecord,
    conversation: ChatGptConversation,
    layer: Layer | 'BRAND_DIAGNOSTIC',
    index: number,
    prompt: string,
  ): Promise<ConversationTurn> {
    const askedAt = this.now();
    const response = await conversation.ask(prompt);
    if (!response.text || response.text.trim().length === 0) {
      throw new Error('ChatGPT returned an empty response.');
    }
    const answeredAt = this.now();
    const turn: ConversationTurn = { index, prompt, response, askedAt, answeredAt };
    const url = await conversation.url().catch(() => undefined);
    if (url) turn.conversationUrl = url;
    const shot = await this.deps.evidence.capture(conversation, record.id, `${layer.toLowerCase()}-${index + 1}`);
    if (shot.publicPath) {
      turn.screenshotPath = shot.publicPath;
      const bucket =
        layer === 'VISIBLE'
          ? record.evidence.visibleScreenshots
          : layer === 'RECOMMENDED'
            ? record.evidence.recommendedScreenshots
            : layer === 'CONVERSATIONAL'
              ? record.evidence.conversationalScreenshots
              : record.evidence.brandDiagnosticScreenshots;
      bucket.push(shot.publicPath);
    } else if (shot.error) {
      this.deps.log?.(`[${record.id}] ${layer} turn ${index + 1}: ${shot.error}`);
      turn.screenshotError = shot.error;
    }

    if (this.deps.visualQaRequired === true && layer !== 'BRAND_DIAGNOSTIC') {
      if (!this.deps.semanticQa?.visualReview) {
        turn.visualReviewError = 'Visual QA provider is unavailable.';
      } else if (!record.understanding) {
        turn.visualReviewError = 'Business understanding is unavailable for visual QA.';
      } else {
        const visualShot = await this.deps.evidence.captureResponse(
          conversation,
          record.id,
          `${layer.toLowerCase()}-${index + 1}-visual`,
        );
        if (!visualShot.path) {
          turn.visualReviewError = visualShot.error ?? 'Visual screenshot capture was unavailable.';
        } else {
          if (visualShot.publicPath) turn.visualScreenshotPath = visualShot.publicPath;
          try {
            const screenshotDataUrl = await this.deps.evidence.dataUrlFromFile(visualShot.path);
            turn.visualReview = await this.deps.semanticQa.visualReview({
              request: record.request,
              understanding: record.understanding,
              layer,
              turnIndex: index,
              prompt,
              screenshotDataUrl,
            });
          } catch (err) {
            turn.visualReviewError = `Visual QA failed: ${(err as Error).message}`;
            this.deps.log?.(`[${record.id}] ${layer} turn ${index + 1}: ${turn.visualReviewError}`);
          }
        }
      }
    }

    await this.deps.store.save(record);
    return turn;
  }
}

/**
 * Set the layer's conclusion from its entities. prospectPresent and businessesSurfaced are
 * independent: three competitors surfaced with the prospect absent is prospectPresent = NO.
 */
export function finaliseLayer(result: LayerResult): void {
  result.state = decideLayerState(result.entities, result.identityResolutions);
  result.prospectPresent = result.state === 'YES' ? 'YES' : result.state === 'IDENTITY_UNRESOLVED' ? 'UNRESOLVED' : 'NO';
  result.businessesSurfaced = businessesSurfaced(result.entities);
  result.competitorsMentioned = competitorNames(result.entities);
  const evidence = prospectEvidence(result.entities);
  if (evidence.length > 0) result.prospectMatchEvidence = evidence;
  else delete result.prospectMatchEvidence;
  if (result.state === 'IDENTITY_UNRESOLVED') {
    const names = [...new Set(unresolvedIdentities(result.identityResolutions).map((r) => `"${r.candidateName}"`))].join(', ');
    result.error = `Could not prove whether ${names} is the prospect; not reported as NO.`;
  } else {
    delete result.error;
  }
}

/**
 * Re-run the interpretation layer (extraction, classification, decisions, competitors,
 * outreach) over the responses already captured in a stored audit. The browser is not
 * touched; prompts, screenshots and displayed responses are preserved. Layers that
 * never produced a usable response keep their ERROR / SIGN_IN_REQUIRED / NOT_TESTED state.
 */
export function reanalyseRecord(record: AuditRecord): AuditRecord {
  const u = record.understanding;
  if (!u) return record;
  if (!u.prospect.serviceTerms) {
    u.prospect.serviceTerms = [u.service, ...u.service.split(/\s+/)].map((s) => s.toLowerCase());
  }
  for (const layer of LAYERS) {
    const result = record.layers[layer];
    if (!hasUsableResponse(result.state)) continue;
    result.entities = result.turns.flatMap((t) => toMentions(extractCandidates(t.response), u.prospect, layer, t.index));
    applyStoredResolutions(result, u.prospect); // sync: stored CONFIRMED_PROSPECT resolutions still count
    finaliseLayer(result);
  }
  if (record.brandDiagnostic?.turn) {
    const mentions = toMentions(extractCandidates(record.brandDiagnostic.turn.response), u.prospect, 'BRAND_DIAGNOSTIC', 0);
    record.brandDiagnostic.state = decideLayerState(mentions);
  }
  record.topCompetitors = rankCompetitors(LAYERS.flatMap((l) => record.layers[l].entities), u.prospect.location);
  const decision = decideAuditStatus(record.layers);
  record.status = decision.status;
  if (decision.reason) record.incompleteReason = decision.reason;
  else delete record.incompleteReason;
  const message = generateOutreach({
    prospect: u.prospect,
    service: u.service,
    status: record.status,
    states: { VISIBLE: record.layers.VISIBLE.state, RECOMMENDED: record.layers.RECOMMENDED.state, CONVERSATIONAL: record.layers.CONVERSATIONAL.state },
    competitors: record.topCompetitors,
  });

  if (record.quality?.required === true) {
    // Reanalysis changes interpretation/outreach, so a previous release decision is stale.
    delete record.quality.final;
    record.status = 'INCOMPLETE';
    record.incompleteReason =
      'Audit was reanalysed. A fresh semantic final review is required before any prospect report can be released.';
    delete record.outreachMessage;
  } else {
    if (message) record.outreachMessage = message;
    else delete record.outreachMessage;
    ensurePublicReport(record);
  }
  record.updatedAt = new Date().toISOString();
  return record;
}

/**
 * Reanalyse and run identity resolution afresh for every conclusive layer (isolated requests to the
 * captured links; ChatGPT is never re-run). Used by the CLI so a stored audit can pick up new evidence.
 */
export async function reanalyseRecordWithIdentity(record: AuditRecord, identity: IdentityProvider): Promise<AuditRecord> {
  const u = record.understanding;
  if (!u) return record;
  for (const layer of LAYERS) {
    const result = record.layers[layer];
    if (!hasUsableResponse(result.state)) continue;
    delete result.identityResolutions;
  }
  reanalyseRecord(record);
  for (const layer of LAYERS) {
    const result = record.layers[layer];
    if (!hasUsableResponse(result.state)) continue;
    await resolveLayerIdentity(result, u.prospect, identity, '');
    finaliseLayer(result);
  }
  return reanalyseRecord(record); // recompute status, competitors, outreach, public report with resolutions applied
}

export function summarise(record: AuditRecord, publicBaseUrl?: string) {
  return {
    publicUrl: publicBaseUrl && isPubliclyAvailable(record) ? publicUrl(publicBaseUrl, record.publicReport.token) : undefined,
    id: record.id,
    status: record.status,
    prospect: {
      name: record.request.business_name,
      location: record.request.location,
      service: record.understanding?.service ?? '',
    },
    VISIBLE: record.layers.VISIBLE.state,
    RECOMMENDED: record.layers.RECOMMENDED.state,
    CONVERSATIONAL: record.layers.CONVERSATIONAL.state,
    topCompetitors: record.topCompetitors.map((c) => c.name),
    layers: Object.fromEntries(
      LAYERS.map((l) => [l, { prospectPresent: record.layers[l].prospectPresent ?? null, businessesSurfaced: record.layers[l].businessesSurfaced, prospectMatchEvidence: record.layers[l].prospectMatchEvidence ?? [] }]),
    ),
    outreachMessage: record.outreachMessage,
    evidence: record.evidence,
    incompleteReason: record.incompleteReason,
  };
}
