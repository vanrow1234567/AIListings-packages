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
} from '../domain/types.ts';
import { LAYERS } from '../domain/types.ts';
import { SignInRequiredError } from '../domain/errors.ts';
import type { ChatGptConversation, ChatGptProvider } from '../chatgpt/provider.ts';
import { understandBusiness, type WebsiteFetcher } from '../business/understand.ts';
import { brandDiagnosticPrompt, generateLayerPrompts, nextConversationalFollowUp } from '../prompts/generate.ts';
import { extractCandidates } from '../analysis/extract.ts';
import { rankCompetitors, toMentions } from '../competitors/classify.ts';
import { competitorNames, decideAuditStatus, decideLayerState } from './decide.ts';
import { generateOutreach } from '../outreach/generate.ts';
import type { EvidenceStore } from '../evidence/capture.ts';
import type { AuditStore } from '../persistence/store.ts';

export interface EngineDeps {
  provider: ChatGptProvider;
  evidence: EvidenceStore;
  store: AuditStore;
  fetcher?: WebsiteFetcher;
  now?: () => Date;
  log?: (msg: string) => void;
}

const MAX_FOLLOW_UPS = 3;

function emptyLayer(layer: Layer): LayerResult {
  return { layer, state: 'NOT_TESTED', turns: [], entities: [], competitorsMentioned: [] };
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

  async run(record: AuditRecord): Promise<AuditRecord> {
    record.status = 'RUNNING';
    await this.step(record, 'Understanding business');
    const understanding = await understandBusiness(record.request, this.deps.fetcher ? { fetcher: this.deps.fetcher } : {});
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
    const message = generateOutreach({
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
    if (message) record.outreachMessage = message;
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
      result.state = decideLayerState(result.entities);
      result.competitorsMentioned = competitorNames(result.entities);
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
    await this.deps.store.save(record);
    return turn;
  }
}

export function summarise(record: AuditRecord) {
  return {
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
    outreachMessage: record.outreachMessage,
    evidence: record.evidence,
    incompleteReason: record.incompleteReason,
  };
}
