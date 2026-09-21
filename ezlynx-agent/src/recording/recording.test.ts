import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inferContext, filterNoise, parseRatingPath, type RecordedEvent } from './types.js';
import { buildFlowMap } from './flow-map.js';
import { redactRecording, findResidualPii, collectSensitiveValues } from './redact.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/ezlynx-recording.redacted.json');
const events: RecordedEvent[] = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : [];

describe('path parsing', () => {
  test('rating paths decompose into lob/quote/step', () => {
    const parsed = parseRatingPath('/web/account/201601955/rating/auto/183176951/drivers-compact');
    assert.deepEqual(parsed, {
      accountId: '201601955',
      lob: 'auto',
      quoteId: '183176951',
      step: 'drivers-compact',
    });
  });

  test('non-rating paths return null', () => {
    assert.equal(parseRatingPath('/applicantportal/policy/74948688/summary/index'), null);
    assert.equal(parseRatingPath('/web/account/201601955/details'), null);
  });
});

describe('noise filtering', { skip: events.length === 0 }, () => {
  test('infers the account, quotes and primary tab', () => {
    const context = inferContext(events);
    assert.equal(context.accountId, '201601955');
    assert.equal(context.quoteIds.auto, '183176951');
    assert.equal(context.quoteIds.home, '183186261');
  });

  test('drops applicant-portal noise and the foreign account', () => {
    const context = inferContext(events);
    const { kept, dropped } = filterNoise(events, context);

    assert.ok(kept.length < events.length);
    assert.ok(kept.every((event) => !event.path.startsWith('/applicantportal')));
    assert.ok(kept.every((event) => !event.path.includes('/account/145923320/')));

    const reasons = dropped.map((entry) => entry.reason);
    assert.ok(reasons.some((reason) => reason.includes('applicant-portal')));
    assert.ok(reasons.some((reason) => reason.includes('145923320')));
  });
});

describe('flow map', { skip: events.length === 0 }, () => {
  const map = buildFlowMap(events);

  test('covers every Auto and Home step', () => {
    for (const stepId of [
      'account/details',
      'auto/rating', 'auto/policy-info', 'auto/drivers-compact', 'auto/vehicles-compact',
      'auto/incidents', 'auto/coverage', 'auto/carrier-questions', 'auto/finish',
      'home/rating', 'home/policy-info', 'home/dwelling-info', 'home/coverage',
      'home/endorsements', 'home/carrier-questions', 'home/finish',
      'submit/submit-details',
    ]) {
      assert.ok(map.steps[stepId], `missing ${stepId}`);
    }
  });

  test('records the observed next-button per step, including the odd ones', () => {
    // Home endorsements really does use #go-to-drivers-btn for "Carrier questions".
    assert.equal(map.steps['home/endorsements']?.nextSelector, '#go-to-drivers-btn');
    assert.equal(map.steps['home/policy-info']?.nextSelector, '#go-to-dwellingInfo-btn');
    assert.equal(map.steps['auto/finish']?.nextSelector, '#save-and-go-to-home-btn');
    assert.equal(map.steps['home/finish']?.nextSelector, '#submit-to-carriers-btn');
  });

  test('option lists are scoped per step, not per selector', () => {
    const auto = map.steps['auto/policy-info']?.fields.find((f) => f.selector === '#priorCarrier');
    const home = map.steps['home/policy-info']?.fields.find((f) => f.selector === '#priorCarrier');

    assert.ok(auto?.options?.length);
    assert.ok(home?.options?.length);
    assert.notEqual(auto!.options!.length, home!.options!.length);
    // Auto-only and home-only carriers prove the lists are genuinely different.
    assert.ok(auto!.options!.includes('Ag Workers Mutual Auto'));
    assert.ok(!home!.options!.includes('Ag Workers Mutual Auto'));
  });

  test('preserves literal selectors that no convention would produce', () => {
    const drivers = map.steps['auto/drivers-compact']!.fields.map((f) => f.selector);
    // 0-based driver fields but 1-based DL fields.
    assert.ok(drivers.includes('#driver-0-dob'));
    assert.ok(drivers.some((s) => /^#textD1DLNumber$/.test(s)));

    const details = map.steps['account/details']!.fields.map((f) => f.selector);
    // Missing hyphen after "contact" — verbatim from the app.
    assert.ok(details.some((s) => s.startsWith('#contactdrivers-license-state-')));
    assert.ok(details.some((s) => s.startsWith('#contact-drivers-license-status-')));
  });

  test('flags Playwright-dialect selectors instead of silently accepting them', () => {
    const playwright = Object.values(map.steps)
      .flatMap((step) => step.fields)
      .filter((field) => field.dialect === 'playwright');
    assert.ok(playwright.length > 0);
    assert.ok(map.warnings.some((warning) => warning.includes('Playwright-dialect')));
  });

  test('captures validation messages seen on each step', () => {
    const policyInfo = map.steps['auto/policy-info']!.messages.map((m) => m.text);
    assert.ok(policyInfo.some((text) => /Date can not be the in past/i.test(text)));

    const carrierQuestions = map.steps['auto/carrier-questions']!.messages.map((m) => m.text);
    assert.ok(carrierQuestions.some((text) => /Coverage A or C Amount/i.test(text)));
  });

  test('dedupes repeated notices rather than listing them three times', () => {
    const saved = map.steps['account/details']!.messages.find((m) => /Applicant Saved/i.test(m.text));
    assert.ok(saved);
    assert.equal(saved!.count, 3);
  });

  test('collects carriers with ids and LOBs', () => {
    const byId = new Map(map.carriers.map((c) => [c.id, c]));
    assert.ok(byId.has('613'));
    assert.ok(byId.has('650'));
    assert.match(byId.get('650')!.label, /GEICO/i);
  });
});

describe('redaction guards', { skip: events.length === 0 }, () => {
  test('the committed fixture contains no PII-shaped values', () => {
    const residual = findResidualPii(readFileSync(FIXTURE, 'utf8'));
    assert.deepEqual(residual, []);
  });

  test('redaction is idempotent and stable', () => {
    const first = redactRecording(events).events;
    const second = redactRecording(events).events;
    assert.deepEqual(first, second);
  });

  test('pseudonyms are consistent across a household', () => {
    const value = (selector: string) =>
      events.flatMap((e) => e.fields ?? []).find((f) => f.selector === selector)?.value;
    assert.equal(value('#driver-0-last-name'), value('#driver-1-last-name'));
  });

  test('business data survives redaction', () => {
    const serialized = readFileSync(FIXTURE, 'utf8');
    assert.ok(serialized.includes('Michigan Millers Mutual'));
    assert.ok(serialized.includes('500CSL'));
    assert.ok(serialized.includes('To/From Work'));
  });

  test('type dropdowns keep their enum values', () => {
    const emailType = events.flatMap((e) => e.fields ?? []).find((f) => f.selector === '#applicant-email-0-type');
    assert.equal(emailType?.value, 'Primary');
  });

  test('already-redacted input yields no new sensitive values', () => {
    const remaining = collectSensitiveValues(events).filter((value) =>
      /gmail|@aol|@yahoo/i.test(value),
    );
    assert.deepEqual(remaining, []);
  });
});
