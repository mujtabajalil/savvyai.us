/**
 * Turn the private recording into a committable fixture.
 *
 * Structure is preserved exactly — selectors, option lists, validation text,
 * step order, field kinds. Only *values* are replaced, and replacement is
 * deterministic per source value so relationships survive: the same driver name
 * maps to the same pseudonym everywhere it appears, which keeps the fixture
 * useful for testing driver/vehicle assignment.
 *
 * Carrier names, coverage limits and dropdown option lists are business data,
 * not PII, and are deliberately left intact.
 */

import { createHash } from 'node:crypto';
import type { RecordedEvent, RecordedField } from './types.js';

const FIRST_NAMES = ['Dana', 'Riley', 'Jordan', 'Avery', 'Quinn', 'Rowan', 'Sage', 'Emerson', 'Harper', 'Linden'];
const LAST_NAMES = ['Whitfield', 'Carrow', 'Ashby', 'Denton', 'Fairlie', 'Gramercy', 'Holloway', 'Ipswich'];
const STREETS = ['Alder Way', 'Birchwood Lane', 'Cedar Ridge Road', 'Dovewood Court', 'Elmhurst Drive'];
const CITIES = ['SPRINGFIELD', 'FAIRVIEW', 'RIVERTON', 'LAKEMONT'];

/**
 * Selector fragments that identify a value as personal data.
 *
 * Patterns are anchored deliberately. Loose ones cause real damage in both
 * directions: `/vin/i` matched "EftCheckingSavings" (Sa-VIN-gs) and `/email/i`
 * matched the radio group `isEmailBridgedToCarriers` and the *type* dropdown
 * `#applicant-email-0-type`, whose value "Primary" would have been rewritten
 * into a fake email address and corrupted the fixture.
 */
const PII_SELECTOR_RULES: Array<[RegExp, PiiKind]> = [
  [/first-?name|firstname/i, 'firstName'],
  [/last-?name|lastname/i, 'lastName'],
  [/middle-?name|middle-?initial/i, 'middleInitial'],
  [/maiden-?name/i, 'lastName'],
  [/nick-?name/i, 'firstName'],
  [/account-?name/i, 'lastName'],
  [/social-?security|(^|[^a-z])ssn([^a-z]|$)/i, 'ssn'],
  [/date-of-birth|(^|[^a-z])dob([^a-z]|$)/i, 'dob'],
  [/drivers?-?licen[cs]e-?number|dlnumber/i, 'dl'],
  [/email-address$|-email$/i, 'email'],
  [/phone.*number$|number.*phone/i, 'phone'],
  [/address1|address2|addressUnit|primary-address-address/i, 'street'],
  [/addressCity$|-city$/i, 'city'],
  [/postal-?code|postalCode|(^|[^a-z])zip([^a-z]|$)/i, 'postal'],
  [/^#VIN-\d+$|(^|[^a-z])vin([^a-z]|$)/i, 'vin'],
  [/assigned-to|input-csr|producer/i, 'staffName'],
  [/customer-since|SelectedPolicyId|SummaryDate/i, 'date'],
];

/** Boolean-valued controls are never PII, whatever their name suggests. */
const NON_PII_KINDS = new Set(['checkbox', 'radio', 'toggle']);

type PiiKind =
  | 'firstName'
  | 'lastName'
  | 'middleInitial'
  | 'ssn'
  | 'dob'
  | 'dl'
  | 'email'
  | 'phone'
  | 'street'
  | 'city'
  | 'postal'
  | 'vin'
  | 'staffName'
  | 'date';

function hashIndex(value: string, modulo: number): number {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt32BE(0) % modulo;
}

function digits(value: string, count: number, seed: string): string {
  const digest = createHash('sha256').update(seed + value).digest('hex').replace(/\D/g, '');
  return (digest + '0000000000').slice(0, count);
}

export class Redactor {
  private readonly cache = new Map<string, string>();

  private memo(key: string, produce: () => string): string {
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;
    const produced = produce();
    this.cache.set(key, produced);
    return produced;
  }

  value(kind: PiiKind, original: string): string {
    const raw = String(original ?? '');
    if (raw.trim() === '') return raw;
    const key = `${kind}:${raw}`;

    return this.memo(key, () => {
      switch (kind) {
        case 'firstName':
          return FIRST_NAMES[hashIndex(raw, FIRST_NAMES.length)]!;
        case 'lastName':
        case 'staffName':
          return LAST_NAMES[hashIndex(raw, LAST_NAMES.length)]!;
        case 'middleInitial':
          return raw.length <= 1 ? 'Q' : 'Q.';
        case 'ssn':
          return `${digits(raw, 3, 'ssn-a')}-${digits(raw, 2, 'ssn-b')}-${digits(raw, 4, 'ssn-c')}`;
        case 'dob':
        case 'date':
          return this.fakeDate(raw);
        case 'dl':
          return `X${digits(raw, 12, 'dl')}`;
        case 'email': {
          const first = FIRST_NAMES[hashIndex(raw, FIRST_NAMES.length)]!.toLowerCase();
          return `${first}${digits(raw, 3, 'mail')}@example.com`;
        }
        case 'phone':
          return `(555) ${digits(raw, 3, 'ph-a')}-${digits(raw, 4, 'ph-b')}`;
        case 'street':
          return `${1000 + hashIndex(raw, 8999)} ${STREETS[hashIndex(raw, STREETS.length)]!}`;
        case 'city':
          return CITIES[hashIndex(raw, CITIES.length)]!;
        case 'postal':
          return raw.length > 5 ? digits(raw, 4, 'zip4') : `5${digits(raw, 4, 'zip')}`;
        case 'vin':
          return this.fakeVin(raw);
        default:
          return '[redacted]';
      }
    });
  }

  /** Keep the month/day shape and shift the year slightly so age logic stays testable. */
  private fakeDate(raw: string): string {
    const match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-]((?:19|20)\d{2})/);
    if (!match) return raw.replace(/\d/g, '1');
    const year = Number(match[3]) + (hashIndex(raw, 5) - 2);
    const separator = raw.includes('-') ? '-' : '/';
    return [match[1]!.padStart(2, '0'), match[2]!.padStart(2, '0'), String(year)].join(separator);
  }

  private fakeVin(raw: string): string {
    const alphabet = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
    const digest = createHash('sha256').update('vin' + raw).digest();
    let out = '';
    for (let i = 0; i < 17; i++) out += alphabet[digest[i % digest.length]! % alphabet.length];
    return out;
  }
}

function kindForSelector(
  selector: string | undefined | null,
  label?: string,
  controlKind?: string,
): PiiKind | null {
  if (controlKind && NON_PII_KINDS.has(controlKind)) return null;

  const target = selector ?? '';
  // "Type" dropdowns carry enum values (Primary / Mobile / Home), not the datum.
  if (/-type$|Type$/.test(target)) return null;

  // Selector and label are tested separately. Concatenating them silently breaks
  // every `$`-anchored rule: "#applicant-email-0-email-address" + " Email Address"
  // no longer ends in "email-address", so the applicant's email leaked through.
  for (const [pattern, kind] of PII_SELECTOR_RULES) {
    if (pattern.test(target)) return kind;
  }
  if (label) {
    for (const [pattern, kind] of PII_SELECTOR_RULES) {
      if (pattern.test(label)) return kind;
    }
  }
  return null;
}

/** A value is only sensitive if redaction would actually change it. */
function isRedactable(kind: PiiKind, value: string, redactor: Redactor): boolean {
  const raw = value.trim();
  if (raw === '' || raw === 'true' || raw === 'false') return false;
  return redactor.value(kind, raw) !== raw;
}

/** Free-text sweep for values that slipped past selector rules (notices, titles, cards). */
function scrubText(text: string, redactor: Redactor, names: Set<string>): string {
  let out = text;
  for (const name of names) {
    if (name.length < 3) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), redactor.value(name.includes(' ') ? 'lastName' : 'firstName', name));
  }
  return out
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '000-00-0000')
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, 'redacted@example.com')
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '(555) 000-0000');
}

/** Collect person names so they can be scrubbed out of free text too. */
function collectNames(events: RecordedEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    for (const field of event.fields ?? []) {
      const kind = kindForSelector(field.selector, field.label, field.kind);
      if ((kind === 'firstName' || kind === 'lastName' || kind === 'staffName') && field.value) {
        names.add(field.value.trim());
      }
    }
    const kind = kindForSelector(event.selector, event.label, event.action);
    if ((kind === 'firstName' || kind === 'lastName') && event.value) names.add(event.value.trim());
  }
  names.delete('');
  return names;
}

function redactField(field: RecordedField, redactor: Redactor): RecordedField {
  const kind = kindForSelector(field.selector, field.label, field.kind);
  if (!kind || field.value === undefined) return field;
  return { ...field, value: redactor.value(kind, field.value) };
}

export interface RedactionResult {
  events: RecordedEvent[];
  replacements: number;
}

export function redactRecording(events: RecordedEvent[]): RedactionResult {
  const redactor = new Redactor();
  const names = collectNames(events);
  let replacements = 0;

  const out = events.map((event) => {
    const copy: RecordedEvent = { ...event };

    if (copy.fields) {
      copy.fields = copy.fields.map((field) => {
        const redacted = redactField(field, redactor);
        if (redacted !== field) replacements += 1;
        return redacted;
      });
    }

    const kind = kindForSelector(copy.selector, copy.label, copy.action);
    if (kind) {
      if (copy.value !== undefined) {
        copy.value = redactor.value(kind, copy.value);
        replacements += 1;
      }
      if (copy.previous !== undefined) copy.previous = redactor.value(kind, copy.previous);
    }

    if (copy.title) copy.title = scrubText(copy.title, redactor, names);
    if (copy.text) copy.text = scrubText(copy.text, redactor, names);
    if (copy.label) copy.label = scrubText(copy.label, redactor, names);
    if (copy.cards) copy.cards = copy.cards.map((card) => scrubText(card, redactor, names));
    if (copy.htmlSample) copy.htmlSample = scrubText(copy.htmlSample, redactor, names);

    return copy;
  });

  return { events: out, replacements };
}

/**
 * Selector-rule-independent leak sweep.
 *
 * `collectSensitiveValues` can only flag what the rules classify, so a wrong
 * rule blinds the guard to exactly the value it failed to redact — which is how
 * the applicant's email slipped through once. This scans the *output* for PII
 * shapes regardless of where they came from, and allows only the known
 * synthetic forms this module produces.
 */
export function findResidualPii(serialized: string): Array<{ kind: string; sample: string }> {
  const findings: Array<{ kind: string; sample: string }> = [];

  const sweeps: Array<[string, RegExp, (m: string) => boolean]> = [
    ['email', /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, (m) => !m.endsWith('@example.com')],
    ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g, (m) => m !== '000-00-0000'],
    ['phone', /\(\d{3}\)\s?\d{3}-\d{4}/g, (m) => !m.startsWith('(555)')],
  ];

  for (const [kind, pattern, isReal] of sweeps) {
    for (const match of serialized.matchAll(pattern)) {
      if (isReal(match[0])) findings.push({ kind, sample: match[0] });
    }
  }
  return findings;
}

/** Values that must not survive redaction; used by the guard and its test. */
export function collectSensitiveValues(events: RecordedEvent[]): string[] {
  const redactor = new Redactor();
  const values = new Set<string>();

  const consider = (kind: PiiKind | null, value: string | undefined) => {
    if (!kind || !value) return;
    const raw = value.trim();
    if (raw.length < 4) return;
    if (!isRedactable(kind, raw, redactor)) return;
    values.add(raw);
  };

  for (const event of events) {
    for (const field of event.fields ?? []) {
      consider(kindForSelector(field.selector, field.label, field.kind), field.value);
    }
    consider(kindForSelector(event.selector, event.label, event.action), event.value);
  }
  return [...values];
}
