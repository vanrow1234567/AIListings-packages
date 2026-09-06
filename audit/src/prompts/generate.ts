import type { BusinessUnderstanding, Layer, LayerPrompt } from '../domain/types.ts';

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One well-designed opening prompt per layer. The prospect is never named. */
export function generateLayerPrompts(u: BusinessUnderstanding): Record<Layer, LayerPrompt> {
  return {
    VISIBLE: {
      layer: 'VISIBLE',
      opening: `${cap(u.providerNoun)} in ${u.market}`,
    },
    RECOMMENDED: {
      layer: 'RECOMMENDED',
      opening: `Who would you recommend for ${u.customerRequirement} in ${u.market}?`,
    },
    CONVERSATIONAL: {
      layer: 'CONVERSATIONAL',
      opening: `${u.customerProblem.replace(/ What should (I|we) do( first)?\?$/, '')} I'm in ${u.market} and I'm not sure what to do. What should I do?`,
    },
  };
}

/**
 * Choose the next natural buying-intent follow-up for the Conversational layer,
 * based on what ChatGPT just said. Returns undefined when no further turn is needed.
 */
export function nextConversationalFollowUp(
  u: BusinessUnderstanding,
  previousResponseText: string,
  followUpsSoFar: number,
  businessesNamedSoFar: number,
): string | undefined {
  if (followUpsSoFar >= 3) return undefined;
  // Once ChatGPT has put specific businesses forward, the buying-intent question has been answered.
  if (businessesNamedSoFar > 0 && followUpsSoFar >= 1) return undefined;

  const text = previousResponseText.toLowerCase();
  const asksForLocation =
    /where (are you|abouts)|which (area|town|city|part)|your (area|location|postcode)|what area/i.test(text);
  const offersHelp = /would you like (me to|help|a hand)|want me to|shall i|do you want me|i can help you find|happy to help you find/i.test(text);
  const asksClarifying = /\?\s*$/.test(previousResponseText.trim()) || /could you (tell|let) me|do you know/i.test(text);

  if (followUpsSoFar === 0) {
    if (asksForLocation) {
      return `I'm in ${u.market}. Who would you recommend I speak to?`;
    }
    if (offersHelp) {
      return 'Yes please. Who would you recommend I speak to?';
    }
    if (asksClarifying) {
      return `Honestly I'd rather get someone qualified to look at it. Who would you recommend I speak to in ${u.market}?`;
    }
    return 'Who would you recommend I speak to?';
  }
  if (followUpsSoFar === 1) {
    return `Can you give me the names of a few specific ${u.providerNoun} in ${u.market} that you'd suggest I contact?`;
  }
  return `Which one of those would you pick first for ${u.customerRequirement}, and why?`;
}

export interface CompetitorDiscoveryPrompt {
  prompt: string;
  /**
   * True only when the wording explicitly asks ChatGPT for local providers in the
   * audited market. This can boost ordering AFTER parser + vision verification.
   */
  localMarket: boolean;
}

/**
 * Extra competitor searches used only when the normal three audit layers produced
 * fewer than three verified competitors. The prospect is deliberately never named.
 */
export function competitorDiscoveryPrompts(
  u: BusinessUnderstanding,
): CompetitorDiscoveryPrompt[] {
  return [
    {
      prompt: `Which local ${u.providerNoun} in ${u.market} would you recommend? Please name three specific businesses you would genuinely consider.`,
      localMarket: true,
    },
    {
      prompt: `What other ${u.providerNoun} serving ${u.market} would you suggest I compare before choosing? Please name specific businesses.`,
      localMarket: false,
    },
  ];
}

/** Separate diagnostic. Never counted as RECOMMENDED evidence. */
export function brandDiagnosticPrompt(u: BusinessUnderstanding): string {
  return `Would you recommend ${u.prospect.name} for ${u.customerRequirement} in ${u.market}?`;
}
