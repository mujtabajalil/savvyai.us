/**
 * Carrier selection and the finish-step prune.
 *
 * The prune is a backtracking search because that is what the recording shows a
 * human doing: deselect a carrier, re-check `finish`, and if the step is still
 * invalid put that carrier BACK before trying another. In the recording Liberty
 * Mutual (35) and Acuity (196) were each dropped, found innocent, restored, and
 * Travelers (13) turned out to be the culprit.
 *
 * Deterministic identification is tried first; the search is the fallback, and
 * no carrier is ever left deselected without a recorded reason.
 */

import type { CamofoxClient } from '../camofox/client.js';
import { describeControl } from '../camofox/controls.js';
import { scanStepExpr, type StepScan } from '../camofox/dom.js';
import { sleep } from '../camofox/waits.js';
import type { Logger } from '../log/logger.js';
import type { DroppedCarrier } from './runner.js';

export interface CarrierToggle {
  id: string;
  label: string;
  selector: string;
  enabled: boolean;
}

const TOGGLE_RE = /^carrier-(\d+)-(.+)-button$/;

export async function readCarrierToggles(client: CamofoxClient, tabId: string): Promise<CarrierToggle[]> {
  const scan = await client.evaluate<StepScan>(tabId, scanStepExpr({}));
  const toggles: CarrierToggle[] = [];

  for (const control of scan.controls) {
    const id = control.id ?? '';
    const match = id.match(TOGGLE_RE);
    if (!match) continue;
    toggles.push({
      id: match[1]!,
      label: control.label || match[2]!.replace(/-/g, ' '),
      selector: `#${cssEscape(id)}`,
      enabled: control.checked === true || control.value === 'true',
    });
  }
  return toggles;
}

export async function setCarrierEnabled(
  client: CamofoxClient,
  tabId: string,
  toggle: CarrierToggle,
  enabled: boolean,
  logger?: Logger,
): Promise<boolean> {
  const before = await describeControl(client, tabId, toggle.selector);
  const current = before.checked === true || before.value === 'true';
  if (current === enabled) return true;

  await client.click(tabId, { selector: toggle.selector });
  await sleep(300);

  const after = await describeControl(client, tabId, toggle.selector);
  const now = after.checked === true || after.value === 'true';
  if (now !== enabled) {
    logger?.warn('carrier toggle did not take', { carrier: toggle.id, wanted: enabled, got: now });
    return false;
  }
  return true;
}

export interface SelectCarriersOptions {
  mode: 'all' | 'all-preferred' | 'all-non-preferred' | 'explicit';
  include?: string[];
  exclude?: string[];
  logger?: Logger;
}

/** Select-all-then-prune. Explicit exclusions are applied immediately. */
export async function selectCarriers(
  client: CamofoxClient,
  tabId: string,
  options: SelectCarriersOptions,
): Promise<CarrierToggle[]> {
  const bulk: string[] = [];
  if (options.mode === 'all' || options.mode === 'all-non-preferred') bulk.push('#all-non-preferred-button');
  if (options.mode === 'all' || options.mode === 'all-preferred') bulk.push('#all-preferred-button');

  for (const selector of bulk) {
    const control = await describeControl(client, tabId, selector);
    if (!control.found) continue;
    const enabled = control.checked === true || control.value === 'true';
    if (!enabled) {
      await client.click(tabId, { selector });
      await sleep(400);
    }
  }

  let toggles = await readCarrierToggles(client, tabId);

  if (options.mode === 'explicit') {
    const wanted = new Set(options.include ?? []);
    for (const toggle of toggles) {
      await setCarrierEnabled(client, tabId, toggle, wanted.has(toggle.id), options.logger);
    }
  }

  for (const id of options.exclude ?? []) {
    const toggle = toggles.find((candidate) => candidate.id === id);
    if (toggle) await setCarrierEnabled(client, tabId, toggle, false, options.logger);
  }

  toggles = await readCarrierToggles(client, tabId);
  options.logger?.info('carriers selected', {
    enabled: toggles.filter((t) => t.enabled).length,
    total: toggles.length,
  });
  return toggles;
}

export interface FinishState {
  valid: boolean;
  headerText: string;
  /** Carriers the page itself names as problematic, when it says so. */
  blamed: string[];
}

export async function readFinishState(client: CamofoxClient, tabId: string): Promise<FinishState> {
  return client.evaluate<FinishState>(
    tabId,
    `(() => {
      const header = document.querySelector('#step-header-finish');
      const text = header ? (header.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      const valid = /done\\s*valid/i.test(text) || (/valid/i.test(text) && !/invalid/i.test(text));
      const blamed = Array.from(document.querySelectorAll('mat-error, .mat-mdc-form-field-error, [role="alert"], .carrier-error'))
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .map((t) => (t.match(/Required for Carrier\\s*:?\\s*(.+)$/i) || [])[1])
        .filter(Boolean);
      return { valid, headerText: text, blamed: Array.from(new Set(blamed)) };
    })()`,
  );
}

export interface PruneOptions {
  client: CamofoxClient;
  tabId: string;
  lob: 'auto' | 'home';
  /** Navigate back to the rating step where carrier toggles live. */
  goToRating: () => Promise<void>;
  /** Navigate forward to the finish step. */
  goToFinish: () => Promise<void>;
  logger: Logger;
  maxCandidates?: number;
}

/**
 * Make `finish` valid, dropping as few carriers as possible.
 *
 * Phase 1 uses whatever the page tells us. Phase 2 falls back to the human's
 * approach: try one carrier at a time, restore it if it was not the problem.
 */
export async function pruneUntilValid(options: PruneOptions): Promise<{
  valid: boolean;
  dropped: DroppedCarrier[];
  restored: string[];
}> {
  const { client, tabId, lob, logger } = options;
  const maxCandidates = options.maxCandidates ?? 8;
  const dropped: DroppedCarrier[] = [];
  const restored: string[] = [];

  let state = await readFinishState(client, tabId);
  if (state.valid) return { valid: true, dropped, restored };

  logger.warn('finish step is invalid', { headerText: state.headerText, blamed: state.blamed });

  // Phase 1 — carriers the page names outright.
  if (state.blamed.length) {
    await options.goToRating();
    const toggles = await readCarrierToggles(client, tabId);
    for (const name of state.blamed) {
      const toggle = matchToggleByName(toggles, name);
      if (!toggle?.enabled) continue;
      await setCarrierEnabled(client, tabId, toggle, false, logger);
      dropped.push({
        carrierId: toggle.id,
        name: toggle.label,
        lob,
        reason: `finish step reported: ${name}`,
        step: `${lob}/finish`,
      });
    }
    await options.goToFinish();
    state = await readFinishState(client, tabId);
    if (state.valid) return { valid: true, dropped, restored };
  }

  // Phase 2 — one-at-a-time search, restoring anything found innocent.
  const tried = new Set<string>();
  for (let round = 0; round < maxCandidates; round++) {
    await options.goToRating();
    const toggles = await readCarrierToggles(client, tabId);
    const candidate = toggles.find((toggle) => toggle.enabled && !tried.has(toggle.id));
    if (!candidate) break;

    tried.add(candidate.id);
    logger.info('trying carrier as the blocker', { carrier: candidate.id, label: candidate.label });

    await setCarrierEnabled(client, tabId, candidate, false, logger);
    await options.goToFinish();
    state = await readFinishState(client, tabId);

    if (state.valid) {
      dropped.push({
        carrierId: candidate.id,
        name: candidate.label,
        lob,
        reason: 'finish step became valid once this carrier was deselected',
        step: `${lob}/finish`,
      });
      return { valid: true, dropped, restored };
    }

    // Innocent — put it back rather than quietly losing a quote.
    await options.goToRating();
    const refreshed = await readCarrierToggles(client, tabId);
    const again = refreshed.find((toggle) => toggle.id === candidate.id);
    if (again) {
      await setCarrierEnabled(client, tabId, again, true, logger);
      restored.push(candidate.label);
      logger.info('carrier restored, was not the blocker', { carrier: candidate.id });
    }
  }

  await options.goToFinish();
  state = await readFinishState(client, tabId);
  return { valid: state.valid, dropped, restored };
}

function matchToggleByName(toggles: CarrierToggle[], name: string): CarrierToggle | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = normalize(name);
  return (
    toggles.find((toggle) => normalize(toggle.label) === wanted) ??
    toggles.find((toggle) => normalize(toggle.label).includes(wanted) || wanted.includes(normalize(toggle.label)))
  );
}

function cssEscape(id: string): string {
  return String(id).replace(/[^\w-]/g, (char) => `\\${char}`);
}
