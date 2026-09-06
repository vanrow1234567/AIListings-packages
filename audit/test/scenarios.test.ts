import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { SPP, advice, listResponse, runAudit } from './helpers.ts';
import { textResponse } from '../src/chatgpt/mockProvider.ts';
import { IncompleteResponseError } from '../src/domain/errors.ts';

const competitorsList = ['Solent Roofing', 'Stormguard Roofing', 'RoofCare Southampton'];

test('1. prospect Visible but not Recommended', async () => {
  const { record } = await runAudit({
    conversations: [
      { answers: [listResponse('Here are some roofing companies in Southampton:', ['SPP Roofing', ...competitorsList])] },
      { answers: [listResponse("I'd suggest:", competitorsList)] },
      { answers: [advice, listResponse('You could speak to:', ['Solent Roofing', 'Stormguard Roofing'])] },
    ],
  });
  assert.equal(record.layers.VISIBLE.state, 'YES');
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.status, 'COMPLETE');
  assert.match(record.outreachMessage ?? '', /In the searches we ran you're visible, which is good/);
  assert.match(record.outreachMessage ?? '', /Solent Roofing/);
  assert.equal(record.topCompetitors[0]?.name, 'Solent Roofing');
  assert.equal(record.evidence.visibleScreenshots.length, 1);
  assert.equal(record.evidence.recommendedScreenshots.length, 1);
  assert.equal(record.evidence.conversationalScreenshots.length, 2);
});

test('2. prospect Recommended', async () => {
  const { record } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', competitorsList)] },
      { answers: [listResponse("I'd recommend:", ['SPP Roofing Ltd', 'Solent Roofing'])] },
      { answers: [advice, listResponse('Try:', ['Solent Roofing'])] },
    ],
  });
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.state, 'YES');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.status, 'COMPLETE');
  assert.match(record.outreachMessage ?? '', /recommended you when we asked directly/);
});

test('3. prospect appearing Conversationally in a follow-up turn', async () => {
  const { record, provider } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', competitorsList)] },
      { answers: [listResponse("I'd recommend:", competitorsList)] },
      { answers: [advice, listResponse('You could contact:', ['SPP Roofing', 'Solent Roofing'])] },
    ],
  });
  assert.equal(record.layers.CONVERSATIONAL.state, 'YES');
  assert.equal(record.layers.CONVERSATIONAL.turns.length, 2);
  // The advice fixture ends by offering help, so the natural follow-up accepts it.
  assert.equal(record.layers.CONVERSATIONAL.turns[1]?.prompt, 'Yes please. Who would you recommend I speak to?');
  assert.equal(provider.transcript.filter((t) => t.conversation === 2).length, 2);
  assert.match(
    record.outreachMessage ?? '',
    /after we described the problem and then asked who we should speak to/,
  );
});

test('4. directory mixed with real competitors', async () => {
  const html =
    '<p>Try these:</p><ul><li><p><strong>Checkatrade</strong> – <a href="https://www.checkatrade.com/">directory</a></p></li>' +
    '<li><p><strong>Solent Roofing</strong></p></li><li><p><strong>Trustpilot</strong> reviews</p></li>' +
    '<li><p><strong>Stormguard Roofing</strong></p></li><li><p><strong>MyBuilder</strong></p></li></ul>';
  const mixed = { text: 'Try these: Checkatrade, Solent Roofing, Trustpilot, Stormguard Roofing, MyBuilder', html, links: ['https://www.checkatrade.com/'] };
  const { record } = await runAudit({
    conversations: [{ answers: [mixed] }, { answers: [mixed] }, { answers: [advice, mixed] }],
  });
  const names = record.topCompetitors.map((c) => c.name);
  assert.deepEqual(names.sort(), ['Solent Roofing', 'Stormguard Roofing']);
  const kinds = Object.fromEntries(record.layers.RECOMMENDED.entities.map((e) => [e.name, e.kind]));
  assert.equal(kinds['Checkatrade'], 'directory');
  assert.equal(kinds['Trustpilot'], 'review_site');
  assert.equal(kinds['MyBuilder'], 'marketplace');
});

test('5. business-name variants resolve to one business', async () => {
  const { record } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', ['ABC Roofing Ltd', 'Solent Roofing'])] },
      { answers: [listResponse('Recommended:', ['ABC Roofing', 'SPP Roofing Southampton'])] },
      { answers: [advice, listResponse('Speak to:', ['ABC Roofing Southampton'])] },
    ],
  });
  const abc = record.topCompetitors.filter((c) => /abc/i.test(c.name));
  assert.equal(abc.length, 1, 'ABC variants must merge');
  assert.equal(abc[0]?.name, 'ABC Roofing');
  assert.deepEqual([...abc[0]!.layers].sort(), ['CONVERSATIONAL', 'RECOMMENDED', 'VISIBLE']);
  assert.equal(record.layers.RECOMMENDED.state, 'YES', 'prospect variant "SPP Roofing Southampton" must match the prospect');
});

test('6. no competitors: list stays empty and message names nobody', async () => {
  const generic = textResponse(
    "I can't browse live listings, but look for NFRC members with good Google reviews, get three quotes and check they are insured.",
  );
  const { record } = await runAudit({ conversations: [{ answers: [generic] }, { answers: [generic] }, { answers: [advice, generic, generic, generic] }] });
  assert.equal(record.status, 'COMPLETE');
  assert.deepEqual(record.topCompetitors, []);
  assert.equal(record.layers.VISIBLE.state, 'NO');
  assert.match(record.outreachMessage ?? '', /didn't suggest you/);
  assert.doesNotMatch(record.outreachMessage ?? '', /forward instead|suggested .* instead/);
  assert.equal(record.layers.CONVERSATIONAL.turns.length, 4, 'up to three follow-ups when nothing is named');
});

test('7. browser error becomes ERROR and INCOMPLETE, never NO', async () => {
  const { record } = await runAudit({
    conversations: [{ answers: [] }, { answers: [listResponse('Recommended:', competitorsList)] }, { answers: [advice, listResponse('Try:', ['Solent Roofing'])] }],
    openErrors: { 0: new Error('net::ERR_TUNNEL_CONNECTION_FAILED') },
  });
  assert.equal(record.layers.VISIBLE.state, 'ERROR');
  assert.match(record.layers.VISIBLE.error ?? '', /ERR_TUNNEL/);
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.outreachMessage, undefined);
  assert.match(record.incompleteReason ?? '', /VISIBLE: ERROR/);
});

test('8. ChatGPT sign-in required', async () => {
  const { record } = await runAudit({ conversations: [], signedOut: true });
  assert.equal(record.layers.VISIBLE.state, 'SIGN_IN_REQUIRED');
  assert.equal(record.layers.RECOMMENDED.state, 'NOT_TESTED');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NOT_TESTED');
  assert.equal(record.status, 'SIGN_IN_REQUIRED');
  assert.equal(record.outreachMessage, undefined);
});

test('9. incomplete ChatGPT response is ERROR', async () => {
  const { record } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', ['SPP Roofing'])] },
      { answers: [new IncompleteResponseError('ChatGPT was still generating when the time limit was reached.')] },
      { answers: [textResponse('   '), advice] },
    ],
  });
  assert.equal(record.layers.VISIBLE.state, 'YES');
  assert.equal(record.layers.RECOMMENDED.state, 'ERROR');
  assert.equal(record.layers.CONVERSATIONAL.state, 'ERROR', 'an empty displayed answer is not a usable response');
  assert.equal(record.status, 'INCOMPLETE');
});

test('10. screenshot failure does not fail the layer', async () => {
  const { record, dir } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', ['SPP Roofing'])], screenshotError: new Error('Page crashed during capture') },
      { answers: [listResponse('Recommended:', competitorsList)] },
      { answers: [advice, listResponse('Try:', ['Solent Roofing'])] },
    ],
  });
  assert.equal(record.layers.VISIBLE.state, 'YES');
  assert.equal(record.evidence.visibleScreenshots.length, 0);
  assert.match(record.layers.VISIBLE.turns[0]?.screenshotError ?? '', /Page crashed/);
  assert.equal(record.evidence.recommendedScreenshots.length, 1);
  const file = decodeURIComponent(record.evidence.recommendedScreenshots[0]!.split('/').at(-1)!);
  await stat(path.join(dir, 'evidence', record.id, file));
  assert.equal(record.status, 'COMPLETE');
});

test('11. one layer failing leaves the others conclusive and never converts to NO', async () => {
  const { record } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', ['SPP Roofing', 'Solent Roofing'])] },
      { answers: [new Error('Target page, context or browser has been closed')] },
      { answers: [advice, listResponse('Try:', ['Solent Roofing'])] },
    ],
  });
  assert.equal(record.layers.VISIBLE.state, 'YES');
  assert.equal(record.layers.RECOMMENDED.state, 'ERROR');
  assert.notEqual(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.layers.CONVERSATIONAL.state, 'NO');
  assert.equal(record.status, 'INCOMPLETE');
  assert.equal(record.outreachMessage, undefined, 'no definitive claims from incomplete evidence');
  assert.equal(record.topCompetitors[0]?.name, 'Solent Roofing', 'competitor evidence from successful layers is still kept');
});

test('12. each layer runs in its own isolated conversation', async () => {
  const { record, provider } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', ['SPP Roofing'])], url: 'https://chatgpt.com/c/visible' },
      { answers: [listResponse('Recommended:', competitorsList)], url: 'https://chatgpt.com/c/recommended' },
      { answers: [advice, listResponse('Try:', ['Solent Roofing'])], url: 'https://chatgpt.com/c/conversational' },
    ],
  });
  const byConv = (i: number) => provider.transcript.filter((t) => t.conversation === i).map((t) => t.prompt);
  assert.deepEqual(byConv(0), [record.layers.VISIBLE.prompt]);
  assert.deepEqual(byConv(1), [record.layers.RECOMMENDED.prompt]);
  assert.equal(byConv(2)[0], record.layers.CONVERSATIONAL.prompt);
  assert.equal(record.layers.VISIBLE.turns[0]?.conversationUrl, 'https://chatgpt.com/c/visible');
  assert.equal(record.layers.RECOMMENDED.turns[0]?.conversationUrl, 'https://chatgpt.com/c/recommended');
  // The prospect is never named in any unbiased prompt.
  for (const t of provider.transcript) assert.doesNotMatch(t.prompt, /SPP/i);
});

test('13. Conversational follow-ups stay within the Conversational conversation', async () => {
  const clarifying = textResponse('That sounds like flashing. Is the leak only when it rains, and roughly where are you based?');
  const { record, provider } = await runAudit({
    conversations: [
      { answers: [listResponse('Roofing companies:', ['SPP Roofing'])] },
      { answers: [listResponse('Recommended:', competitorsList)] },
      { answers: [clarifying, textResponse('Thanks. A local roofer can do a flashing repair in a day; get a couple of quotes.'), listResponse('Specific companies:', ['Solent Roofing'])] },
    ],
  });
  const conv = provider.transcript.filter((t) => t.conversation === 2).map((t) => t.prompt);
  assert.equal(conv.length, 3);
  assert.match(conv[1] ?? '', /I'm in Southampton\. Who would you recommend I speak to\?/);
  assert.match(conv[2] ?? '', /names of a few specific roofing companies in Southampton/);
  assert.equal(provider.transcript.filter((t) => t.conversation !== 2).length, 2, 'no follow-up leaked into another conversation');
  assert.equal(record.layers.CONVERSATIONAL.turns.length, 3);
  assert.deepEqual(record.layers.CONVERSATIONAL.competitorsMentioned, ['Solent Roofing']);
});

test('14. explicit brand diagnostic is recorded separately and never counts as RECOMMENDED', async () => {
  const { record, provider } = await runAudit(
    {
      conversations: [
        { answers: [listResponse('Roofing companies:', ['SPP Roofing', 'Solent Roofing'])] },
        { answers: [listResponse('Recommended:', competitorsList)] },
        { answers: [advice, listResponse('Try:', ['Solent Roofing'])] },
        { answers: [textResponse('Yes, SPP Roofing in Southampton has solid reviews and would be a reasonable choice.', '<p>Yes, <strong>SPP Roofing</strong> in Southampton has solid reviews.</p>')] },
      ],
    },
    { ...SPP, include_brand_diagnostic: true },
  );
  assert.equal(record.brandDiagnostic?.state, 'YES');
  assert.match(record.brandDiagnostic?.prompt ?? '', /Would you recommend SPP Roofing/);
  assert.equal(record.layers.RECOMMENDED.state, 'NO');
  assert.equal(record.layers.RECOMMENDED.entities.some((e) => e.kind === 'prospect'), false);
  assert.equal(provider.transcript.filter((t) => t.conversation === 3).length, 1, 'diagnostic runs in its own conversation');
  const unbiased = provider.transcript.filter((t) => t.conversation < 3);
  for (const t of unbiased) assert.doesNotMatch(t.prompt, /SPP/i);
  assert.equal(record.evidence.brandDiagnosticScreenshots.length, 1);
  assert.equal(record.evidence.recommendedScreenshots.length, 1);
});
