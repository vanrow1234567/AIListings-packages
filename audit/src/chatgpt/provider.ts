import type { ChatGptResponse } from '../domain/types.ts';

/**
 * The only seam between the audit engine and the ChatGPT consumer website.
 * Implementations must talk to the real chatgpt.com UI (see PlaywrightChatGptProvider);
 * the MockChatGptProvider exists for unit tests only and must never be used for a live audit.
 */
export interface ChatGptConversation {
  /** URL of the conversation, when ChatGPT exposes one (Temporary Chats often do not). */
  url(): Promise<string | undefined>;
  /** Submit a message, wait until ChatGPT has finished responding, return the displayed answer. */
  ask(prompt: string): Promise<ChatGptResponse>;
  /** Save a full-page screenshot of the current state to `path`. */
  screenshot(path: string): Promise<void>;
  /** Save only the latest assistant response at readable resolution when supported. */
  screenshotResponse?(path: string): Promise<void>;
  /** Close this conversation (tab). */
  close(): Promise<void>;
}

export interface ChatGptProvider {
  readonly name: string;
  /** Open ChatGPT in a fresh, clean conversation (Temporary Chat where possible). Throws SignInRequiredError when a sign-in is needed. */
  newConversation(): Promise<ChatGptConversation>;
  /** Cheap check used by the UI to decide whether to show Connect ChatGPT. */
  isSignedIn(): Promise<boolean>;
  /** Release the browser. */
  dispose(): Promise<void>;
}
