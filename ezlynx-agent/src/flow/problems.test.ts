import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectProblems } from './runner.js';
import type { StepScan, ControlState } from '../camofox/dom.js';

function control(overrides: Partial<ControlState>): ControlState {
  return {
    found: true,
    kind: 'mat-select',
    selector: '#x',
    resolvedSelector: '#x',
    id: 'x',
    value: '',
    checked: null,
    disabled: false,
    required: false,
    visible: true,
    label: '',
    error: null,
    matches: 1,
    ...overrides,
  };
}

function scan(overrides: Partial<StepScan>): StepScan {
  return { url: '', controls: [], errors: [], carrierRequirements: [], notices: [], ...overrides };
}

describe('collectProblems — required vs optional', () => {
  test('a field EZLynx marks required is blocking', () => {
    const problems = collectProblems(
      scan({
        controls: [
          control({ selector: '#applicant-gender', required: true, error: 'Gender is required for rating' }),
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.required, true);
  });

  test('a field EZLynx does not mark required is reported but not blocking', () => {
    const problems = collectProblems(
      scan({
        controls: [
          control({ selector: '#applicant-middle-name', required: false, error: 'Something is off' }),
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.required, false);
  });

  test('"required" wording wins even when the control flag is unset', () => {
    // EZLynx is not always consistent about aria-required.
    const problems = collectProblems(
      scan({
        controls: [
          control({ selector: '#contact-first-name-0', required: false, error: 'First name is required to proceed' }),
        ],
      }),
    );
    assert.equal(problems[0]?.required, true);
  });

  test('carrier requirements are always blocking', () => {
    const problems = collectProblems(
      scan({
        controls: [
          control({ selector: '#membershipsince_aaa__613', required: false, error: 'Required for Carrier: AAA' }),
        ],
      }),
    );
    assert.equal(problems[0]?.required, true);
    assert.equal(problems[0]?.carrier, 'AAA');
  });

  test('an error with no matching control is assumed required', () => {
    // Safer to ask than to skip something that blocks the quote.
    const problems = collectProblems(scan({ errors: [{ text: 'Enter a Valid Phone.', forId: 'mystery-field' }] }));
    assert.equal(problems[0]?.required, true);
  });

  test('form-level errors win over the per-control copy of the same problem', () => {
    const problems = collectProblems(
      scan({
        errors: [{ text: 'Gender is required for rating', forId: 'applicant-gender' }],
        controls: [control({ selector: '#applicant-gender', required: true, error: 'Gender is required for rating' })],
      }),
    );
    assert.equal(problems.length, 1, 'deduped');
  });

  test('clean controls produce no problems', () => {
    const problems = collectProblems(
      scan({ controls: [control({ selector: '#applicant-gender', required: true, value: 'Male' })] }),
    );
    assert.deepEqual(problems, []);
  });
});
