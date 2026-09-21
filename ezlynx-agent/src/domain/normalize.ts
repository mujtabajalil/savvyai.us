/**
 * Value normalisation.
 *
 * Driven by what the recording actually contained: driver's licence numbers with
 * leading spaces, tabs and dashes (" E000-143-514-100"), a URL pasted into a DL
 * field, dates typed MM-DD-YYYY into fields that display MM/DD/YYYY, and stale
 * prefilled values that must never be trusted over source data.
 */

export class NormalizationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly input: string,
  ) {
    super(message);
    this.name = 'NormalizationError';
  }
}

const URL_SHAPED = /^(https?:\/\/|www\.)|\.(com|net|org|gov|io)\b|\//i;

/**
 * Per-state DL formats. Deliberately partial — unknown states fall back to a
 * permissive length check rather than rejecting a valid licence we can't model.
 */
const DL_FORMATS: Record<string, { pattern: RegExp; hint: string }> = {
  MN: { pattern: /^[A-Z]\d{12}$/, hint: '1 letter followed by 12 digits' },
  WI: { pattern: /^[A-Z]\d{13}$/, hint: '1 letter followed by 13 digits' },
  IA: { pattern: /^(\d{9}|\d{3}[A-Z]{2}\d{4})$/, hint: '9 digits, or 3 digits + 2 letters + 4 digits' },
  ND: { pattern: /^[A-Z]{3}\d{6}$|^\d{9}$/, hint: '3 letters + 6 digits, or 9 digits' },
  SD: { pattern: /^\d{6,10}$/, hint: '6-10 digits' },
  IL: { pattern: /^[A-Z]\d{11,12}$/, hint: '1 letter followed by 11-12 digits' },
  MI: { pattern: /^[A-Z]\d{12}$/, hint: '1 letter followed by 12 digits' },
  CA: { pattern: /^[A-Z]\d{7}$/, hint: '1 letter followed by 7 digits' },
  FL: { pattern: /^[A-Z]\d{12}$/, hint: '1 letter followed by 12 digits' },
  TX: { pattern: /^\d{7,8}$/, hint: '7-8 digits' },
  NY: { pattern: /^(\d{9}|[A-Z]\d{18}|\d{16})$/, hint: '9 digits, 16 digits, or 1 letter + 18 digits' },
};

export function normalizeDriversLicense(input: string, state?: string): string {
  const raw = String(input ?? '');
  if (raw.trim() === '') return '';

  if (URL_SHAPED.test(raw.trim())) {
    throw new NormalizationError('Value looks like a URL, not a driver\'s licence number', 'driversLicenseNumber', raw);
  }

  const cleaned = raw.replace(/[\s\t-]+/g, '').toUpperCase();

  if (!/^[A-Z0-9*]+$/.test(cleaned)) {
    throw new NormalizationError('Contains characters that are not letters or digits', 'driversLicenseNumber', raw);
  }
  if (cleaned.length < 5 || cleaned.length > 25) {
    throw new NormalizationError(`Implausible length (${cleaned.length})`, 'driversLicenseNumber', raw);
  }

  const format = state ? DL_FORMATS[state.toUpperCase()] : undefined;
  if (format && !format.pattern.test(cleaned)) {
    throw new NormalizationError(
      `Does not match the ${state!.toUpperCase()} format (${format.hint})`,
      'driversLicenseNumber',
      raw,
    );
  }
  return cleaned;
}

export type DateStyle = 'MM/DD/YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD';

export interface ParsedDate {
  year: number;
  month: number;
  day: number;
}

export function parseDate(input: string): ParsedDate {
  const raw = String(input ?? '').trim();

  const iso = raw.match(/^((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };

  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-]((?:19|20)\d{2})$/);
  if (us) return { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) };

  throw new NormalizationError('Unrecognised date format', 'date', raw);
}

export function formatDate(date: ParsedDate, style: DateStyle = 'MM/DD/YYYY'): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  const yyyy = String(date.year);
  if (style === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`;
  return style === 'MM-DD-YYYY' ? `${mm}-${dd}-${yyyy}` : `${mm}/${dd}/${yyyy}`;
}

export function normalizeDate(input: string, style: DateStyle = 'MM/DD/YYYY'): string {
  const parsed = parseDate(input);
  if (parsed.month < 1 || parsed.month > 12) {
    throw new NormalizationError(`Month out of range (${parsed.month})`, 'date', input);
  }
  const daysInMonth = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  if (parsed.day < 1 || parsed.day > daysInMonth) {
    throw new NormalizationError(`Day out of range for that month (${parsed.day})`, 'date', input);
  }
  return formatDate(parsed, style);
}

export function toIsoDate(input: string): string {
  return normalizeDate(input, 'YYYY-MM-DD');
}

/** Two dates compared by value, independent of the local timezone. */
export function compareDates(a: string, b: string): number {
  return toIsoDate(a).localeCompare(toIsoDate(b));
}

export function isFutureDate(input: string, today = new Date()): boolean {
  const iso = toIsoDate(input);
  const todayIso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  return iso > todayIso;
}

export function addDays(input: string, days: number): string {
  const { year, month, day } = parseDate(input);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(
    { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    'YYYY-MM-DD',
  );
}

export function normalizeCurrency(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new NormalizationError('Not a finite number', 'currency', String(input));
    return Math.round(input);
  }
  const raw = String(input ?? '').trim();
  if (raw === '') throw new NormalizationError('Empty currency value', 'currency', raw);

  const cleaned = raw.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new NormalizationError('Not a currency value', 'currency', raw);
  return Math.round(value);
}

export function formatCurrency(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

const VIN_ALPHABET = /^[A-HJ-NPR-Z0-9]{17}$/;
const VIN_TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function normalizeVin(input: string, options: { strictCheckDigit?: boolean } = {}): string {
  const cleaned = String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (cleaned === '') return '';

  if (cleaned.length !== 17) {
    throw new NormalizationError(`VIN must be 17 characters (got ${cleaned.length})`, 'vin', input);
  }
  if (!VIN_ALPHABET.test(cleaned)) {
    throw new NormalizationError('VIN contains I, O or Q, or a non-alphanumeric character', 'vin', input);
  }

  if (options.strictCheckDigit && !hasValidVinCheckDigit(cleaned)) {
    throw new NormalizationError('VIN check digit does not validate', 'vin', input);
  }
  return cleaned;
}

export function hasValidVinCheckDigit(vin: string): boolean {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const char = vin[i]!;
    const value = /\d/.test(char) ? Number(char) : (VIN_TRANSLIT[char] ?? 0);
    sum += value * VIN_WEIGHTS[i]!;
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return vin[8] === expected;
}

export function normalizePhone(input: string): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) throw new NormalizationError('Phone number must have 10 digits', 'phone', input);
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

export function normalizeZip(input: string): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  if (digits.length !== 5) throw new NormalizationError('ZIP must be 5 or 9 digits', 'postalCode', input);
  return digits;
}

/** "100/300" and "500CSL" both appear in EZLynx limit dropdowns. */
export function normalizeLimits(input: string): string {
  const raw = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const csl = raw.match(/^(\d+)(?:CSL|K?CSL)$/);
  if (csl) return `${csl[1]}CSL`;
  const split = raw.match(/^(\d+)\/(\d+)(?:\/(\d+))?$/);
  if (split) return split[3] ? `${split[1]}/${split[2]}/${split[3]}` : `${split[1]}/${split[2]}`;
  return String(input ?? '').trim();
}

export function titleCase(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}
