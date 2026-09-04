import type { AuditStatus, Competitor, Layer, LayerState, Prospect } from '../domain/types.ts';

export interface OutreachInput {
  prospect: Prospect;
  service: string;
  status: AuditStatus;
  states: Record<Layer, LayerState>;
  competitors: Competitor[];
}

function list(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Short, evidence-bound prospect outreach message. Focuses on the Recommended
 * and Conversational evidence and never overstates what a single test showed.
 * Returns undefined when the audit is incomplete: no definitive claims from partial evidence.
 */
export function generateOutreach(input: OutreachInput): string | undefined {
  if (input.status !== 'COMPLETE') return undefined;
  const { prospect, service, states } = input;
  const recommendedElsewhere = input.competitors
    .filter((c) => c.layers.includes('RECOMMENDED') || c.layers.includes('CONVERSATIONAL'))
    .map((c) => c.name);
  const anyCompetitors = input.competitors.map((c) => c.name);
  const named = recommendedElsewhere.length > 0 ? recommendedElsewhere : anyCompetitors;
  const namedText = list(named.slice(0, 3));

  const intro = `Hi there, we ran a set of ChatGPT searches to see how ${prospect.name} appears when someone in ${prospect.location} looks for ${service} help.`;
  const close = 'That\'s the area we help businesses improve. Would you like me to send you what we found?';

  const rec = states.RECOMMENDED === 'YES';
  const conv = states.CONVERSATIONAL === 'YES';
  const vis = states.VISIBLE === 'YES';

  if (rec && conv) {
    const tail = namedText
      ? ` In those same searches ChatGPT also put ${namedText} forward alongside you, so it's worth protecting that position.`
      : ' That\'s a strong position and worth protecting.';
    return `${intro} Good news: in the searches we ran, ChatGPT put you forward both when we asked who it would recommend and when we described a real ${service} problem.${tail} Would you like me to send you the screenshots?`;
  }
  if (rec || conv) {
    const passed = rec ? 'asked directly who it would recommend' : 'described a real customer problem and asked who to speak to';
    const missed = rec ? 'we described a real problem in conversation' : 'we asked directly who it would recommend';
    const tail = namedText ? ` and put ${namedText} forward instead` : '';
    return `${intro} In our test ChatGPT recommended you when we ${passed}, which is good. But when ${missed} it didn't mention you${tail}. ${close}`;
  }
  if (vis) {
    const tail = namedText
      ? ` it put ${namedText} forward instead.`
      : " it didn't put you forward.";
    return `${intro} In the searches we ran you're visible, which is good. The issue is that when we asked ChatGPT who it would actually recommend,${tail} ${close}`;
  }
  const tail = namedText
    ? ` When we asked who it would recommend, ChatGPT suggested ${namedText} instead.`
    : " When we asked who it would recommend, it didn't suggest you.";
  return `${intro} In the ChatGPT searches we ran, ${prospect.name} didn't appear at any point.${tail} ${close}`;
}
