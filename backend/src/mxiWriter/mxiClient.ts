import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { deriveTodoListUrl, loadMxiConfig, printProductionWarningIfNeeded, type MxiConfig } from './config.js';
import { login } from './selectors.js';

export type MxiSessionState =
  | { status: 'not_initialized' }
  | { status: 'ready' }
  | { status: 'failed'; reason: string };

/**
 * A single persistent authenticated Playwright browser context for the
 * server's lifetime — not one per request. Logs in once on startup; on
 * subsequent use, detects a dead session and re-authenticates exactly once.
 * If that re-auth also fails, the client moves to a terminal 'failed' state
 * and every future call surfaces that same error immediately, without
 * attempting Playwright again — this is what "halt all further approval
 * processing" means in an HTTP server with no batch loop to stop.
 */
export class MxiClient {
  readonly config: MxiConfig;
  readonly todoListUrl: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: MxiSessionState = { status: 'not_initialized' };

  constructor(config: MxiConfig = loadMxiConfig()) {
    this.config = config;
    // Empty baseUrl (not yet configured) degrades gracefully via
    // initialize()'s own check below, exactly as before — only a
    // non-empty-but-malformed baseUrl should fail loudly at construction.
    this.todoListUrl = config.baseUrl ? deriveTodoListUrl(config.baseUrl) : '';
  }

  getState(): MxiSessionState {
    return this.state;
  }

  /**
   * Attempts login. Does not throw — a failure here is recorded in state
   * and logged loudly, but the server still starts (GET endpoints and
   * /reject don't need MXI at all; /approve will fail clearly per-request
   * until this is resolved).
   */
  async initialize(): Promise<void> {
    printProductionWarningIfNeeded(this.config);

    if (!this.config.baseUrl || !this.config.username || !this.config.password) {
      this.state = {
        status: 'failed',
        reason:
          'MXI not fully configured (need MXI_STAGE_BASE_URL/MXI_PROD_BASE_URL, MXI_USERNAME, MXI_PASSWORD)',
      };
      console.error(`[mxiClient] ${this.state.reason}. /approve requests will fail until this is set.`);
      return;
    }

    try {
      this.browser = await chromium.launch({ headless: false });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      await login(this.page, this.config.username, this.config.password, this.config.baseUrl);
      this.state = { status: 'ready' };
      console.log(`[mxiClient] Logged in to MXI (${this.config.env}).`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.state = { status: 'failed', reason };
      console.error(`[mxiClient] Login failed: ${reason}. /approve requests will fail until this is resolved.`);
    }
  }

  /**
   * Returns the active, authenticated page. Re-authenticates once if the
   * session looks dead. Throws (which the caller records as a failed write,
   * never silently) if there is no session, or if re-auth also fails —
   * and in the re-auth-failure case, moves state to 'failed' so every
   * subsequent call fails immediately without retrying Playwright.
   */
  async getAuthenticatedPage(): Promise<Page> {
    if (this.state.status === 'failed') {
      throw new Error(`MXI session not established: ${this.state.reason}`);
    }
    if (this.state.status === 'not_initialized' || !this.page) {
      throw new Error('MXI client was never initialized.');
    }

    if (await this.isSessionAlive(this.page)) {
      return this.page;
    }

    console.warn('[mxiClient] MXI session appears to have expired. Re-authenticating once...');
    try {
      await login(this.page, this.config.username, this.config.password, this.config.baseUrl);
      if (!(await this.isSessionAlive(this.page))) {
        throw new Error('Session still not valid after re-authentication attempt.');
      }
      console.log('[mxiClient] Re-authentication succeeded.');
      return this.page;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.state = { status: 'failed', reason: `Re-authentication failed: ${reason}` };
      throw new Error(
        `MXI session lost and re-authentication failed (${reason}). Halting further approval processing until this is fixed.`,
      );
    }
  }

  /**
   * Persists the current authenticated context (cookies, localStorage) to
   * disk so a `playwright codegen --load-storage=<path>` session can start
   * already logged in, with no login flow to record. One-off diagnostic use
   * only (see mxiWriter/saveStorageState.ts) — not part of the writer path.
   */
  async saveStorageState(path: string): Promise<void> {
    if (!this.context) {
      throw new Error('MXI client was never initialized.');
    }
    await this.context.storageState({ path });
  }

  private async isSessionAlive(page: Page): Promise<boolean> {
    // Quick check: MXI may have already redirected an idle page to login.
    if (page.url().includes('login.jsp')) {
      return false;
    }
    // For stale sessions that haven't auto-redirected yet, navigate to a
    // known authenticated URL. MXI bounces unauthenticated requests to
    // login.jsp, so landing there means the session is dead.
    try {
      await page.goto(this.todoListUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      return !page.url().includes('login.jsp');
    } catch {
      // Navigation timeout or network error — treat as dead so re-auth fires.
      return false;
    }
  }

  async shutdown(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
