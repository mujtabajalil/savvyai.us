/**
 * Element-level waiting.
 *
 * camofox's POST /wait only does page-level readiness (domcontentloaded →
 * networkidle → hydration → settle). EZLynx needs far finer waits: VIN decode,
 * make→model cascades, use→miles reveals, carrier-question sections, the
 * mat-option panel, and results progress bars.
 *
 * Each in-page poll is capped below the server's HANDLER_TIMEOUT_MS (30s). Waits
 * longer than that are chunked across multiple /evaluate calls rather than
 * holding one request open.
 */

import type { CamofoxClient } from './client.js';
import { waitForExpr, type WaitCondition } from './dom.js';
import type { Logger } from '../log/logger.js';

/** Server default is 30_000; stay clear of it so the tab lock is never the thing that trips. */
const CHUNK_MS = 20_000;

export class WaitTimeout extends Error {
  constructor(
    public readonly condition: WaitCondition,
    public readonly waitedMs: number,
    public readonly lastValue: string,
  ) {
    super(
      `Timed out after ${waitedMs}ms waiting for ${condition.type} on "${condition.selector}"` +
        (lastValue ? ` (last value: "${lastValue}")` : ''),
    );
    this.name = 'WaitTimeout';
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  logger?: Logger;
}

export async function waitFor(
  client: CamofoxClient,
  tabId: string,
  condition: WaitCondition,
  options: WaitOptions = {},
): Promise<string> {
  const total = options.timeoutMs ?? 15_000;
  const started = Date.now();
  let lastValue = '';

  while (Date.now() - started < total) {
    const remaining = total - (Date.now() - started);
    const chunk = Math.min(CHUNK_MS, remaining);
    const result = await client.evaluate<{ ok: boolean; value: string }>(
      tabId,
      waitForExpr(condition, chunk),
      { timeoutMs: chunk + 10_000 },
    );
    lastValue = result.value;
    if (result.ok) return result.value;
  }

  throw new WaitTimeout(condition, Date.now() - started, lastValue);
}

/** Non-throwing variant for optional/dependent controls. */
export async function waitForOptional(
  client: CamofoxClient,
  tabId: string,
  condition: WaitCondition,
  options: WaitOptions = {},
): Promise<string | null> {
  try {
    return await waitFor(client, tabId, condition, options);
  } catch (err) {
    if (err instanceof WaitTimeout) {
      options.logger?.debug('optional wait expired', { selector: condition.selector, type: condition.type });
      return null;
    }
    throw err;
  }
}

/**
 * Wait for a set of dependent controls to populate after an upstream change —
 * VIN decode filling year/make/model, "To/From Work" revealing the miles fields.
 */
export async function waitForDependents(
  client: CamofoxClient,
  tabId: string,
  selectors: string[],
  options: WaitOptions = {},
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const selector of selectors) {
    out[selector] = await waitForOptional(
      client,
      tabId,
      { type: 'value-not-empty', selector },
      { ...options, timeoutMs: options.timeoutMs ?? 15_000 },
    );
  }
  return out;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an arbitrary async probe until it returns a value. Used for waits the
 * page cannot express alone (carrier rating finishing, re-rate completing),
 * where each probe is itself a round trip.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs?: number; label?: string; logger?: Logger },
): Promise<T> {
  const interval = options.intervalMs ?? 2_000;
  const started = Date.now();
  let ticks = 0;

  while (Date.now() - started < options.timeoutMs) {
    const result = await probe();
    if (result !== null) return result;
    ticks += 1;
    if (ticks % 10 === 0) {
      options.logger?.info('still waiting', {
        label: options.label ?? 'poll',
        elapsedSec: Math.round((Date.now() - started) / 1000),
      });
    }
    await sleep(interval);
  }

  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label ?? 'condition'}`);
}
