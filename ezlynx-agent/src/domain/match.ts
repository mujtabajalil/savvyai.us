/**
 * Option matching: map a desired value onto a dropdown's actual option list.
 *
 * Pure and deterministic. Tiers 1–4 resolve the overwhelming majority; only an
 * unresolved match is escalated to DeepSeek, and even then the LLM picks from
 * this closed list — it never invents a value.
 *
 * Every tier is exercised against option lists captured in the recording
 * (#priorCarrier has 299 entries on auto and a *different* 265 on home, which is
 * why callers must key option lists by lob+step+selector, not selector alone).
 */

export type MatchTier = 'exact' | 'normalized' | 'alias' | 'fuzzy' | 'none';

export interface MatchResult {
  matched: string | null;
  index: number;
  tier: MatchTier;
  confidence: number;
  candidates: string[];
}

export const PLACEHOLDER_OPTIONS = new Set(['--select--', 'select', 'select one', 'please select', '', '-']);

/** Dash family, ampersand, and punctuation all vary between EZLynx lists. */
export function normalizeOption(value: string): string {
  return String(value)
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/®|™|©/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalizeOption(value).split(' ').filter(Boolean));
}

/** Dice coefficient over token sets — stable for reordered multi-word names. */
function tokenOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

function editSimilarity(a: string, b: string): number {
  const na = normalizeOption(a);
  const nb = normalizeOption(b);
  if (!na && !nb) return 1;
  const longest = Math.max(na.length, nb.length);
  return longest === 0 ? 0 : 1 - levenshtein(na, nb) / longest;
}

export interface MatchOptions {
  /** Field-scoped synonyms, e.g. { "geico": "GEICO", "safeco": "Liberty Mutual (formerly Safeco)" }. */
  aliases?: Record<string, string>;
  /** Minimum score for tier 4. Below this the caller escalates. */
  fuzzyThreshold?: number;
  /** Keep placeholders like "--Select--" eligible (almost never wanted). */
  includePlaceholders?: boolean;
}

export function matchOption(desired: string, options: string[], config: MatchOptions = {}): MatchResult {
  const threshold = config.fuzzyThreshold ?? 0.82;
  const wanted = String(desired ?? '').trim();

  const eligible = options
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => config.includePlaceholders || !PLACEHOLDER_OPTIONS.has(normalizeOption(text)));

  const miss: MatchResult = { matched: null, index: -1, tier: 'none', confidence: 0, candidates: [] };
  if (!wanted || !eligible.length) return miss;

  for (const { text, index } of eligible) {
    if (text.trim() === wanted) return { matched: text, index, tier: 'exact', confidence: 1, candidates: [] };
  }

  for (const { text, index } of eligible) {
    if (text.trim().toLowerCase() === wanted.toLowerCase()) {
      return { matched: text, index, tier: 'exact', confidence: 1, candidates: [] };
    }
  }

  const wantedNorm = normalizeOption(wanted);
  const normalizedHits = eligible.filter(({ text }) => normalizeOption(text) === wantedNorm);
  if (normalizedHits.length === 1) {
    const hit = normalizedHits[0]!;
    return { matched: hit.text, index: hit.index, tier: 'normalized', confidence: 0.97, candidates: [] };
  }

  const alias = config.aliases?.[wantedNorm] ?? config.aliases?.[wanted] ?? config.aliases?.[wanted.toLowerCase()];
  if (alias) {
    const aliasNorm = normalizeOption(alias);
    const aliasHit = eligible.find(({ text }) => normalizeOption(text) === aliasNorm);
    if (aliasHit) {
      return { matched: aliasHit.text, index: aliasHit.index, tier: 'alias', confidence: 0.95, candidates: [] };
    }
  }

  const scored = eligible
    .map(({ text, index }) => ({
      text,
      index,
      score: Math.max(tokenOverlap(wanted, text), editSimilarity(wanted, text)),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best) return miss;

  const candidates = scored.slice(0, 8).map((entry) => entry.text);

  // An ambiguous top pair is worse than no answer — let the LLM disambiguate
  // rather than silently choosing between two near-identical carrier names.
  const ambiguous = runnerUp !== undefined && best.score - runnerUp.score < 0.05;
  if (best.score >= threshold && !ambiguous) {
    return { matched: best.text, index: best.index, tier: 'fuzzy', confidence: best.score, candidates };
  }

  return { matched: null, index: -1, tier: 'none', confidence: best.score, candidates };
}

/** Yes/No controls appear constantly in ICQ/carrier questions. */
export function matchBoolean(desired: boolean | string, options: string[]): MatchResult {
  const wanted =
    typeof desired === 'boolean'
      ? desired
      : ['yes', 'y', 'true', '1', 'on'].includes(String(desired).trim().toLowerCase());
  return matchOption(wanted ? 'Yes' : 'No', options);
}
