/**
 * Build the flow map from the recording.
 *
 * The flow map is the selector map: for every LOB/step it records the URL
 * pattern, the next-button selector actually observed, every field with its
 * literal selector, kind, required flag and captured option list, and every
 * validation message seen on that step.
 *
 * Two rules hold this together:
 *  - Selectors are recorded literally, never derived. The recording contains
 *    `#contactdrivers-license-state-...` (missing hyphen) next to
 *    `#contact-drivers-license-status-...`, and drivers are 0-based
 *    (#driver-0-dob) while their DL fields are 1-based (#textD1DLNumber).
 *    Any convention-based guess would be wrong.
 *  - Option lists are keyed by lob+step+selector. #priorCarrier has 299 options
 *    on auto and a different 265 on home; a selector-keyed map would corrupt the
 *    home step.
 */

import {
  filterNoise,
  inferContext,
  isDetailsPath,
  isResultsPath,
  isSubmitPath,
  parseRatingPath,
  type Lob,
  type RecordedEvent,
} from './types.js';
import { isCssSelector } from '../camofox/dom.js';

export interface FlowField {
  selector: string;
  dialect: 'css' | 'playwright';
  kind: string;
  label: string | null;
  required: boolean;
  disabled: boolean;
  container: string | null;
  /** Options as captured. Absent when the recording never opened the control. */
  options?: string[];
  /** Values the operator actually set, in order. */
  observedValues?: string[];
  matches?: number;
  group?: string;
}

export interface FlowMessage {
  kind: 'notice' | 'field-error';
  text: string;
  field: string | null;
  count: number;
}

export interface FlowStep {
  id: string;
  lob: Lob | 'account' | 'submit' | 'results';
  step: string;
  urlPattern: string;
  nextSelector: string | null;
  nextLabel: string | null;
  fields: FlowField[];
  messages: FlowMessage[];
  clicks: Array<{ selector: string; label: string | null }>;
}

export interface FlowMap {
  generatedFrom: {
    events: number;
    kept: number;
    accountId: string;
    quoteIds: Partial<Record<Lob, string>>;
    primaryTab: number;
    span: { from: string; to: string };
  };
  dropped: Array<{ reason: string; path: string; count: number }>;
  order: string[];
  steps: Record<string, FlowStep>;
  carriers: Array<{ id: string; slug: string; label: string; selector: string; lobs: Lob[] }>;
  warnings: string[];
}

const NEXT_BUTTON = /^#(go-to-|save-and-go-to-|submit-to-carriers|submit-carriers)/;
const CARRIER_TOGGLE = /^#carrier-(\d+)-(.+)-button$/;

function stepIdFor(event: RecordedEvent): string | null {
  const rating = parseRatingPath(event.path ?? '');
  if (rating) return `${rating.lob}/${rating.step}`;
  if (isDetailsPath(event.path ?? '')) return 'account/details';
  if (isSubmitPath(event.path ?? '')) return 'submit/submit-details';
  if (isResultsPath(event.path ?? '')) return 'results/quote-results';
  return null;
}

function urlPatternFor(stepId: string): string {
  const [lob, step] = stepId.split('/') as [string, string];
  if (lob === 'account') return '/web/account/{accountId}/details';
  if (lob === 'submit') return '/web/account/{accountId}/rating/submit-details/{quoteId}';
  if (lob === 'results') return '/web/account/{accountId}/rating/quote-results/{quoteId}/{resultId}';
  return `/web/account/{accountId}/rating/${lob}/{quoteId}/${step}`;
}

function lobOf(stepId: string): FlowStep['lob'] {
  const prefix = stepId.split('/')[0]!;
  return prefix as FlowStep['lob'];
}

const VALUE_ACTIONS = new Set(['type', 'dropdown', 'select', 'checkbox', 'radio', 'toggle']);

export function buildFlowMap(events: RecordedEvent[]): FlowMap {
  const context = inferContext(events);
  const { kept, dropped } = filterNoise(events, context);
  const warnings: string[] = [];

  const steps = new Map<string, FlowStep>();
  const order: string[] = [];
  const fieldsByStep = new Map<string, Map<string, FlowField>>();
  const messagesByStep = new Map<string, Map<string, FlowMessage>>();
  const carriers = new Map<string, { id: string; slug: string; label: string; selector: string; lobs: Set<Lob> }>();

  const ensureStep = (stepId: string): FlowStep => {
    let existing = steps.get(stepId);
    if (!existing) {
      const [, step = ''] = stepId.split('/');
      existing = {
        id: stepId,
        lob: lobOf(stepId),
        step,
        urlPattern: urlPatternFor(stepId),
        nextSelector: null,
        nextLabel: null,
        fields: [],
        messages: [],
        clicks: [],
      };
      steps.set(stepId, existing);
      fieldsByStep.set(stepId, new Map());
      messagesByStep.set(stepId, new Map());
      order.push(stepId);
    }
    return existing;
  };

  const upsertField = (stepId: string, partial: FlowField): void => {
    const bucket = fieldsByStep.get(stepId)!;
    const existing = bucket.get(partial.selector);
    if (!existing) {
      bucket.set(partial.selector, partial);
      return;
    }
    // Later observations win for options/label; required stays sticky once seen.
    if (partial.options?.length) existing.options = partial.options;
    if (partial.label && !existing.label) existing.label = partial.label;
    if (partial.required) existing.required = true;
    if (partial.container && !existing.container) existing.container = partial.container;
    if (partial.observedValues?.length) {
      existing.observedValues = [...(existing.observedValues ?? []), ...partial.observedValues];
    }
    if (partial.matches !== undefined) existing.matches = partial.matches;
    if (partial.group && !existing.group) existing.group = partial.group;
  };

  for (const event of kept) {
    const stepId = stepIdFor(event);
    if (!stepId) continue;
    const step = ensureStep(stepId);

    if (event.action === 'screen') {
      for (const field of event.fields ?? []) {
        if (!field.selector) continue;
        upsertField(stepId, {
          selector: field.selector,
          dialect: isCssSelector(field.selector) ? 'css' : 'playwright',
          kind: field.kind,
          label: field.label ?? null,
          required: field.required === true,
          disabled: field.disabled === true,
          container: field.container ?? null,
          ...(field.options?.length ? { options: field.options } : {}),
          ...(field.matches !== undefined ? { matches: field.matches } : {}),
          ...(field.group ? { group: field.group } : {}),
        });
      }
      continue;
    }

    if (VALUE_ACTIONS.has(event.action) && event.selector) {
      upsertField(stepId, {
        selector: event.selector,
        dialect: isCssSelector(event.selector) ? 'css' : 'playwright',
        kind: event.action === 'type' ? 'text' : event.action,
        label: event.label ?? null,
        required: false,
        disabled: false,
        container: event.container ?? null,
        ...(event.options?.length ? { options: event.options } : {}),
        ...(event.value !== undefined ? { observedValues: [event.value] } : {}),
        ...(event.matches !== undefined ? { matches: event.matches } : {}),
        ...(event.group ? { group: event.group } : {}),
      });

      const carrierMatch = event.selector.match(CARRIER_TOGGLE);
      if (carrierMatch) {
        const id = carrierMatch[1]!;
        const entry = carriers.get(id) ?? {
          id,
          slug: carrierMatch[2]!,
          label: event.label ?? carrierMatch[2]!,
          selector: event.selector,
          lobs: new Set<Lob>(),
        };
        const rating = parseRatingPath(event.path ?? '');
        if (rating) entry.lobs.add(rating.lob);
        if (event.label) entry.label = event.label;
        carriers.set(id, entry);
      }
      continue;
    }

    if (event.action === 'click' && event.selector) {
      step.clicks.push({ selector: event.selector, label: event.label ?? null });
      if (NEXT_BUTTON.test(event.selector)) {
        if (step.nextSelector && step.nextSelector !== event.selector) {
          warnings.push(
            `${stepId}: more than one next-button observed (${step.nextSelector}, ${event.selector}) — review by hand`,
          );
        }
        step.nextSelector = event.selector;
        step.nextLabel = event.label ?? null;
      }
      continue;
    }

    if (event.action === 'message' && event.text) {
      const bucket = messagesByStep.get(stepId)!;
      const key = `${event.kind}::${event.text}`;
      const existing = bucket.get(key);
      if (existing) existing.count += 1;
      else {
        bucket.set(key, {
          kind: (event.kind as FlowMessage['kind']) ?? 'notice',
          text: event.text,
          field: event.field ?? null,
          count: 1,
        });
      }
    }
  }

  for (const [stepId, step] of steps) {
    step.fields = [...fieldsByStep.get(stepId)!.values()].sort((a, b) => a.selector.localeCompare(b.selector));
    step.messages = [...messagesByStep.get(stepId)!.values()].sort((a, b) => b.count - a.count);

    if (!step.nextSelector && !['results/quote-results'].includes(stepId)) {
      warnings.push(`${stepId}: no next-button observed — the runner cannot advance this step`);
    }
    const playwrightFields = step.fields.filter((field) => field.dialect === 'playwright');
    if (playwrightFields.length) {
      warnings.push(
        `${stepId}: ${playwrightFields.length} Playwright-dialect selector(s) cannot be read via /evaluate: ` +
          playwrightFields.map((field) => field.selector).join(', '),
      );
    }
  }

  const span = {
    from: events[0]?.t ?? '',
    to: events[events.length - 1]?.t ?? '',
  };

  return {
    generatedFrom: {
      events: events.length,
      kept: kept.length,
      accountId: context.accountId,
      quoteIds: context.quoteIds,
      primaryTab: context.primaryTab,
      span,
    },
    dropped,
    order,
    steps: Object.fromEntries(steps),
    carriers: [...carriers.values()]
      .map((entry) => ({ ...entry, lobs: [...entry.lobs].sort() }))
      .sort((a, b) => Number(a.id) - Number(b.id)),
    warnings,
  };
}
