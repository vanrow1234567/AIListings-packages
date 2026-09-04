import type { IdentityResolution, Layer, Prospect } from '../domain/types.ts';

/** The surfaced result we are trying to attribute. */
export interface IdentityCandidate {
  name: string;
  context: string;
  /** The visible link captured from the ChatGPT answer, if any. */
  href?: string;
  layer: Layer | 'BRAND_DIAGNOSTIC';
  turnIndex: number;
}

/**
 * Seam for identity evidence. The link resolver is the first implementation; a later
 * external provider (Google Business Profile, Apify, a data vendor) implements the same
 * contract and is consulted after it. Every implementation must return UNRESOLVED when
 * it cannot prove identity either way: UNRESOLVED never becomes prospectPresent = YES.
 */
export interface IdentityProvider {
  readonly name: string;
  resolve(candidate: IdentityCandidate, prospect: Prospect): Promise<IdentityResolution>;
}

/** Result of following a link to where it actually lands. */
export type DestinationResult =
  | { ok: true; sourceUrl: string; finalUrl: string; finalHost: string; canonicalUrl?: string; canonicalHost?: string; hops: string[] }
  | { ok: false; sourceUrl: string; error: string; hops: string[] };

/** Follows a URL safely (redirects, redirector params, canonical) without touching the ChatGPT browser session. */
export interface DestinationResolver {
  resolve(url: string): Promise<DestinationResult>;
}
