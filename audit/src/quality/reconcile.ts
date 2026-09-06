import { distinctiveTokens, nameKey } from '../analysis/normalise.ts';
import type {
  LayerEvidenceReconciliation,
  LayerResult,
  SemanticVisualReview,
  TurnProspectReconciliation,
  VisualProspectState,
} from '../domain/types.ts';

function deterministicState(layer: LayerResult): 'YES' | 'NO' | 'UNRESOLVED' {
  if (layer.prospectPresent) return layer.prospectPresent;
  if (layer.state === 'YES') return 'YES';
  if (layer.state === 'NO') return 'NO';
  return 'UNRESOLVED';
}

function deterministicTurnState(
  layer: LayerResult,
  turnIndex: number,
): 'YES' | 'NO' | 'UNRESOLVED' {
  // With exactly one captured turn, the final parser layer verdict is necessarily
  // the verdict for that turn. This also preserves older stored/test records that
  // did not retain prospect EntityMention evidence separately.
  if (layer.turns.length === 1 && layer.turns[0]?.index === turnIndex) {
    return deterministicState(layer);
  }

  const mentions = layer.entities.filter((e) => e.turnIndex === turnIndex);
  if (mentions.some((e) => e.kind === 'prospect' && e.evidence)) return 'YES';

  const resolutions = (layer.identityResolutions ?? []).filter((r) => r.turnIndex === turnIndex);
  if (resolutions.some((r) => r.resolutionState === 'CONFIRMED_PROSPECT')) return 'YES';
  if (resolutions.some((r) => r.resolutionState === 'UNRESOLVED')) return 'UNRESOLVED';

  return 'NO';
}

function sameEvidenceBusiness(
  a: string,
  b: string,
  location: string,
  serviceTerms: readonly string[],
): boolean {
  const ka = nameKey(a, location);
  const kb = nameKey(b, location);
  if (!ka || !kb) return false;
  if (ka === kb) return true;

  const ta = new Set(ka.split(' '));
  const tb = new Set(kb.split(' '));
  const [small, large, smallName] = ta.size <= tb.size ? [ta, tb, a] : [tb, ta, b];
  if (![...small].every((t) => large.has(t))) return false;

  // Semantic service terms are descriptive rather than identity. This prevents
  // generic names such as "SEO Warrington" being merged with a different brand
  // merely because both names contain the audited service.
  return distinctiveTokens(smallName, location, serviceTerms).length > 0;
}

function uniqueNames(
  names: string[],
  location: string,
  serviceTerms: readonly string[],
): string[] {
  const out: string[] = [];
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    if (!out.some((existing) => sameEvidenceBusiness(existing, name, location, serviceTerms))) {
      out.push(name);
    }
  }
  return out;
}

function hasBusiness(
  name: string,
  list: string[],
  location: string,
  serviceTerms: readonly string[],
): boolean {
  return list.some((candidate) => sameEvidenceBusiness(name, candidate, location, serviceTerms));
}

/** Shared by the production competitor filter: both parser and vision must name it. */
export function visualConfirmsBusinessName(
  name: string,
  visualNames: string[],
  location: string,
  serviceTerms: readonly string[] = [],
): boolean {
  return hasBusiness(name, visualNames, location, serviceTerms);
}

/**
 * Independent witness reconciliation.
 *
 * Hard release disputes:
 * - missing visual witness or confidence below 0.90;
 * - target-prospect disagreement on ANY individual turn;
 * - aggregate target-prospect disagreement;
 * - parser says "competitor/provider" while vision explicitly classifies the same
 *   named entity only as a source/citation.
 *
 * A Conversational sequence can validly be NO on the problem prompt and YES only
 * after a natural follow-up. That is agreement when parser and vision independently
 * report the same NO -> YES sequence.
 *
 * Coverage gaps (one witness names an additional business) are retained for the
 * final Sol multimodal gate rather than treated as contradictions.
 */
export function reconcileLayerVisualEvidence(
  layer: LayerResult,
  location: string,
  serviceTerms: readonly string[] = [],
): LayerEvidenceReconciliation {
  const deterministicProspectPresent = deterministicState(layer);
  const deterministicBusinesses = uniqueNames(layer.businessesSurfaced, location, serviceTerms);

  if (layer.turns.length === 0) {
    return {
      layer: layer.layer,
      deterministicProspectPresent,
      visualProspectPresent: 'UNRESOLVED',
      turnProspectComparisons: [],
      deterministicBusinesses,
      visualBusinesses: [],
      visualSources: [],
      parserOnlyBusinesses: deterministicBusinesses,
      visionOnlyBusinesses: [],
      sourceConflicts: [],
      prospectAgreed: false,
      businessesAgreed: false,
      agreed: false,
      confidence: 0,
      reason: 'No captured ChatGPT turn was available for visual verification.',
    };
  }

  const missing = layer.turns.filter((t) => !t.visualReview);
  if (missing.length > 0) {
    const details = missing
      .map((t) => `turn ${t.index + 1}${t.visualReviewError ? `: ${t.visualReviewError}` : ''}`)
      .join('; ');
    return {
      layer: layer.layer,
      deterministicProspectPresent,
      visualProspectPresent: 'UNRESOLVED',
      turnProspectComparisons: layer.turns.map((t) => ({
        turnIndex: t.index,
        deterministicProspectPresent: deterministicTurnState(layer, t.index),
        visualProspectPresent: t.visualReview?.prospectPresent ?? 'UNRESOLVED',
        confidence: t.visualReview?.confidence ?? 0,
        agreed: false,
      })),
      deterministicBusinesses,
      visualBusinesses: [],
      visualSources: [],
      parserOnlyBusinesses: deterministicBusinesses,
      visionOnlyBusinesses: [],
      sourceConflicts: [],
      prospectAgreed: false,
      businessesAgreed: false,
      agreed: false,
      confidence: 0,
      reason: `Visual witness unavailable for ${details}.`,
    };
  }

  const reviews = layer.turns.map((t) => t.visualReview!);
  const confidence = Math.min(...reviews.map((r) => r.confidence));
  const allHighConfidence = reviews.every((r) => r.confidence >= 0.9);

  const turnProspectComparisons: TurnProspectReconciliation[] = layer.turns.map((turn) => {
    const visual = turn.visualReview!;
    const deterministic = deterministicTurnState(layer, turn.index);
    const agreed =
      visual.confidence >= 0.9 &&
      deterministic !== 'UNRESOLVED' &&
      visual.prospectPresent !== 'UNRESOLVED' &&
      deterministic === visual.prospectPresent;
    return {
      turnIndex: turn.index,
      deterministicProspectPresent: deterministic,
      visualProspectPresent: visual.prospectPresent,
      confidence: visual.confidence,
      agreed,
    };
  });

  const yes = reviews.filter((r) => r.prospectPresent === 'YES');
  let visualProspectPresent: VisualProspectState;
  if (yes.length > 0) {
    visualProspectPresent = 'YES';
  } else if (reviews.every((r) => r.prospectPresent === 'NO')) {
    visualProspectPresent = 'NO';
  } else {
    visualProspectPresent = 'UNRESOLVED';
  }

  // Compare surfaced-provider coverage to surfaced-provider coverage. Recommendation
  // semantics remain the visual witness + final Sol gate's job; the DOM parser does
  // not independently encode "recommended" vs "merely mentioned" for every entity.
  const visualBusinesses = uniqueNames(
    reviews.flatMap((r) => r.businessesSurfaced),
    location,
    serviceTerms,
  );
  const visualSources = uniqueNames(
    reviews.flatMap((r) => r.citationsOrSources),
    location,
    serviceTerms,
  );

  const parserOnlyBusinesses = deterministicBusinesses.filter(
    (name) => !hasBusiness(name, visualBusinesses, location, serviceTerms),
  );
  const visionOnlyBusinesses = visualBusinesses.filter(
    (name) => !hasBusiness(name, deterministicBusinesses, location, serviceTerms),
  );

  // A provider may also have its own citation/source pill. That is not a conflict.
  // It is a conflict only when vision classifies the parser competitor as a source
  // and does NOT independently list it as a surfaced business/provider.
  const sourceConflicts = layer.competitorsMentioned.filter(
    (name) =>
      hasBusiness(name, visualSources, location, serviceTerms) &&
      !hasBusiness(name, visualBusinesses, location, serviceTerms),
  );

  const everyTurnProspectAgreed = turnProspectComparisons.every((t) => t.agreed);
  const prospectAgreed =
    allHighConfidence &&
    everyTurnProspectAgreed &&
    visualProspectPresent !== 'UNRESOLVED' &&
    deterministicProspectPresent === visualProspectPresent;

  const businessesAgreed = allHighConfidence && sourceConflicts.length === 0;
  const agreed = prospectAgreed && businessesAgreed;

  const turnSequence = turnProspectComparisons
    .map(
      (t) =>
        `turn ${t.turnIndex + 1} parser=${t.deterministicProspectPresent}/vision=${t.visualProspectPresent}/${t.agreed ? 'agree' : 'DISPUTE'}`,
    )
    .join(', ');

  const parts = [
    `DOM/parser prospect=${deterministicProspectPresent}`,
    `vision prospect=${visualProspectPresent}`,
    `vision confidence floor=${confidence.toFixed(2)}`,
    `turn sequence: ${turnSequence}`,
  ];
  if (parserOnlyBusinesses.length > 0) {
    parts.push(`parser-only coverage: ${parserOnlyBusinesses.join(', ')}`);
  }
  if (visionOnlyBusinesses.length > 0) {
    parts.push(`vision-only coverage: ${visionOnlyBusinesses.join(', ')}`);
  }
  if (sourceConflicts.length > 0) {
    parts.push(`provider/source contradictions: ${sourceConflicts.join(', ')}`);
  }

  return {
    layer: layer.layer,
    deterministicProspectPresent,
    visualProspectPresent,
    turnProspectComparisons,
    deterministicBusinesses,
    visualBusinesses,
    visualSources,
    parserOnlyBusinesses,
    visionOnlyBusinesses,
    sourceConflicts,
    prospectAgreed,
    businessesAgreed,
    agreed,
    confidence,
    reason: agreed
      ? `Independent witnesses agree on material release facts. Coverage gaps, if any, require final multimodal review. ${parts.join('; ')}.`
      : `Independent evidence dispute. ${parts.join('; ')}.`,
  };
}
