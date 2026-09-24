import { Injectable, signal } from '@angular/core';

const KEY = 'savvy.theme';
type Mode = 'light' | 'dark';

function stored(): Mode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** Explicit choice wins; otherwise styles.css itself follows prefers-color-scheme. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly mode = signal<Mode>(
    stored() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );

  toggle(): void {
    const next: Mode = this.mode() === 'dark' ? 'light' : 'dark';
    this.mode.set(next);
    document.documentElement.dataset['theme'] = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // a toggle that forgets is a papercut, not a failure worth surfacing
    }
  }
}
