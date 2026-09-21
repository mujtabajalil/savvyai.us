import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCssSelector,
  assertCssSelector,
  describeControlExpr,
  scanStepExpr,
  waitForExpr,
  openPanelOptionsExpr,
} from './dom.js';
import { cssEscapeId } from './controls.js';

describe('selector dialect screening', () => {
  test('plain CSS selectors from the recording pass', () => {
    for (const selector of [
      '#priorCarrier',
      '#driver-0-dob',
      '#textD1DLNumber',
      '[name="isEmailBridgedToCarriers"]',
      '#carrier-613-aaa-–-auto-club-group-–-insurance-link-button',
      '#prior_liabilityasi\\*MN',
      'div.submit-detail-action > div.lob-action:nth-of-type(1) > mat-checkbox > div > div > input',
    ]) {
      assert.equal(isCssSelector(selector), true, selector);
    }
  });

  test('Playwright pseudo-selectors are rejected', () => {
    // These appear in the recording and would throw inside document.querySelector.
    for (const selector of [
      'a:has-text("Details")',
      'mat-form-field:has(mat-label:text-is("Premium: Low-High")) mat-select',
      'mat-form-field:has(mat-label:text-is("LOB")) mat-select',
      'text=Submit',
      'xpath=//button',
    ]) {
      assert.equal(isCssSelector(selector), false, selector);
      assert.throws(() => assertCssSelector(selector), /Playwright pseudo-selector/);
    }
  });
});

describe('expression building', () => {
  test('produces a self-contained awaited expression', () => {
    const expr = describeControlExpr('#priorCarrier');
    assert.match(expr, /^\(async \(A\) => \{/);
    assert.match(expr, /\}\)\(\{.*\}\)$/s);
  });

  test('arguments are JSON-encoded, not interpolated raw', () => {
    const nasty = '#a"b\\c';
    const expr = describeControlExpr(nasty);
    assert.ok(expr.includes(JSON.stringify({ selector: nasty }).slice(1, -1)));
    assert.ok(!expr.includes('#a"b\\c"'));
  });

  test('quotes in a wait value cannot break out of the literal', () => {
    const expr = waitForExpr({ type: 'value-equals', selector: '#x', value: '");alert(1);//' }, 1000);
    assert.ok(expr.includes('\\");alert(1);//'));
  });

  test('scan and panel expressions are syntactically valid JS', () => {
    for (const expr of [
      scanStepExpr({ container: '#step-content-drivers' }),
      scanStepExpr({}),
      openPanelOptionsExpr(),
      waitForExpr({ type: 'exists', selector: '#VIN-0' }, 5000),
      describeControlExpr('#priorCarrier'),
    ]) {
      assert.doesNotThrow(() => new Function(`return ${expr};`), expr.slice(0, 80));
    }
  });

  test('rejects Playwright selectors before they reach the page', () => {
    assert.throws(() => describeControlExpr('a:has-text("Details")'));
    assert.throws(() => scanStepExpr({ container: 'div:has-text("x")' }));
  });
});

describe('cssEscapeId', () => {
  test('escapes characters that appear in real EZLynx ids', () => {
    assert.equal(cssEscapeId('mat-option-123'), 'mat-option-123');
    assert.equal(cssEscapeId('prior_liabilityasi*MN'), 'prior_liabilityasi\\*MN');
    assert.equal(cssEscapeId('carrier-35-liberty-mutual-(formerly-safeco)'), 'carrier-35-liberty-mutual-\\(formerly-safeco\\)');
    assert.equal(cssEscapeId('universal-property-&-casualty'), 'universal-property-\\&-casualty');
  });
});
