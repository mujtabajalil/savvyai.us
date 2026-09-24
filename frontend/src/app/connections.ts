import { Component, computed, signal } from '@angular/core';

/** What GET/POST /api/ezlynx returns. The password is never part of it. */
interface Connection {
  saved: boolean;
  connected: boolean;
  username: string | null;
  connectedAt: string | null;
  mfaPending: boolean;
  result?: 'connected' | 'mfa_required' | 'failed';
  message?: string | null;
}

@Component({
  selector: 'app-connections',
  template: `
    <div class="page pad">
    <h1>Connections</h1>

    <div class="card">
      <div class="row">
        <h3>EZLynx</h3>
        @if (state()?.connected) {
          <span class="tag tag-ok">Connected</span>
        } @else if (state()?.saved) {
          <span class="tag tag-warn">Saved, not signed in</span>
        } @else {
          <span class="tag tag-warn">Not connected</span>
        }
      </div>

      @if (showCredentials()) {
        <div class="notice notice-warn">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 1.5 19 18H1L10 1.5Zm0 6a1 1 0 0 0-1 1v3.2a1 1 0 0 0 2 0V8.5a1 1 0 0 0-1-1Zm0 7.2a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z"/>
          </svg>
          <span>
            EZLynx texts a one-time code the first time. This form turns into a code box
            when it does — type it there and the browser is trusted from then on, so later
            sign-ins use the saved username and password alone.
          </span>
        </div>

        <form (submit)="connect($event, user.value, pass.value)">
          <div class="field">
            <label for="ez-user">EZLynx username</label>
            <input #user id="ez-user" name="ezlynx-username" autocomplete="off"
                   placeholder="a.reyes@agency.com" [value]="state()?.username ?? ''" [disabled]="busy()">
          </div>
          <div class="field">
            <label for="ez-pass">EZLynx password</label>
            <input #pass id="ez-pass" name="ezlynx-password" type="password" autocomplete="off"
                   [disabled]="busy()" aria-describedby="ez-pass-help">
            <p class="help" id="ez-pass-help">
              Encrypted on the server and used to sign in again when the EZLynx session expires.
            </p>
          </div>
          <button class="btn btn-primary" type="submit" [disabled]="busy()">
            {{ busy() ? 'Signing in to EZLynx…' : 'Save and sign in' }}
          </button>
        </form>
      }

      @if (state()?.mfaPending) {
        <form (submit)="verify($event, code.value)">
          <div class="field">
            <label for="ez-code">One-time code</label>
            <input #code id="ez-code" name="one-time-code" inputmode="numeric" autocomplete="one-time-code"
                   [disabled]="busy()" aria-describedby="ez-code-help">
            <p class="help" id="ez-code-help">
              EZLynx just sent this. It is typed straight into the browser session and never stored.
            </p>
          </div>
          <button class="btn btn-primary" type="submit" [disabled]="busy()">
            {{ busy() ? 'Checking the code…' : 'Finish sign-in' }}
          </button>
        </form>
      }

      @if (busy()) {
        <p class="small muted" role="status">
          A real browser is signing in. The first run also has to start it, which takes about a minute.
        </p>
      }

      @if (error(); as message) {
        <p class="error small" role="alert">{{ message }}</p>
      }

      @if (state()?.connected) {
        <div class="notice notice-ok" role="status">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4.3 6.7-5 5a1 1 0 0 1-1.4 0l-2.2-2.2a1 1 0 1 1 1.4-1.4l1.5 1.5 4.3-4.3a1 1 0 1 1 1.4 1.4Z"/>
          </svg>
          <span>Signed in as {{ state()?.username }}. No code is needed from here on.</span>
        </div>
      }

      @if (state()?.saved && !state()?.mfaPending) {
        <div class="row">
          <button class="btn btn-secondary" type="button" [disabled]="busy()" (click)="reconnect()">
            Sign in again
          </button>
          <button class="btn btn-secondary" type="button" [disabled]="busy()" (click)="forget()">
            Forget credentials
          </button>
        </div>
      }
    </div>
    </div>
  `,
  styles: `
    .pad { padding-block: var(--s-7); }
    h1 { margin-block-end: var(--s-6); }
    .card { max-inline-size: 40rem; display: grid; gap: var(--s-5); }
    .row { display: flex; align-items: center; gap: var(--s-4); flex-wrap: wrap; }
    .muted { color: var(--ink-3); }
    .error { color: var(--bad); }
    .small { margin: 0; }
    form { display: grid; gap: var(--s-5); justify-items: start; }
    .field { inline-size: 100%; }
    .help { margin: 0; }
  `,
})
export class Connections {
  protected readonly state = signal<Connection | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The credentials form gives way to the code prompt, and to the connected card. */
  protected readonly showCredentials = computed(() => {
    const state = this.state();
    return !state?.mfaPending && !state?.connected;
  });

  constructor() {
    void this.run(() => this.api('', { method: 'GET' }));
  }

  protected connect(event: Event, username: string, password: string): void {
    event.preventDefault();
    if (!username.trim() || !password) {
      this.error.set('Both the EZLynx username and password are needed.');
      return;
    }
    void this.run(() => this.api('', { method: 'POST', body: JSON.stringify({ username, password }) }));
  }

  protected verify(event: Event, code: string): void {
    event.preventDefault();
    if (!code.trim()) {
      this.error.set('Type the code EZLynx sent.');
      return;
    }
    void this.run(() => this.api('/mfa', { method: 'POST', body: JSON.stringify({ code }) }));
  }

  protected reconnect(): void {
    void this.run(() => this.api('/login', { method: 'POST' }));
  }

  protected forget(): void {
    void this.run(() => this.api('', { method: 'DELETE' }));
  }

  /** Every call ends the same way: new state, or one plain sentence about why not. */
  private async run(call: () => Promise<Connection>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const state = await call();
      this.state.set(state);
      if (state.result === 'failed') this.error.set(state.message ?? 'EZLynx did not accept that.');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async api(path: string, init: RequestInit): Promise<Connection> {
    const response = await fetch(`/api/ezlynx${path}`, {
      ...init,
      headers: { 'content-type': 'application/json' },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // FastAPI puts a string in `detail`, or a list when a field failed validation.
      const detail = (body as { detail?: unknown } | null)?.detail;
      if (typeof detail === 'string') throw new Error(detail);
    }
    // A dev server with no /api proxy answers 200 with index.html. Say that, do not render it.
    if (body === null || typeof (body as Connection).saved !== 'boolean') {
      throw new Error('The backend did not answer. Start it, and restart the dev server so /api is proxied.');
    }
    return body as Connection;
  }
}
