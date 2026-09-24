import {
  Component,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Conversations } from './conversations';
import { Markdown } from './markdown';

@Component({
  selector: 'app-chat',
  imports: [RouterLink, Markdown],
  template: `
    <h1 class="sr-only">Chat</h1>

    <!-- sits in the pane's reserved top strip, beside the sidebar toggle -->
    @if (conversation(); as c) {
      <div class="head">
        <button class="title-btn" type="button" popovertarget="convo-menu">
          <span class="ui name">{{ c.title }}</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <div id="convo-menu" class="menu" popover>
          <button type="button" (click)="rename(c.id, c.title)">Rename</button>
          <button type="button" class="bad" (click)="remove(c.id, c.title)">Delete</button>
        </div>
      </div>
    }

    <div class="col">

    @if (store.storageFailed()) {
      <div class="notice notice-warn" role="status">
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 1.5 19 18H1L10 1.5Zm0 6a1 1 0 0 0-1 1v3.2a1 1 0 0 0 2 0V8.5a1 1 0 0 0-1-1Zm0 7.2a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z" />
        </svg>
        <span>
          History is not being saved. This browser is blocking site data, so these
          conversations disappear when you close the tab. Allow site data for this
          site to keep them.
        </span>
      </div>
    }

    @if (missing()) {
      <div class="state">
        <p>That conversation is not here. It was deleted, or the link came from another browser.</p>
        <a class="btn btn-primary" routerLink="/app/chat">Start a new chat</a>
      </div>
    } @else {
      <div #log class="log" tabindex="0" aria-label="Conversation" (scroll)="trackBottom(log)">
        @if (messages().length === 0) {
          <p class="empty">No messages yet. Describe the quote you want and the run starts here.</p>
        }
        @for (m of messages(); track m.id) {
          <article class="msg" [class.mine]="m.role === 'you'">
            <span class="who small">{{ m.role === 'you' ? 'You' : 'Agent' }}</span>
            @if (m.pending) {
              <p class="thinking" role="status">
                <span class="cradle" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
                <span>Working on it</span>
              </p>
            } @else if (m.role === 'agent') {
              <div class="prose" [innerHTML]="m.text | markdown"></div>
              @if (m.tools?.length) {
                <span class="tools small">Ran in EZLynx: {{ m.tools!.join(', ') }}</span>
              }
            } @else {
              <p>{{ m.text }}</p>
            }
          </article>
        }
      </div>

      <div class="composer">
        <form class="pill" (submit)="send($event, box)">
          <label class="sr-only" for="box">Message</label>
          <button class="round" type="button" disabled aria-label="Attach a document">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 4.2v11.6M4.2 10h11.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
          <textarea
            #box
            id="box"
            rows="1"
            placeholder="Quote auto and home"
            [disabled]="busy()"
            (keydown.enter)="send($event, box)"></textarea>
          <button class="round send" type="submit" aria-label="Send message" [disabled]="busy()">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.3 9.1 16.6 3.4a.65.65 0 0 1 .85.85l-5.7 13.3a.65.65 0 0 1-1.16.04l-2.4-4.5-4.5-2.4a.65.65 0 0 1 .04-1.16Z" fill="currentColor" />
            </svg>
          </button>
        </form>
      </div>
    }
    </div>
  `,
  styles: `
    /* Every stop is a DESIGN.md surface token, so text contrast stays inside the
       verified paper/mat/wash range in both themes. Static — §7 bans animated gradients. */
    :host {
      display: flex; flex-direction: column; flex: 1; min-block-size: 0;
      /* run the surface up under the pane's top strip, so it has no hard top edge */
      margin-block-start: -3rem; padding-block-start: 3rem;
      position: relative; isolation: isolate;
      background:
        radial-gradient(64rem 42rem at 30% -10%, var(--glow-1), transparent 64%),
        radial-gradient(56rem 42rem at 106% 106%, var(--glow-2), transparent 62%),
        var(--paper);
    }

    /* Sweeping ribbons, Zaha Hadid style: long continuous curves in place of blooms.
       Masks carry the shape so the colours stay theme tokens (transparent in dark). */
    :host::before, :host::after {
      content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
      mask-size: 100% 100%; mask-repeat: no-repeat;
    }
    :host::before { background: var(--ribbon-1); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 900' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='b' x='-10%25' y='-30%25' width='120%25' height='160%25'%3E%3CfeGaussianBlur stdDeviation='7'/%3E%3C/filter%3E%3ClinearGradient id='g' gradientUnits='userSpaceOnUse' x1='0' x2='1440'%3E%3Cstop offset='0' stop-opacity='.15'/%3E%3Cstop offset='.55'/%3E%3Cstop offset='1' stop-opacity='.3'/%3E%3C/linearGradient%3E%3Cpath id='c' d='M-80 280C260 140 520 440 860 350S1300 100 1540 180'/%3E%3C/defs%3E%3Cg filter='url(%23b)' fill='none' stroke='url(%23g)' stroke-linecap='round'%3E%3Cuse href='%23c' stroke-width='56'/%3E%3Cuse href='%23c' stroke-width='3' transform='translate(0 62)'/%3E%3Cuse href='%23c' stroke-width='2' transform='translate(0 92)'/%3E%3Cuse href='%23c' stroke-width='2' transform='translate(0 -50)'/%3E%3C/g%3E%3C/svg%3E"); }
    :host::after { background: var(--ribbon-2); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 900' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='b' x='-10%25' y='-30%25' width='120%25' height='160%25'%3E%3CfeGaussianBlur stdDeviation='7'/%3E%3C/filter%3E%3ClinearGradient id='g' gradientUnits='userSpaceOnUse' x1='0' x2='1440'%3E%3Cstop offset='0' stop-opacity='.15'/%3E%3Cstop offset='.55'/%3E%3Cstop offset='1' stop-opacity='.3'/%3E%3C/linearGradient%3E%3Cpath id='c' d='M-80 820C300 700 640 870 980 710S1380 540 1540 580'/%3E%3C/defs%3E%3Cg filter='url(%23b)' fill='none' stroke='url(%23g)' stroke-linecap='round'%3E%3Cuse href='%23c' stroke-width='80'/%3E%3Cuse href='%23c' stroke-width='2' transform='translate(0 -66)'/%3E%3Cuse href='%23c' stroke-width='1.5' transform='translate(0 -96)'/%3E%3C/g%3E%3C/svg%3E"); }

    /* one centred column, so collapsing the panel re-centres the thread
       instead of sliding it left. Type inside it stays flush left. The log alone spans
       the pane, so its scrollbar sits at the far right, and pads itself back to the column. */
    .col {
      --col: 52rem;
      inline-size: 100%;
      display: flex; flex-direction: column; flex: 1; min-block-size: 0;
    }
    .col > * { inline-size: min(100% - 2 * var(--s-5), var(--col) - 2 * var(--s-5)); margin-inline: auto; }

    /* --bar-start comes from the workspace: past the toggle when it sits over the pane */
    .head {
      position: absolute; inset-block-start: 0; block-size: 3rem;
      inset-inline: var(--bar-start, var(--s-4)) var(--s-4);
      display: flex; align-items: center; min-inline-size: 0;
    }
    .title-btn {
      display: flex; align-items: center; gap: var(--s-1); min-inline-size: 0; max-inline-size: 100%;
      block-size: 36px; padding-inline: var(--s-2); margin-inline-start: calc(var(--s-2) * -1);
      background: none; border: 0; border-radius: var(--r-control); cursor: pointer; color: var(--ink);
      anchor-name: --convo-title;
      transition: background-color var(--t-state) var(--ease);
    }
    .title-btn:hover { background: var(--mist); }
    .title-btn svg { inline-size: 16px; block-size: 16px; flex: none; color: var(--ink-3); }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* native popover: light dismiss and Escape for free */
    .menu {
      position-anchor: --convo-title; position-area: bottom span-right; margin: var(--s-1) 0 0;
      min-inline-size: 10rem; padding: var(--s-1);
      background: var(--sheet); color: var(--ink);
      border: 1px solid var(--rule); border-radius: var(--r-card); box-shadow: var(--float);
    }
    .menu button {
      display: block; inline-size: 100%; text-align: start; padding: var(--s-2) var(--s-3);
      background: none; border: 0; border-radius: var(--r-control); cursor: pointer;
      color: inherit; font: 500 0.9375rem/1.35 var(--ff-text);
    }
    .menu button:hover, .menu button:focus-visible { background: var(--mist); }
    .menu .bad { color: var(--bad); }

    .col > .log {
      inline-size: 100%; margin-inline: 0;
      padding-inline: max(var(--s-5), (100% - var(--col)) / 2 + var(--s-5));
      flex: 1; min-block-size: 0; overflow-y: auto;
      display: grid; gap: var(--s-5); align-content: start; padding-block: var(--s-5);
    }
    .empty { color: var(--ink-3); }

    .msg { display: grid; gap: var(--s-1); justify-items: start; }
    .who { color: var(--ink-3); }
    .msg > p { max-inline-size: var(--measure); white-space: pre-wrap; }
    .thinking { color: var(--ink-3); display: flex; align-items: center; gap: var(--s-3); }

    /* Loader: a Newton's cradle. The outer balls swing out in turn, pivoting on the top of
       their column, and the middle two stay put. --action is teal on light, lime on dark.
       With reduced motion the global rule stops the swing and the four balls rest in a row. */
    .cradle {
      --size: 28px; --speed: 1.2s;
      flex: none; display: flex; align-items: center; justify-content: center;
      inline-size: var(--size); block-size: var(--size);
    }
    .cradle > span {
      display: flex; align-items: center;
      inline-size: 25%; block-size: 100%; transform-origin: center top;
    }
    .cradle > span::after {
      content: ""; display: block; inline-size: 100%; block-size: 25%;
      border-radius: 50%; background: var(--action);
    }
    .cradle > span:first-child { animation: cradle-left var(--speed) linear infinite; }
    .cradle > span:last-child { animation: cradle-right var(--speed) linear infinite; }
    @keyframes cradle-left {
      0% { rotate: 0deg; animation-timing-function: ease-out; }
      25% { rotate: 70deg; animation-timing-function: ease-in; }
      50% { rotate: 0deg; animation-timing-function: linear; }
    }
    @keyframes cradle-right {
      0% { rotate: 0deg; animation-timing-function: linear; }
      50% { rotate: 0deg; animation-timing-function: ease-out; }
      75% { rotate: -70deg; animation-timing-function: ease-in; }
    }
    .tools { color: var(--ink-3); }
    .msg.mine > p {
      background: var(--mat); border-radius: var(--r-card); padding: var(--s-3) var(--s-4);
    }

    .state { display: grid; gap: var(--s-5); justify-items: start; padding-block: var(--s-6); }

    .composer { flex: none; display: grid; gap: var(--s-2); padding-block: var(--s-3) var(--s-5); }

    .pill {
      display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center; gap: var(--s-2);
      background: var(--mat); border-radius: 999px; padding: var(--s-2);
    }
    /* Ring the pill, not the borderless textarea inside it. Plain :focus, not
       :focus-visible — a borderless text field with no ring has no focus cue at all. */
    .pill:has(textarea:focus) { outline: 2px solid var(--action); outline-offset: 2px; }
    .pill textarea {
      background: none; border: 0; padding: var(--s-2);
      color: var(--ink); font: 400 1rem/1.5 var(--ff-text);
      resize: none; field-sizing: content; max-block-size: 7rem; overflow-y: auto;
    }
    .pill textarea:focus { outline: none; }
    .pill textarea::placeholder { color: var(--ink-3); }

    .round {
      display: grid; place-items: center; inline-size: 40px; block-size: 40px;
      border: 0; border-radius: 999px; background: var(--sheet); color: var(--ink-3);
      cursor: pointer; transition: background-color var(--t-state) var(--ease);
    }
    .round svg { inline-size: 20px; block-size: 20px; }
    .round:disabled { cursor: not-allowed; opacity: 0.55; }
    .round:not(:disabled):hover { background: var(--mist); }
    .send { color: var(--action); }
  `,
})
export class Chat {
  protected readonly store = inject(Conversations);
  private readonly router = inject(Router);
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');

  /** Bound by the router on /app/chat/:id; undefined on the bare /app/chat draft route. */
  readonly id = input<string>();

  /** Covers the microtask between send() storing a new chat and the URL catching up. */
  private readonly justCreated = signal<string | null>(null);

  protected readonly activeId = computed(() => this.id() ?? this.justCreated() ?? undefined);
  protected readonly conversation = computed(() => this.store.byId(this.activeId()));
  protected readonly messages = computed(() => this.conversation()?.messages ?? []);
  protected readonly missing = computed(() => !!this.activeId() && !this.conversation());
  /** A reply is out; a second send would collide with the run already in the browser. */
  protected readonly busy = computed(() => this.messages().some((m) => m.pending));

  /** Whether the reader was at the end last time they scrolled. */
  private atBottom = true;

  constructor() {
    // Loads a conversation's messages from the backend the first time its route is opened.
    effect(() => void this.store.ensureLoaded(this.id()));

    // Must run after render: a signal write does not update the DOM synchronously, so
    // scrollHeight read any earlier measures the list without the new message.
    // The agent answers minutes later, so only follow the end for someone already
    // there — otherwise a reply yanks a reader out of the history they scrolled to.
    afterRenderEffect(() => {
      this.messages();
      const el = this.log()?.nativeElement;
      if (el && this.atBottom) el.scrollTop = el.scrollHeight;
    });

    // The draft route and /app/chat/:id are different routes, so the first send destroys
    // this component and builds a new one. Focusing on mount is what survives that.
    afterNextRender(() => this.box()?.nativeElement.focus());
  }

  // ponytail: native prompt/confirm, same as the sidebar's delete
  protected rename(id: string, title: string): void {
    const next = prompt('Rename conversation', title);
    if (next?.trim()) this.store.rename(id, next);
  }

  protected remove(id: string, title: string): void {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    this.store.remove(id);
    this.router.navigate(['/app/chat']);
  }

  protected trackBottom(log: HTMLElement): void {
    this.atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
  }

  protected send(event: Event, box: HTMLTextAreaElement): void {
    // Enter also commits an IME candidate; sending then would eat the half-typed word.
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    const text = box.value.trim();
    if (!text || this.busy()) return;

    // A new message is yours, so follow it down wherever the reader was.
    this.atBottom = true;

    const id = this.store.send(this.activeId(), text);
    box.value = '';
    if (id !== this.id()) {
      this.justCreated.set(id);
      this.router.navigate(['/app/chat', id]);
    }
    box.focus();
  }
}
