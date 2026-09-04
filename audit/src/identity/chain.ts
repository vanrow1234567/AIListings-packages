import type { IdentityResolution, Prospect } from '../domain/types.ts';
import type { IdentityCandidate, IdentityProvider } from './provider.ts';

/**
 * Runs identity providers in order and stops at the first that resolves either way.
 * Earlier UNRESOLVED attempts are kept on the final resolution as evidence.
 */
export class ChainedIdentityProvider implements IdentityProvider {
  readonly name: string;
  private readonly providers: IdentityProvider[];

  constructor(providers: IdentityProvider[]) {
    if (providers.length === 0) throw new Error('ChainedIdentityProvider needs at least one provider');
    this.providers = providers;
    this.name = providers.map((p) => p.name).join(' > ');
  }

  async resolve(candidate: IdentityCandidate, prospect: Prospect): Promise<IdentityResolution> {
    const attempts: NonNullable<IdentityResolution['previousAttempts']> = [];
    let last: IdentityResolution | undefined;
    for (const provider of this.providers) {
      const r = await provider.resolve(candidate, prospect);
      if (r.resolutionState !== 'UNRESOLVED') return attempts.length ? { ...r, previousAttempts: attempts } : r;
      attempts.push({ provider: r.provider, resolutionMethod: r.resolutionMethod, resolutionState: r.resolutionState, ...(r.error ? { error: r.error } : {}) });
      last = r;
    }
    const final = last!;
    const previous = attempts.slice(0, -1);
    return previous.length ? { ...final, previousAttempts: previous } : final;
  }
}
