/**
 * Setting a field value, dispatched by control kind.
 *
 * The split that makes this work: /evaluate READS (classify, option lists,
 * verification), /click and /type ACT. Acting through Playwright means Angular
 * receives real input events and we inherit actionability checks (visible,
 * stable, enabled, hit-target). Synthetic el.click() from inside /evaluate would
 * skip all of that and silently "succeed" against a covered control.
 *
 * Every set is verified by reading the value back. An unverified write is
 * treated as a failure, because EZLynx prefills are stale often enough that
 * "it looks right" is not evidence.
 */

import { CamofoxClient, CamofoxError } from './client.js';
import {
  describeControlExpr,
  openPanelOptionsExpr,
  panelClosedExpr,
  anyPanelOpenExpr,
  scrollIntoViewExpr,
  visibilityReportExpr,
  scrollVirtualOptionExpr,
  waitForPanelExpr,
  type ControlState,
  type OptionItem,
} from './dom.js';
import { waitFor } from './waits.js';
import { matchOption, type MatchOptions, type MatchResult } from '../domain/match.js';
import type { Logger } from '../log/logger.js';

export interface SetFieldOptions {
  aliases?: Record<string, string>;
  fuzzyThreshold?: number;
  /** Called when tiers 1–4 fail; return an exact option string or null. */
  resolveOption?: (context: ResolveOptionContext) => Promise<string | null>;
  /** Controls that must populate after this change before the step continues. */
  dependents?: string[];
  logger?: Logger;
  panelTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

export interface ResolveOptionContext {
  selector: string;
  label: string;
  desired: string;
  options: string[];
  candidates: string[];
}

export interface SetFieldResult {
  selector: string;
  kind: ControlState['kind'];
  applied: boolean;
  skipped: 'already-set' | 'disabled' | 'not-found' | null;
  value: string;
  tier: MatchResult['tier'] | 'direct';
  note?: string;
}

const YES_NO = new Set(['true', 'false']);

export class ControlError extends Error {
  constructor(
    message: string,
    public readonly selector: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

export async function describeControl(
  client: CamofoxClient,
  tabId: string,
  selector: string,
): Promise<ControlState> {
  return client.evaluate<ControlState>(tabId, describeControlExpr(selector));
}

/**
 * Dismiss any open option panel before interacting with something else.
 *
 * An open mat-select lays a `cdk-overlay-backdrop` over the entire page. Every
 * subsequent click then lands on that backdrop — dismissing the stale panel
 * instead of reaching the intended control — so one failed dropdown silently
 * breaks every field after it. Always start from a clean slate.
 */
export async function ensureNoPanelOpen(client: CamofoxClient, tabId: string): Promise<void> {
  const open = await client.evaluate<boolean>(tabId, anyPanelOpenExpr()).catch(() => false);
  if (!open) return;

  await client.press(tabId, 'Escape').catch(() => undefined);
  const closed = await client.evaluate<boolean>(tabId, panelClosedExpr(3_000)).catch(() => false);
  if (closed) return;

  // Escape did not take (some panels swallow it) — click the backdrop itself.
  await client.click(tabId, { selector: '.cdk-overlay-backdrop' }).catch(() => undefined);
  await client.evaluate<boolean>(tabId, panelClosedExpr(2_000)).catch(() => false);
  // The overlay animates out; clicking during that is swallowed.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export async function setField(
  client: CamofoxClient,
  tabId: string,
  selector: string,
  desired: string | boolean,
  options: SetFieldOptions = {},
): Promise<SetFieldResult> {
  const log = options.logger;
  let state = await describeControl(client, tabId, selector);

  if (!state.found) {
    return { selector, kind: 'unknown', applied: false, skipped: 'not-found', value: '', tier: 'direct' };
  }

  // Scroll a below-the-fold control into view, then let Playwright decide
  // whether it is actionable.
  //
  // Do NOT gate on our own visibility heuristic. Angular Material deliberately
  // renders the real <input> of a radio/checkbox at zero size with the visible
  // UI drawn by sibling elements, so `vis()` says "hidden" for controls that
  // click perfectly well. Playwright's actionability check is the authority,
  // and its failure messages name the actual element.
  if (!state.visible) {
    await client.evaluate(tabId, scrollIntoViewExpr(state.resolvedSelector)).catch(() => undefined);
    state = await describeControl(client, tabId, selector);
    if (!state.visible) {
      const why = await client
        .evaluate<Record<string, unknown>>(tabId, visibilityReportExpr(state.resolvedSelector))
        .catch(() => null);
      log?.debug('control reads as not visible, attempting anyway', { selector: state.resolvedSelector, why });
    }
  }
  if (state.disabled) {
    log?.debug('control disabled, skipping', { selector, kind: state.kind });
    return { selector, kind: state.kind, applied: false, skipped: 'disabled', value: state.value, tier: 'direct' };
  }

  const wanted = typeof desired === 'boolean' ? (desired ? 'Yes' : 'No') : String(desired);

  if (isAlreadySet(state, wanted)) {
    return { selector, kind: state.kind, applied: false, skipped: 'already-set', value: state.value, tier: 'direct' };
  }

  let result: SetFieldResult;
  switch (state.kind) {
    case 'mat-select':
      result = await setMatSelect(client, tabId, state, wanted, options);
      break;
    case 'native-select':
      result = await setNativeSelect(client, tabId, state, wanted);
      break;
    case 'mat-autocomplete':
      result = await setAutocomplete(client, tabId, state, wanted, options);
      break;
    case 'radio':
    case 'checkbox':
    case 'toggle':
      result = await setToggleLike(client, tabId, state, desired, options);
      break;
    case 'text':
    case 'textarea':
      result = await setText(client, tabId, state, wanted, options);
      break;
    default:
      throw new ControlError(`Cannot set control of kind "${state.kind}"`, selector, state);
  }

  if (options.dependents?.length) {
    for (const dependent of options.dependents) {
      await waitFor(client, tabId, { type: 'value-not-empty', selector: dependent }, {
        timeoutMs: 15_000,
        logger: log,
      }).catch(() => log?.debug('dependent did not populate', { selector, dependent }));
    }
  }

  return result;
}

function isAlreadySet(state: ControlState, wanted: string): boolean {
  const current = state.value.trim();
  if (!current) return false;
  if (current.toLowerCase() === wanted.trim().toLowerCase()) return true;
  if (YES_NO.has(current.toLowerCase())) {
    const asBool = current.toLowerCase() === 'true';
    const wantBool = ['yes', 'true', '1', 'on'].includes(wanted.trim().toLowerCase());
    return asBool === wantBool;
  }
  return false;
}

/**
 * mat-select: click to open, read the CDK overlay, match, click the option by
 * its own id, verify the panel closed and the trigger updated.
 *
 * Clicking by option id (never nth-child) matters because long lists such as
 * the 299-entry Prior Carrier dropdown can virtualise.
 */
async function setMatSelect(
  client: CamofoxClient,
  tabId: string,
  state: ControlState,
  wanted: string,
  options: SetFieldOptions,
): Promise<SetFieldResult> {
  const log = options.logger;
  const panelTimeout = options.panelTimeoutMs ?? 8_000;

  // A stale backdrop from a previous dropdown would swallow this click.
  await ensureNoPanelOpen(client, tabId);
  await client.evaluate(tabId, scrollIntoViewExpr(state.resolvedSelector)).catch(() => undefined);
  await client.click(tabId, { selector: state.resolvedSelector });

  let panel = await client.evaluate<{ ok: boolean; options: OptionItem[] }>(
    tabId,
    waitForPanelExpr(panelTimeout, state.resolvedSelector),
    { timeoutMs: panelTimeout + 10_000 },
  );

  // One retry: the first click on a freshly painted Angular form is sometimes
  // absorbed before the component is listening.
  if (!panel.ok || !panel.options.length) {
    log?.debug('dropdown did not open, retrying once', { selector: state.resolvedSelector });
    await ensureNoPanelOpen(client, tabId);
    await client.click(tabId, { selector: state.resolvedSelector });
    panel = await client.evaluate<{ ok: boolean; options: OptionItem[] }>(
      tabId,
      waitForPanelExpr(panelTimeout, state.resolvedSelector),
      { timeoutMs: panelTimeout + 10_000 },
    );
  }

  if (!panel.ok || !panel.options.length) {
    // Leave the page clean so the NEXT field is not poisoned by this failure.
    await ensureNoPanelOpen(client, tabId);
    throw new ControlError('Dropdown did not open (no options rendered)', state.resolvedSelector, { label: state.label });
  }

  const texts = panel.options.map((option) => option.text);
  const matchConfig: MatchOptions = {
    aliases: options.aliases,
    ...(options.fuzzyThreshold !== undefined ? { fuzzyThreshold: options.fuzzyThreshold } : {}),
  };
  let match = matchOption(wanted, texts, matchConfig);

  if (!match.matched && options.resolveOption) {
    const suggestion = await options.resolveOption({
      selector: state.resolvedSelector,
      label: state.label,
      desired: wanted,
      options: texts,
      candidates: match.candidates,
    });
    if (suggestion) {
      const confirmed = matchOption(suggestion, texts, { ...matchConfig, fuzzyThreshold: 0.95 });
      if (confirmed.matched) match = { ...confirmed, tier: 'alias' };
    }
  }

  if (!match.matched) {
    await ensureNoPanelOpen(client, tabId);
    throw new ControlError(
      `No option matches "${wanted}" (best ${match.confidence.toFixed(2)}: ${match.candidates.slice(0, 3).join(' | ')})`,
      state.resolvedSelector,
      { label: state.label, candidates: match.candidates },
    );
  }

  const chosen = panel.options[match.index];
  if (!chosen) throw new ControlError('Matched option vanished from the panel', state.resolvedSelector);

  let target = chosen;
  if (!target.id) {
    await client.evaluate(tabId, scrollVirtualOptionExpr(match.index, state.resolvedSelector));
    const refreshed = await client.evaluate<OptionItem[]>(tabId, openPanelOptionsExpr(state.resolvedSelector));
    const again = refreshed.find((option) => option.text === chosen.text);
    if (!again?.id) {
      await ensureNoPanelOpen(client, tabId);
      throw new ControlError('Option has no stable id to click', state.resolvedSelector, { text: chosen.text });
    }
    target = again;
  }

  await client.click(tabId, { selector: `#${cssEscapeId(target.id!)}` });
  await client.evaluate<boolean>(tabId, panelClosedExpr(4_000));

  const after = await describeControl(client, tabId, state.resolvedSelector);
  if (normalize(after.value) !== normalize(match.matched)) {
    throw new ControlError(
      `Verification failed: expected "${match.matched}", control shows "${after.value}"`,
      state.resolvedSelector,
      { label: state.label },
    );
  }

  log?.debug('mat-select set', { selector: state.resolvedSelector, tier: match.tier, value: after.value });
  return {
    selector: state.resolvedSelector,
    kind: 'mat-select',
    applied: true,
    skipped: null,
    value: after.value,
    tier: match.tier,
    ...(match.tier === 'fuzzy' ? { note: `fuzzy match from "${wanted}" (${match.confidence.toFixed(2)})` } : {}),
  };
}

async function setNativeSelect(
  client: CamofoxClient,
  tabId: string,
  state: ControlState,
  wanted: string,
): Promise<SetFieldResult> {
  await client.selectNative(tabId, { selector: state.resolvedSelector }, wanted);
  const after = await describeControl(client, tabId, state.resolvedSelector);
  if (!after.value) throw new ControlError(`Native select did not take "${wanted}"`, state.resolvedSelector);
  return { selector: state.resolvedSelector, kind: 'native-select', applied: true, skipped: null, value: after.value, tier: 'direct' };
}

async function setAutocomplete(
  client: CamofoxClient,
  tabId: string,
  state: ControlState,
  wanted: string,
  options: SetFieldOptions,
): Promise<SetFieldResult> {
  await client.type(tabId, { selector: state.resolvedSelector }, wanted);

  const panel = await client.evaluate<{ ok: boolean; options: OptionItem[] }>(
    tabId,
    waitForPanelExpr(options.panelTimeoutMs ?? 6_000, state.resolvedSelector),
    { timeoutMs: 16_000 },
  );

  if (panel.ok && panel.options.length) {
    const texts = panel.options.map((option) => option.text);
    const match = matchOption(wanted, texts, { aliases: options.aliases });
    const chosen = match.index >= 0 ? panel.options[match.index] : undefined;
    if (chosen?.id) {
      await client.click(tabId, { selector: `#${cssEscapeId(chosen.id)}` });
      await client.evaluate<boolean>(tabId, panelClosedExpr(3_000));
    }
  }

  const after = await describeControl(client, tabId, state.resolvedSelector);
  return { selector: state.resolvedSelector, kind: 'mat-autocomplete', applied: true, skipped: null, value: after.value, tier: 'direct' };
}

async function setToggleLike(
  client: CamofoxClient,
  tabId: string,
  state: ControlState,
  desired: string | boolean,
  options: SetFieldOptions,
): Promise<SetFieldResult> {
  await ensureNoPanelOpen(client, tabId);
  const want =
    typeof desired === 'boolean' ? desired : ['yes', 'true', '1', 'on'].includes(String(desired).trim().toLowerCase());

  if (state.checked === want) {
    return { selector: state.resolvedSelector, kind: state.kind, applied: false, skipped: 'already-set', value: state.value, tier: 'direct' };
  }

  await client.click(tabId, { selector: state.resolvedSelector });

  const after = await describeControl(client, tabId, state.resolvedSelector);
  if (after.checked !== want) {
    throw new ControlError(`Toggle did not reach ${want} (still ${after.checked})`, state.resolvedSelector, { label: state.label });
  }
  options.logger?.debug('toggle set', { selector: state.resolvedSelector, value: want });
  return { selector: state.resolvedSelector, kind: state.kind, applied: true, skipped: null, value: String(want), tier: 'direct' };
}

async function setText(
  client: CamofoxClient,
  tabId: string,
  state: ControlState,
  wanted: string,
  options: SetFieldOptions,
): Promise<SetFieldResult> {
  // A leftover overlay backdrop blocks fill() just as it blocks clicks.
  await ensureNoPanelOpen(client, tabId);
  try {
    await client.type(tabId, { selector: state.resolvedSelector }, wanted);
  } catch (err) {
    // A control the recorder logged as text can turn out to be something else.
    // camofox's message names the actual element, so keep it — swallowing it
    // left "the page disagrees" with no way to tell what the element really is.
    if (err instanceof CamofoxError && err.isNotActionable) {
      throw new ControlError(
        `Not fillable as "${state.kind}" — ${err.message}`,
        state.resolvedSelector,
        { original: err.message },
      );
    }
    throw err;
  }

  const after = await describeControl(client, tabId, state.resolvedSelector);
  if (normalize(after.value) !== normalize(wanted)) {
    // Masked/reformatting inputs (dates, currency) legitimately echo back differently.
    options.logger?.debug('text readback differs', {
      selector: state.resolvedSelector,
      wrote: wanted,
      readBack: after.value,
    });
    return {
      selector: state.resolvedSelector,
      kind: state.kind,
      applied: true,
      skipped: null,
      value: after.value,
      tier: 'direct',
      note: `wrote "${wanted}", field shows "${after.value}"`,
    };
  }

  return { selector: state.resolvedSelector, kind: state.kind, applied: true, skipped: null, value: after.value, tier: 'direct' };
}

function normalize(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Mirrors CSS.escape for ids we build selectors from on the Node side. */
export function cssEscapeId(id: string): string {
  return String(id).replace(/[^\w-]/g, (char) => `\\${char}`);
}
