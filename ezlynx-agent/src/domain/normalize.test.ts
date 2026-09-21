import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDriversLicense,
  normalizeDate,
  normalizeCurrency,
  normalizeVin,
  hasValidVinCheckDigit,
  normalizePhone,
  normalizeZip,
  normalizeLimits,
  isFutureDate,
  addDays,
  compareDates,
  NormalizationError,
} from './normalize.js';

describe('driver licence normalisation', () => {
  test('strips the whitespace and dashes seen in the recording', () => {
    assert.equal(normalizeDriversLicense(' E000-111-222-333'), 'E000111222333');
    assert.equal(normalizeDriversLicense('\tM111-222-333-444 '), 'M111222333444');
  });

  test('rejects a pasted URL', () => {
    // This actually happened during the recording.
    assert.throws(() => normalizeDriversLicense('https://app.ezlynx.com/web/account/1/details'), NormalizationError);
    assert.throws(() => normalizeDriversLicense('www.example.com/x'), NormalizationError);
  });

  test('validates against the state format when known', () => {
    assert.equal(normalizeDriversLicense('M111222333444', 'MN'), 'M111222333444');
    assert.throws(() => normalizeDriversLicense('M4600', 'MN'), NormalizationError);
    assert.throws(() => normalizeDriversLicense('123456789012', 'MN'), /1 letter followed by 12 digits/);
  });

  test('unknown states fall back to a permissive check', () => {
    assert.equal(normalizeDriversLicense('AB-1234567', 'ZZ'), 'AB1234567');
  });

  test('empty stays empty rather than throwing', () => {
    assert.equal(normalizeDriversLicense(''), '');
  });
});

describe('dates', () => {
  test('accepts both formats the recording used', () => {
    assert.equal(normalizeDate('11-14-2026'), '11/14/2026');
    assert.equal(normalizeDate('11/14/2026'), '11/14/2026');
    assert.equal(normalizeDate('2026-11-14'), '11/14/2026');
  });

  test('renders in the style the field wants', () => {
    assert.equal(normalizeDate('11/14/2026', 'MM-DD-YYYY'), '11-14-2026');
    assert.equal(normalizeDate('11/14/2026', 'YYYY-MM-DD'), '2026-11-14');
  });

  test('rejects impossible dates', () => {
    assert.throws(() => normalizeDate('02/30/2026'), /Day out of range/);
    assert.throws(() => normalizeDate('13/01/2026'), /Month out of range/);
    assert.throws(() => normalizeDate('not a date'), NormalizationError);
  });

  test('leap years are handled', () => {
    assert.equal(normalizeDate('02/29/2028'), '02/29/2028');
    assert.throws(() => normalizeDate('02/29/2027'), /Day out of range/);
  });

  test('future comparison uses the supplied today', () => {
    const today = new Date(2026, 8, 15);
    assert.equal(isFutureDate('11/14/2026', today), true);
    assert.equal(isFutureDate('11/12/2025', today), false);
    assert.equal(isFutureDate('09/15/2026', today), false);
  });

  test('date arithmetic and ordering', () => {
    assert.equal(addDays('2026-11-14', 30), '2026-12-14');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.ok(compareDates('01/01/2026', '02/01/2026') < 0);
  });
});

describe('currency', () => {
  test('strips symbols and separators', () => {
    assert.equal(normalizeCurrency('$800,000'), 800000);
    assert.equal(normalizeCurrency('1,432.00'), 1432);
    assert.equal(normalizeCurrency(485000), 485000);
  });

  test('rejects nonsense', () => {
    assert.throws(() => normalizeCurrency('abc'), NormalizationError);
    assert.throws(() => normalizeCurrency(''), NormalizationError);
  });
});

describe('VIN', () => {
  test('a valid VIN round-trips and validates', () => {
    assert.equal(normalizeVin('1hgcm82633a004352'), '1HGCM82633A004352');
    assert.equal(hasValidVinCheckDigit('1HGCM82633A004352'), true);
  });

  test('rejects wrong length and forbidden letters', () => {
    assert.throws(() => normalizeVin('1HGCM82633A00435'), /17 characters/);
    assert.throws(() => normalizeVin('1HGCM82633A0O4352'), /I, O or Q/);
  });

  test('check digit only enforced when asked', () => {
    assert.doesNotThrow(() => normalizeVin('11111111111111111'));
    assert.throws(() => normalizeVin('1HGCM82633A004353', { strictCheckDigit: true }), /check digit/);
  });
});

describe('phone, zip, limits', () => {
  test('phones normalise to the EZLynx display form', () => {
    assert.equal(normalizePhone('5551234567'), '(555) 123-4567');
    assert.equal(normalizePhone('1-555-123-4567'), '(555) 123-4567');
    assert.throws(() => normalizePhone('12345'), NormalizationError);
  });

  test('zip accepts 5 and 9 digit forms', () => {
    assert.equal(normalizeZip('55304'), '55304');
    assert.equal(normalizeZip('553042097'), '55304-2097');
    assert.throws(() => normalizeZip('123'), NormalizationError);
  });

  test('liability limits keep both EZLynx shapes', () => {
    assert.equal(normalizeLimits('100/300'), '100/300');
    assert.equal(normalizeLimits('100 / 300'), '100/300');
    assert.equal(normalizeLimits('500csl'), '500CSL');
    assert.equal(normalizeLimits('State Minimum'), 'State Minimum');
  });
});
