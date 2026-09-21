import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchOption, matchBoolean, normalizeOption, levenshtein } from './match.js';

/**
 * Option strings below are verbatim from the recording's captured lists.
 * Carrier names are public business names, not client PII.
 */
const PRIOR_CARRIER = [
  '--Select--',
  'Other Standard',
  'Other Non-Standard',
  'No Prior Insurance',
  '1st Auto',
  '21st Century',
  'AAA',
  'Acuity',
  'Auto-Owners',
  'Geico',
  'Liberty Mutual',
  'Liberty Northwest',
  'Nationwide',
  'Progressive',
  'Safeco',
  'St. Paul/Travelers',
  'State Farm',
  'Travelers',
  'Universal',
];

const LIABILITY_LIMITS = [
  '--Select--', 'State Minimum', '30/60', '50/50', '50/100', '100/100', '100/300',
  '250/500', '300/300', '500/500', '1000/1000', '55CSL', '100CSL', '300CSL', '500CSL', 'None',
];

const VEHICLE_USE = ['--Select--', 'Business', 'Farming', 'Pleasure', 'To/From Work', 'To/From School'];

describe('normalizeOption', () => {
  test('unifies the dash family', () => {
    assert.equal(normalizeOption('AAA – Auto Club'), normalizeOption('AAA - Auto Club'));
    assert.equal(normalizeOption('A—B'), normalizeOption('A-B'));
  });

  test('expands ampersand and strips trademark marks', () => {
    assert.equal(normalizeOption('Universal Property & Casualty'), 'universal property and casualty');
    assert.equal(normalizeOption('IntelliDrive®'), 'intellidrive');
  });

  test('is case and punctuation insensitive', () => {
    assert.equal(normalizeOption('St. Paul/Travelers'), 'st paul travelers');
  });
});

describe('levenshtein', () => {
  test('basic distances', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });
});

describe('matchOption — exact and normalized tiers', () => {
  test('exact match wins', () => {
    const result = matchOption('Progressive', PRIOR_CARRIER);
    assert.equal(result.matched, 'Progressive');
    assert.equal(result.tier, 'exact');
    assert.equal(result.confidence, 1);
  });

  test('case-insensitive exact — the list says "Geico", agents say "GEICO"', () => {
    const result = matchOption('GEICO', PRIOR_CARRIER);
    assert.equal(result.matched, 'Geico');
    assert.equal(result.tier, 'exact');
  });

  test('normalized match handles punctuation drift', () => {
    const result = matchOption('Auto Owners', PRIOR_CARRIER);
    assert.equal(result.matched, 'Auto-Owners');
    assert.equal(result.tier, 'normalized');
  });

  test('placeholders are never selected', () => {
    const result = matchOption('--Select--', PRIOR_CARRIER);
    assert.equal(result.matched, null);
  });
});

describe('matchOption — ambiguity is escalated, not guessed', () => {
  test('bare "Travelers" still resolves exactly despite St. Paul/Travelers', () => {
    const result = matchOption('Travelers', PRIOR_CARRIER);
    assert.equal(result.matched, 'Travelers');
    assert.equal(result.tier, 'exact');
  });

  test('carrier-toggle name maps to no single prior-carrier entry', () => {
    // The rating page calls it "Liberty Mutual (formerly Safeco)" but the prior
    // carrier list has Liberty Mutual and Safeco as separate options. Silently
    // picking one would record the wrong prior carrier, so this must escalate
    // rather than resolve — the candidates go to the LLM or the operator.
    const result = matchOption('Liberty Mutual (formerly Safeco)', PRIOR_CARRIER);
    assert.equal(result.matched, null);
    assert.equal(result.tier, 'none');
    assert.ok(result.candidates.includes('Liberty Mutual'));
    assert.ok(result.candidates.includes('Safeco'));
  });

  test('an unknown carrier returns no match with candidates for the LLM', () => {
    const result = matchOption('Some Regional Mutual Co', PRIOR_CARRIER);
    assert.equal(result.matched, null);
    assert.ok(result.candidates.length > 0);
  });

  test('aliases resolve what fuzzy cannot', () => {
    const result = matchOption('Safeco', PRIOR_CARRIER, {
      aliases: { safeco: 'Liberty Mutual' },
    });
    assert.equal(result.matched, 'Safeco');
    assert.equal(result.tier, 'exact');
  });
});

describe('matchOption — liability limits and vehicle use', () => {
  test('limit formats match exactly', () => {
    assert.equal(matchOption('500CSL', LIABILITY_LIMITS).matched, '500CSL');
    assert.equal(matchOption('100/300', LIABILITY_LIMITS).matched, '100/300');
  });

  test('spoken limit form normalizes', () => {
    assert.equal(matchOption('100 / 300', LIABILITY_LIMITS).matched, '100/300');
  });

  test('to/from work variants', () => {
    assert.equal(matchOption('To/From Work', VEHICLE_USE).matched, 'To/From Work');
    assert.equal(matchOption('to from work', VEHICLE_USE).matched, 'To/From Work');
    assert.equal(matchOption('Commute', VEHICLE_USE).matched, null);
  });
});

describe('matchBoolean', () => {
  const YES_NO = ['Yes', 'No'];

  test('booleans and strings both resolve', () => {
    assert.equal(matchBoolean(true, YES_NO).matched, 'Yes');
    assert.equal(matchBoolean(false, YES_NO).matched, 'No');
    assert.equal(matchBoolean('yes', YES_NO).matched, 'Yes');
    assert.equal(matchBoolean('N', YES_NO).matched, 'No');
  });
});
