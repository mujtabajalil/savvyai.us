import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Auth } from './auth';

export type Role = 'you' | 'agent';
export type Message = {
  id: string;
  role: Role;
  text: string;
  at: number;
  /** The reply has been asked for and has not come back. */
  pending?: boolean;
  /** Tools the agent ran for this reply — what actually touched EZLynx. */
  tools?: string[];
};
export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

/** One cache per user: the browser is shared, the history is not. */
const keyFor = (user: string): string => `savvy.chats.${user}`;
const VERSION = 1;

// The pre-per-user cache held whoever used this browser last. Its chats are on the backend.
try {
  localStorage.removeItem('savvy.chats');
} catch {}

type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt: string };

/** crypto.randomUUID is secure-context only, so it is missing over plain http on a LAN IP. */
const uid = (): string =>
  crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** localStorage throws outright in private browsing and when site data is blocked. */
function load(user: string): Conversation[] {
  try {
    const raw = localStorage.getItem(keyFor(user));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (parsed?.version !== VERSION || !Array.isArray(parsed.conversations)) return [];
    // Stored data is a trust boundary: one malformed entry would break every reader.
    return parsed.conversations
      .filter((c: Conversation) => c && typeof c.id === 'string' && Array.isArray(c.messages))
      // A reload drops the request that was in flight, so nothing will ever
      // settle these. Say so rather than spin forever.
      .map((c: Conversation) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.pending ? { ...m, pending: false, text: m.text || 'That run was interrupted by a reload.' } : m,
        ),
      }));
  } catch {
    return [];
  }
}

export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 40) return flat;
  const cut = flat.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${space > 20 ? cut.slice(0, space) : cut}…`;
}

@Injectable({ providedIn: 'root' })
export class Conversations {
  // ponytail: whole history in one signal, rewritten on every change. Fine at chat-history
  // scale; if it ever gets big, persist per-conversation keys instead.
  readonly all = signal<Conversation[]>([]);

  /** True once a write has failed, so the UI can say history is not being saved. */
  readonly storageFailed = signal(false);

  private readonly auth = inject(Auth);
  /** Whose cache `all` is. Set together with `all`, so a switch never writes one user's
   *  list under the other's key. */
  private owner: string | null = null;

  readonly byRecency = computed(() => [...this.all()].sort((a, b) => b.updatedAt - a.updatedAt));

  constructor() {
    // Load the signed-in user's cache, then pull their list from the backend. Runs at
    // startup and again on every sign-in, sign-out, or switch from another tab.
    effect(() => {
      const user = this.auth.user();
      untracked(() => {
        this.owner = user;
        this.all.set(user ? load(user) : []);
        if (user) void this.syncFromBackend();
      });
    });

    effect(() => {
      const conversations = this.all();
      if (!this.owner) return;
      try {
        localStorage.setItem(keyFor(this.owner), JSON.stringify({ version: VERSION, conversations }));
        this.storageFailed.set(false);
      } catch {
        this.storageFailed.set(true);
      }
    });

    // Another tab writes the whole blob under one key, so without this a stale tab's next
    // write silently wipes everything the other one saved. The equality check matters:
    // re-setting the signal would persist again and ping-pong the two tabs forever.
    addEventListener('storage', (event) => {
      if (!this.owner || event.key !== keyFor(this.owner)) return;
      const incoming = load(this.owner);
      if (JSON.stringify(incoming) === JSON.stringify(this.all())) return;
      this.all.set(incoming);
    });
  }

  private async syncFromBackend(): Promise<void> {
    const owner = this.owner;
    try {
      const res = await fetch('/api/conversations');
      // Session expired or was revoked (add-user resets log everyone out): the name in
      // this browser no longer means anything, so neither may its cached chats.
      if (res.status === 401 && this.owner === owner) {
        this.clear();
        this.auth.signOut();
        return;
      }
      if (!res.ok) return;
      const summaries: ConversationSummary[] = await res.json();
      // Signed out or switched user while this was in flight: it is someone else's list.
      if (this.owner !== owner) return;
      this.all.update((list) => {
        const byId = new Map(list.map((c) => [c.id, c]));
        for (const s of summaries) {
          const existing = byId.get(s.id);
          byId.set(s.id, {
            id: s.id,
            title: s.title,
            messages: existing?.messages ?? [],
            createdAt: Date.parse(s.createdAt) || Date.now(),
            updatedAt: Date.parse(s.updatedAt) || Date.now(),
          });
        }
        return [...byId.values()];
      });
    } catch {
      // Offline, or the backend is down — the local cache stands as-is.
    }
  }

  byId(id: string | undefined): Conversation | undefined {
    return id ? this.all().find((c) => c.id === id) : undefined;
  }

  /** Fetches a conversation's messages from the backend the first time it is opened. */
  async ensureLoaded(id: string | undefined): Promise<void> {
    const existing = this.byId(id);
    if (!id || !existing || existing.messages.length > 0) return;
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const full: { messages: { role: string; content: string }[] } = await res.json();
      const messages: Message[] = full.messages.map((m) => ({
        id: uid(),
        role: m.role === 'user' ? 'you' : 'agent',
        text: m.content,
        at: existing.updatedAt,
      }));
      this.all.update((list) => list.map((c) => (c.id === id ? { ...c, messages } : c)));
    } catch {
      // Leave it empty; the composer still works for a fresh message.
    }
  }

  /**
   * Appends to `id`, or starts a conversation when there is none. Returns the id
   * used, synchronously — the reply is filled into the placeholder when it lands.
   */
  send(id: string | undefined, text: string): string {
    const now = Date.now();
    const reply: Message = { id: uid(), role: 'agent', text: '', at: now, pending: true };
    const turn: Message[] = [{ id: uid(), role: 'you', text, at: now }, reply];
    const existing = this.byId(id);
    let used: string;

    if (!existing) {
      const created: Conversation = {
        id: uid(),
        title: titleFrom(text),
        messages: turn,
        createdAt: now,
        updatedAt: now,
      };
      this.all.update((list) => [created, ...list]);
      used = created.id;
    } else {
      used = existing.id;
      this.all.update((list) =>
        list.map((c) =>
          c.id !== used ? c : { ...c, messages: [...c.messages, ...turn], updatedAt: now },
        ),
      );
    }

    void this.ask(used, reply.id);
    return used;
  }

  /**
   * One turn against the backend, which runs DeepSeek over the EZLynx tools.
   *
   * ponytail: no timeout and no cancel. A quoting tool drives a real browser for
   * minutes, so a hung request looks the same as a slow one. Give it an abort
   * button when someone has to sit through a bad run.
   */
  private async ask(conversationId: string, replyId: string): Promise<void> {
    // Whatever is on screen minus the placeholder — the placeholder is what is
    // being answered, and an empty message would be rejected by the API.
    const history = (this.byId(conversationId)?.messages ?? [])
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.text }));

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, conversationId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail ?? `The agent answered ${response.status}.`);
      this.settle(conversationId, replyId, body.reply || '(no answer)', body.toolCalls);
    } catch (err) {
      this.settle(
        conversationId,
        replyId,
        `Could not reach the agent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private settle(conversationId: string, replyId: string, text: string, tools?: string[]): void {
    this.all.update((list) =>
      list.map((c) =>
        c.id !== conversationId
          ? c
          : {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id !== replyId ? m : { ...m, text, pending: false, ...(tools?.length ? { tools } : {}) },
              ),
            },
      ),
    );
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.all.update((list) =>
      list.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
    );
  }

  remove(id: string): void {
    this.all.update((list) => list.filter((c) => c.id !== id));
    void fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  }

  /** Called on sign-out: localStorage outlives the session, so don't leave these behind.
   *  Removes the key directly — sign-out clears the owner before the persist effect would
   *  get to write the empty list. */
  clear(): void {
    try {
      if (this.owner) localStorage.removeItem(keyFor(this.owner));
    } catch {}
    this.all.set([]);
  }
}
