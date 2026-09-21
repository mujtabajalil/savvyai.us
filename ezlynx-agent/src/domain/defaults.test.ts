import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mergeQuoteSources, formatProvenance, loadDefaults, loadCarriers } from './defaults.js';
import { DraftQuoteSchema, QuoteRequestSchema } from './schema.js';

const DEFAULTS_PATH = resolve(process.cwd(), 'config/defaults.json');
const CARRIERS_PATH = resolve(process.cwd(), 'config/carriers.json');

const MINIMAL = {
  ratingState: 'MN',
  applicant: { firstName: 'Dana', lastName: 'Ashby' },
  address: { line1: '1 Alder Way', city: 'SPRINGFIELD', state: 'MN', postalCode: '55304' },
  creditAuthorization: { authorized: true, obtainedFrom: 'client by phone', obtainedOn: '09/10/2026' },
};

describe('agency defaults file', () => {
  test('separates quote-shaped defaults from agent policy', () => {
    const defaults = loadDefaults(DEFAULTS_PATH);

    assert.equal(defaults.quote.newPolicyTerm, '12 Month');
    assert.equal(defaults.quote.quoteAsPackage, true);

    // Regression: `effectiveDate` policy is an OBJECT and must never be merged
    // into the quote, whose `effectiveDate` is a date STRING. When the file was
    // flat, this produced "Expected string, received object".
    assert.equal(defaults.quote.effectiveDate, undefined);
    assert.equal(typeof defaults.policy.effectiveDate, 'object');
    assert.equal(defaults.policy.effectiveDate?.strategy, 'prior-expiration');
  });

  test('$comment annotations never reach the merged quote', () => {
    const defaults = loadDefaults(DEFAULTS_PATH);
    assert.ok(!('$comment' in defaults.quote));
    assert.ok(!('$comment' in (defaults.policy.icq ?? {})));
  });

  test('the real defaults file merges into a valid draft quote', () => {
    const defaults = loadDefaults(DEFAULTS_PATH);
    const merged = mergeQuoteSources({ input: MINIMAL, defaults: defaults.quote, schema: DraftQuoteSchema });
    assert.equal(merged.quote.newPolicyTerm, '12 Month');
    assert.equal(merged.quote.homeCoverage?.policyFormType, 'HO3 - Dwelling');
  });

  test('credit authorisation is not defaulted anywhere', () => {
    const defaults = loadDefaults(DEFAULTS_PATH);
    const serialized = JSON.stringify(defaults);
    assert.ok(!/creditAuthorization/.test(serialized));

    assert.throws(
      () => mergeQuoteSources({ input: { ...MINIMAL, creditAuthorization: undefined }, defaults: defaults.quote }),
      /creditAuthorization/,
    );
  });
});

describe('precedence', () => {
  test('input beats extracted beats defaults', () => {
    const merged = mergeQuoteSources({
      input: { ...MINIMAL, newPolicyTerm: '6 Month' },
      extracted: { newPolicyTerm: '12 Month', dwelling: { squareFeet: 2400 } },
      defaults: { newPolicyTerm: '12 Month', quoteAsPackage: true },
      schema: DraftQuoteSchema,
    });

    assert.equal(merged.quote.newPolicyTerm, '6 Month');
    assert.equal(merged.quote.dwelling?.squareFeet, 2400);
    assert.equal(merged.quote.quoteAsPackage, true);
  });

  test('provenance records the winner and what it overrode', () => {
    const merged = mergeQuoteSources({
      input: { ...MINIMAL, newPolicyTerm: '6 Month' },
      extracted: { newPolicyTerm: '12 Month' },
      schema: DraftQuoteSchema,
    });

    const entry = merged.provenance.find((candidate) => candidate.path === 'newPolicyTerm');
    assert.equal(entry?.source, 'input');
    assert.deepEqual(entry?.overrode, [{ source: 'extracted', value: '12 Month' }]);
    assert.equal(merged.conflicts.length, 1);
  });

  test('nested objects merge key by key rather than wholesale', () => {
    const merged = mergeQuoteSources({
      input: { ...MINIMAL, dwelling: { squareFeet: 2400 } },
      extracted: { dwelling: { yearBuilt: 1998, squareFeet: 1750 } },
      schema: DraftQuoteSchema,
    });

    assert.equal(merged.quote.dwelling?.squareFeet, 2400, 'input wins');
    assert.equal(merged.quote.dwelling?.yearBuilt, 1998, 'extracted fills the gap');
  });

  test('a stale prefill-style value never wins just by being present', () => {
    // The recording prefilled 1750 sq ft and an $800,000 dwelling for a client
    // whose real figures differed. Defaults are the lowest priority, always.
    const merged = mergeQuoteSources({
      input: { ...MINIMAL, dwelling: { squareFeet: 2400 } },
      defaults: { dwelling: { squareFeet: 1750 } },
      schema: DraftQuoteSchema,
    });
    assert.equal(merged.quote.dwelling?.squareFeet, 2400);
  });
});

describe('provenance report', () => {
  test('lists defaulted values for confirmation and redacts sensitive paths', () => {
    const merged = mergeQuoteSources({
      input: {
        ...MINIMAL,
        drivers: [{ firstName: 'Dana', lastName: 'Ashby', dateOfBirth: '03/14/1975' }],
      },
      extracted: { drivers: [{ dateOfBirth: '01/01/1970' }] },
      defaults: { newPolicyTerm: '12 Month' },
      schema: DraftQuoteSchema,
    });

    const report = formatProvenance(merged);
    assert.match(report, /Taken from agency defaults/);
    assert.match(report, /newPolicyTerm = "12 Month"/);
    assert.ok(!report.includes('03/14/1975'), 'a DOB must not appear in the provenance report');
  });
});

describe('carrier registry', () => {
  test('loads carriers and prior-carrier aliases', () => {
    const registry = loadCarriers(CARRIERS_PATH);
    const byId = new Map(registry.carriers.map((carrier) => [carrier.id, carrier]));

    assert.ok(byId.has('613'));
    assert.ok(byId.has('650'));
    assert.equal(byId.get('650')?.name, 'GEICO');
    assert.ok(!('$comment' in registry.priorCarrierAliases));

    // The rating page and the prior-carrier dropdown disagree; aliases bridge them.
    assert.equal(registry.priorCarrierAliases['geico'], 'Geico');
  });
});

describe('schemas', () => {
  test('a draft quote does not need an account id, a full one does', () => {
    assert.equal(DraftQuoteSchema.safeParse(MINIMAL).success, true);
    assert.equal(QuoteRequestSchema.safeParse(MINIMAL).success, false);
    assert.equal(QuoteRequestSchema.safeParse({ ...MINIMAL, accountId: '201601955' }).success, true);
  });

  test('account id must be numeric', () => {
    assert.equal(QuoteRequestSchema.safeParse({ ...MINIMAL, accountId: 'abc' }).success, false);
  });

  test('credit authorisation requires who and when, not just a boolean', () => {
    const result = QuoteRequestSchema.safeParse({
      ...MINIMAL,
      accountId: '1',
      creditAuthorization: { authorized: true },
    });
    assert.equal(result.success, false);
  });
});
