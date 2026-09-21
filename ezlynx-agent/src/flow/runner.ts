/**
 * The step loop.
 *
 * For each step: scan -> diff against desired -> apply -> settle -> rescan ->
 * recover errors (max 3 attempts) -> click next -> assert arrival.
 *
 * Already-correct fields are skipped, but prefill is never trusted as a source:
 * a value only counts as correct if it matches what the quote says it should be.
 */

import { CamofoxClient } from '../camofox/client.js';
import {
  scanStepExpr,
  pageBlockedExpr,
  scrollIntoViewExpr,
  visibilityReportExpr,
  type StepScan,
  type BlockedPage,
} from '../camofox/dom.js';
import { setField, type SetFieldResult } from '../camofox/controls.js';
import { waitFor, sleep } from '../camofox/waits.js';
import { recoverField, type RecoveryRecord, type RecoveryContext } from '../recovery/recover.js';
import type { QuoteRequest } from '../domain/schema.js';
import type { Logger } from '../log/logger.js';

export interface FieldPlan {
  selector: string;
  value: string | boolean;
  /** Controls that must populate afterwards (VIN decode, use -> miles). */
  dependents?: string[];
  optional?: boolean;
  aliases?: Record<string, string>;
}

export interface StepDefinition {
  id: string;
  title: string;
  urlPattern: RegExp;
  container?: string;
  nextSelector: string | null;
  /**
   * A control that proves the step has actually painted.
   *
   * camofox's /wait returns after networkidle + hydration, which on EZLynx's
   * Angular shell happens seconds before the form exists — scanning then finds
   * ~1 control instead of 50. Every step should name an anchor.
   */
  anchorSelector?: string;
  /** Build the field plan from the quote. Runs before every attempt. */
  plan: (quote: QuoteRequest, scan: StepScan) => FieldPlan[] | Promise<FieldPlan[]>;
  /** Extra work that cannot be expressed as a field plan (carrier toggles, grids). */
  before?: (context: StepContext) => Promise<void>;
  after?: (context: StepContext) => Promise<void>;
  /** Step is considered done only when this passes, if supplied. */
  verify?: (context: StepContext, scan: StepScan) => Promise<string | null>;
}

export interface StepContext {
  client: CamofoxClient;
  tabId: string;
  quote: QuoteRequest;
  logger: Logger;
  recovery: RecoveryContext;
  dryRun: boolean;
  /** Carriers dropped so far, with reasons. */
  droppedCarriers: DroppedCarrier[];
  flags: string[];
}

export interface DroppedCarrier {
  carrierId: string | null;
  name: string;
  lob: 'auto' | 'home';
  reason: string;
  step: string;
}

export interface StepResult {
  step: string;
  applied: SetFieldResult[];
  recovered: RecoveryRecord[];
  errors: string[];
  advanced: boolean;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

export async function scanStep(client: CamofoxClient, tabId: string, container?: string): Promise<StepScan> {
  return client.evaluate<StepScan>(tabId, scanStepExpr(container ? { container } : {}));
}

export async function runStep(definition: StepDefinition, context: StepContext): Promise<StepResult> {
  const { client, tabId, quote, logger } = context;
  const log = logger.child({ step: definition.id });

  const result: StepResult = { step: definition.id, applied: [], recovered: [], errors: [], advanced: false, attempts: 0 };

  await assertOnStep(client, tabId, definition, log);
  if (definition.before) await definition.before(context);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result.attempts = attempt;

    const scan = await scanStep(client, tabId, definition.container);
    const plan = await definition.plan(quote, scan);

    for (const field of plan) {
      // Presence is NOT pre-checked against `scan`. The page mutates as it is
      // filled — setting Address State materialises the co-applicant block — so
      // a control absent at scan time may exist by the time we reach it.
      // setField re-reads the control and reports `not-found` if it is really
      // missing, which is the only trustworthy answer.
      const present = scan.controls.find((control) => control.selector === field.selector);

      try {
        const applied = await setField(client, tabId, field.selector, field.value, {
          logger: log,
          ...(field.aliases ? { aliases: field.aliases } : {}),
          ...(field.dependents ? { dependents: field.dependents } : {}),
          ...(context.recovery.llm
            ? {
                resolveOption: async (optionContext) => {
                  const { mapOptionPrompt } = await import('../llm/prompts.js');
                  const choice = await context.recovery.llm!.complete(mapOptionPrompt(optionContext));
                  return choice.confidence >= 0.7 ? choice.option : null;
                },
              }
            : {}),
        });
        if (applied.skipped === 'not-found') continue;
        if (applied.applied || applied.skipped === 'already-set') result.applied.push(applied);
        if (applied.note) context.flags.push(`${definition.id} ${field.selector}: ${applied.note}`);
      } catch (err) {
        // `optional` means "skip if the control is absent" — handled above. Once
        // we are actually attempting a set, a failure is real and must surface.
        // Swallowing it hid genuine County/Years failures behind a later
        // "required" error with no explanation.
        const message = err instanceof Error ? err.message : String(err);

        // A field EZLynx does not mark mandatory is not worth blocking on.
        if (present && !present.required) {
          log.info('optional field could not be set, continuing', { selector: field.selector, error: message });
          context.flags.push(`${definition.id} ${field.selector} (optional): ${message}`);
          continue;
        }

        log.warn('field failed', { selector: field.selector, error: message });
        result.errors.push(`${field.selector}: ${message}`);
      }
    }

    await sleep(400);
    const after = await scanStep(client, tabId, definition.container);

    const allProblems = collectProblems(after);

    // EZLynx marks mandatory fields; anything it does not mark is not worth
    // stopping for. Note them once, then leave them alone.
    const problems = allProblems.filter((problem) => problem.required);
    const ignored = allProblems.filter((problem) => !problem.required);
    if (ignored.length) {
      log.info('ignoring errors on non-required fields', {
        count: ignored.length,
        selectors: ignored.map((problem) => problem.selector).join(', '),
      });
      for (const problem of ignored) {
        context.flags.push(`${definition.id} ${problem.selector} (optional): ${problem.text}`);
      }
    }

    if (!problems.length) {
      if (definition.verify) {
        const failure = await definition.verify(context, after);
        if (failure) {
          result.errors.push(failure);
          log.warn('step verification failed', { reason: failure, attempt });
          continue;
        }
      }
      result.errors = [];
      break;
    }

    log.info('resolving step problems', { count: problems.length, attempt });

    // Fields that appear only after an earlier field is set (the co-applicant
    // block is like this) are absent at plan time, so the fill pass skips them.
    // Re-plan against the current page and use the supplied value before asking
    // anyone — never prompt for something the quote already contains.
    const latePlan = await definition.plan(quote, after);
    const plannedValue = new Map(latePlan.map((field) => [field.selector, field.value]));

    let progressed = false;
    for (const problem of problems) {
      const supplied = plannedValue.get(problem.selector);
      if (supplied !== undefined) {
        try {
          const applied = await setField(client, tabId, problem.selector, supplied, { logger: log });
          if (applied.applied || applied.skipped === 'already-set') {
            log.info('filled from the quote on retry', { selector: problem.selector });
            progressed = true;
            continue;
          }
        } catch (err) {
          log.warn('quote value did not apply, escalating', {
            selector: problem.selector,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const control = after.controls.find((candidate) => candidate.selector === problem.selector);
      const record = await recoverField(
        {
          selector: problem.selector,
          label: control?.label ?? '',
          errorText: problem.text,
          ...(control?.kind === 'mat-select' ? {} : {}),
          ...(problem.carrier ? { carrier: problem.carrier } : {}),
          quote,
        },
        context.recovery,
      );
      result.recovered.push(record);
      if (record.flag) context.flags.push(`${definition.id}: ${record.flag}`);

      if (record.action === 'set' && record.value !== undefined) {
        try {
          await setField(client, tabId, problem.selector, record.value, { logger: log });
          progressed = true;
        } catch (err) {
          log.warn('recovery set failed', { selector: problem.selector, error: String(err) });
        }
      } else if (record.action === 'skip_carrier') {
        context.droppedCarriers.push({
          carrierId: carrierIdFromSelector(problem.selector),
          name: problem.carrier ?? carrierIdFromSelector(problem.selector) ?? 'unknown',
          lob: definition.id.startsWith('home') ? 'home' : 'auto',
          reason: record.reason,
          step: definition.id,
        });
        progressed = true;
      } else {
        result.errors.push(`${problem.selector}: ${record.reason}`);
      }
    }

    if (!progressed) {
      result.errors = problems.map((problem) => `${problem.selector}: ${problem.text}`);
      break;
    }
  }

  if (definition.after) await definition.after(context);

  if (result.errors.length) {
    log.warn('step finished with unresolved problems', { count: result.errors.length });
    return result;
  }

  if (definition.nextSelector) {
    if (context.dryRun && isSubmitButton(definition.nextSelector)) {
      log.info('dry run: not clicking submit', { selector: definition.nextSelector });
      return result;
    }
    // Angular re-renders after the last field is set, which can detach the
    // button mid-click ("no bounding box ... element likely detached"). Retry
    // rather than aborting the whole run.
    let clicked = false;
    for (let attempt = 1; attempt <= 3 && !clicked; attempt++) {
      // The action bar sits at the very bottom of a long form (y≈2024 on the
      // applicant screen, well below a 1349px viewport) and grows further as
      // sections are added, so scroll to it before every attempt.
      await client.evaluate(tabId, scrollIntoViewExpr(definition.nextSelector)).catch(() => undefined);

      try {
        await client.click(tabId, { selector: definition.nextSelector });
        clicked = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === 3) {
          const why = await client
            .evaluate<Record<string, unknown>>(tabId, visibilityReportExpr(definition.nextSelector))
            .catch(() => null);
          result.errors.push(`${definition.nextSelector}: ${message}`);
          log.warn('could not click the next button', { selector: definition.nextSelector, error: message, why });
          return result;
        }
        log.debug('next button click failed, retrying', { attempt, error: message });
        await sleep(1_500);
      }
    }

    await client.waitForPage(tabId, { timeout: 20_000 });
    result.advanced = true;
  }

  return result;
}

export interface StepProblem {
  selector: string;
  text: string;
  carrier?: string;
  /** Only required fields block the step; optional ones are noted and ignored. */
  required: boolean;
}

const REQUIRED_TEXT = /\bis required\b|\brequired for\b|\brequired to proceed\b/i;

/**
 * Field errors plus "Required for Carrier: X" markers, deduped.
 *
 * Each problem carries whether EZLynx actually marks the field required. A
 * control we cannot find is assumed required — better to ask than to skip
 * something that blocks the quote.
 */
export function collectProblems(scan: StepScan): StepProblem[] {
  const problems = new Map<string, StepProblem>();
  const byId = new Map(scan.controls.map((control) => [control.selector, control]));

  const requiredFor = (selector: string, text: string): boolean => {
    if (carrierFromText(text)) return true;
    const control = byId.get(selector);
    if (control) return control.required || REQUIRED_TEXT.test(text);
    return true;
  };

  for (const error of scan.errors) {
    const selector = error.forId ? `#${error.forId}` : '';
    if (!selector) continue;
    problems.set(selector, {
      selector,
      text: error.text,
      required: requiredFor(selector, error.text),
      ...(carrierFromText(error.text) ?? {}),
    });
  }

  for (const control of scan.controls) {
    if (!control.error) continue;
    if (problems.has(control.selector)) continue;
    problems.set(control.selector, {
      selector: control.selector,
      text: control.error,
      required: control.required || REQUIRED_TEXT.test(control.error),
      ...(carrierFromText(control.error) ?? {}),
    });
  }

  return [...problems.values()];
}

function carrierFromText(text: string): { carrier: string } | null {
  const match = text.match(/Required for Carrier\s*:\s*(.+)$/i);
  return match?.[1] ? { carrier: match[1].trim() } : null;
}

function carrierIdFromSelector(selector: string): string | null {
  return selector.match(/__(\d+)$/)?.[1] ?? selector.match(/#carrier-(\d+)-/)?.[1] ?? null;
}

function isSubmitButton(selector: string): boolean {
  return /submit-to-carriers|submit-carriers/.test(selector);
}

async function assertOnStep(
  client: CamofoxClient,
  tabId: string,
  definition: StepDefinition,
  log: Logger,
): Promise<void> {
  const url = await client.currentUrl(tabId);
  const blocked = await client.evaluate<BlockedPage>(tabId, pageBlockedExpr());

  if (blocked.blocked) {
    if (blocked.kind === 'unauthorized') throw new NotAuthorized(url, blocked.detail);
    throw new ReauthenticationRequired(url);
  }

  if (!definition.urlPattern.test(url)) {
    log.warn('unexpected url for step', { expected: String(definition.urlPattern), actual: redactUrl(url) });
  }

  // Default the anchor to the step's own next-button: if that has rendered, the
  // step has painted. Explicit anchors win when a step needs something earlier.
  const anchor = definition.anchorSelector ?? definition.nextSelector;
  if (anchor) {
    try {
      await waitFor(client, tabId, { type: 'exists', selector: anchor }, { timeoutMs: 45_000, logger: log });
    } catch {
      throw new StepNotReady(definition.id, anchor, redactUrl(url));
    }
  }
}

export class StepNotReady extends Error {
  constructor(step: string, anchor: string, url: string) {
    super(
      `Step "${step}" never rendered: anchor ${anchor} did not appear within 45s (url ${url}).\n` +
        'The page may be slow, the selector may have changed, or the screen may differ for this EZLynx user.',
    );
    this.name = 'StepNotReady';
  }
}

/** EZLynx served its in-app 403 card: the logged-in user lacks access. */
export class NotAuthorized extends Error {
  constructor(
    public readonly url: string,
    public readonly detail: string,
  ) {
    super(
      'EZLynx returned 403 Unauthorized Access for this account or quote.\n' +
        'The logged-in EZLynx user does not have permission for it. Log in as a user who can ' +
        'open this account, or run against an account that user can access.\n' +
        `Page said: ${detail}`,
    );
    this.name = 'NotAuthorized';
  }
}

export class ReauthenticationRequired extends Error {
  constructor(public readonly url: string) {
    super(
      'Landed on a login page — the persisted EZLynx session is missing or expired.\n' +
        'Re-authenticate: start camofox with CAMOFOX_INTERACTIVE=desktop, log in by hand, then re-run.\n' +
        'Credential entry and MFA are never automated.',
    );
    this.name = 'ReauthenticationRequired';
  }
}

function redactUrl(url: string): string {
  return url.replace(/\/\d{6,}/g, '/{id}');
}
