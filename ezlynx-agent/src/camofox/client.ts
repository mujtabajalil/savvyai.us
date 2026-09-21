/**
 * Typed REST client for camofox-browser.
 *
 * Only the endpoints this agent needs. Response shapes follow openapi.json.
 * Retries are deliberately narrow: idempotent reads and transport faults only.
 * A failed click is never replayed automatically — the step runner decides,
 * because a half-applied form action is not safe to repeat blindly.
 */

import type { Logger } from '../log/logger.js';

export class CamofoxError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'CamofoxError';
  }

  /** Refs went stale / the page changed underneath us; re-read and retry. */
  get isStale(): boolean {
    return this.status === 409 || this.code === 'stale_refs';
  }

  /** Tab is gone because the browser restarted — a new tab is required. */
  get isGone(): boolean {
    return this.status === 410 || this.code === 'browser_restarted';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Element exists but cannot take this action (e.g. fill on a mat-select). */
  get isNotActionable(): boolean {
    return this.status === 422 || this.code === 'element_not_actionable';
  }
}

export interface CamofoxClientOptions {
  baseUrl: string;
  accessKey?: string;
  userId: string;
  sessionKey?: string;
  timeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface TabInfo {
  tabId: string;
  url?: string;
  title?: string;
}

export interface SnapshotResult {
  snapshot?: string;
  url?: string;
  title?: string;
  truncated?: boolean;
  totalChars?: number;
  nextOffset?: number | null;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export class CamofoxClient {
  readonly userId: string;
  readonly sessionKey: string;

  private readonly baseUrl: string;
  private readonly accessKey: string;
  private readonly timeoutMs: number;
  private readonly log?: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CamofoxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.accessKey = options.accessKey ?? '';
    this.userId = options.userId;
    this.sessionKey = options.sessionKey ?? 'default';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.log = options.logger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; retries?: number } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const retries = opts.retries ?? 2;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.accessKey) headers.authorization = `Bearer ${this.accessKey}`;

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = text ? safeJson(text) : undefined;

        if (!response.ok) {
          const record = (payload ?? {}) as Record<string, unknown>;
          const error = new CamofoxError(
            typeof record.error === 'string' ? record.error : `HTTP ${response.status}`,
            response.status,
            typeof record.code === 'string' ? record.code : undefined,
            payload,
          );
          if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
            lastError = error;
            await backoff(attempt);
            continue;
          }
          throw error;
        }

        return payload as T;
      } catch (err) {
        if (err instanceof CamofoxError) throw err;
        lastError = err;
        const aborted = err instanceof Error && err.name === 'AbortError';
        if (attempt < retries) {
          this.log?.debug('camofox request retry', { path, attempt, reason: aborted ? 'timeout' : String(err) });
          await backoff(attempt);
          continue;
        }
        if (aborted) throw new CamofoxError(`Request to ${path} timed out after ${timeoutMs}ms`, 0, 'timeout');
        throw new CamofoxError(`Request to ${path} failed: ${String(err)}`, 0, 'transport');
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async health(): Promise<{ status?: string; [k: string]: unknown }> {
    return this.request('GET', '/health', undefined, { retries: 0 });
  }

  /**
   * Create a tab. `trace: true` starts Playwright tracing on the session, which
   * records a screenshot and DOM snapshot for every action — the best way to
   * review timings afterwards. Traces are written when the session closes.
   */
  async createTab(url?: string, options: { trace?: boolean } = {}): Promise<TabInfo> {
    return this.request<TabInfo>('POST', '/tabs', {
      userId: this.userId,
      sessionKey: this.sessionKey,
      ...(url ? { url } : {}),
      ...(options.trace ? { trace: true } : {}),
    });
  }

  /** Trace files recorded for this user. */
  async listTraces(): Promise<{ traces?: Array<{ filename: string; sizeBytes: number }> }> {
    return this.request('GET', `/sessions/${encodeURIComponent(this.userId)}/traces`);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.request('DELETE', `/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(this.userId)}`);
  }

  async navigate(tabId: string, url: string): Promise<unknown> {
    return this.request('POST', `/tabs/${encodeURIComponent(tabId)}/navigate`, { userId: this.userId, url });
  }

  async snapshot(tabId: string, offset = 0): Promise<SnapshotResult> {
    const query = `userId=${encodeURIComponent(this.userId)}${offset ? `&offset=${offset}` : ''}`;
    return this.request<SnapshotResult>('GET', `/tabs/${encodeURIComponent(tabId)}/snapshot?${query}`);
  }

  async waitForPage(tabId: string, opts: { timeout?: number; waitForNetwork?: boolean } = {}): Promise<void> {
    await this.request('POST', `/tabs/${encodeURIComponent(tabId)}/wait`, {
      userId: this.userId,
      timeout: opts.timeout ?? 10_000,
      waitForNetwork: opts.waitForNetwork ?? true,
    });
  }

  async click(tabId: string, target: { ref?: string; selector?: string }): Promise<unknown> {
    return this.request('POST', `/tabs/${encodeURIComponent(tabId)}/click`, {
      userId: this.userId,
      ...target,
    }, { retries: 0 });
  }

  async type(
    tabId: string,
    target: { ref?: string; selector?: string },
    text: string,
    opts: { mode?: 'fill' | 'keyboard'; pressEnter?: boolean } = {},
  ): Promise<unknown> {
    return this.request('POST', `/tabs/${encodeURIComponent(tabId)}/type`, {
      userId: this.userId,
      text,
      mode: opts.mode ?? 'fill',
      ...(opts.pressEnter ? { pressEnter: true } : {}),
      ...target,
    }, { retries: 0 });
  }

  /** Native <select> only — Playwright's selectOption throws on mat-select. */
  async selectNative(tabId: string, target: { ref?: string; selector?: string }, option: string): Promise<unknown> {
    return this.request('POST', `/tabs/${encodeURIComponent(tabId)}/select`, {
      userId: this.userId,
      option,
      ...target,
    }, { retries: 0 });
  }

  async press(tabId: string, key: string): Promise<unknown> {
    return this.request('POST', `/tabs/${encodeURIComponent(tabId)}/press`, { userId: this.userId, key }, { retries: 0 });
  }

  /**
   * Run JS in the page. `expression` must be a self-contained expression;
   * a returned promise is awaited by the server. Bounded by the server's
   * HANDLER_TIMEOUT_MS (30s default) regardless of the client timeout.
   */
  async evaluate<T>(tabId: string, expression: string, opts: { timeoutMs?: number } = {}): Promise<T> {
    const result = await this.request<{ ok: boolean; result: T }>(
      'POST',
      `/tabs/${encodeURIComponent(tabId)}/evaluate`,
      { userId: this.userId, expression },
      { retries: 0, timeoutMs: opts.timeoutMs },
    );
    return result.result;
  }

  async currentUrl(tabId: string): Promise<string> {
    return this.evaluate<string>(tabId, 'window.location.href');
  }

  /**
   * Destroy this user's session. The persistence plugin checkpoints storage
   * state on `session:destroyed`, so this is how a fresh login gets written to
   * disk without waiting for a reaper or a server shutdown.
   */
  async destroySession(): Promise<void> {
    await this.request('DELETE', `/sessions/${encodeURIComponent(this.userId)}`, undefined, { timeoutMs: 60_000 });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(2000, 150 * 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
