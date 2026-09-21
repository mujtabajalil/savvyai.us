import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactText, redactDl, redactDate, maskTail } from './redact.js';

describe('field-level redaction', () => {
  test('DL numbers keep only the last 4', () => {
    // " E000-111-222-333" normalizes to E000111222333 (13 chars), so 9 are masked.
    assert.equal(redactDl(' E000-111-222-333'), '*********2333');
    assert.ok(!redactDl('M111222333444').includes('1112'));
  });

  test('DOB degrades to a birth year', () => {
    assert.equal(redactDate('03/14/1975'), '1975-**-**');
    assert.equal(redactDate('1971-06-01'), '1971-**-**');
    assert.equal(redactDate('not a date'), '[redacted-date]');
  });

  test('maskTail never leaks short values', () => {
    assert.equal(maskTail('12', 4), '**');
  });
});

describe('pattern redaction', () => {
  test('SSNs never survive', () => {
    assert.equal(redactText('ssn is 000-11-2222 ok'), 'ssn is [redacted-ssn] ok');
  });

  test('API keys and bearer tokens are scrubbed', () => {
    assert.ok(!redactText('key sk-EXAMPLEKEY0000000000000000000000').includes('EXAMPLEKEY'));
    assert.ok(!redactText('Authorization: Bearer abcdef1234567890').includes('abcdef1234567890'));
  });

  test('emails, phones, VINs and dates are reduced', () => {
    assert.ok(!redactText('mail someone1473@example.org').includes('someone1473'));
    assert.equal(redactText('call (555) 123-4567'), 'call [redacted-phone]');
    assert.ok(!redactText('vin 1HGCM82633A004352').includes('1HGCM82633A'));
    assert.equal(redactText('dob 03/14/1975'), 'dob 1975-**-**');
  });
});

describe('deep redaction', () => {
  test('sensitive keys are masked regardless of value shape', () => {
    const out = redact({
      firstName: 'Dana',
      ssn: '000000000',
      dob: '03/14/1975',
      driversLicenseNumber: 'M111222333444',
      nested: { socialSecurityNumber: 'anything' },
    }) as Record<string, unknown>;

    assert.equal(out.firstName, 'Dana');
    assert.equal(out.ssn, '[redacted]');
    assert.equal(out.dob, '1975-**-**');
    assert.equal(out.driversLicenseNumber, '*********3444');
    assert.equal((out.nested as Record<string, unknown>).socialSecurityNumber, '[redacted]');
  });

  test('arrays and errors are handled', () => {
    const out = redact([{ ssn: '111-22-3333' }, new Error('failed for 000-11-2222')]) as unknown[];
    assert.equal((out[0] as Record<string, unknown>).ssn, '[redacted]');
    assert.equal((out[1] as Record<string, unknown>).message, 'failed for [redacted-ssn]');
  });

  test('cycles do not hang the logger', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    assert.equal(out.self, '[circular]');
  });

  test('empty sensitive values stay empty rather than becoming [redacted]', () => {
    const out = redact({ ssn: '' }) as Record<string, unknown>;
    assert.equal(out.ssn, '');
  });
});
