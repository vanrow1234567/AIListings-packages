/**
 * Adapter plumbing test against a local DOM double of chatgpt.com.
 * Proves the Playwright component can type, send, wait for streaming to end,
 * read the rendered answer, screenshot and detect sign-in walls. It does NOT
 * prove live ChatGPT behaviour: that requires the real acceptance run.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlaywrightChatGptProvider } from '../../src/chatgpt/playwrightProvider.ts';
import { IncompleteResponseError, SignInRequiredError } from '../../src/domain/errors.ts';
import { startFakeChatGpt } from './fakeChatGpt.ts';

let fake: Awaited<ReturnType<typeof startFakeChatGpt>>;
let dir: string;
const providers: PlaywrightChatGptProvider[] = [];

function make(pathSuffix = ''): PlaywrightChatGptProvider {
  const p = new PlaywrightChatGptProvider({
    userDataDir: path.join(dir, `profile${providers.length}`),
    headless: true,
    baseUrl: `${fake.baseUrl}${pathSuffix}`,
    responseTimeoutMs: 4000,
    navigationTimeoutMs: 15_000,
  });
  providers.push(p);
  return p;
}

before(async () => {
  fake = await startFakeChatGpt();
  dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-browser-'));
});
after(async () => {
  await Promise.all(providers.map((p) => p.dispose()));
  await fake.close();
});

test('opens a clean conversation, submits, waits for completion, reads the answer and screenshots', async () => {
  const provider = make();
  assert.equal(await provider.isSignedIn(), true);
  const conversation = await provider.newConversation();
  const response = await conversation.ask('Roofing companies in Southampton');
  assert.match(response.text, /Solent Roofing/);
  assert.match(response.html, /<strong>Solent Roofing<\/strong>/);
  assert.deepEqual(response.links, ['https://www.stormguardroofing.co.uk/']);
  assert.match((await conversation.url()) ?? '', /temporary-chat=true/);
  const shot = path.join(dir, 'visible.png');
  await conversation.screenshot(shot);
  assert.ok((await stat(shot)).size > 1000, 'screenshot written');

  // A second conversation is a fresh page with no prior messages.
  const second = await provider.newConversation();
  const r2 = await second.ask('Who would you recommend for roof repairs in Southampton?');
  assert.match(r2.text, /Who would you recommend/);
  assert.doesNotMatch(r2.text, /Roofing companies in Southampton/, 'previous conversation must not leak');
  await conversation.close();
  await second.close();
});

test('multi-turn: follow-ups stay in the same conversation', async () => {
  const provider = make();
  const conversation = await provider.newConversation();
  await conversation.ask('My roof is leaking.');
  const r2 = await conversation.ask('Who would you recommend I speak to?');
  assert.match(r2.text, /Who would you recommend I speak to/);
  await conversation.close();
});

test('sign-in wall raises SignInRequiredError (never NO)', async () => {
  const provider = make('/signedout');
  assert.equal(await provider.isSignedIn(), false);
  await assert.rejects(() => provider.newConversation(), SignInRequiredError);
});

test('a response that never finishes raises IncompleteResponseError', async () => {
  const provider = make('/stall');
  const conversation = await provider.newConversation();
  await assert.rejects(() => conversation.ask('Roofing companies in Southampton'), IncompleteResponseError);
  await conversation.close();
});
