import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import type { ChatGptResponse } from '../domain/types.ts';
import { ChatGptUnavailableError, IncompleteResponseError, SignInRequiredError } from '../domain/errors.ts';
import type { ChatGptConversation, ChatGptProvider } from './provider.ts';

export interface PlaywrightProviderOptions {
  /** Persistent Chrome profile directory. Keeps the user's normal ChatGPT sign-in between audits. */
  userDataDir: string;
  /** Show the browser (default true: the user must be able to sign in normally). */
  headless?: boolean;
  /** "chrome" uses the user's installed Google Chrome; undefined uses Playwright's bundled Chromium. */
  channel?: 'chrome' | 'msedge';
  /** Base URL of the consumer product. */
  baseUrl?: string;
  /** Use Temporary Chat so memories and history do not influence results (default true). */
  temporaryChat?: boolean;
  /** Max time to wait for ChatGPT to finish a response. */
  responseTimeoutMs?: number;
  navigationTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * DOM hooks for chatgpt.com. Kept in one place so a UI change is a one-line fix.
 * Several alternatives are listed per element because the site changes often.
 */
export const SELECTORS = {
  composer: '#prompt-textarea, div[contenteditable="true"][data-virtualkeyboard], textarea[data-id="root"]',
  send: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]',
  stop: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]',
  assistant: '[data-message-author-role="assistant"]',
  assistantBody: '.markdown, [data-message-author-role="assistant"] > div',
  login: '[data-testid="login-button"], a[href*="/auth/login"], button[data-testid="mobile-login-button"]',
  profile: '[data-testid="profile-button"], [data-testid="accounts-profile-button"], button[aria-label*="profile" i]',
  errorBanner: 'text=/something went wrong|network error|an error occurred|too many requests|unusual activity/i',
  loginDialog: 'div[role="dialog"]:has-text("Log in")',
  stayLoggedOut: 'a:has-text("Stay logged out"), button:has-text("Stay logged out")',
  temporaryBadge: 'text=/temporary chat/i',
} as const;

const DEFAULT_TIMEOUT = 180_000;

/** Playwright errors carry a multi-line call log with ANSI codes; keep the human-readable first line. */
function firstLine(message: string): string {
  return (message.split('\n')[0] ?? message).replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/**
 * Drives the normal consumer ChatGPT website with visible browser controls in a
 * persistent Chrome profile. Never sees or stores the user's password: the user
 * signs in themselves in the same browser window via connectForSignIn().
 */
export class PlaywrightChatGptProvider implements ChatGptProvider {
  readonly name: string;
  private context: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private readonly opts: Required<Omit<PlaywrightProviderOptions, 'channel' | 'log'>> &
    Pick<PlaywrightProviderOptions, 'channel' | 'log'>;

  constructor(options: PlaywrightProviderOptions) {
    this.opts = {
      headless: false,
      baseUrl: 'https://chatgpt.com',
      temporaryChat: true,
      responseTimeoutMs: DEFAULT_TIMEOUT,
      navigationTimeoutMs: 60_000,
      ...options,
    };
    this.name = `playwright-chatgpt${this.opts.channel ? `-${this.opts.channel}` : ''}${this.opts.headless ? '-headless' : ''}`;
  }

  private log(msg: string): void {
    this.opts.log?.(`[chatgpt] ${msg}`);
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) {
      // The 'close' handler clears this.context when the user closes the window; a
      // context whose browser is disconnected is also treated as gone.
      const browser = this.context.browser();
      if (!browser || browser.isConnected()) return this.context;
      this.context = undefined;
    }
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = undefined;
      });
    }
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    await mkdir(this.opts.userDataDir, { recursive: true });
    const common = {
      headless: this.opts.headless,
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
      ignoreDefaultArgs: ['--enable-automation'],
    };
    try {
      this.context = await chromium.launchPersistentContext(this.opts.userDataDir, {
        ...common,
        ...(this.opts.channel ? { channel: this.opts.channel } : {}),
      });
      this.log(`launched ${this.opts.channel ?? 'bundled chromium'} (${this.opts.headless ? 'headless' : 'headed'})`);
    } catch (err) {
      if (!this.opts.channel) throw new ChatGptUnavailableError(`Could not launch browser: ${firstLine((err as Error).message)}`, { cause: err });
      this.log(`channel ${this.opts.channel} failed (${(err as Error).message}); falling back to bundled chromium`);
      this.context = await chromium.launchPersistentContext(this.opts.userDataDir, common);
    }
    this.context.setDefaultTimeout(this.opts.navigationTimeoutMs);
    this.context.on('close', () => {
      this.context = undefined;
    });
    return this.context;
  }

  private chatUrl(): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    return this.opts.temporaryChat ? `${base}/?temporary-chat=true` : `${base}/`;
  }

  /** Navigate a page to a clean chat and make sure ChatGPT is usable and signed in. */
  private async openChat(page: Page): Promise<void> {
    try {
      await page.goto(this.chatUrl(), { waitUntil: 'domcontentloaded', timeout: this.opts.navigationTimeoutMs });
    } catch (err) {
      throw new ChatGptUnavailableError(`Could not open ChatGPT: ${firstLine((err as Error).message)}`, { cause: err });
    }
    await this.waitPastChallenge(page);
    const composer = page.locator(SELECTORS.composer).first();
    const login = page.locator(SELECTORS.login).first();
    const dialog = page.locator(SELECTORS.loginDialog).first();

    const deadline = Date.now() + this.opts.navigationTimeoutMs;
    while (Date.now() < deadline) {
      if ((await dialog.isVisible().catch(() => false)) || (await login.isVisible().catch(() => false))) {
        throw new SignInRequiredError();
      }
      if (await composer.isVisible().catch(() => false)) {
        // Signed-out visitors may still see a composer; require a signed-in session so Temporary Chat is honoured.
        if (await this.looksSignedOut(page)) throw new SignInRequiredError();
        return;
      }
      await page.waitForTimeout(500);
    }
    if (/chatgpt\.com|openai\.com/i.test(page.url()) === false) {
      throw new ChatGptUnavailableError(`Unexpected page: ${page.url()}`);
    }
    throw new ChatGptUnavailableError('ChatGPT composer did not appear.');
  }

  private async looksSignedOut(page: Page): Promise<boolean> {
    const profile = await page.locator(SELECTORS.profile).first().isVisible().catch(() => false);
    if (profile) return false;
    const login = await page.locator(SELECTORS.login).first().isVisible().catch(() => false);
    if (login) return true;
    const stayOut = await page.locator(SELECTORS.stayLoggedOut).first().isVisible().catch(() => false);
    if (stayOut) return true;
    // No profile button but no login button either (e.g. narrow layout): check for the auth links in the DOM.
    const authLinks = await page.locator('a[href*="/auth/login"], a[href*="auth.openai.com"]').count().catch(() => 0);
    return authLinks > 0;
  }

  /** Cloudflare interstitials ("Just a moment...") clear themselves in a real browser; wait briefly. */
  private async waitPastChallenge(page: Page): Promise<void> {
    const deadline = Date.now() + Math.min(this.opts.navigationTimeoutMs, 45_000);
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => '');
      if (!/just a moment|attention required|verify you are human/i.test(title)) return;
      await page.waitForTimeout(1000);
    }
    throw new ChatGptUnavailableError('ChatGPT is showing a verification challenge. Complete it in the browser window and retry.');
  }

  async isSignedIn(): Promise<boolean> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      await page.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded', timeout: this.opts.navigationTimeoutMs });
      await this.waitPastChallenge(page);
      await page.locator(`${SELECTORS.composer}, ${SELECTORS.login}, ${SELECTORS.profile}`).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      return !(await this.looksSignedOut(page));
    } catch {
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Opens ChatGPT in the (visible) persistent browser so the user can sign in
   * normally. Resolves true once a signed-in session is detected. The password
   * is typed by the user into ChatGPT's own page and is never seen by this code.
   */
  async connectForSignIn(timeoutMs = 10 * 60_000): Promise<boolean> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      await page.goto(`${this.opts.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: this.opts.navigationTimeoutMs });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (page.isClosed()) return false;
        const url = page.url();
        if (/chatgpt\.com/i.test(url)) {
          const composerVisible = await page.locator(SELECTORS.composer).first().isVisible().catch(() => false);
          if (composerVisible && !(await this.looksSignedOut(page))) {
            this.log('signed-in session detected');
            return true;
          }
        }
        await page.waitForTimeout(2000);
      }
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async newConversation(): Promise<ChatGptConversation> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      await this.openChat(page);
    } catch (err) {
      await page.close().catch(() => undefined);
      throw err;
    }
    const badge = await page.locator(SELECTORS.temporaryBadge).first().isVisible().catch(() => false);
    this.log(`new conversation opened (${badge ? 'Temporary Chat' : 'temporary badge not detected'})`);
    return new PlaywrightConversation(page, this.opts.responseTimeoutMs, (m) => this.log(m));
  }

  async dispose(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    await ctx?.close().catch(() => undefined);
  }
}

class PlaywrightConversation implements ChatGptConversation {
  private turns = 0;
  private readonly page: Page;
  private readonly responseTimeoutMs: number;
  private readonly log: (msg: string) => void;
  constructor(page: Page, responseTimeoutMs: number, log: (msg: string) => void) {
    this.page = page;
    this.responseTimeoutMs = responseTimeoutMs;
    this.log = log;
  }

  async url(): Promise<string | undefined> {
    const u = this.page.url();
    return u && u !== 'about:blank' ? u : undefined;
  }

  async ask(prompt: string): Promise<ChatGptResponse> {
    const page = this.page;
    const before = await page.locator(SELECTORS.assistant).count();
    const composer = page.locator(SELECTORS.composer).first();
    try {
      await composer.click({ timeout: 15_000 });
      await composer.fill(prompt, { timeout: 15_000 }).catch(async () => {
        await page.keyboard.type(prompt);
      });
    } catch (err) {
      throw new ChatGptUnavailableError(`Could not type into the ChatGPT composer: ${firstLine((err as Error).message)}`, { cause: err });
    }
    const send = page.locator(SELECTORS.send).first();
    if (await send.isVisible().catch(() => false)) {
      await send.click({ timeout: 10_000 }).catch(() => page.keyboard.press('Enter'));
    } else {
      await page.keyboard.press('Enter');
    }
    this.turns++;
    this.log(`turn ${this.turns} sent (${prompt.length} chars)`);

    // Wait for a new assistant message (or the stop button) to appear.
    const stop = page.locator(SELECTORS.stop).first();
    const appeared = Date.now() + 45_000;
    while (Date.now() < appeared) {
      if (await page.locator(SELECTORS.loginDialog).first().isVisible().catch(() => false)) throw new SignInRequiredError();
      if ((await page.locator(SELECTORS.assistant).count()) > before) break;
      if (await stop.isVisible().catch(() => false)) break;
      await page.waitForTimeout(300);
    }
    if ((await page.locator(SELECTORS.assistant).count()) <= before && !(await stop.isVisible().catch(() => false))) {
      if (await page.locator(SELECTORS.errorBanner).first().isVisible().catch(() => false)) {
        throw new IncompleteResponseError('ChatGPT displayed an error instead of a response.');
      }
      throw new IncompleteResponseError('ChatGPT did not start responding.');
    }

    // Wait for generation to finish: stop button gone and text stable.
    const deadline = Date.now() + this.responseTimeoutMs;
    let lastText = '';
    let stableSince = Date.now();
    while (true) {
      if (Date.now() > deadline) throw new IncompleteResponseError('ChatGPT was still generating when the time limit was reached.');
      const generating = await stop.isVisible().catch(() => false);
      const text = await this.lastAssistantText();
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      }
      if (!generating && text.length > 0 && Date.now() - stableSince > 1500) break;
      await page.waitForTimeout(400);
    }
    if (await page.locator(SELECTORS.errorBanner).first().isVisible().catch(() => false)) {
      throw new IncompleteResponseError('ChatGPT displayed an error while responding.');
    }

    const last = page.locator(SELECTORS.assistant).last();
    const text = (await last.innerText().catch(() => '')).trim();
    const html = await last.innerHTML().catch(() => '');
    const links = await last
      .locator('a[href]')
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
      .catch(() => []);
    if (!text) throw new IncompleteResponseError('ChatGPT response was empty.');
    this.log(`turn ${this.turns} answered (${text.length} chars, ${links.length} links)`);
    await last.scrollIntoViewIfNeeded().catch(() => undefined);
    return { text, html, links: [...new Set(links)] };
  }

  private async lastAssistantText(): Promise<string> {
    return (await this.page.locator(SELECTORS.assistant).last().innerText().catch(() => '')).trim();
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true, timeout: 30_000 });
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }
}
