/**
 * Step definitions for Auto (1-9) and Home (10-16).
 *
 * Selectors are taken literally from the recording. Two traps are load-bearing:
 *  - Home "endorsements" advances with #go-to-drivers-btn. That is not a typo.
 *  - Drivers are 0-based (#driver-0-dob) but their DL fields are 1-based
 *    (#textD1DLNumber, #drpD1DLState).
 */

import { scanStep, type StepDefinition, type FieldPlan, type StepContext } from './runner.js';
import type { QuoteRequest } from '../domain/schema.js';
import { normalizeDate, normalizeDriversLicense, normalizeVin, normalizeCurrency } from '../domain/normalize.js';
import { selectCarriers } from './carriers.js';
import { setField, describeControl } from '../camofox/controls.js';
import { waitForOptional } from '../camofox/waits.js';
import type { StepScan } from '../camofox/dom.js';

const account = (step: string) => new RegExp(`/web/account/\\d+/${step}`);
const rating = (lob: string, step: string) => new RegExp(`/web/account/\\d+/rating/${lob}/\\d+/${step}`);

function push(plan: FieldPlan[], selector: string, value: unknown, extra: Partial<FieldPlan> = {}): void {
  if (value === undefined || value === null || value === '') return;
  plan.push({ selector, value: typeof value === 'boolean' ? value : String(value), optional: true, ...extra });
}

function safeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeDate(value);
  } catch {
    return undefined;
  }
}

/**
 * Shared applicant field plan.
 *
 * The create screen (/web/account/create/personal) and the details screen
 * (/web/account/{id}/details) are the same form with the same selectors —
 * verified live — so both steps share this.
 */
function applicantFieldPlan(quote: QuoteRequest, scan?: StepScan): FieldPlan[] {
  const plan: FieldPlan[] = [];
  const a = quote.applicant;

  push(plan, '#applicant-first-name', a.firstName);
  push(plan, '#applicant-last-name', a.lastName);
  push(plan, '#applicant-middle-name', a.middleInitial);
  push(plan, '#applicant-gender', a.gender);
  push(plan, '#applicant-date-of-birth', safeDate(a.dateOfBirth));
  // Married / Domestic Partner makes EZLynx create a REQUIRED spouse-contact row
  // that it renders visibility:hidden — unfillable, and it blocks the save. See
  // maritalStatusWarning() and README "Known limits".
  push(plan, '#applicant-marital-status', a.maritalStatus);
  push(plan, '#applicant-education', a.education);

  // Occupation is populated by Industry; wait for it before setting it.
  if (a.industry) {
    plan.push({
      selector: '#applicant-industry',
      value: a.industry,
      optional: true,
      ...(a.occupation ? { dependents: ['#applicant-occupation'] } : {}),
    });
  }
  push(plan, '#applicant-occupation', a.occupation);
  push(plan, '#applicant-rating-state', quote.ratingState);

  const address = quote.address;
  push(plan, '#applicant-primary-address-address1', address.line1);
  push(plan, '#applicant-primary-address-addressUnit', address.unit);
  push(plan, '#applicant-primary-address-addressCity', address.city);
  push(plan, '#applicant-primary-address-addressState', address.state);

  // Postal code drives County, which the app fills in itself.
  plan.push({
    selector: '#applicant-primary-address-postalCode',
    value: address.postalCode,
    optional: true,
    dependents: ['#applicant-primary-address-addressCounty'],
  });
  push(plan, '#applicant-primaryaddress-postalcode', address.postalCode);
  push(plan, '#applicant-primary-address-postalCodeSuffix', address.postalCodeSuffix);
  if (address.county) push(plan, '#applicant-primary-address-addressCounty', address.county);
  push(plan, '#applicant-primary-address-yearsAtAddress', address.yearsAtAddress);
  push(plan, '#applicant-primary-address-monthsAtAddress', address.monthsAtAddress);

  if (a.email) push(plan, '#applicant-email-0-email-address', a.email);
  if (a.phone) push(plan, '#applicant-phone-1-personal-number', a.phone);

  if (quote.bridgeEmailToCarriers !== undefined) {
    plan.push({ selector: '[name="isEmailBridgedToCarriers"]', value: quote.bridgeEmailToCarriers, optional: true });
  }

  plan.push(...coApplicantFieldPlan(quote, scan));
  return plan;
}

/**
 * Co-applicant / additional contact.
 *
 * On the CREATE screen these are index-suffixed (`#contact-first-name-0`); on an
 * existing account's details screen the recording shows them keyed by contact id
 * (`#contact-first-name-67645461`). Both are handled: the indexed form is planned
 * and anything absent is skipped.
 *
 * EZLynx surfaces this block as required during validation even though it is not
 * on the pristine form, so it is always planned when a co-applicant is supplied.
 */
function coApplicantFieldPlan(quote: QuoteRequest, scan?: StepScan): FieldPlan[] {
  const co = quote.coApplicant;
  if (!co) return [];

  // Use the row that is actually visible. Filling the applicant form can leave a
  // phantom contact row behind — present and validated, but visibility:hidden,
  // so nothing can be typed into it. `#add-contact-btn` creates a real one; see
  // revealCoApplicantRow below.
  const plan: FieldPlan[] = [];
  const n = visibleContactRow(scan) ?? 0;

  push(plan, `#contact-first-name-${n}`, co.firstName);
  push(plan, `#contact-last-name-${n}`, co.lastName);
  push(plan, `#contact-middle-name-${n}`, co.middleInitial);
  push(plan, `#contact-gender-${n}`, co.gender);
  push(plan, `#contact-date-of-birth-${n}`, safeDate(co.dateOfBirth));
  push(plan, `#contact-marital-statuses-${n}`, co.maritalStatus);
  push(plan, `#contact-relationships-${n}`, 'Spouse');

  if (co.industry) {
    plan.push({
      selector: `#contact-industry-${n}`,
      value: co.industry,
      optional: true,
      ...(co.occupation ? { dependents: [`#contact-occupation-${n}`] } : {}),
    });
  }
  push(plan, `#contact-occupation-${n}`, co.occupation);
  push(plan, `#contact-education-${n}`, co.education);

  // The contact carries its own address block (`#contact-address-{n}-*`, a
  // different shape from the applicant's `#applicant-primary-address-*`). A
  // spouse shares the household address, so mirror it rather than asking.
  const address = quote.address;
  push(plan, `#contact-address-${n}-yearsAtAddress`, address.yearsAtAddress);
  push(plan, `#contact-address-${n}-monthsAtAddress`, address.monthsAtAddress);
  push(plan, `#contact-address-${n}-address1`, address.line1);
  push(plan, `#contact-address-${n}-addressCity`, address.city);
  push(plan, `#contact-address-${n}-addressState`, address.state);
  push(plan, `#contact-address-${n}-postalCode`, address.postalCode);
  if (address.county) push(plan, `#contact-address-${n}-addressCounty`, address.county);

  return plan;
}


/** Index of the first co-applicant row that is actually visible, if any. */
function visibleContactRow(scan?: StepScan): number | null {
  if (!scan) return null;
  for (const control of scan.controls) {
    const match = control.selector.match(/^#contact-first-name-(\d+)$/);
    if (match && control.visible) return Number(match[1]);
  }
  return null;
}

/**
 * Make sure a usable co-applicant row exists before the plan tries to fill it.
 *
 * Observed live: after the applicant fields are filled, EZLynx leaves a contact
 * row in the DOM that is `visibility: hidden` — required by validation, but
 * impossible to type into. Clicking "Add contact" produces a visible one.
 */
/**
 * Warn when the quote will trigger EZLynx's hidden spouse-contact row.
 *
 * A/B verified on the live form: marital status "Married" creates a contact row
 * after Address State is set, rendered `visibility: hidden` but still required,
 * so the applicant cannot be saved. "Single" creates no row and saves cleanly.
 */
function maritalStatusWarning(context: StepContext): void {
  const status = context.quote.applicant.maritalStatus ?? '';
  if (!/^(married|domestic partner)$/i.test(status)) return;

  context.logger.warn(
    `marital status "${status}" makes EZLynx add a hidden, required spouse-contact row ` +
      'that cannot be filled; this step will not be able to save. ' +
      'Co-applicant/married support is incomplete — see README "Known limits".',
  );
  context.flags.push(
    `Applicant marital status is "${status}": EZLynx adds a hidden required contact row, ` +
      'which blocks saving the applicant.',
  );
}

async function revealCoApplicantRow(context: StepContext): Promise<void> {
  maritalStatusWarning(context);

  if (!context.quote.coApplicant) return;

  // Known limitation, observed live: clicking "Add contact" switches the form
  // into a contact-editing mode that REMOVES the action bar —
  // #save-and-go-to-auto-btn disappears from the DOM (29 buttons -> 25) — and
  // the control that commits the contact has not been identified. The contact
  // fields themselves fill correctly; the step simply cannot be saved
  // afterwards. Warn loudly rather than failing opaquely at the save.
  context.logger.warn(
    'adding a co-applicant removes the Save / Go to buttons in EZLynx; ' +
      'this step will not be able to advance. Remove coApplicant from the quote to proceed.',
  );
  context.flags.push(
    'Co-applicant requested: EZLynx hides the action bar while a contact is being edited, ' +
      'so the applicant step cannot be saved. Co-applicant support is incomplete.',
  );

  const visible = async (): Promise<boolean> => {
    const state = await describeControl(context.client, context.tabId, '#contact-first-name-0');
    if (state.found && state.visible) return true;
    const scan = await scanStep(context.client, context.tabId);
    return visibleContactRow(scan) !== null;
  };

  if (await visible()) return;

  context.logger.info('revealing the co-applicant row via #add-contact-btn');
  await context.client.click(context.tabId, { selector: '#add-contact-btn' }).catch((err) => {
    context.logger.warn('could not click Add contact', { error: String(err) });
  });

  await waitForOptional(
    context.client,
    context.tabId,
    { type: 'visible', selector: '#contact-first-name-0' },
    { timeoutMs: 10_000, logger: context.logger },
  );

  if (!(await visible())) {
    context.flags.push('Could not reveal a co-applicant row; contact fields may block this step.');
  }
}

/**
 * Always plain "Save" — never "Go to auto" / "Go to home".
 *
 * Verified live: on a NEW applicant those two buttons are silent no-ops. They
 * are enabled and hit-testable, but clicking them (real click or JS) fires no
 * handler and zero network requests, because the account does not exist yet.
 * "Save" creates the account (13+ requests) and routes to
 * /web/account/{id}/details with an "Applicant Saved" notice; the rater is
 * reached from there.
 */
function applicantSaveButton(_lobs: string[]): string {
  return '#save-personal-applicant-btn';
}

/**
 * Step 0 — create a new Personal Lines applicant.
 *
 * Reached from `#root-NavMenu_Applicants` → `#CreateApplicant`, but the flyout is
 * unnecessary: the link is a plain URL. Saving with "Go to auto" both creates the
 * account and starts the auto quote, so this step flows straight into the rater.
 */
export function createApplicantStep(lobs: string[] = ['auto']): StepDefinition {
  return {
    id: 'account/create',
    title: 'Create applicant',
    urlPattern: /\/web\/account\/create\/personal/,
    anchorSelector: '#applicant-first-name',
    nextSelector: applicantSaveButton(lobs),
    plan: (quote, scan) => applicantFieldPlan(quote, scan),
    before: revealCoApplicantRow,
  };
}

/**
 * Step 1 — applicant details on an account that already exists.
 *
 * "Go to auto" / "Go to home" work here (unlike on the create screen) because
 * the account has an id. This is also the screen a freshly created applicant
 * lands on, so `--create` runs the create step and then this one.
 */
export function applicantDetailsStep(lobs: string[] = ['auto']): StepDefinition {
  return {
    ...applicantStep,
    nextSelector: lobs.includes('auto')
      ? '#save-and-go-to-auto-btn'
      : lobs.includes('home')
        ? '#save-and-go-to-home-btn'
        : '#save-personal-applicant-btn',
  };
}

/** Step 1 — applicant details on an existing account. */
export const applicantStep: StepDefinition = {
  id: 'account/details',
  title: 'Applicant details',
  urlPattern: account('details'),
  anchorSelector: '#applicant-first-name',
  nextSelector: '#save-and-go-to-auto-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];
    const a = quote.applicant;

    push(plan, '#applicant-first-name', a.firstName);
    push(plan, '#applicant-last-name', a.lastName);
    push(plan, '#applicant-middle-name', a.middleInitial);
    push(plan, '#applicant-gender', a.gender);
    push(plan, '#applicant-date-of-birth', safeDate(a.dateOfBirth));
    push(plan, '#applicant-marital-status', a.maritalStatus);
    push(plan, '#applicant-education', a.education);
    push(plan, '#applicant-industry', a.industry);
    push(plan, '#applicant-occupation', a.occupation);
    push(plan, '#applicant-rating-state', quote.ratingState);

    const address = quote.address;
    push(plan, '#applicant-primary-address-address1', address.line1);
    push(plan, '#applicant-primary-address-addressUnit', address.unit);
    push(plan, '#applicant-primary-address-addressCity', address.city);
    push(plan, '#applicant-primary-address-addressState', address.state);
    push(plan, '#applicant-primary-address-postalCode', address.postalCode);
    push(plan, '#applicant-primary-address-addressCounty', address.county);
    push(plan, '#applicant-primaryaddress-postalcode', address.postalCode);

    if (a.email) push(plan, '#applicant-email-0-email-address', a.email);
    if (a.phone) push(plan, '#applicant-phone-1-personal-number', a.phone);

    if (quote.bridgeEmailToCarriers !== undefined) {
      plan.push({ selector: '[name="isEmailBridgedToCarriers"]', value: quote.bridgeEmailToCarriers, optional: true });
    }
    return plan;
  },
};

/** Steps 2 and 10 — carrier selection. */
export function ratingStep(lob: 'auto' | 'home'): StepDefinition {
  return {
    id: `${lob}/rating`,
    title: `${lob === 'auto' ? 'Auto' : 'Home'} carriers`,
    urlPattern: rating(lob, 'rating'),
    nextSelector: '#go-to-policy-info-btn',
    plan: (quote) => {
      const plan: FieldPlan[] = [];
      if (lob === 'home') push(plan, '#policyFormType', quote.homeCoverage?.policyFormType);
      return plan;
    },
    before: async (context: StepContext) => {
      const selection = context.quote.carriers?.[lob];
      await selectCarriers(context.client, context.tabId, {
        mode: selection?.mode ?? 'all',
        include: selection?.include ?? [],
        exclude: selection?.exclude ?? [],
        logger: context.logger,
      });
    },
  };
}

/** Steps 3 and 11 — policy info. */
export function policyInfoStep(lob: 'auto' | 'home'): StepDefinition {
  return {
    id: `${lob}/policy-info`,
    title: `${lob === 'auto' ? 'Auto' : 'Home'} policy info`,
    urlPattern: rating(lob, 'policy-info'),
    nextSelector: lob === 'auto' ? '#go-to-drivers-btn' : '#go-to-dwellingInfo-btn',
    plan: (quote) => {
      const plan: FieldPlan[] = [];
      const prior = lob === 'auto' ? quote.priorAuto : quote.priorHome;

      push(plan, '#priorCarrier', prior?.carrier);
      push(plan, '#priorPolicyExpirationDate', safeDate(prior?.expirationDate));
      push(plan, '#priorPolicyTerm', prior?.policyTerm);
      push(plan, '#yearsWithPriorCarrier', prior?.yearsWithCarrier);
      push(plan, '#monthsWithPriorCarrier', prior?.monthsWithCarrier);
      push(plan, '#yearsWithContinuousCoverage', prior?.yearsContinuousCoverage);
      push(plan, '#monthsWithContinuousCoverage', prior?.monthsContinuousCoverage);
      if (prior?.premium !== undefined) push(plan, '#priorPolicyPremium', prior.premium);

      if (lob === 'auto') {
        push(plan, '#priorLiabilityLimits', prior?.liabilityLimits);
        push(plan, '#package', quote.quoteAsPackage ? 'Yes' : 'No');
      }

      push(plan, '#newPolicyTerm', quote.newPolicyTerm);
      push(plan, '#effectiveDateNewPolicy', safeDate(quote.effectiveDate));

      // Credit authorisation is only ever answered from explicit client consent.
      if (quote.creditAuthorization.authorized) push(plan, '#creditCheckAuthorized', 'Yes');

      const household = quote.household;
      if (household?.numberOfResidents) push(plan, '#numberofresidents_common', household.numberOfResidents);

      for (const [selector, value] of Object.entries(quote.carrierAnswers ?? {})) {
        if (selector.startsWith('#')) plan.push({ selector, value, optional: true });
      }
      return plan;
    },
  };
}

/** Step 4 — drivers. */
export const driversStep: StepDefinition = {
  id: 'auto/drivers-compact',
  title: 'Auto drivers',
  urlPattern: rating('auto', 'drivers-compact'),
  nextSelector: '#go-to-vehicles-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];

    quote.drivers.forEach((driver, index) => {
      const n = index;
      const oneBased = index + 1;

      push(plan, `#driver-${n}-first-name`, driver.firstName);
      push(plan, `#driver-${n}-last-name`, driver.lastName);
      push(plan, `#driver-${n}-dob`, safeDate(driver.dateOfBirth));
      push(plan, `#driver-${n}-gender`, driver.gender);
      push(plan, `#driver-${n}-maritalStatus`, driver.maritalStatus);
      push(plan, `#driver-${n}-relationship`, driver.relationship);
      push(plan, `#driver-${n}-occupationIndustry`, driver.industry);
      push(plan, `#driver-${n}-occupation`, driver.occupation);
      push(plan, `#driver-${n}-ageLicensed`, driver.ageFirstLicensed);
      push(plan, `#driver-${n}-driversLicenseStatus`, driver.driversLicenseStatus);

      // DL fields are 1-based while everything else on this step is 0-based.
      if (driver.driversLicenseNumber) {
        try {
          const dl = normalizeDriversLicense(driver.driversLicenseNumber, driver.driversLicenseState);
          push(plan, `#textD${oneBased}DLNumber`, dl);
        } catch {
          // Surfaced by validation rather than written as a bad value.
        }
      }
      push(plan, `#drpD${oneBased}DLState`, driver.driversLicenseState);

      for (const [selector, value] of Object.entries(driver.carrierAnswers ?? {})) {
        plan.push({ selector, value, optional: true });
      }
    });

    return plan;
  },
};

/** Step 5 — vehicles. VIN decode and use-driven fields are asynchronous. */
export const vehiclesStep: StepDefinition = {
  id: 'auto/vehicles-compact',
  title: 'Auto vehicles',
  urlPattern: rating('auto', 'vehicles-compact'),
  nextSelector: '#go-to-incidents-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];

    quote.vehicles.forEach((vehicle, index) => {
      const n = index;

      if (vehicle.vin) {
        try {
          plan.push({
            selector: `#VIN-${n}`,
            value: normalizeVin(vehicle.vin),
            optional: true,
            dependents: [`#year-${n}`, `#make-${n}`, `#model-${n}`],
          });
        } catch {
          // Invalid VIN falls through to year/make/model below.
        }
      }
      push(plan, `#year-${n}`, vehicle.year);
      push(plan, `#make-${n}`, vehicle.make);
      push(plan, `#model-${n}`, vehicle.model);
      push(plan, `#sub-model-${n}`, vehicle.subModel);

      if (vehicle.use) {
        const revealsMileage = /work|school/i.test(vehicle.use);
        plan.push({
          selector: `#selected-use-${n}`,
          value: vehicle.use,
          optional: true,
          ...(revealsMileage ? { dependents: [`#oneWayMiles-${n}`] } : {}),
        });
      }

      // Must be >= 1; "Miles one way cannot be less than 1" was hit in the recording.
      if (vehicle.oneWayMiles !== undefined) {
        push(plan, `#oneWayMiles-${n}`, Math.max(1, vehicle.oneWayMiles));
      }
      push(plan, `#selected-daysPerWeek-${n}`, vehicle.daysPerWeek);
      push(plan, `#selected-weeksPerMonth-${n}`, vehicle.weeksPerMonth);
      push(plan, `#annual-miles-${n}`, vehicle.annualMiles);
      push(plan, `#selected-ownership-${n}`, vehicle.ownership);
      push(plan, `#purchase-date-${n}`, safeDate(vehicle.purchaseDate));

      for (const [selector, value] of Object.entries(vehicle.carrierAnswers ?? {})) {
        plan.push({ selector, value, optional: true });
      }
    });

    // Assignment grid: vehicles are 1-based, drivers 0-based.
    quote.driverVehicleAssignment?.forEach((row, vehicleIndex) => {
      row.forEach((percentage, driverIndex) => {
        if (percentage === undefined) return;
        push(plan, `#vehicle-assignment-${vehicleIndex + 1}-${driverIndex}`, percentage);
      });
    });

    return plan;
  },
  after: async (context) => {
    // Annual miles is recomputed by the app; let it settle before advancing.
    await waitForOptional(
      context.client,
      context.tabId,
      { type: 'value-not-empty', selector: '#annual-miles-0' },
      { timeoutMs: 8_000, logger: context.logger },
    );
  },
};

/** Step 6 — incidents. Usually nothing to enter. */
export const incidentsStep: StepDefinition = {
  id: 'auto/incidents',
  title: 'Auto incidents',
  urlPattern: rating('auto', 'incidents'),
  nextSelector: '#go-to-coverage-btn',
  plan: () => [],
};

/** Step 7 — auto coverage. */
export const autoCoverageStep: StepDefinition = {
  id: 'auto/coverage',
  title: 'Auto coverage',
  urlPattern: rating('auto', 'coverage'),
  nextSelector: '#go-to-carrier-questions-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];
    const coverage = quote.autoCoverage;
    if (!coverage) return plan;

    push(plan, '#bodily-injury', coverage.bodilyInjury);
    push(plan, '#property-damage', coverage.propertyDamage);
    push(plan, '#uninsured-motorist', coverage.uninsuredMotorist);
    push(plan, '#underinsured-motorist', coverage.underinsuredMotorist);
    push(plan, '#medical-payments', coverage.medicalPayments);

    if (quote.ratingState === 'MN') {
      push(plan, '#MNPIPOptions', coverage.mnPipOption);
      push(plan, '#MNPIPDeductible', coverage.mnPipDeductible);
      push(plan, '#MNWorkLoss', coverage.mnWorkLoss);
    }

    if (coverage.applyToAllVehicles !== undefined) {
      plan.push({ selector: '#apply-coverage-to-all-vehicles-input', value: coverage.applyToAllVehicles, optional: true });
    }

    quote.vehicles.forEach((vehicle, index) => {
      push(plan, `#vehicle-${index}-comprehensive`, vehicle.comprehensiveDeductible);
      push(plan, `#vehicle-${index}-collision`, vehicle.collisionDeductible);
      push(plan, `#vehicle-${index}-towingAndLabor`, vehicle.towingAndLabor);
      push(plan, `#vehicle-${index}-extTransExpense`, vehicle.extendedTransportation);
      if (vehicle.fullGlass !== undefined) {
        plan.push({ selector: `#vehicle-${index}-fullGlass-input`, value: vehicle.fullGlass, optional: true });
      }
    });

    return plan;
  },
};

/** Steps 8 and 15 — carrier questions. Answered from carrierAnswers, then recovery. */
export function carrierQuestionsStep(lob: 'auto' | 'home'): StepDefinition {
  return {
    id: `${lob}/carrier-questions`,
    title: `${lob === 'auto' ? 'Auto' : 'Home'} carrier questions`,
    urlPattern: rating(lob, 'carrier-questions'),
    nextSelector: '#go-to-finish-btn',
    plan: (quote, scan: StepScan) => {
      const plan: FieldPlan[] = [];
      const answers = quote.carrierAnswers ?? {};

      for (const [selector, value] of Object.entries(answers)) {
        if (scan.controls.some((control) => control.selector === selector)) {
          plan.push({ selector, value, optional: true });
        }
      }

      // Auto-Owners wants the pending home Coverage A on the auto side.
      const dwelling = quote.homeCoverage?.dwelling ?? quote.dwelling?.estimatedReplacementCost;
      if (lob === 'auto' && dwelling) {
        const control = scan.controls.find((candidate) => /coveragehome/i.test(candidate.selector));
        if (control) plan.push({ selector: control.selector, value: String(normalizeCurrency(dwelling)), optional: true });
      }

      if (lob === 'home') {
        const market = quote.dwelling?.marketValue ?? dwelling;
        const control = scan.controls.find((candidate) => /marketvalue/i.test(candidate.selector));
        if (control && market) plan.push({ selector: control.selector, value: String(normalizeCurrency(market)), optional: true });

        const garage = quote.dwelling?.garageType;
        for (const candidate of scan.controls) {
          if (/garagetype/i.test(candidate.selector) && garage) {
            plan.push({ selector: candidate.selector, value: garage, optional: true });
          }
          if (/numvehicles/i.test(candidate.selector)) {
            plan.push({ selector: candidate.selector, value: String(quote.vehicles.length), optional: true });
          }
        }
      }

      return plan;
    },
  };
}

/** Step 12 — dwelling info, mostly from the RCE. */
export const dwellingInfoStep: StepDefinition = {
  id: 'home/dwelling-info',
  title: 'Home dwelling info',
  urlPattern: rating('home', 'dwelling-info'),
  nextSelector: '#go-to-coverage-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];
    const dwelling = quote.dwelling;
    if (!dwelling) return plan;

    push(plan, '#dwellingUsage', dwelling.usage);
    push(plan, '#dwellingOccupancy', dwelling.occupancy);
    push(plan, '#dwellingType', dwelling.dwellingType);
    push(plan, '#numberOfOccupants', dwelling.numberOfOccupants ?? quote.household?.numberOfResidents);
    push(plan, '#numberOfStories', dwelling.stories);
    push(plan, '#squareFeet', dwelling.squareFeet);
    push(plan, '#yearBuilt', dwelling.yearBuilt);
    push(plan, '#construction', dwelling.construction);
    push(plan, '#roofType', dwelling.roofType);
    push(plan, '#roofDesign', dwelling.roofDesign);
    push(plan, '#foundation', dwelling.foundation);
    push(plan, '#exteriorWalls', dwelling.exteriorWalls);
    push(plan, '#numberOfFullBaths', dwelling.fullBaths);
    push(plan, '#numberOfHalfBaths', dwelling.halfBaths);
    push(plan, '#heating', dwelling.heating);
    push(plan, '#garageType', dwelling.garageType);
    push(plan, '#distanceToHydrant', dwelling.hydrantDistance);
    push(plan, '#protectionClass', dwelling.protectionClass);

    push(plan, '#roofUpdateYear', dwelling.updates?.roofYear);
    push(plan, '#electricalUpdateYear', dwelling.updates?.electricalYear);
    push(plan, '#plumbingUpdateYear', dwelling.updates?.plumbingYear);
    push(plan, '#heatingUpdateYear', dwelling.updates?.heatingYear);

    return plan;
  },
};

/** Step 13 — home coverage. Dwelling amount comes from the RCE, never prefill. */
export const homeCoverageStep: StepDefinition = {
  id: 'home/coverage',
  title: 'Home coverage',
  urlPattern: rating('home', 'coverage'),
  nextSelector: '#go-to-endorsements-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];
    const coverage = quote.homeCoverage;
    const replacementCost = quote.dwelling?.estimatedReplacementCost;

    push(plan, '#dwelling', coverage?.dwelling ?? replacementCost);
    push(plan, '#estReplacementCost', replacementCost ?? coverage?.dwelling);
    push(plan, '#other-structure', coverage?.otherStructures);
    push(plan, '#personal-property', coverage?.personalProperty);
    push(plan, '#loss-of-use', coverage?.lossOfUse);
    if (/custom/i.test(coverage?.lossOfUse ?? '')) {
      push(plan, '#loss-of-use-amount', coverage?.lossOfUseAmount);
    }
    push(plan, '#personalLiability', coverage?.personalLiability);
    push(plan, '#medicalPayments', coverage?.medicalPayments);
    push(plan, '#allPerilsDeductible', coverage?.allPerilsDeductible);

    return plan;
  },
};

/** Step 14 — endorsements. Its "Carrier questions" button really is #go-to-drivers-btn. */
export const endorsementsStep: StepDefinition = {
  id: 'home/endorsements',
  title: 'Home endorsements',
  urlPattern: rating('home', 'endorsements'),
  nextSelector: '#go-to-drivers-btn',
  plan: (quote) => {
    const plan: FieldPlan[] = [];
    for (const [selector, value] of Object.entries(quote.homeCoverage?.endorsements ?? {})) {
      plan.push({ selector: selector.startsWith('#') ? selector : `#${selector}`, value, optional: true });
    }
    return plan;
  },
};

/** Steps 9 and 16 — finish. */
export function finishStep(lob: 'auto' | 'home'): StepDefinition {
  return {
    id: `${lob}/finish`,
    title: `${lob === 'auto' ? 'Auto' : 'Home'} finish`,
    urlPattern: rating(lob, 'finish'),
    nextSelector: lob === 'auto' ? '#save-and-go-to-home-btn' : '#submit-to-carriers-btn',
    plan: () => [],
  };
}

export function autoSteps(): StepDefinition[] {
  return [
    ratingStep('auto'),
    policyInfoStep('auto'),
    driversStep,
    vehiclesStep,
    incidentsStep,
    autoCoverageStep,
    carrierQuestionsStep('auto'),
    finishStep('auto'),
  ];
}

export function homeSteps(): StepDefinition[] {
  return [
    ratingStep('home'),
    policyInfoStep('home'),
    dwellingInfoStep,
    homeCoverageStep,
    endorsementsStep,
    carrierQuestionsStep('home'),
    finishStep('home'),
  ];
}

export { applicantStep as accountStep };

/** Convenience for the CLI and tests. */
export async function applyExtraAnswers(
  context: StepContext,
  answers: Record<string, string>,
): Promise<void> {
  for (const [selector, value] of Object.entries(answers)) {
    await setField(context.client, context.tabId, selector, value, { logger: context.logger }).catch(() => undefined);
  }
}
