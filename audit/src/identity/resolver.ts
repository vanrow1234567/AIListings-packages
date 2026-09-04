import type { EntityMention, IdentityResolution, LayerResult, Prospect } from '../domain/types.ts';
import { domainKind, isAmbiguousProspectCandidate, matchProspect } from '../competitors/classify.ts';
import type { DestinationResolver, IdentityCandidate, IdentityProvider } from './provider.ts';
import { hostOfUrl, stripWww } from './destination.ts';

/**
 * Resolves identity from the link ChatGPT actually showed. Resolution order:
 *  1. existing strong evidence (accepted name variant, visible prospect domain, visible link on the prospect domain);
 *  2. a captured link: unwrap redirectors, follow redirects, compare the final host, then rel=canonical;
 *  3. no link: UNRESOLVED.
 * Tracking / intermediary hosts (directories, maps, search) are never identity themselves.
 */
export class LinkIdentityResolver implements IdentityProvider {
  readonly name = 'link-resolver';
  private readonly destinations: DestinationResolver;
  private readonly now: () => Date;

  constructor(destinations: DestinationResolver, now: () => Date = () => new Date()) {
    this.destinations = destinations;
    this.now = now;
  }

  async resolve(candidate: IdentityCandidate, prospect: Prospect): Promise<IdentityResolution> {
    const base = {
      candidateName: candidate.name,
      candidateContext: candidate.context,
      prospectDomain: prospect.domain,
      layer: candidate.layer,
      turnIndex: candidate.turnIndex,
      provider: this.name,
      resolvedAt: this.now().toISOString(),
    };
    const withSource = (r: Partial<IdentityResolution>): IdentityResolution =>
      ({ ...base, ...(candidate.href ? { sourceUrl: candidate.href } : {}), ...r }) as IdentityResolution;

    // 1. Strong evidence already in hand.
    const hrefHost = candidate.href ? hostOfUrl(candidate.href) : undefined;
    const strong = matchProspect(
      { raw: candidate.name, source: candidate.href ? 'link' : 'text', context: candidate.context, ...(hrefHost ? { domain: hrefHost } : {}) },
      prospect,
      candidate.turnIndex,
    );
    if (strong) {
      const method = strong.matchedBy === 'visible_domain' ? 'visible_domain' : strong.matchedBy === 'name_with_domain' ? 'captured_link' : 'name_variant';
      return withSource({ resolutionMethod: method, resolutionState: 'CONFIRMED_PROSPECT', ...(hrefHost && domainKind(hrefHost, prospect) === 'prospect' ? { matchedDomain: stripWww(hrefHost) } : {}) });
    }

    // 3. Nothing to resolve against.
    if (!candidate.href || !hrefHost) return withSource({ resolutionMethod: 'no_link', resolutionState: 'UNRESOLVED' });

    // 2. Follow the link to where it really lands.
    const dest = await this.destinations.resolve(candidate.href);
    if (!dest.ok) {
      const lastHop = dest.hops.at(-1);
      return withSource({ resolutionMethod: 'fetch_failed', resolutionState: 'UNRESOLVED', error: dest.error, ...(lastHop ? { finalUrl: lastHop } : {}) });
    }
    const finalKind = domainKind(dest.finalHost, prospect);
    const details: Partial<IdentityResolution> = { finalUrl: dest.finalUrl, ...(dest.canonicalUrl ? { canonicalUrl: dest.canonicalUrl } : {}) };
    if (finalKind === 'prospect') {
      return withSource({ ...details, matchedDomain: stripWww(dest.finalHost), resolutionMethod: dest.hops.length ? 'redirect_follow' : 'captured_link', resolutionState: 'CONFIRMED_PROSPECT' });
    }
    if (dest.canonicalHost && domainKind(dest.canonicalHost, prospect) === 'prospect' && finalKind !== 'intermediary') {
      // The page itself declares it belongs to the prospect's site (alias / mirror domain).
      return withSource({ ...details, matchedDomain: stripWww(dest.canonicalHost), resolutionMethod: 'canonical', resolutionState: 'CONFIRMED_PROSPECT' });
    }
    if (finalKind === 'business') {
      return withSource({ ...details, matchedDomain: stripWww(dest.finalHost), resolutionMethod: dest.hops.length ? 'redirect_follow' : 'captured_link', resolutionState: 'CONFIRMED_OTHER_BUSINESS' });
    }
    // Landed on a directory, map or search page: that is not identity either way.
    return withSource({ ...details, matchedDomain: stripWww(dest.finalHost), resolutionMethod: dest.hops.length ? 'redirect_follow' : 'captured_link', resolutionState: 'UNRESOLVED' });
  }
}

/** A provider that never resolves anything; used when identity checks are disabled. */
export class NullIdentityProvider implements IdentityProvider {
  readonly name = 'none';
  async resolve(candidate: IdentityCandidate, prospect: Prospect): Promise<IdentityResolution> {
    return {
      candidateName: candidate.name,
      candidateContext: candidate.context,
      ...(candidate.href ? { sourceUrl: candidate.href } : {}),
      prospectDomain: prospect.domain,
      resolutionMethod: 'no_link',
      resolutionState: 'UNRESOLVED',
      layer: candidate.layer,
      turnIndex: candidate.turnIndex,
      provider: this.name,
      resolvedAt: new Date().toISOString(),
    };
  }
}

/** Mentions worth an identity check: not already the prospect, name carries the prospect's identity tokens. */
export function ambiguousMentions(result: LayerResult, prospect: Prospect): EntityMention[] {
  return result.entities.filter((m) => m.kind !== 'prospect' && (m.kind === 'competitor' || m.kind === 'uncertain') && isAmbiguousProspectCandidate({ raw: m.raw }, prospect));
}

/**
 * Run identity resolution for a layer's ambiguous mentions and apply confirmed results.
 * CONFIRMED_PROSPECT turns the mention into the prospect with evidence; anything else leaves it
 * exactly as classified. Never touches the browser.
 */
export async function resolveLayerIdentity(result: LayerResult, prospect: Prospect, provider: IdentityProvider, context: string): Promise<void> {
  const resolutions: IdentityResolution[] = [];
  const cache = new Map<string, IdentityResolution>();
  for (const mention of ambiguousMentions(result, prospect)) {
    const key = `${mention.raw}|${mention.href ?? ''}`;
    let resolution = cache.get(key);
    if (!resolution) {
      const candidate: IdentityCandidate = { name: mention.raw, context: contextFor(result, mention, context), layer: result.layer, turnIndex: mention.turnIndex };
      if (mention.href) candidate.href = mention.href;
      resolution = await provider.resolve(candidate, prospect);
      cache.set(key, resolution);
    }
    resolutions.push({ ...resolution, turnIndex: mention.turnIndex });
    applyResolution(mention, resolution, prospect);
  }
  result.identityResolutions = resolutions;
}

/** Re-apply resolutions already stored on the record (sync; no network). */
export function applyStoredResolutions(result: LayerResult, prospect: Prospect): void {
  for (const r of result.identityResolutions ?? []) {
    const mention = result.entities.find((m) => m.kind !== 'prospect' && m.raw === r.candidateName && m.turnIndex === r.turnIndex && (m.href ?? '') === (r.sourceUrl ?? ''));
    if (mention) applyResolution(mention, r, prospect);
  }
}

function applyResolution(mention: EntityMention, resolution: IdentityResolution, prospect: Prospect): void {
  if (resolution.resolutionState !== 'CONFIRMED_PROSPECT') return; // UNRESOLVED / OTHER never become YES
  mention.kind = 'prospect';
  mention.key = '__prospect__';
  mention.name = prospect.name;
  mention.evidence = {
    snippet: mention.raw,
    context: resolution.candidateContext,
    source: mention.href ? 'link' : 'bold',
    matchedBy: resolution.resolutionMethod === 'name_variant' ? 'business_name' : resolution.resolutionMethod === 'visible_domain' ? 'visible_domain' : 'resolved_destination',
    turnIndex: mention.turnIndex,
  };
}

function contextFor(result: LayerResult, mention: EntityMention, fallback: string): string {
  const turn = result.turns.find((t) => t.index === mention.turnIndex);
  if (!turn) return fallback;
  const text = turn.response.text.replace(/\s+/g, ' ');
  const i = text.toLowerCase().indexOf(mention.raw.toLowerCase());
  if (i === -1) return fallback;
  return text.slice(Math.max(0, i - 60), Math.min(text.length, i + mention.raw.length + 60)).trim();
}
