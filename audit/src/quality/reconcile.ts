import { distinctiveTokens, nameKey } from '../analysis/normalise.ts';
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

  // In reconciliation, semantic service terms are descriptive rather than identity.
  // This prevents generic names such as "SEO Warrington" being merged with
  // "AI Listings | AI SEO Agency" merely because both contain "SEO".
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

/**
 * Independent witness reconciliation.
 *
 * Hard release disputes:
 * - missing visual witness or confidence below 0.90;
 * - target-prospect YES/NO disagreement;
 * - parser says "competitor/provider" while vision explicitly classifies the same
 *   named entity only as a source/citation.
 *
 * Coverage gaps (one witness names an additional business) are retained for the
 * final Sol multimodal gate rather than treated as contradictions. A screenshot
 * witness is not assumed to be an exhaustive OCR/parser replacement.
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

  const prospectAgreed =
    allHighConfidence &&
    visualProspectPresent !== 'UNRESOLVED' &&
    deterministicProspectPresent === visualProspectPresent;

  const businessesAgreed = allHighConfidence && sourceConflicts.length === 0;
  const agreed = prospectAgreed && businessesAgreed;

  const parts = [
    `DOM/parser prospect=${deterministicProspectPresent}`,
    `vision prospect=${visualProspectPresent}`,
    `vision confidence floor=${confidence.toFixed(2)}`,
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
