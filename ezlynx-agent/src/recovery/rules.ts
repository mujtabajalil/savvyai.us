/**
 * Deterministic error recovery. Tried before the LLM, always.
 *
 * Every rule here corresponds to an error actually observed in the recording.
 * Rules return an action or null; null means "escalate".
 */

import { isFutureDate, normalizeDate, normalizeCurrency, addDays } from '../domain/normalize.js';
import type { QuoteRequest } from '../domain/schema.js';

export interface RecoveryInput {
  selector: string;
  label: string;
  errorText: string;
  options?: string[];
  carrier?: string;
  quote: QuoteRequest;
  /** Today, injectable for tests. */
  today?: Date;
}

export interface RecoveryOutcome {
  action: 'set' | 'skip_carrier' | 'ask_human';
  value?: string;
  reason: string;
  /** Surfaced in the final report when a value was derived rather than supplied. */
  flag?: string;
}

export type RecoveryRule = (input: RecoveryInput) => RecoveryOutcome | null;

const PAST_DATE_ERROR = /date\s*can\s*not\s*be\s*the?\s*in\s*past|effective date cannot be in the past|in the past/i;

/**
 * "Invalid Effective Date Specified. Date can not be the in past." (auto) and
 * "Effective date cannot be in the past" (home).
 *
 * Prefer the prior policy expiration when it is in the future — that is the real
 * intent of a rewrite. Otherwise ask, rather than silently inventing a date that
 * changes the premium.
 */
export const effectiveDateRule: RecoveryRule = (input) => {
  if (!PAST_DATE_ERROR.test(input.errorText)) return null;
  if (!/effectiveDate|effective-date/i.test(input.selector)) return null;

  const today = input.today ?? new Date();
  const supplied = input.quote.effectiveDate;
  if (supplied && isFutureDate(supplied, today)) {
    return { action: 'set', value: normalizeDate(supplied), reason: 'supplied effective date is in the future' };
  }

  const priorExpiry = input.quote.priorAuto?.expirationDate ?? input.quote.priorHome?.expirationDate;
  if (priorExpiry && isFutureDate(priorExpiry, today)) {
    return {
      action: 'set',
      value: normalizeDate(priorExpiry),
      reason: 'used prior policy expiration date, which is in the future',
      flag: `Effective date derived from prior policy expiration (${normalizeDate(priorExpiry)})`,
    };
  }

  return {
    action: 'ask_human',
    reason:
      'Effective date is in the past and no future prior-policy expiration is available. ' +
      'Choosing a date changes the premium, so this needs a human decision.',
  };
};

/**
 * Auto-Owners cross-check: "Coverage A or C Amount of Pending Homeowners Policy
 * is invalid." The auto quote must state the pending home Coverage A.
 */
export const pendingHomeCoverageRule: RecoveryRule = (input) => {
  if (!/coveragehome/i.test(input.selector) && !/Coverage A or C Amount/i.test(input.errorText)) return null;

  const dwelling = input.quote.homeCoverage?.dwelling ?? input.quote.dwelling?.estimatedReplacementCost;
  if (!dwelling) {
    return {
      action: 'ask_human',
      reason: 'Carrier wants the pending home Coverage A but no home dwelling amount is available.',
    };
  }
  return {
    action: 'set',
    value: String(normalizeCurrency(dwelling)),
    reason: 'mirrored the pending home Coverage A (dwelling) amount',
  };
};

/** Auto-Owners home: "Market Value is invalid." */
export const marketValueRule: RecoveryRule = (input) => {
  if (!/marketvalue/i.test(input.selector) && !/Market Value is invalid/i.test(input.errorText)) return null;

  const market = input.quote.dwelling?.marketValue;
  if (market) {
    return { action: 'set', value: String(normalizeCurrency(market)), reason: 'used the supplied market value' };
  }

  const dwelling = input.quote.homeCoverage?.dwelling ?? input.quote.dwelling?.estimatedReplacementCost;
  if (dwelling) {
    return {
      action: 'set',
      value: String(normalizeCurrency(dwelling)),
      reason: 'no market value supplied; fell back to the dwelling amount',
      flag:
        `Market value was not supplied — used the dwelling amount (${normalizeCurrency(dwelling)}) instead. ` +
        'Verify before presenting this quote.',
    };
  }

  return { action: 'ask_human', reason: 'Market value is required and neither a market value nor a dwelling amount is available.' };
};

/** "Miles one way cannot be less than 1" on the vehicles step. */
export const oneWayMilesRule: RecoveryRule = (input) => {
  if (!/Miles one way cannot be less than 1/i.test(input.errorText) && !/oneWayMiles/i.test(input.selector)) return null;

  const index = Number(input.selector.match(/oneWayMiles-(\d+)/)?.[1] ?? NaN);
  const vehicle = Number.isInteger(index) ? input.quote.vehicles[index] : undefined;
  const miles = vehicle?.oneWayMiles;

  if (miles && miles >= 1) {
    return { action: 'set', value: String(miles), reason: 'used the supplied one-way mileage' };
  }
  return {
    action: 'ask_human',
    reason: 'Commute mileage is required for this vehicle and none was supplied. It affects the premium directly.',
  };
};

/**
 * "Required for Carrier: X" on a field with no value we hold.
 *
 * Only fires when the field is genuinely unanswerable from quote data; the
 * runner tries the normal field mapping first.
 */
export const requiredForCarrierRule: RecoveryRule = (input) => {
  if (!/Required for Carrier/i.test(input.errorText)) return null;

  const answer = input.quote.carrierAnswers?.[input.selector];
  if (answer) {
    return { action: 'set', value: answer, reason: 'answered from the quote\'s carrierAnswers map' };
  }
  return null;
};

/** Yes/No questions where the quote already holds the household fact. */
export const householdQuestionRule: RecoveryRule = (input) => {
  const household = input.quote.household;
  if (!household) return null;

  const map: Array<[RegExp, boolean | undefined]> = [
    [/dog/i, household.dogs],
    [/pool/i, household.pool],
    [/trampoline/i, household.trampoline],
    [/business/i, household.businessOnPremises],
  ];

  for (const [pattern, value] of map) {
    if (value === undefined) continue;
    if (pattern.test(input.selector) || pattern.test(input.label)) {
      return { action: 'set', value: value ? 'Yes' : 'No', reason: 'answered from household questions' };
    }
  }
  return null;
};

export const DEFAULT_RULES: RecoveryRule[] = [
  effectiveDateRule,
  pendingHomeCoverageRule,
  marketValueRule,
  oneWayMilesRule,
  requiredForCarrierRule,
  householdQuestionRule,
];

export function applyDeterministicRules(input: RecoveryInput, rules = DEFAULT_RULES): RecoveryOutcome | null {
  for (const rule of rules) {
    const outcome = rule(input);
    if (outcome) return outcome;
  }
  return null;
}

/** Choose the new-policy effective date when the input does not supply one. */
export function chooseEffectiveDate(
  quote: QuoteRequest,
  policy: { strategy?: string; fallbackDaysFromToday?: number; minimumDaysFromToday?: number } = {},
  today = new Date(),
): { value: string; reason: string } | null {
  const supplied = quote.effectiveDate;
  if (supplied && isFutureDate(supplied, today)) {
    return { value: normalizeDate(supplied), reason: 'supplied' };
  }

  if ((policy.strategy ?? 'prior-expiration') === 'prior-expiration') {
    const prior = quote.priorAuto?.expirationDate ?? quote.priorHome?.expirationDate;
    if (prior && isFutureDate(prior, today)) {
      return { value: normalizeDate(prior), reason: 'prior policy expiration' };
    }
  }

  const days = policy.fallbackDaysFromToday;
  if (typeof days === 'number' && days > 0) {
    const iso = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    return { value: normalizeDate(addDays(iso, days)), reason: `${days} days from today (fallback)` };
  }

  return null;
}
