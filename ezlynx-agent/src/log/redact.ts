/**
 * Redaction for anything that may reach a log, a report, or the LLM.
 *
 * Deliberately over-redacts. A missed SSN is a breach; an over-redacted log line
 * is an inconvenience. Field-name-driven rules run before pattern rules so a
 * value stored under `ssn` is masked even when it doesn't look like an SSN.
 */

const SENSITIVE_KEYS = [
  'ssn',
  'socialsecuritynumber',
  'social_security_number',
  'dob',
  'dateofbirth',
  'date_of_birth',
  'birthdate',
  'driverslicensenumber',
  'drivers_license_number',
  'dlnumber',
  'dl',
  'licensenumber',
  'password',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'authorization',
  'token',
  'secret',
];

const KEY_RULE: Array<[RegExp, 'mask' | 'dl' | 'date']> = [
  [/ssn|social_?security/i, 'mask'],
  [/dob|date_?of_?birth|birth_?date/i, 'date'],
  [/(drivers?_?licen[cs]e|dl)_?(number|num|no)?$/i, 'dl'],
  [/password|api_?key|access_?key|authorization|token|secret/i, 'mask'],
];

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const DATE_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}\b/g;
const EMAIL_RE = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const BEARER_RE = /\b(?:Bearer\s+|Token\s+|sk-)[A-Za-z0-9._-]{8,}/gi;
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

/** Keep the last 4 so log lines stay correlatable without exposing the value. */
export function maskTail(value: string, keep = 4): string {
  const s = String(value);
  if (s.length <= keep) return '*'.repeat(s.length);
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}

export function redactDl(value: string): string {
  return maskTail(String(value).replace(/\s|-/g, ''), 4);
}

/** Dates of birth degrade to a birth year — enough to debug age rules, not to identify. */
export function redactDate(value: string): string {
  const year = String(value).match(/(?:19|20)\d{2}/)?.[0];
  return year ? `${year}-**-**` : '[redacted-date]';
}

export function redactText(input: string): string {
  return input
    .replace(BEARER_RE, '[redacted-secret]')
    .replace(SSN_RE, '[redacted-ssn]')
    .replace(EMAIL_RE, (m) => `${m.slice(0, 2)}***@***`)
    .replace(VIN_RE, (m) => maskTail(m, 4))
    .replace(PHONE_RE, '[redacted-phone]')
    .replace(DATE_RE, (m) => redactDate(m));
}

function ruleForKey(key: string): 'mask' | 'dl' | 'date' | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
  for (const [pattern, rule] of KEY_RULE) {
    if (pattern.test(key) || pattern.test(normalized)) return rule;
  }
  return SENSITIVE_KEYS.includes(normalized) ? 'mask' : null;
}

function applyKeyRule(rule: 'mask' | 'dl' | 'date', value: unknown): unknown {
  if (value == null) return value;
  const s = String(value);
  if (s === '') return s;
  if (rule === 'dl') return redactDl(s);
  if (rule === 'date') return redactDate(s);
  return '[redacted]';
}

/**
 * Deep-redact an arbitrary value. Cycles collapse to '[circular]' so a logger
 * can never be hung by a self-referential object.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const rule = ruleForKey(key);
    out[key] = rule ? applyKeyRule(rule, child) : redact(child, seen);
  }
  return out;
}
