/** Raised by the ChatGPT adapter when the consumer site asks the user to sign in. */
export class SignInRequiredError extends Error {
  readonly code = 'SIGN_IN_REQUIRED' as const;
  constructor(message = 'ChatGPT is asking the user to sign in.') {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

/** Any technical failure while talking to ChatGPT. Never becomes a NO. */
export class ChatGptUnavailableError extends Error {
  readonly code = 'CHATGPT_ERROR' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatGptUnavailableError';
  }
}

/** ChatGPT returned but the answer was empty / truncated / still generating. */
export class IncompleteResponseError extends ChatGptUnavailableError {
  constructor(message = 'ChatGPT did not return a usable, complete response.') {
    super(message);
    this.name = 'IncompleteResponseError';
  }
}
