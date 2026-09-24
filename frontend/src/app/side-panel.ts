import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Auth } from './auth';
import { Conversation, Conversations } from './conversations';
import { Theme } from './theme';
import { LogoMark } from './logo-mark';

const LABELS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

@Component({
  selector: 'app-side-panel',
  imports: [RouterLink, RouterLinkActive, LogoMark],
  host: { role: 'navigation', 'aria-label': 'Sidebar' },
  template: `
    <div class="brand-row">
      <a class="brand" routerLink="/app/chat" (click)="pick.emit()">
        <app-logo-mark />
        <span class="word">savvyai</span>
      </a>
    </div>

    <div class="links">
      <!-- exact, so an open conversation's row is the only thing lit, not this too -->
      <a routerLink="/app/chat" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }"
        ariaCurrentWhenActive="page" (click)="pick.emit()">
        <svg class="ic" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 11.5v-7Z"
            fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
        Chat
      </a>
      <a routerLink="/app/connections" routerLinkActive="on" ariaCurrentWhenActive="page" (click)="pick.emit()">
        <svg class="ic" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M9 6.5 10.6 4.9a2.6 2.6 0 1 1 3.7 3.7L12.7 10" fill="none" stroke="currentColor"
            stroke-width="1.4" stroke-linecap="round" />
          <path d="M11 13.5 9.4 15.1a2.6 2.6 0 1 1-3.7-3.7L7.3 10" fill="none" stroke="currentColor"
            stroke-width="1.4" stroke-linecap="round" />
          <path d="M8.3 11.7 11.7 8.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        Connections
      </a>
    </div>

    <div class="convos">
      @if (groups().length === 0) {
        <p class="small none">No conversations yet.</p>
      }

      @for (group of groups(); track group.label) {
        <h2 class="group">{{ group.label }}</h2>
        <ul class="rows">
          @for (c of group.items; track c.id) {
            <li class="row" [attr.data-cid]="c.id">
              @if (renaming() === c.id) {
                <input
                  #box
                  class="rename"
                  [value]="c.title"
                  aria-label="Conversation title"
                  (keydown.enter)="commit(c.id, box.value)"
                  (keydown.escape)="cancel($event)"
                  (blur)="commit(c.id, box.value)" />
              } @else {
                <a
                  class="convo"
                  [routerLink]="['/app/chat', c.id]"
                  routerLinkActive="on"
                  ariaCurrentWhenActive="page"
                  (click)="pick.emit()">
                  <svg class="ic" viewBox="0 0 20 20" aria-hidden="true">
                    <path
                      d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 11.5v-7Z"
                      fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                  </svg>
                  <span class="title">{{ c.title }}</span>
                </a>
                <span class="acts">
                  <button class="act edit" type="button" title="Rename" (click)="startRename(c.id)">
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M4 16l.9-3.6 8.4-8.4 2.7 2.7-8.4 8.4L4 16Z" />
                      <path d="M14.1 3.2l1-1a1.4 1.4 0 0 1 2 0l.7.7a1.4 1.4 0 0 1 0 2l-1 1-2.7-2.7Z" />
                    </svg>
                    <span class="sr-only">Rename {{ c.title }}</span>
                  </button>
                  <button class="act del" type="button" title="Delete" (click)="remove(c)">
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <rect x="8.6" y="3.4" width="2.8" height="1.8" rx=".9" />
                      <rect x="4.5" y="4.6" width="11" height="1.5" rx=".75" />
                      <path fill-rule="evenodd"
                        d="M5.6 7h8.8l-.6 8.6a1.6 1.6 0 0 1-1.6 1.4H7.8a1.6 1.6 0 0 1-1.6-1.4L5.6 7Zm2.4 1.8h.9V15H8V8.8Zm1.55 0h.9V15h-.9V8.8Zm1.55 0h.9V15h-.9V8.8Z" />
                    </svg>
                    <span class="sr-only">Delete {{ c.title }}</span>
                  </button>
                </span>
              }
            </li>
          }
        </ul>
      }
    </div>

    <div class="foot">
      <span class="avatar" aria-hidden="true">{{ initial() }}</span>
      <span class="who small">{{ user() }}</span>
      <button
        class="icon-btn"
        type="button"
        [attr.aria-label]="theme.mode() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        [attr.title]="theme.mode() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        (click)="theme.toggle()">
        @if (theme.mode() === 'dark') {
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9 4.5 4.5"
              stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        } @else {
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M16.5 12.4A6.6 6.6 0 1 1 7.6 3.5a5.2 5.2 0 0 0 8.9 8.9Z" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        }
      </button>
      <button class="icon-btn" type="button" aria-label="Sign out" title="Sign out" (click)="signOut()">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8 3.5H5.5A1.5 1.5 0 0 0 4 5v10a1.5 1.5 0 0 0 1.5 1.5H8" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M12.5 13.5 16 10l-3.5-3.5M16 10H8" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-block-size: 0; }

    /* the shell's floating toggle sits over this row's far end while the panel is open */
    .brand-row {
      display: flex; align-items: center; block-size: 3rem; flex: none;
      padding-inline: var(--s-4) calc(36px + var(--s-4) + var(--s-2));
    }

    /* Active rows run edge to edge with an accent bar on the panel's edge. The tint is
       mixed into --mat (the panel surface) so it stays opaque: .acts inherits it to
       mask the title tail. */
    :host { --active-bg: color-mix(in oklab, var(--action) 12%, var(--mat)); }

    .links { display: grid; gap: 2px; flex: none; padding-block-start: var(--s-2); }
    .links a {
      position: relative;
      min-block-size: 44px; display: flex; align-items: center; gap: var(--s-3); padding-inline: var(--s-4);
      color: var(--ink-2); text-decoration: none;
      font: 500 1rem/1.35 var(--ff-text);
      transition: background-color var(--t-state) var(--ease);
    }
    .links a:hover { background: var(--mist); color: var(--ink); }
    .links a.on, .row:has(.convo.on) { background: var(--active-bg); }
    .links a.on { color: var(--ink); }
    .links a.on::before, .row:has(.convo.on)::before {
      content: ""; position: absolute; inset-block: 0; inset-inline-start: 0;
      inline-size: 4px; border-start-end-radius: 4px; border-end-end-radius: 4px;
      background: var(--action);
    }
    .links a.on .ic, .convo.on .ic { color: var(--action); }
    .ic { inline-size: 20px; block-size: 20px; flex: none; }

    .convos { flex: 1; min-block-size: 0; overflow-y: auto; padding-block-end: var(--s-5); }
    /* sits in the slot a group label would take, with the same top spacing, so the list
       reads as its own section below the nav links whether or not it has rows */
    .none { color: var(--ink-3); padding: var(--s-5) var(--s-4) 0; }

    .group {
      font-family: var(--ff-text); font-size: 0.875rem; line-height: 1.45; font-weight: 700;
      letter-spacing: 0; color: var(--ink-2);
      padding: var(--s-5) var(--s-4) var(--s-1);
    }
    .rows { display: grid; gap: 2px; list-style: none; padding: 0; }

    .row {
      position: relative;
      display: grid; grid-template-columns: minmax(0, 1fr); align-items: center;
      transition: background-color var(--t-state) var(--ease);
    }
    /* inherit so the buttons mask the title tail they sit over */
    .acts {
      position: absolute; inset-block: 0; inset-inline-end: 0;
      display: flex; align-items: center; gap: var(--s-1);
      padding-inline: var(--s-2) var(--s-3);
    }
    /* Up on hover, or while keyboard focus is on a button itself. Not :focus-within: a
       clicked button or a refocused title kept them up after the cursor had left. */
    .row:hover, .row:has(.act:focus-visible) { background: var(--mist); }
    .row:hover .acts, .row:has(.act:focus-visible) .acts { background: inherit; }
    /* full-bleed rows sit in a scroller, which clips an outside ring to two stray lines */
    .links a:focus-visible, .convo:focus-visible { outline-offset: -2px; }

    .convo {
      min-block-size: 44px; display: flex; align-items: center; gap: var(--s-3);
      padding: var(--s-2) var(--s-4);
      color: var(--ink-2); text-decoration: none;
      font-size: 1rem; line-height: 1.35; font-weight: 500;
    }
    .convo.on { color: var(--ink); }
    .title { min-inline-size: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* touch has no hover, so the buttons stay up: end the title before them instead */
    @media (hover: none) { .convo { padding-inline-end: calc(2 * 28px + var(--s-1) + var(--s-2) + var(--s-3)); } }

    .act {
      display: grid; place-items: center; inline-size: 28px; block-size: 28px;
      padding: 0; border: 0; border-radius: 999px; cursor: pointer;
      opacity: 0; pointer-events: none;
      transition: opacity var(--t-state) var(--ease), background-color var(--t-state) var(--ease),
                  color var(--t-state) var(--ease);
    }
    .act svg { inline-size: 16px; block-size: 16px; }
    .edit { background: none; color: var(--action); }
    .edit:hover { background: var(--mat); }
    .del { background: var(--bad-tint); color: var(--bad); }
    .del:hover { background: var(--bad); color: var(--paper); }
    .row:hover .act, .row:has(.act:focus-visible) .act { opacity: 1; pointer-events: auto; }
    @media (hover: none) { .act { opacity: 1; pointer-events: auto; } }

    .rename {
      grid-column: 1 / -1; min-block-size: 44px;
      inline-size: calc(100% - 2 * var(--s-3)); margin-inline: var(--s-3);
      padding: var(--s-2) var(--s-3);
      background: var(--sheet); color: var(--ink);
      border: 1px solid var(--rule-strong); border-radius: var(--r-control);
      font: 600 1rem/1.35 var(--ff-text);
    }

    .foot {
      flex: none; display: flex; align-items: center; gap: var(--s-2);
      padding: var(--s-3) var(--s-4);
      border-block-start: 1px solid var(--rule);
    }
    .avatar {
      display: grid; place-items: center; flex: none;
      inline-size: 32px; block-size: 32px; border-radius: 999px;
      background: var(--mist); color: var(--ink-2);
      font: 700 0.8125rem/1 var(--ff-text);
    }
    .who { color: var(--ink-2); min-inline-size: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-btn {
      flex: none; display: grid; place-items: center;
      inline-size: 32px; block-size: 32px;
      background: none; border: 0; cursor: pointer; color: var(--ink-2); border-radius: var(--r-control);
      transition: background-color var(--t-state) var(--ease), color var(--t-state) var(--ease);
    }
    .icon-btn:hover { background: var(--mist); color: var(--ink); }
    .icon-btn svg { inline-size: 18px; block-size: 18px; }
  `,
})
export class SidePanel {
  private readonly store = inject(Conversations);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  protected readonly theme = inject(Theme);
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Lets the shell close the mobile drawer when something in here is chosen. */
  readonly pick = output<void>();

  protected readonly user = this.auth.user;
  protected readonly initial = computed(() => (this.user() || '?').charAt(0).toUpperCase());
  protected readonly renaming = signal<string | null>(null);
  /** A fresh object each time, so refocusing the same row twice still notifies. */
  private readonly refocus = signal<{ id: string | null } | null>(null);

  protected readonly groups = computed(() => {
    const now = new Date();
    const dayStart = (back: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
    const [today, yesterday, week] = [dayStart(0), dayStart(1), dayStart(7)];
    const bucket = (at: number) =>
      at >= today ? 0 : at >= yesterday ? 1 : at >= week ? 2 : 3;

    const sorted = this.store.byRecency();
    return LABELS.map((label, i) => ({
      label,
      items: sorted.filter((c) => bucket(c.updatedAt) === i),
    })).filter((group) => group.items.length > 0);
  });

  constructor() {
    afterRenderEffect(() => {
      if (!this.renaming()) return;
      const el = this.box()?.nativeElement;
      el?.focus();
      el?.select();
    });

    // Committing, cancelling and deleting all destroy the element that had focus, which
    // would otherwise drop the caret to <body>.
    afterRenderEffect(() => {
      const target = this.refocus();
      if (!target) return;
      const root = this.host.nativeElement;
      const el = target.id
        ? root.querySelector<HTMLElement>(`[data-cid="${CSS.escape(target.id)}"] .convo`)
        : root.querySelector<HTMLElement>('.links a');
      el?.focus();
    });
  }

  protected startRename(id: string): void {
    this.renaming.set(id);
  }

  /** Stops the Escape bubbling to the shell's listener, which would shut the drawer. */
  protected cancel(event?: Event): void {
    event?.stopPropagation();
    const id = this.renaming();
    this.renaming.set(null);
    this.refocus.set({ id });
  }

  /** Escape clears `renaming` first, so the blur it causes lands here as a no-op. */
  protected commit(id: string, value: string): void {
    if (this.renaming() !== id) return;
    this.renaming.set(null);
    this.store.rename(id, value);
    this.refocus.set({ id });
  }

  // ponytail: native confirm. A custom dialog needs a focus trap to be correct, and a
  // bad one is worse than the platform's.
  protected remove(c: Conversation): void {
    if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
    const wasActive = this.router.url.split('?')[0] === `/app/chat/${c.id}`;
    this.store.remove(c.id);
    this.refocus.set({ id: null });
    if (!wasActive) return;
    const next = this.store.byRecency()[0];
    this.router.navigate(next ? ['/app/chat', next.id] : ['/app/chat']);
  }

  protected signOut(): void {
    // The cache is per user, but it outlives the session: do not leave their chats sitting
    // in a shared browser. The backend still has them for next time.
    this.store.clear();
    this.auth.signOut();
    this.router.navigate(['/']);
  }
}
