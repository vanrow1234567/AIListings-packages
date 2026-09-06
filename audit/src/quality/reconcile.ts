import { sameBusiness } from '../analysis/normalise.ts';
import type {
  LayerEvidenceReconciliation,
  LayerResult,
  SemanticVisualReview,
  VisualProspectState,
} from '../domain/types.ts';

function deterministicState(layer: LayerResult): 'YES' | 'NO' | 'UNRESOLVED' {
  if (layer.prospectPresent) return layer.prospectPresent;
  if (layer.state === 'YES') return 'YES';
  if (layer.state === 'NO') return 'NO';
  return 'UNRESOLVED';
}

function uniqueNames(names: string[], location: string): string[] {
  const out: string[] = [];
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    if (!out.some((existing) => sameBusiness(existing, name, location))) out.push(name);
  }
  return out;
}

function hasBusiness(name: string, list: string[], location: string): boolean {
  return list.some((candidate) => sameBusiness(name, candidate, location));
}

function visualBusinessesForLayer(
  layer: LayerResult,
  reviews: SemanticVisualReview[],
  location: string,
): string[] {
  const names =
    layer.layer === 'VISIBLE'
      ? reviews.flatMap((r) => r.businessesSurfaced)
      : reviews.flatMap((r) => r.businessesRecommended);
  return uniqueNames(names, location);
}

/**
 * Independent witness reconciliation.
 *
 * Accuracy-first release rule:
 * - every captured turn must have a visual review;
 * - every visual review must be >= 0.90 confidence;
 * - target-prospect YES/NO must agree;
 * - the provider/business set must agree in both directions;
 * - anything the parser calls a competitor but vision calls a citation/source is a dispute;
 * - UNRESOLVED never counts as agreement.
 *
 * This deliberately prefers false INCOMPLETEs over sending a materially incorrect audit.
 */
export function reconcileLayerVisualEvidence(
  layer: LayerResult,
  location: string,
): LayerEvidenceReconciliation {
  const deterministicProspectPresent = deterministicState(layer);
  const deterministicBusinesses = uniqueNames(layer.businessesSurfaced, location);

  if (layer.turns.length === 0) {
    return {
      layer: layer.layer,
      deterministicProspectPresent,
      visualProspectPresent: 'UNRESOLVED',
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

  const yes = reviews.filter((r) => r.prospectPresent === 'YES');
  let visualProspectPresent: VisualProspectState;
  if (yes.length > 0) {
    visualProspectPresent = 'YES';
  } else if (reviews.every((r) => r.prospectPresent === 'NO')) {
    visualProspectPresent = 'NO';
  } else {
    visualProspectPresent = 'UNRESOLVED';
  }

  const visualBusinesses = visualBusinessesForLayer(layer, reviews, location);
  const visualSources = uniqueNames(
    reviews.flatMap((r) => r.citationsOrSources),
    location,
  );

  const parserOnlyBusinesses = deterministicBusinesses.filter(
    (name) => !hasBusiness(name, visualBusinesses, location),
  );
  const visionOnlyBusinesses = visualBusinesses.filter(
    (name) => !hasBusiness(name, deterministicBusinesses, location),
  );
  const sourceConflicts = layer.competitorsMentioned.filter(
    (name) => hasBusiness(name, visualSources, location),
  );

  const prospectAgreed =
    allHighConfidence &&
    visualProspectPresent !== 'UNRESOLVED' &&
    deterministicProspectPresent === visualProspectPresent;

  const businessesAgreed =
    allHighConfidence &&
    parserOnlyBusinesses.length === 0 &&
    visionOnlyBusinesses.length === 0 &&
    sourceConflicts.length === 0;

  const agreed = prospectAgreed && businessesAgreed;

  const parts = [
    `DOM/parser prospect=${deterministicProspectPresent}`,
    `vision prospect=${visualProspectPresent}`,
    `vision confidence floor=${confidence.toFixed(2)}`,
  ];
  if (parserOnlyBusinesses.length > 0) {
    parts.push(`parser-only businesses: ${parserOnlyBusinesses.join(', ')}`);
  }
  if (visionOnlyBusinesses.length > 0) {
    parts.push(`vision-only businesses: ${visionOnlyBusinesses.join(', ')}`);
  }
  if (sourceConflicts.length > 0) {
    parts.push(`parser competitors classified visually as sources: ${sourceConflicts.join(', ')}`);
  }

  return {
    layer: layer.layer,
    deterministicProspectPresent,
    visualProspectPresent,
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
      ? `Independent DOM/parser and visual witnesses agree. ${parts.join('; ')}.`
      : `Independent evidence dispute. ${parts.join('; ')}.`,
  };
}
