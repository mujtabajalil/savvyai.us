import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApplicantStep, applicantDetailsStep, accountStep, autoSteps, homeSteps } from './steps.js';
import type { QuoteRequest } from '../domain/schema.js';
import type { StepScan } from '../camofox/dom.js';

const QUOTE: QuoteRequest = {
  accountId: '0',
  ratingState: 'MN',
  effectiveDate: '11/14/2026',
  bridgeEmailToCarriers: true,
  applicant: {
    firstName: 'Dana',
    lastName: 'Ashby',
    gender: 'Male',
    dateOfBirth: '03/14/1975',
    maritalStatus: 'Married',
    industry: 'Retired',
    occupation: 'Retired',
    email: 'dana@example.org',
    phone: '(555) 123-4567',
  },
  address: {
    line1: '1 Alder Way',
    city: 'ANDOVER',
    state: 'MN',
    postalCode: '55304',
    county: 'Anoka',
    yearsAtAddress: 5,
  },
  coApplicant: {
    firstName: 'Testco',
    lastName: 'Ashby',
    gender: 'Female',
    dateOfBirth: '07/22/1977',
    maritalStatus: 'Married',
    industry: 'Business/Sales/Office',
    occupation: 'Administrative Assistant',
  },
  drivers: [],
  vehicles: [],
  creditAuthorization: { authorized: true, obtainedFrom: 'client by phone', obtainedOn: '09/10/2026' },
};

const EMPTY_SCAN: StepScan = { url: '', controls: [], errors: [], carrierRequirements: [], notices: [] };

async function planOf(step: ReturnType<typeof createApplicantStep>, quote = QUOTE) {
  return step.plan(quote, EMPTY_SCAN);
}

describe('createApplicantStep', () => {
  test('targets the create URL confirmed live', () => {
    const step = createApplicantStep(['auto']);
    assert.match('https://app.ezlynx.com/web/account/create/personal', step.urlPattern);
    assert.equal(step.id, 'account/create');
  });

  test('always uses plain Save, never Go to auto/home', () => {
    // Verified live: on a NEW applicant, "Go to auto"/"Go to home" are silent
    // no-ops — enabled and hit-testable, but zero handlers and zero network
    // requests, because the account does not exist yet. Plain Save creates it.
    for (const lobs of [['auto', 'home'], ['auto'], ['home'], []]) {
      assert.equal(createApplicantStep(lobs).nextSelector, '#save-personal-applicant-btn');
    }
  });

  test('the details step entered after save does use Go to auto/home', () => {
    assert.equal(applicantDetailsStep(['auto', 'home']).nextSelector, '#save-and-go-to-auto-btn');
    assert.equal(applicantDetailsStep(['home']).nextSelector, '#save-and-go-to-home-btn');
    assert.equal(applicantDetailsStep([]).nextSelector, '#save-personal-applicant-btn');
  });

  test('anchors on a control that proves the Angular form painted', () => {
    // networkidle returns seconds before this form exists.
    assert.equal(createApplicantStep(['auto']).anchorSelector, '#applicant-first-name');
  });

  test('covers every field EZLynx marks required on that screen', async () => {
    const plan = await planOf(createApplicantStep(['auto']));
    const selectors = new Set(plan.map((field) => field.selector));

    // Verbatim from the live discovery capture of /web/account/create/personal.
    for (const required of [
      '#applicant-first-name',
      '#applicant-last-name',
      '#applicant-rating-state',
      '#applicant-gender',
      '#applicant-date-of-birth',
      '#applicant-marital-status',
      '#applicant-industry',
      '#applicant-occupation',
      '#applicant-primary-address-address1',
      '#applicant-primary-address-addressCity',
      '#applicant-primary-address-addressState',
      '#applicant-primary-address-addressCounty',
      '#applicant-primary-address-postalCode',
      '#applicant-primary-address-yearsAtAddress',
      '#applicant-phone-1-personal-number',
    ]) {
      assert.ok(selectors.has(required), `missing required field ${required}`);
    }
  });

  test('occupation waits on industry, which populates it', async () => {
    const plan = await planOf(createApplicantStep(['auto']));
    const industry = plan.find((field) => field.selector === '#applicant-industry');
    assert.deepEqual(industry?.dependents, ['#applicant-occupation']);
  });

  test('postal code waits on county, which the app fills itself', async () => {
    const plan = await planOf(createApplicantStep(['auto']));
    const postal = plan.find((field) => field.selector === '#applicant-primary-address-postalCode');
    assert.deepEqual(postal?.dependents, ['#applicant-primary-address-addressCounty']);
  });

  test('industry is not planned without a value, so occupation is not blocked', async () => {
    const quote: QuoteRequest = { ...QUOTE, applicant: { ...QUOTE.applicant, industry: undefined } };
    const plan = await planOf(createApplicantStep(['auto']), quote);
    assert.equal(plan.some((field) => field.selector === '#applicant-industry'), false);
  });

  test('the co-applicant shares the household address', async () => {
    // The contact block has its own address section with a different selector
    // shape; Years At Address there is required for rating.
    const plan = await planOf(createApplicantStep(['auto']));
    const selectors = new Set(plan.map((field) => field.selector));
    assert.ok(selectors.has('#contact-address-0-yearsAtAddress'));
    assert.ok(selectors.has('#contact-address-0-address1'));
    const years = plan.find((f) => f.selector === '#contact-address-0-yearsAtAddress');
    assert.equal(years?.value, '5');
  });

  test('no co-applicant means no contact fields at all', async () => {
    const quote = { ...QUOTE };
    delete (quote as { coApplicant?: unknown }).coApplicant;
    const plan = await planOf(createApplicantStep(['auto']), quote);
    assert.equal(plan.some((field) => field.selector.startsWith('#contact-')), false);
  });

  test('bridge-email radio is planned as a boolean', async () => {
    const plan = await planOf(createApplicantStep(['auto']));
    const bridge = plan.find((field) => field.selector === '[name="isEmailBridgedToCarriers"]');
    assert.equal(bridge?.value, true);
  });

  test('empty optional values are never planned', async () => {
    const quote: QuoteRequest = {
      ...QUOTE,
      applicant: { ...QUOTE.applicant, middleInitial: '', education: undefined },
    };
    const plan = await planOf(createApplicantStep(['auto']), quote);
    assert.equal(plan.some((field) => field.selector === '#applicant-middle-name'), false);
    assert.equal(plan.some((field) => field.selector === '#applicant-education'), false);
  });
});

describe('step anchors', () => {
  test('every step can prove it painted, via an anchor or its next button', () => {
    for (const step of [accountStep, createApplicantStep(['auto']), applicantDetailsStep(['auto']), ...autoSteps(), ...homeSteps()]) {
      const anchor = step.anchorSelector ?? step.nextSelector;
      assert.ok(anchor, `step ${step.id} has no anchor and no next button`);
    }
  });

  test('the recorded oddities are preserved literally', () => {
    const home = homeSteps();
    // Home endorsements advances with #go-to-drivers-btn. Not a typo.
    assert.equal(home.find((step) => step.id === 'home/endorsements')?.nextSelector, '#go-to-drivers-btn');
    assert.equal(home.find((step) => step.id === 'home/policy-info')?.nextSelector, '#go-to-dwellingInfo-btn');
    assert.equal(autoSteps().find((step) => step.id === 'auto/finish')?.nextSelector, '#save-and-go-to-home-btn');
  });
});

describe('applicant details step (existing account)', () => {
  test('shares the create screen selectors', async () => {
    const plan = await accountStep.plan(QUOTE, EMPTY_SCAN);
    const selectors = new Set(plan.map((field) => field.selector));
    assert.ok(selectors.has('#applicant-first-name'));
    assert.ok(selectors.has('#applicant-gender'));
    assert.ok(selectors.has('#applicant-primary-address-address1'));
  });
});
