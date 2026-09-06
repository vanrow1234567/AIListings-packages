import type { AuditStatus, Competitor, Layer, LayerState, Prospect } from '../domain/types.ts';

export interface OutreachInput {
  prospect: Prospect;
  service: string;
  status: AuditStatus;
  states: Record<Layer, LayerState>;
  competitors: Competitor[];
  /** First zero-based turn in each layer where parser evidence proved the prospect appeared. */
  firstProspectTurn?: Partial<Record<Layer, number>>;
}

export interface CompetitorOutreachInput {
  prospect: Prospect;
  /** Must already be evidence-gated by the audit engine. */
  competitors: Competitor[];
}

function list(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Competitor-first SMS. This is intentionally decoupled from the prospect verdict:
 * it says only that independently verified businesses surfaced in completed searches.
 * It can therefore be used when a prospect layer is EVIDENCE_DISPUTED, while the
 * full prospect audit/report remains fail-closed.
 */
export function generateCompetitorOutreach(
  input: CompetitorOutreachInput,
): string | undefined {
  const names = input.competitors.slice(0, 3).map((c) => c.name);
  const namedText = list(names);
  if (!namedText) return undefined;

  return `Hi there, we've been running ChatGPT searches for your market in ${input.prospect.location}. Across the searches we completed, ChatGPT surfaced ${namedText}. We're comparing where ${input.prospect.name} appears against those businesses. Would you like me to send you the screenshots?`;
}

/**
 * Short, evidence-bound prospect outreach message. Focuses on the Recommended
 * and Conversational evidence and never overstates what a single test showed.
 * Returns undefined when the audit is incomplete: no definitive claims from partial evidence.
 */
export function generateOutreach(input: OutreachInput): string | undefined {
  if (input.status !== 'COMPLETE') return undefined;
  const { prospect, service, states } = input;

  // Competitor names are evidence-bound to the layer being described.
  const namesFor = (layer: Layer): string[] =>
    input.competitors.filter((c) => c.layers.includes(layer)).map((c) => c.name);

  const recommendedNames = namesFor('RECOMMENDED');
  const conversationalNames = namesFor('CONVERSATIONAL');
  const combinedRecommendedOrConversational = input.competitors
    .filter((c) => c.layers.includes('RECOMMENDED') || c.layers.includes('CONVERSATIONAL'))
    .map((c) => c.name);
  const allCompetitorNames = input.competitors.map((c) => c.name);

  // topCompetitors are already evidence-gated by the audit engine in production.
  // If a competitor did not appear in the exact missed layer, use broader
  // "across the searches" wording rather than implying it was recommended there.
  const broadCompetitorContext = (): string => {
    const namedText = list(allCompetitorNames.slice(0, 3));
    return namedText
      ? ` Across the searches we ran, ChatGPT also surfaced ${namedText}.`
      : '';
  };

  const intro = `Hi there, we ran a set of ChatGPT searches to see how ${prospect.name} appears when someone in ${prospect.location} looks for ${service} help.`;
  const close = 'That\'s the area we help businesses improve. Would you like me to send you what we found?';

  const rec = states.RECOMMENDED === 'YES';
  const conv = states.CONVERSATIONAL === 'YES';
  const vis = states.VISIBLE === 'YES';

  const conversationalFirstTurn = input.firstProspectTurn?.CONVERSATIONAL;
  const conversationalPass =
    conversationalFirstTurn !== undefined && conversationalFirstTurn > 0
      ? 'after we described the problem and then asked who we should speak to'
      : `when we described a real ${service} problem`;

  if (rec && conv) {
    const namedText = list(combinedRecommendedOrConversational.slice(0, 3));
    const tail = namedText
      ? ` Across those searches ChatGPT also put ${namedText} forward alongside you, so it's worth protecting that position.`
      : broadCompetitorContext() || ' That\'s a strong position and worth protecting.';
    return `${intro} Good news: in the searches we ran, ChatGPT put you forward both when we asked who it would recommend and ${conversationalPass}.${tail} Would you like me to send you the screenshots?`;
  }

  if (rec || conv) {
    const passedClause = rec
      ? 'when we asked directly who it would recommend'
      : conversationalPass;
    const missed = rec ? 'we described a real problem in conversation' : 'we asked directly who it would recommend';
    const missedLayerNames = rec ? conversationalNames : recommendedNames;
    const namedText = list(missedLayerNames.slice(0, 3));

    // Exact "put X forward instead" wording is reserved for competitors verified
    // in the exact layer where the prospect was missed. Otherwise we can still
    // use the verified top competitors with the safer cross-search wording.
    const competitorContext = namedText
      ? ` and put ${namedText} forward instead.`
      : `.${broadCompetitorContext()}`;

    return `${intro} In our test ChatGPT recommended you ${passedClause}, which is good. But when ${missed} it didn't mention you${competitorContext} ${close}`;
  }

  if (vis) {
    const namedText = list(recommendedNames.slice(0, 3));
    const tail = namedText
      ? ` it put ${namedText} forward instead.`
      : ` it didn't put you forward.${broadCompetitorContext()}`;
    return `${intro} In the searches we ran you're visible, which is good. The issue is that when we asked ChatGPT who it would actually recommend,${tail} ${close}`;
  }

  const namedText = list(recommendedNames.slice(0, 3));
  const tail = namedText
    ? ` When we asked who it would recommend, ChatGPT suggested ${namedText} instead.`
    : ` When we asked who it would recommend, it didn't suggest you.${broadCompetitorContext()}`;
  return `${intro} In the ChatGPT searches we ran, ${prospect.name} didn't appear at any point.${tail} ${close}`;
}
