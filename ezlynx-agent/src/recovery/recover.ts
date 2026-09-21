/**
 * The escalation ladder for a field error: deterministic rules -> DeepSeek ->
 * ask a human. Bounded attempts per step; nothing is dropped silently.
 */

import { applyDeterministicRules, type RecoveryInput, type RecoveryOutcome } from './rules.js';
import { resolveErrorPrompt, type RecoveryAction } from '../llm/prompts.js';
import type { DeepSeekClient } from '../llm/deepseek.js';
import type { QuoteRequest } from '../domain/schema.js';
import type { Logger } from '../log/logger.js';

export interface RecoveryContext {
  llm?: DeepSeekClient;
  logger?: Logger;
  /** Prompts the operator; returns their answer, or null to abandon the field. */
  askHuman?: (question: string, input: RecoveryInput) => Promise<string | null>;
}

export interface RecoveryRecord extends RecoveryOutcome {
  selector: string;
  errorText: string;
  carrier?: string;
  resolvedBy: 'rule' | 'llm' | 'human';
}

/**
 * Minimal, non-identifying slice of the quote for the LLM.
 * Names, DOBs and licence numbers are deliberately absent.
 */
export function contextSliceFor(selector: string, quote: QuoteRequest): Record<string, unknown> {
  const slice: Record<string, unknown> = {
    ratingState: quote.ratingState,
    effectiveDate: quote.effectiveDate,
    vehicleCount: quote.vehicles.length,
    driverCount: quote.drivers.length,
  };

  if (/home|dwelling|coverage[ab]|marketvalue|garage|roof/i.test(selector)) {
    slice.dwelling = {
      squareFeet: quote.dwelling?.squareFeet,
      yearBuilt: quote.dwelling?.yearBuilt,
      construction: quote.dwelling?.construction,
      garageType: quote.dwelling?.garageType,
      estimatedReplacementCost: quote.dwelling?.estimatedReplacementCost,
      marketValue: quote.dwelling?.marketValue,
    };
    slice.homeCoverage = { dwelling: quote.homeCoverage?.dwelling };
  }

  if (/vehicle|miles|use|vin/i.test(selector)) {
    slice.vehicles = quote.vehicles.map((vehicle) => ({
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      use: vehicle.use,
      oneWayMiles: vehicle.oneWayMiles,
      annualMiles: vehicle.annualMiles,
    }));
  }

  if (/prior|carrier|continuous/i.test(selector)) {
    slice.priorAuto = quote.priorAuto;
    slice.priorHome = quote.priorHome;
  }

  if (/occupation|industry|employ/i.test(selector)) {
    slice.applicantOccupation = {
      industry: quote.applicant.industry,
      occupation: quote.applicant.occupation,
    };
    if (quote.coApplicant) {
      slice.coApplicantOccupation = {
        industry: quote.coApplicant.industry,
        occupation: quote.coApplicant.occupation,
      };
    }
  }

  return JSON.parse(JSON.stringify(slice, (_key, value) => (value === undefined ? undefined : value)));
}

export async function recoverField(input: RecoveryInput, context: RecoveryContext = {}): Promise<RecoveryRecord> {
  const base = { selector: input.selector, errorText: input.errorText, ...(input.carrier ? { carrier: input.carrier } : {}) };

  const rule = applyDeterministicRules(input);
  if (rule) {
    context.logger?.info('recovered by rule', { selector: input.selector, action: rule.action });
    return { ...base, ...rule, resolvedBy: 'rule' };
  }

  if (context.llm) {
    try {
      const action: RecoveryAction = await context.llm.complete(
        resolveErrorPrompt({
          selector: input.selector,
          label: input.label,
          errorText: input.errorText,
          ...(input.options ? { options: input.options } : {}),
          ...(input.carrier ? { carrier: input.carrier } : {}),
          context: contextSliceFor(input.selector, input.quote),
        }),
      );

      // A "set" with no value is not a usable answer.
      if (action.action === 'set' && !action.value) {
        context.logger?.warn('llm returned set with no value; treating as ask_human', { selector: input.selector });
      } else if (action.action !== 'ask_human') {
        context.logger?.info('recovered by llm', { selector: input.selector, action: action.action });
        return {
          ...base,
          action: action.action,
          ...(action.value !== undefined ? { value: action.value } : {}),
          reason: action.reason,
          resolvedBy: 'llm',
        };
      }
    } catch (err) {
      context.logger?.warn('llm recovery failed', { selector: input.selector, error: String(err) });
    }
  }

  if (context.askHuman) {
    const question = [
      `Cannot resolve a field on the EZLynx form.`,
      `  field:   ${input.selector}`,
      `  label:   ${input.label || '(none)'}`,
      input.carrier ? `  carrier: ${input.carrier}` : '',
      `  error:   ${input.errorText}`,
      input.options?.length ? `  options: ${input.options.slice(0, 20).join(' | ')}` : '',
      '',
      'Enter a value, or leave blank to skip this carrier.',
    ]
      .filter(Boolean)
      .join('\n');

    const answer = await context.askHuman(question, input);
    if (answer && answer.trim()) {
      return { ...base, action: 'set', value: answer.trim(), reason: 'answered by operator', resolvedBy: 'human' };
    }
    return {
      ...base,
      action: 'skip_carrier',
      reason: 'operator declined to supply a value',
      resolvedBy: 'human',
    };
  }

  return {
    ...base,
    action: 'ask_human',
    reason: 'No rule matched, no LLM configured, and the run is non-interactive.',
    resolvedBy: 'rule',
  };
}
