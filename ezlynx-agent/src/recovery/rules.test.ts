import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeterministicRules, chooseEffectiveDate, type RecoveryInput } from './rules.js';
import { contextSliceFor } from './recover.js';
import type { QuoteRequest } from '../domain/schema.js';

const TODAY = new Date(2026, 8, 15);

const QUOTE: QuoteRequest = {
  accountId: '201601955',
  ratingState: 'MN',
  effectiveDate: '11/12/2025',
  applicant: { firstName: 'Dana', lastName: 'Ashby', industry: 'Retired', occupation: 'Retired' },
  address: { line1: '1 Alder Way', city: 'SPRINGFIELD', state: 'MN', postalCode: '55304' },
  drivers: [{ firstName: 'Dana', lastName: 'Ashby', dateOfBirth: '03/14/1975' }],
  vehicles: [{ vin: '1HGCM82633A004352', use: 'To/From Work', oneWayMiles: 12 }],
  priorAuto: { carrier: 'Progressive', expirationDate: '11/14/2026', liabilityLimits: '500CSL' },
  dwelling: { estimatedReplacementCost: 485_000, squareFeet: 2400, garageType: '2-Car-Attached' },
  homeCoverage: { dwelling: 485_000 },
  household: { dogs: false, pool: true, numberOfResidents: 4 },
  creditAuthorization: { authorized: true, obtainedFrom: 'client by phone', obtainedOn: '09/10/2026' },
};

function input(partial: Partial<RecoveryInput>): RecoveryInput {
  return {
    selector: '#x',
    label: '',
    errorText: '',
    quote: QUOTE,
    today: TODAY,
    ...partial,
  };
}

describe('effective date rule', () => {
  test('falls back to a future prior expiration and flags it', () => {
    const outcome = applyDeterministicRules(
      input({
        selector: '#effectiveDateNewPolicy',
        errorText: 'Invalid Effective Date Specified. Date can not be the in past.',
      }),
    );
    assert.equal(outcome?.action, 'set');
    assert.equal(outcome?.value, '11/14/2026');
    assert.match(outcome!.flag ?? '', /prior policy expiration/i);
  });

  test('handles the home wording too', () => {
    const outcome = applyDeterministicRules(
      input({ selector: '#effectiveDateNewPolicy', errorText: 'Effective date cannot be in the past' }),
    );
    assert.equal(outcome?.action, 'set');
  });

  test('asks a human when no future date exists rather than inventing one', () => {
    const quote: QuoteRequest = { ...QUOTE, priorAuto: { carrier: 'Progressive', expirationDate: '01/01/2020' } };
    const outcome = applyDeterministicRules(
      input({ selector: '#effectiveDateNewPolicy', errorText: 'Date can not be the in past.', quote }),
    );
    assert.equal(outcome?.action, 'ask_human');
  });
});

describe('carrier cross-check rules', () => {
  test('pending home Coverage A mirrors the dwelling amount', () => {
    const outcome = applyDeterministicRules(
      input({
        selector: '#coveragehome_mn__105',
        errorText: 'Coverage A or C Amount of Pending Homeowners Policy is invalid.',
      }),
    );
    assert.equal(outcome?.action, 'set');
    assert.equal(outcome?.value, '485000');
  });

  test('market value falls back to dwelling and flags the substitution', () => {
    const outcome = applyDeterministicRules(
      input({ selector: '#marketvalue_autoownersxml__105', errorText: 'Market Value is invalid.' }),
    );
    assert.equal(outcome?.action, 'set');
    assert.equal(outcome?.value, '485000');
    assert.match(outcome!.flag ?? '', /not supplied/i);
  });

  test('a supplied market value is preferred and not flagged', () => {
    const quote: QuoteRequest = { ...QUOTE, dwelling: { ...QUOTE.dwelling, marketValue: 520_000 } };
    const outcome = applyDeterministicRules(
      input({ selector: '#marketvalue_autoownersxml__105', errorText: 'Market Value is invalid.', quote }),
    );
    assert.equal(outcome?.value, '520000');
    assert.equal(outcome?.flag, undefined);
  });
});

describe('vehicle and household rules', () => {
  test('one-way miles uses the supplied commute', () => {
    const outcome = applyDeterministicRules(
      input({ selector: '#oneWayMiles-0', errorText: 'Miles one way cannot be less than 1' }),
    );
    assert.equal(outcome?.action, 'set');
    assert.equal(outcome?.value, '12');
  });

  test('missing commute mileage asks rather than guessing', () => {
    const quote: QuoteRequest = { ...QUOTE, vehicles: [{ vin: '1HGCM82633A004352', use: 'To/From Work' }] };
    const outcome = applyDeterministicRules(
      input({ selector: '#oneWayMiles-0', errorText: 'Miles one way cannot be less than 1', quote }),
    );
    assert.equal(outcome?.action, 'ask_human');
  });

  test('household questions answer from stored facts', () => {
    const pool = applyDeterministicRules(
      input({ selector: '#pool_question__105', label: 'Pool', errorText: 'Required for Carrier: Auto-Owners' }),
    );
    assert.equal(pool?.value, 'Yes');

    const dogs = applyDeterministicRules(
      input({ selector: '#dogs_question__105', label: 'Dogs', errorText: 'Required for Carrier: Auto-Owners' }),
    );
    assert.equal(dogs?.value, 'No');
  });

  test('unknown carrier questions escalate', () => {
    const outcome = applyDeterministicRules(
      input({ selector: '#membershipsince_aaa__613', errorText: 'Required for Carrier: AAA' }),
    );
    assert.equal(outcome, null);
  });

  test('carrierAnswers satisfies a required carrier field', () => {
    const quote: QuoteRequest = { ...QUOTE, carrierAnswers: { '#membershipsince_aaa__613': '2015' } };
    const outcome = applyDeterministicRules(
      input({ selector: '#membershipsince_aaa__613', errorText: 'Required for Carrier: AAA', quote }),
    );
    assert.equal(outcome?.value, '2015');
  });
});

describe('chooseEffectiveDate', () => {
  test('prefers a supplied future date', () => {
    const quote: QuoteRequest = { ...QUOTE, effectiveDate: '12/01/2026' };
    assert.equal(chooseEffectiveDate(quote, {}, TODAY)?.value, '12/01/2026');
  });

  test('falls back to prior expiration when the supplied date is past', () => {
    const chosen = chooseEffectiveDate(QUOTE, {}, TODAY);
    assert.equal(chosen?.value, '11/14/2026');
    assert.match(chosen!.reason, /prior policy/);
  });

  test('uses the configured day offset as a last resort', () => {
    const quote: QuoteRequest = { ...QUOTE, effectiveDate: '01/01/2020', priorAuto: {} };
    const chosen = chooseEffectiveDate(quote, { fallbackDaysFromToday: 30 }, TODAY);
    assert.equal(chosen?.value, '10/15/2026');
  });
});

describe('LLM context slices', () => {
  test('never include names, DOBs or licence numbers', () => {
    for (const selector of ['#marketvalue__105', '#oneWayMiles-0', '#priorCarrier', '#app_occupation__650']) {
      const slice = JSON.stringify(contextSliceFor(selector, QUOTE));
      assert.ok(!slice.includes('Ashby'), `${selector} leaked a surname`);
      assert.ok(!slice.includes('03/14/1975'), `${selector} leaked a DOB`);
      assert.ok(!/socialSecurity|ssn/i.test(slice), `${selector} leaked an SSN field`);
    }
  });

  test('slices are scoped to the field being fixed', () => {
    const home = contextSliceFor('#marketvalue_autoownersxml__105', QUOTE);
    assert.ok(home.dwelling);
    assert.equal(home.vehicles, undefined);

    const vehicle = contextSliceFor('#oneWayMiles-0', QUOTE);
    assert.ok(vehicle.vehicles);
    assert.equal(vehicle.dwelling, undefined);
  });

  test('vehicle slices carry no VIN', () => {
    const slice = JSON.stringify(contextSliceFor('#oneWayMiles-0', QUOTE));
    assert.ok(!slice.includes('1HGCM82633A004352'));
  });
});
