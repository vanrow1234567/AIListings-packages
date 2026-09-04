import type { AuditStatus, EntityMention, IdentityResolution, Layer, LayerResult, LayerState, ProspectMatchEvidence } from '../domain/types.ts';

/** The visible evidence that the prospect appeared, if any. */
export function prospectEvidence(entities: EntityMention[]): ProspectMatchEvidence[] {
  return entities.flatMap((e) => (e.kind === 'prospect' && e.evidence ? [e.evidence] : []));
}

/** Ambiguous prospect candidates whose identity could not be proven either way. */
export function unresolvedIdentities(resolutions: IdentityResolution[] | undefined): IdentityResolution[] {
  return (resolutions ?? []).filter((r) => r.resolutionState === 'UNRESOLVED');
}

/**
 * Decide a layer's state from its mentions and identity checks. Only called after ChatGPT
 * returned a usable response; technical failures are set to ERROR / SIGN_IN_REQUIRED by the engine.
 *  - YES requires explicit, user-visible evidence that the PROSPECT itself was surfaced
 *    (an accepted name variant, its domain, or a CONFIRMED_PROSPECT identity resolution).
 *  - NO requires that nothing surfaced could plausibly be the prospect: every ambiguous candidate
 *    was CONFIRMED_OTHER_BUSINESS, or there were none.
 *  - IDENTITY_UNRESOLVED when an ambiguous candidate stayed UNRESOLVED (no usable link, timeout,
 *    bot block, network error, intermediary). We cannot prove it is the prospect, and we cannot
 *    prove it is not, so the layer is non-conclusive rather than a false NO.
 */
export function decideLayerState(entities: EntityMention[], resolutions?: IdentityResolution[]): LayerState {
  if (prospectEvidence(entities).length > 0) return 'YES';
  if (unresolvedIdentities(resolutions).length > 0) return 'IDENTITY_UNRESOLVED';
  return 'NO';
}

export function isConclusive(state: LayerState): boolean {
  return state === 'YES' || state === 'NO';
}

/** Layers whose displayed ChatGPT response can be re-interpreted (as opposed to technical failures). */
export function hasUsableResponse(state: LayerState): boolean {
  return state === 'YES' || state === 'NO' || state === 'IDENTITY_UNRESOLVED';
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
