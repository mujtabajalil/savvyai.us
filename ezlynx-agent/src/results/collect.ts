/**
 * Drive the quote-results page: wait for rating to finish, answer follow-up
 * carrier questions, switch to list view, and read the cards.
 */

import type { CamofoxClient } from '../camofox/client.js';
import { pollUntil, sleep } from '../camofox/waits.js';
import { describeControl, setField } from '../camofox/controls.js';
import {
  answerButtonsExpr,
  buildQuoteCards,
  graphToggleExpr,
  progressBarsExpr,
  resultsExtractionExpr,
  submitAnswersButtonExpr,
  type NormalizedQuote,
  type RawResultCard,
} from './parse.js';
import { readNoticesExpr, scanStepExpr, type StepScan } from '../camofox/dom.js';
import { recoverField, type RecoveryContext } from '../recovery/recover.js';
import type { QuoteRequest } from '../domain/schema.js';
import type { Logger } from '../log/logger.js';
import type { DroppedCarrier } from '../flow/runner.js';

export interface CollectOptions {
  client: CamofoxClient;
  tabId: string;
  quote: QuoteRequest;
  logger: Logger;
  recovery: RecoveryContext;
  ratingTimeoutMs?: number;
  answerQuestions?: boolean;
}

export interface CollectResult {
  quotes: NormalizedQuote[];
  droppedCarriers: DroppedCarrier[];
  flags: string[];
  answeredCarriers: string[];
}

/** Rating can take minutes; polled in short probes rather than one long wait. */
export async function waitForRatingComplete(
  client: CamofoxClient,
  tabId: string,
  logger: Logger,
  timeoutMs = 300_000,
): Promise<void> {
  await pollUntil(
    async () => {
      const bars = await client.evaluate<number>(tabId, progressBarsExpr());
      return bars === 0 ? true : null;
    },
    { timeoutMs, intervalMs: 3_000, label: 'carrier rating to finish', logger },
  );
  await sleep(1_000);
}

interface AnswerButton {
  id: string;
  carrierId: string | null;
  lob: string | null;
  disabled: boolean;
}

/**
 * Answer follow-up questions for one carrier.
 * The submit button's id carries a dynamic numeric suffix, so it is matched by
 * prefix rather than constructed.
 */
async function answerCarrierQuestions(
  options: CollectOptions,
  button: AnswerButton,
): Promise<{ answered: boolean; dropped?: DroppedCarrier; flags: string[] }> {
  const { client, tabId, quote, logger, recovery } = options;
  const log = logger.child({ carrier: button.carrierId ?? 'unknown', lob: button.lob ?? '' });
  const flags: string[] = [];

  await client.click(tabId, { selector: `#${button.id}` });
  await sleep(1_200);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const scan = await client.evaluate<StepScan>(tabId, scanStepExpr({}));

    const answers = quote.carrierAnswers ?? {};
    for (const [selector, value] of Object.entries(answers)) {
      if (scan.controls.some((control) => control.selector === selector)) {
        await setField(client, tabId, selector, value, { logger: log }).catch(() => undefined);
      }
    }

    const unanswered = scan.controls.filter(
      (control) => control.required && control.visible && !control.disabled && control.value.trim() === '',
    );

    for (const control of unanswered) {
      const record = await recoverField(
        {
          selector: control.selector,
          label: control.label,
          errorText: control.error ?? `Required for Carrier: ${button.carrierId ?? 'unknown'}`,
          ...(button.carrierId ? { carrier: button.carrierId } : {}),
          quote,
        },
        recovery,
      );
      if (record.flag) flags.push(record.flag);

      if (record.action === 'set' && record.value !== undefined) {
        await setField(client, tabId, control.selector, record.value, { logger: log }).catch(() => undefined);
      } else if (record.action === 'skip_carrier' || record.action === 'ask_human') {
        return {
          answered: false,
          dropped: {
            carrierId: button.carrierId,
            name: button.carrierId ?? 'unknown',
            lob: (button.lob?.toLowerCase() === 'home' ? 'home' : 'auto') as 'auto' | 'home',
            reason: record.reason,
            step: 'quote-results/answer-questions',
          },
          flags,
        };
      }
    }

    const submit = await client.evaluate<{ id: string; disabled: boolean } | null>(tabId, submitAnswersButtonExpr());
    if (!submit) {
      log.warn('no submit-answers button found');
      return { answered: false, flags };
    }

    await client.click(tabId, { selector: `#${submit.id}` });

    // "<Carrier> additional questions submitted" then a re-rate.
    const settled = await pollUntil(
      async () => {
        const notices = await client.evaluate<string[]>(tabId, readNoticesExpr());
        return notices.some((notice) => /additional questions submitted/i.test(notice)) ? true : null;
      },
      { timeoutMs: 30_000, intervalMs: 1_500, label: 'answers to be accepted', logger: log },
    ).catch(() => false);

    if (settled) {
      await waitForRatingComplete(client, tabId, log, 180_000).catch(() => undefined);
      return { answered: true, flags };
    }

    log.info('answers not accepted yet, retrying', { attempt });
  }

  return { answered: false, flags };
}

/** Graph view hides exact premium/term/basis; the list view shows them. */
async function ensureListView(client: CamofoxClient, tabId: string, logger: Logger): Promise<void> {
  const toggle = await client.evaluate<{ id: string | null; checked: boolean } | null>(tabId, graphToggleExpr());
  if (!toggle) return;
  if (!toggle.checked) return;

  if (toggle.id) {
    await setField(client, tabId, `#${toggle.id}`, false, { logger }).catch(async () => {
      await client.click(tabId, { selector: `#${toggle.id}` });
    });
  }
  await sleep(800);
}

export async function collectResults(options: CollectOptions): Promise<CollectResult> {
  const { client, tabId, logger } = options;
  const droppedCarriers: DroppedCarrier[] = [];
  const flags: string[] = [];
  const answeredCarriers: string[] = [];

  await waitForRatingComplete(client, tabId, logger, options.ratingTimeoutMs ?? 300_000);

  if (options.answerQuestions !== false) {
    const seen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const buttons = await client.evaluate<AnswerButton[]>(tabId, answerButtonsExpr());
      const pending = buttons.filter((button) => !button.disabled && !seen.has(button.id));
      if (!pending.length) break;

      const button = pending[0]!;
      seen.add(button.id);
      logger.info('answering carrier questions', { carrier: button.carrierId, lob: button.lob });

      const outcome = await answerCarrierQuestions(options, button);
      flags.push(...outcome.flags);
      if (outcome.dropped) droppedCarriers.push(outcome.dropped);
      if (outcome.answered) answeredCarriers.push(button.carrierId ?? button.id);
    }
  }

  await ensureListView(client, tabId, logger);
  await waitForRatingComplete(client, tabId, logger, 120_000).catch(() => undefined);

  const raw = await client.evaluate<RawResultCard[]>(tabId, resultsExtractionExpr());
  const quotes = buildQuoteCards(raw);

  logger.info('results collected', {
    cards: raw.length,
    quotes: quotes.length,
    withErrors: quotes.filter((quote) => quote.error).length,
  });

  return { quotes, droppedCarriers, flags, answeredCarriers };
}

/** Used by `ezlynx-agent results --url ...` against an existing results page. */
export async function collectFromUrl(
  client: CamofoxClient,
  url: string,
  logger: Logger,
): Promise<NormalizedQuote[]> {
  const tab = await client.createTab(url);
  try {
    await client.waitForPage(tab.tabId, { timeout: 30_000 });

    const current = await client.currentUrl(tab.tabId);
    if (/login|signin|\/auth/i.test(current)) {
      throw new Error('Landed on a login page — re-authenticate with CAMOFOX_INTERACTIVE=desktop first.');
    }

    await waitForRatingComplete(client, tab.tabId, logger, 300_000).catch(() => undefined);
    await ensureListView(client, tab.tabId, logger);

    const raw = await client.evaluate<RawResultCard[]>(tab.tabId, resultsExtractionExpr());
    return buildQuoteCards(raw);
  } finally {
    await client.closeTab(tab.tabId).catch(() => undefined);
  }
}

export async function readSelectedCarrierNames(
  client: CamofoxClient,
  tabId: string,
): Promise<string[]> {
  const scan = await client.evaluate<StepScan>(tabId, scanStepExpr({}));
  return scan.controls
    .filter((control) => /^carrier-\d+-.*-button$/.test(control.id ?? '') && control.checked === true)
    .map((control) => control.label || control.id || '')
    .filter(Boolean);
}

export { describeControl };
