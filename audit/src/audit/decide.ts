import type { AuditStatus, EntityMention, Layer, LayerResult, LayerState, ProspectMatchEvidence } from '../domain/types.ts';

/** The visible evidence that the prospect appeared, if any. */
export function prospectEvidence(entities: EntityMention[]): ProspectMatchEvidence[] {
  return entities.flatMap((e) => (e.kind === 'prospect' && e.evidence ? [e.evidence] : []));
}

/**
 * Decide a layer's state from its mentions. YES requires explicit, user-visible evidence
 * that the PROSPECT itself was surfaced. Surfacing other businesses never makes it YES.
 * Only called after ChatGPT returned a usable response; technical failures are set to
 * ERROR / SIGN_IN_REQUIRED by the engine.
 */
export function decideLayerState(entities: EntityMention[]): LayerState {
  return prospectEvidence(entities).length > 0 ? 'YES' : 'NO';
}

export function isConclusive(state: LayerState): boolean {
  return state === 'YES' || state === 'NO';
}

/** Overall audit status. Any required layer that is not YES/NO makes the audit INCOMPLETE. */
export function decideAuditStatus(layers: Record<Layer, LayerResult>): {
  status: AuditStatus;
  reason?: string;
} {
  const states = Object.values(layers);
  if (states.some((l) => l.state === 'SIGN_IN_REQUIRED')) {
    return { status: 'SIGN_IN_REQUIRED', reason: 'ChatGPT asked the user to sign in. Use Connect ChatGPT, then run the audit again.' };
  }
  const failed = states.filter((l) => !isConclusive(l.state));
  if (failed.length > 0) {
    const reason = failed
      .map((l) => `${l.layer}: ${l.state}${l.error ? ` (${l.error})` : ''}`)
      .join('; ');
    return { status: 'INCOMPLETE', reason: `Not every layer produced a usable ChatGPT response. ${reason}` };
  }
  return { status: 'COMPLETE' };
}

/** Genuine competitors surfaced (deduplicated, display names). */
export function competitorNames(entities: EntityMention[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entities) {
    if (e.kind !== 'competitor') continue;
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e.name);
  }
  return out;
}

/** Every genuine, user-visible named business surfaced: the prospect (when present) plus competitors. */
export function businessesSurfaced(entities: EntityMention[]): string[] {
  const prospect = entities.find((e) => e.kind === 'prospect' && e.evidence);
  return [...(prospect ? [prospect.name] : []), ...competitorNames(entities)];
}
