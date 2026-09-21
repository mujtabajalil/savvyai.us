/** Event shapes emitted by the browser recorder. */

export interface RecordedField {
  kind: string;
  label?: string;
  value?: string;
  selector?: string;
  container?: string | null;
  required?: boolean;
  disabled?: boolean;
  options?: string[];
  index?: number;
  matches?: number;
  group?: string;
}

export interface RecordedEvent {
  t: string;
  tab: number;
  path: string;
  step?: string | null;
  action: 'screen' | 'type' | 'dropdown' | 'select' | 'checkbox' | 'radio' | 'toggle' | 'click' | 'message' | 'results';
  title?: string;
  fields?: RecordedField[];
  selector?: string;
  container?: string | null;
  label?: string;
  value?: string;
  previous?: string;
  before?: string;
  after?: string;
  options?: string[];
  source?: string;
  kind?: string;
  text?: string;
  field?: string | null;
  element?: string;
  href?: string | null;
  group?: string;
  index?: number;
  matches?: number;
  inputType?: string;
  cards?: string[];
  htmlSample?: string;
  afterClick?: string;
}

export type Lob = 'auto' | 'home';

export interface RecordingContext {
  accountId: string;
  quoteIds: Partial<Record<Lob, string>>;
  primaryTab: number;
}

const RATING_PATH = /^\/web\/account\/(\d+)\/rating\/(auto|home)\/(\d+)\/([a-z-]+)/i;
const DETAILS_PATH = /^\/web\/account\/(\d+)\/details/i;
const SUBMIT_PATH = /^\/web\/account\/(\d+)\/rating\/submit-details\/(\d+)/i;
const RESULTS_PATH = /^\/web\/account\/(\d+)\/rating\/quote-results\/(\d+)\/(\d+)/i;

export function accountOf(path: string): string | null {
  const match = path?.match(/^\/web\/account\/(\d+)\//);
  return match?.[1] ?? null;
}

export function parseRatingPath(path: string): { accountId: string; lob: Lob; quoteId: string; step: string } | null {
  const match = path?.match(RATING_PATH);
  if (!match) return null;
  return {
    accountId: match[1]!,
    lob: match[2]!.toLowerCase() as Lob,
    quoteId: match[3]!,
    step: match[4]!.toLowerCase(),
  };
}

export function isDetailsPath(path: string): boolean {
  return DETAILS_PATH.test(path ?? '');
}

export function isSubmitPath(path: string): boolean {
  return SUBMIT_PATH.test(path ?? '');
}

export function isResultsPath(path: string): boolean {
  return RESULTS_PATH.test(path ?? '');
}

/**
 * Work out which account/quotes/tab the recording is actually about.
 *
 * The capture contains noise: applicant-portal policy tabs whose labels are
 * polluted with inline JS/CSS, and a results tab belonging to a *different*
 * account. Everything downstream filters against this context.
 */
export function inferContext(events: RecordedEvent[]): RecordingContext {
  const accountCounts = new Map<string, number>();
  const tabCounts = new Map<number, number>();

  for (const event of events) {
    const account = accountOf(event.path ?? '');
    if (account) accountCounts.set(account, (accountCounts.get(account) ?? 0) + 1);
    tabCounts.set(event.tab, (tabCounts.get(event.tab) ?? 0) + 1);
  }

  const accountId = [...accountCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const primaryTab = [...tabCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

  const quoteIds: Partial<Record<Lob, string>> = {};
  const perLob = new Map<Lob, Map<string, number>>();
  for (const event of events) {
    const parsed = parseRatingPath(event.path ?? '');
    if (!parsed || parsed.accountId !== accountId) continue;
    const bucket = perLob.get(parsed.lob) ?? new Map<string, number>();
    bucket.set(parsed.quoteId, (bucket.get(parsed.quoteId) ?? 0) + 1);
    perLob.set(parsed.lob, bucket);
  }
  for (const [lob, counts] of perLob) {
    quoteIds[lob] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  return { accountId, quoteIds, primaryTab };
}

export interface FilterReport {
  kept: RecordedEvent[];
  dropped: Array<{ reason: string; path: string; count: number }>;
}

/** Keep only events belonging to the account and quotes under test. */
export function filterNoise(events: RecordedEvent[], context: RecordingContext): FilterReport {
  const kept: RecordedEvent[] = [];
  const dropReasons = new Map<string, { reason: string; path: string; count: number }>();

  const drop = (reason: string, path: string) => {
    const key = `${reason}::${path}`;
    const existing = dropReasons.get(key);
    if (existing) existing.count += 1;
    else dropReasons.set(key, { reason, path, count: 1 });
  };

  for (const event of events) {
    const path = event.path ?? '';

    if (path.startsWith('/applicantportal')) {
      drop('applicant-portal noise', path);
      continue;
    }

    const account = accountOf(path);
    if (account && account !== context.accountId) {
      drop(`different account (${account})`, path);
      continue;
    }

    const parsed = parseRatingPath(path);
    if (parsed) {
      const expected = context.quoteIds[parsed.lob];
      if (expected && parsed.quoteId !== expected) {
        drop(`different ${parsed.lob} quote (${parsed.quoteId})`, path);
        continue;
      }
    }

    if (!account && !path.startsWith('/web/')) {
      drop('unrecognised path', path);
      continue;
    }

    kept.push(event);
  }

  return { kept, dropped: [...dropReasons.values()].sort((a, b) => b.count - a.count) };
}
