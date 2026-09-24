import { Injectable, signal } from '@angular/core';

const KEY = 'savvy.user';

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The backend checks the password and sets an HttpOnly session cookie. The name kept here
 *  is only for the guard and the UI — it grants nothing on its own.
 *
 *  It lives in localStorage, not sessionStorage, because the cookie is per-browser: a tab
 *  that kept an old name after another tab signed in as someone else would show one
 *  user's cache while the backend answered as the other. */
@Injectable({ providedIn: 'root' })
export class Auth {
  readonly user = signal(stored());

  constructor() {
    // Another tab signed in or out: follow it, since the cookie already has.
    addEventListener('storage', (event) => {
      if (event.key === KEY) this.user.set(event.newValue);
    });
  }

  async signIn(user: string, pass: string): Promise<boolean> {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    }).catch(() => null);
    if (!res?.ok) return false;
    this.remember(user);
    return true;
  }

  signOut(): void {
    void fetch('/api/logout', { method: 'POST' }).catch(() => {});
    this.remember(null);
  }

  private remember(user: string | null): void {
    try {
      if (user) localStorage.setItem(KEY, user);
      else localStorage.removeItem(KEY);
    } catch {
      // Blocked storage: the name lasts for this page only, the cookie still works.
    }
    this.user.set(user);
  }
}
