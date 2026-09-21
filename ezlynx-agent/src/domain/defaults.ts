/**
 * Merge input JSON, extracted document data and agency defaults, tracking where
 * every value came from.
 *
 * Precedence: input > extracted > default. Prefill from EZLynx is never a
 * source here — the recording had an effective date of 11/12/2025 when the date
 * was already past, a default 1750 sq ft and an $800,000 dwelling, none of which
 * matched the client.
 */

import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { QuoteRequestSchema, type QuoteRequest } from './schema.js';
import { redact } from '../log/redact.js';

export type Provenance = 'input' | 'extracted' | 'default';

export interface ProvenanceEntry {
  path: string;
  source: Provenance;
  value: unknown;
  overrode?: Array<{ source: Provenance; value: unknown }>;
}

export interface MergeResult {
  quote: QuoteRequest;
  provenance: ProvenanceEntry[];
  /** Fields present in more than one source where a lower-priority value lost. */
  conflicts: ProvenanceEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drop the `$comment` keys used to annotate the JSON config files. */
function stripComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripComments) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$comment') continue;
    out[key] = stripComments(child);
  }
  return out as T;
}

interface Layer {
  source: Provenance;
  data: Record<string, unknown>;
}

function mergeInto(
  target: Record<string, unknown>,
  layers: Layer[],
  path: string,
  provenance: Map<string, ProvenanceEntry>,
): void {
  const keys = new Set<string>();
  for (const layer of layers) for (const key of Object.keys(layer.data)) keys.add(key);

  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    const present = layers
      .filter((layer) => layer.data[key] !== undefined && layer.data[key] !== null)
      .map((layer) => ({ source: layer.source, value: layer.data[key] }));

    if (!present.length) continue;

    if (present.every((entry) => isPlainObject(entry.value))) {
      const child: Record<string, unknown> = {};
      mergeInto(
        child,
        present.map((entry) => ({ source: entry.source, data: entry.value as Record<string, unknown> })),
        childPath,
        provenance,
      );
      if (Object.keys(child).length) target[key] = child;
      continue;
    }

    const winner = present[0]!;
    target[key] = winner.value;

    const losers = present.slice(1);
    provenance.set(childPath, {
      path: childPath,
      source: winner.source,
      value: winner.value,
      ...(losers.length ? { overrode: losers } : {}),
    });
  }
}

export interface MergeInputs {
  input?: Record<string, unknown>;
  extracted?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  /** Defaults to QuoteRequestSchema; `extract` passes DraftQuoteSchema. */
  schema?: z.ZodType<QuoteRequest> | z.ZodTypeAny;
}

export function mergeQuoteSources(inputs: MergeInputs): MergeResult {
  const layers: Layer[] = [
    { source: 'input', data: stripComments(inputs.input ?? {}) },
    { source: 'extracted', data: stripComments(inputs.extracted ?? {}) },
    { source: 'default', data: stripComments(inputs.defaults ?? {}) },
  ];

  const merged: Record<string, unknown> = {};
  const provenance = new Map<string, ProvenanceEntry>();
  mergeInto(merged, layers, '', provenance);

  const quote = (inputs.schema ?? QuoteRequestSchema).parse(merged) as QuoteRequest;
  const entries = [...provenance.values()].sort((a, b) => a.path.localeCompare(b.path));

  return {
    quote,
    provenance: entries,
    conflicts: entries.filter((entry) => entry.overrode?.length),
  };
}

export interface AgencyDefaults {
  /** Merged into the QuoteRequest. Must match its shape. */
  quote: Record<string, unknown>;
  /** Agent behaviour. Never merged into the quote. */
  policy: {
    effectiveDate?: { strategy?: string; fallbackDaysFromToday?: number; minimumDaysFromToday?: number };
    icq?: Record<string, string>;
  };
}

/**
 * The two sections are kept apart on purpose. They were flat once, and the
 * `effectiveDate` *policy* object collided with the quote's `effectiveDate`
 * *string*, producing "Expected string, received object" at validation.
 */
export function loadDefaults(path: string): AgencyDefaults {
  const raw = stripComments(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);
  return {
    quote: isPlainObject(raw.quote) ? raw.quote : {},
    policy: (isPlainObject(raw.policy) ? raw.policy : {}) as AgencyDefaults['policy'],
  };
}

export interface CarrierRegistry {
  carriers: Array<{ id: string; name: string; lobs: string[] }>;
  priorCarrierAliases: Record<string, string>;
}

export function loadCarriers(path: string): CarrierRegistry {
  const parsed = stripComments(JSON.parse(readFileSync(path, 'utf8')) as CarrierRegistry);
  return {
    carriers: parsed.carriers ?? [],
    priorCarrierAliases: parsed.priorCarrierAliases ?? {},
  };
}

/**
 * Render a value for the report.
 *
 * Runs through the same `redact()` the logger uses rather than a second,
 * path-based rule set. A path allowlist missed `drivers` entirely — arrays merge
 * as single values, so the whole driver list (DOBs included) was printed under a
 * path that contained no sensitive-looking word.
 */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  }
  const safe = redact(value);
  const rendered = JSON.stringify(safe);
  return rendered !== undefined && rendered.length > 120 ? `${rendered.slice(0, 117)}…` : String(rendered);
}

/** Human-readable provenance report printed before a run proceeds. */
export function formatProvenance(result: MergeResult): string {
  const lines: string[] = [];
  const counts = { input: 0, extracted: 0, default: 0 } as Record<Provenance, number>;
  for (const entry of result.provenance) counts[entry.source] += 1;

  lines.push('Value sources:');
  lines.push(`  input JSON  ${counts.input}`);
  lines.push(`  extracted   ${counts.extracted}`);
  lines.push(`  defaults    ${counts.default}`);

  if (result.conflicts.length) {
    lines.push('', `Overrides (${result.conflicts.length}):`);
    for (const entry of result.conflicts) {
      const losers = entry.overrode!.map((loser) => `${loser.source}=${renderValue(loser.value)}`).join(', ');
      lines.push(`  ${entry.path}: ${entry.source}=${renderValue(entry.value)}  (over ${losers})`);
    }
  }

  const defaulted = result.provenance.filter((entry) => entry.source === 'default');
  if (defaulted.length) {
    lines.push('', `Taken from agency defaults (${defaulted.length}) — confirm these are right for this client:`);
    for (const entry of defaulted) {
      lines.push(`  ${entry.path} = ${renderValue(entry.value)}`);
    }
  }

  return lines.join('\n');
}
