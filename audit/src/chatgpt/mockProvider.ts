import type { ChatGptResponse } from '../domain/types.ts';
import { SignInRequiredError } from '../domain/errors.ts';
import type { ChatGptConversation, ChatGptProvider } from './provider.ts';
import { writeFile } from 'node:fs/promises';

export type ScriptedAnswer = ChatGptResponse | Error | ((prompt: string, turn: number) => ChatGptResponse | Error);

export interface MockConversationScript {
  /** Answers in order; a function may inspect the prompt. */
  answers: ScriptedAnswer[];
  url?: string;
  /** Throw on screenshot to simulate a capture failure. */
  screenshotError?: Error;
}

export interface MockOptions {
  /** Conversations in the order the engine opens them (Visible, Recommended, Conversational, [Brand]). */
  conversations: MockConversationScript[];
  /** Simulate a signed-out state: every newConversation() throws SignInRequiredError. */
  signedOut?: boolean;
  /** Throw this from newConversation() for the nth conversation (0-based) to simulate a browser error. */
  openErrors?: Record<number, Error>;
}

export function textResponse(text: string, html?: string, links: string[] = []): ChatGptResponse {
  return { text, html: html ?? `<p>${text}</p>`, links };
}

/**
 * Test-only provider. Records every prompt per conversation so tests can assert
 * isolation between layers and continuity within the Conversational layer.
 */
export class MockChatGptProvider implements ChatGptProvider {
  readonly name = 'mock';
  readonly transcript: { conversation: number; prompt: string }[] = [];
  readonly screenshots: string[] = [];
  private opened = 0;
  private readonly options: MockOptions;

  constructor(options: MockOptions) {
    this.options = options;
  }

  async isSignedIn(): Promise<boolean> {
    return !this.options.signedOut;
  }

  async newConversation(): Promise<ChatGptConversation> {
    const index = this.opened++;
    if (this.options.signedOut) throw new SignInRequiredError();
    const openError = this.options.openErrors?.[index];
    if (openError) throw openError;
    const script = this.options.conversations[index];
    if (!script) throw new Error(`Mock has no script for conversation ${index}`);
    let turn = 0;
    const self = this;
    return {
      async url() {
        return script.url;
      },
      async ask(prompt) {
        self.transcript.push({ conversation: index, prompt });
        const answer = script.answers[turn];
        turn++;
        if (!answer) throw new Error(`Mock conversation ${index} has no answer for turn ${turn}`);
        const resolved = typeof answer === 'function' ? answer(prompt, turn) : answer;
        if (resolved instanceof Error) throw resolved;
        return resolved;
      },
      async screenshot(path) {
        if (script.screenshotError) throw script.screenshotError;
        await writeFile(path, 'mock-screenshot');
        self.screenshots.push(path);
      },
      async screenshotResponse(path) {
        if (script.screenshotError) throw script.screenshotError;
        await writeFile(path, 'mock-response-screenshot');
        self.screenshots.push(path);
      },
      async close() {},
    };
  }

  async dispose(): Promise<void> {}
}
