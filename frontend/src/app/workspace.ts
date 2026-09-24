import {
  Component,
  ElementRef,
  afterRenderEffect,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { Auth } from './auth';
import { SidePanel } from './side-panel';

const PANEL_KEY = 'savvy.sidebar';

/** Docked open on desktop unless collapsed before; phones always start with it away. */
function readOpen(): boolean {
  try {
    if (!matchMedia('(min-width: 64rem)').matches) return false;
    return localStorage.getItem(PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
}

@Component({
  selector: 'app-workspace',
  imports: [RouterOutlet, SidePanel],
  host: {
    '(document:keydown.escape)': 'close()',
    '(window:resize)': 'syncViewport()',
  },
  template: `
    <div class="shell" [class.open]="open()">
      <button
        #toggleBtn
        class="panel-toggle"
        type="button"
        aria-label="Sidebar"
        aria-controls="side-panel"
        [attr.aria-expanded]="open()"
        (click)="toggle()">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M8 4v12" />
        </svg>
      </button>

      <app-side-panel #panel id="side-panel" class="side" (pick)="close()" />

      @if (overlay() && open()) {
        <button class="scrim" type="button" aria-label="Close sidebar" (click)="close()"></button>
      }

      <main class="pane" [attr.inert]="(overlay() && open()) || null">
        <router-outlet />
      </main>
    </div>
  `,
  styles: `
    .shell {
      --panel-w: 17rem;
      position: relative; block-size: 100dvh; overflow: hidden;
      display: flex;
    }

    /* The panel keeps its width and slides out on a margin. Animating a grid column
       instead re-flowed the contents mid-collapse, which is what made it look broken. */
    .side {
      flex: none; inline-size: var(--panel-w);
      background: var(--mat); border-inline-end: 1px solid var(--rule);
      margin-inline-start: calc(var(--panel-w) * -1);
      /* hidden only once it has finished collapsing, so it leaves the tab order */
      visibility: hidden;
      transition: margin-inline-start var(--t-open) var(--ease),
                  visibility 0s linear var(--t-open);
    }
    .shell.open .side {
      margin-inline-start: 0; visibility: visible;
      transition: margin-inline-start var(--t-open) var(--ease), visibility 0s;
    }

    /* Anchored to the shell and centred in the 3rem strip the pane reserves, which is also
       the sidebar's brand row. Open, it rides at that row's far end, gliding with the panel;
       collapsed, it waits at the pane's top-left so the panel can always come back. Above
       the overlay drawer (z 30), so it closes the drawer from inside too. */
    .panel-toggle {
      position: absolute; z-index: 35;
      inset-block-start: calc((3rem - 36px) / 2); inset-inline-start: var(--s-3);
      display: grid; place-items: center;
      inline-size: 36px; block-size: 36px;
      border: 0; border-radius: var(--r-control); background: none; color: var(--ink-3);
      cursor: pointer;
      transition: inset-inline-start var(--t-open) var(--ease),
                  background-color var(--t-state) var(--ease), color var(--t-state) var(--ease);
    }
    .shell.open .panel-toggle { inset-inline-start: calc(var(--panel-w) - var(--s-4) - 36px); }
    .panel-toggle:hover { background: var(--mist); color: var(--ink); }
    .panel-toggle svg { inline-size: 20px; block-size: 20px; }

    .scrim { display: none; }
    @media (min-width: 64rem) { .shell.open .pane { --bar-start: var(--s-4); } }

    .pane {
      position: relative;
      /* where page headers in the top strip start: clear of the toggle while it sits here */
      --bar-start: calc(var(--s-3) + 36px + var(--s-2));
      flex: 1; min-inline-size: 0;
      display: flex; flex-direction: column; min-block-size: 0; overflow: hidden;
      /* reserve the toggle's row so it never lands on top of page content */
      padding-block-start: 3rem;
    }

    @media (max-width: 63.999rem) {
      .shell { --panel-w: min(20rem, 82vw); }
      .side {
        position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 30;
        margin-inline-start: 0; translate: -100% 0;
        box-shadow: var(--float);
        /* visible the instant it opens so focus can land; hidden only once it has slid away */
        transition: translate var(--t-open) var(--ease), visibility 0s linear var(--t-open);
      }
      .shell.open .side {
        translate: 0 0; visibility: visible;
        transition: translate var(--t-open) var(--ease), visibility 0s;
      }
      .scrim { display: block; position: fixed; inset: 0; z-index: 20; background: var(--scrim); border: 0; }
    }
  `,
})
export class Workspace {
  private readonly toggleEl = viewChild<ElementRef<HTMLButtonElement>>('toggleBtn');
  // A ref on a component element yields the component instance unless ElementRef is asked for.
  private readonly panel = viewChild<unknown, ElementRef<HTMLElement>>('panel', {
    read: ElementRef,
  });

  /** Under 64rem the panel overlays the pane instead of sitting beside it. */
  private readonly narrow = matchMedia('(max-width: 63.999rem)');
  protected readonly overlay = signal(this.narrow.matches);
  protected readonly open = signal(readOpen());
  /** Keeps the first render from pulling focus onto the toggle. */
  private readonly reopenable = signal(false);

  constructor() {
    this.narrow.addEventListener('change', () => this.syncViewport());

    // Signed out from anywhere — another tab, an expired session — leaves the workspace.
    const auth = inject(Auth);
    const router = inject(Router);
    effect(() => {
      if (!auth.user()) void router.navigate(['/']);  // same place the sign-out button goes
    });

    // Focus has to move with the panel, and only ever after render: focus() on a
    // still-hidden element is discarded.
    afterRenderEffect(() => {
      if (this.overlay() && this.open()) {
        this.panel()?.nativeElement.querySelector<HTMLElement>('a, button')?.focus();
        return;
      }
      if (!this.reopenable()) return;
      this.toggleEl()?.nativeElement.focus();
    });
  }

  /**
   * Crossing the breakpoint has to reset the panel, or "open" carries into overlay mode
   * and drops a scrim over the pane. Driven by two independent signals plus every
   * toggle, because a viewport can change without either event arriving.
   */
  protected syncViewport(): void {
    const narrow = this.narrow.matches;
    if (narrow === this.overlay()) return;
    this.overlay.set(narrow);
    this.open.set(narrow ? false : readOpen());
  }

  protected toggle(): void {
    this.syncViewport();
    const next = !this.open();
    this.reopenable.set(true);
    this.open.set(next);
    try {
      localStorage.setItem(PANEL_KEY, next ? 'open' : 'closed');
    } catch {
      // a collapsed panel that forgets is a papercut, not a failure worth surfacing
    }
  }

  /** Scrim, Escape and picking a link only dismiss the panel while it is overlaying. */
  protected close(): void {
    this.syncViewport();
    if (!this.overlay() || !this.open()) return;
    this.reopenable.set(true);
    this.open.set(false);
  }
}
