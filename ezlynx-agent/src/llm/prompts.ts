/**
 * The three — and only three — jobs the LLM does.
 *
 *  1. extract structured data from source documents
 *  2. resolve a validation error or an unknown carrier question
 *  3. map a free-text value onto a dropdown's actual option list
 *
 * It never decides what to click. Every prompt carries the minimum slice of
 * data needed, and SSNs are never included.
 */

import { z } from 'zod';
import type { CompletionRequest } from './deepseek.js';
import { PartialQuoteSchema, type PartialQuote } from '../domain/schema.js';

export const OptionChoiceSchema = z.object({
  option: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type OptionChoice = z.infer<typeof OptionChoiceSchema>;

export const RecoveryActionSchema = z.object({
  action: z.enum(['set', 'skip_carrier', 'ask_human']),
  value: z.string().optional(),
  reason: z.string(),
});
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const ExtractionSchema = z.object({
  quote: PartialQuoteSchema,
  notes: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
});
export type ExtractionResult = { quote: PartialQuote; notes: string[]; unresolved: string[] };

/** Tier 5 of the matching ladder: choose from a closed list or answer null. */
export function mapOptionPrompt(input: {
  label: string;
  selector: string;
  desired: string;
  options: string[];
  candidates: string[];
}): CompletionRequest<OptionChoice> {
  const options = input.options.slice(0, 400);
  return {
    task: 'map-option',
    schema: OptionChoiceSchema,
    schemaExample: { option: 'Exact option text or null', confidence: 0.0, reason: 'short justification' },
    maxTokens: 300,
    system: [
      'You map an insurance value onto a dropdown option list in the EZLynx rater.',
      'Rules:',
      '- "option" MUST be copied character-for-character from the provided list, or be null.',
      '- Never invent an option. Never return a value that is not in the list.',
      '- If two options are plausible and you cannot tell which is correct, return null.',
      '- Returning null is correct and safe; a wrong option silently corrupts the quote.',
    ].join('\n'),
    user: [
      `Field label: ${input.label || '(no label — this field has a useless label, rely on the value)'}`,
      `Field selector: ${input.selector}`,
      `Desired value: ${input.desired}`,
      input.candidates.length ? `Closest candidates: ${JSON.stringify(input.candidates)}` : '',
      `Full option list (json): ${JSON.stringify(options)}`,
      '',
      'Which option corresponds to the desired value? Reply as json.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Resolve a field error or a carrier question the deterministic rules could not. */
export function resolveErrorPrompt(input: {
  selector: string;
  label: string;
  errorText: string;
  options?: string[];
  carrier?: string;
  /** Minimal, already-redacted slice of the quote. Never includes SSNs. */
  context: Record<string, unknown>;
}): CompletionRequest<RecoveryAction> {
  return {
    task: 'resolve-error',
    schema: RecoveryActionSchema,
    schemaExample: { action: 'set', value: 'the value to enter', reason: 'why' },
    maxTokens: 400,
    system: [
      'You resolve validation errors in the EZLynx comparative rater for a licensed insurance agency.',
      'Choose exactly one action:',
      '- "set": you are confident of the correct value. If an option list is given, "value" MUST be copied from it.',
      '- "skip_carrier": the carrier requires information the agency does not have, so drop that carrier from this quote.',
      '- "ask_human": anything else, including anything that needs a judgement call about the client.',
      '',
      'Never guess at client facts you were not given (dates of birth, licence numbers, prior coverage).',
      'Prefer ask_human over a plausible guess. A wrong value produces a wrong premium.',
    ].join('\n'),
    user: [
      `Field selector: ${input.selector}`,
      `Field label: ${input.label || '(label is unreliable for this field)'}`,
      input.carrier ? `Carrier: ${input.carrier}` : '',
      `Error message: ${input.errorText}`,
      input.options?.length ? `Allowed options (json): ${JSON.stringify(input.options.slice(0, 200))}` : '',
      `Relevant quote data (json): ${JSON.stringify(input.context)}`,
      '',
      'What should be done? Reply as json.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Pull structured quote data out of an RCE or other source document. */
export function extractDocumentPrompt(input: {
  documentText: string;
  documentKind: 'rce' | 'dec-page' | 'notes';
  ratingState?: string;
}): CompletionRequest<ExtractionResult> {
  const truncated = input.documentText.slice(0, 60_000);
  return {
    task: 'extract-document',
    schema: ExtractionSchema as unknown as z.ZodType<ExtractionResult>,
    schemaExample: {
      quote: {
        dwelling: {
          squareFeet: 2400,
          yearBuilt: 1998,
          construction: 'Frame',
          roofType: 'Architectural Shingle',
          estimatedReplacementCost: 485000,
        },
      },
      notes: ['anything noteworthy about the document'],
      unresolved: ['fields the document did not contain'],
    },
    maxTokens: 3000,
    system: [
      'You extract structured insurance data from source documents for a licensed agency.',
      'Rules:',
      '- Only report values the document actually states. Never estimate or infer.',
      '- List anything a quote needs but the document lacks under "unresolved".',
      '- Omit a field entirely rather than guessing it.',
      '- Do not include social security numbers even if present in the document.',
      '- Money values are integers with no currency symbol or separators.',
    ].join('\n'),
    user: [
      `Document kind: ${input.documentKind}`,
      input.ratingState ? `Rating state: ${input.ratingState}` : '',
      '',
      'Document text:',
      '---',
      truncated,
      '---',
      '',
      'Extract the quote data as json.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
