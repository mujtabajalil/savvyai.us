/**
 * Quote-results parsing.
 *
 * Parsed from the DOM, not from the recorder's flattened `cards[]`. That text
 * has no carrier name (it lives in `img.carrier-img` alt) and is polluted with
 * Material icon ligatures — "directions_car", "home" and "keyboard_arrow_down"
 * appear as words. The flattened cards are used as test fixtures only.
 */

export type Lob = 'auto' | 'home' | 'package';

export interface QuoteCard {
  carrier: string;
  lob: Lob;
  premium: number | null;
  termMonths: 6 | 12 | null;
  basis: 'Paid-In-Full' | 'Total Premium' | null;
  altQuoteName: string | null;
  badges: string[];
  error: string | null;
  /** Per-LOB split when the card is a package total. */
  components?: Array<{ lob: Lob; premium: number }>;
}

export interface NormalizedQuote extends QuoteCard {
  annualPremium: number | null;
  annualIsEstimated: boolean;
}

const MONEY = /\$\s?([\d,]+(?:\.\d{2})?)/g;
const TERM = /\/\s*(6|12)\s*mo/i;
const ICON_WORDS = /\b(directions_car|home|keyboard_arrow_down|keyboard_arrow_up|info|expand_more|check_circle|error|warning)\b/g;

export function parseMoney(text: string): number | null {
  const match = /\$\s?([\d,]+(?:\.\d{2})?)/.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? Math.round(value) : null;
}

export function stripIconWords(text: string): string {
  return text.replace(ICON_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

export function detectTerm(text: string): 6 | 12 | null {
  const match = TERM.exec(text);
  if (!match?.[1]) return null;
  return match[1] === '6' ? 6 : 12;
}

export function detectBasis(text: string): QuoteCard['basis'] {
  if (/paid[\s-]?in[\s-]?full/i.test(text)) return 'Paid-In-Full';
  if (/total premium/i.test(text)) return 'Total Premium';
  return null;
}

export function detectBadges(text: string): string[] {
  const badges: string[] = [];
  if (/national partner/i.test(text)) badges.push('National partner');
  if (/local deal/i.test(text)) badges.push('Local deal');
  return badges;
}

export function detectError(text: string): string | null {
  const match = /Carrier Error\s*:?\s*([^|]+)/i.exec(text);
  return match?.[1] ? match[1].trim() : null;
}

export function detectAltQuote(text: string): string | null {
  const match = /Alt Quote\s+([^$|]+?)(?=\s*(?:directions_car|home|\$|\||$))/i.exec(text);
  const name = match?.[1]?.trim();
  return name && name.length > 1 ? name : null;
}

/**
 * Parse a flattened card string. Package cards carry an auto amount, a home
 * amount and a combined total:
 *   "National partner Local deal $6,077 directions_car $1,432 home $7,509 / 12 mo"
 */
export function parseCardText(text: string): QuoteCard {
  const badges = detectBadges(text);
  const error = detectError(text);
  const altQuoteName = detectAltQuote(text);
  const termMonths = detectTerm(text);
  const basis = detectBasis(text);

  const amounts: Array<{ value: number; index: number }> = [];
  for (const match of text.matchAll(MONEY)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    if (Number.isFinite(value)) amounts.push({ value: Math.round(value), index: match.index ?? 0 });
  }

  // Incentive copy ("earn up to $1,000") is marketing, not a premium.
  const isIncentive = /earn up to|race for the cash|incentive/i.test(text);
  const usable = isIncentive ? [] : amounts;

  const hasAuto = /directions_car/.test(text);
  const hasHome = /\bhome\b/.test(text);

  let lob: Lob = 'auto';
  if (hasAuto && hasHome) lob = 'package';
  else if (hasHome && !hasAuto) lob = 'home';

  let premium: number | null = null;
  let components: QuoteCard['components'];

  if (lob === 'package' && usable.length >= 3) {
    const [auto, home, total] = usable;
    components = [
      { lob: 'auto', premium: auto!.value },
      { lob: 'home', premium: home!.value },
    ];
    premium = total!.value;
  } else if (usable.length) {
    premium = usable[usable.length - 1]!.value;
  }

  return {
    carrier: '',
    lob,
    premium,
    termMonths,
    basis,
    altQuoteName,
    badges,
    error,
    ...(components ? { components } : {}),
  };
}

/** Annualise, marking 6-month doubling as an estimate. */
export function normalizeAnnual(card: QuoteCard): NormalizedQuote {
  if (card.premium === null) return { ...card, annualPremium: null, annualIsEstimated: false };
  if (card.termMonths === 6) return { ...card, annualPremium: card.premium * 2, annualIsEstimated: true };
  return { ...card, annualPremium: card.premium, annualIsEstimated: false };
}

/** Page-side extraction expression for the live results page. */
export function resultsExtractionExpr(): string {
  return `(() => {
    const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
    const cards = Array.from(document.querySelectorAll('script-result, .quote-result, .carrier-result, [class*="carrier-row"]'));
    return cards.map((card) => {
      const img = card.querySelector('img.carrier-img, img[class*="carrier"]');
      const errorEl = card.querySelector('.carrier-error, [class*="error"]');
      return {
        carrier: img ? (img.getAttribute('alt') || '').trim() : '',
        text: txt(card),
        errorText: txt(errorEl),
        html: card.outerHTML.slice(0, 4000),
      };
    });
  })()`;
}

export function progressBarsExpr(): string {
  return `(() => document.querySelectorAll('mat-progress-bar, .mat-mdc-progress-bar').length)()`;
}

export function answerButtonsExpr(): string {
  return `(() => Array.from(document.querySelectorAll('[id^="answer-questions-"]')).map((el) => ({
    id: el.id,
    carrierId: (el.id.match(/answer-questions-(\\d+)-/) || [])[1] || null,
    lob: (el.id.match(/answer-questions-\\d+-(\\w+)/) || [])[1] || null,
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
  })))()`;
}

/** The submit-answers button id carries a dynamic numeric suffix. */
export function submitAnswersButtonExpr(): string {
  return `(() => {
    const el = document.querySelector('[id^="submit-answers-button"]');
    return el ? { id: el.id, disabled: el.disabled === true } : null;
  })()`;
}

export function graphToggleExpr(): string {
  return `(() => {
    const toggles = Array.from(document.querySelectorAll('mat-slide-toggle'));
    const graph = toggles.find((t) => /graph/i.test(t.textContent || '') || /graph/i.test(t.getAttribute('aria-label') || ''));
    if (!graph) return null;
    const input = graph.querySelector('input, button');
    const checked = (input && (input.getAttribute('aria-checked') === 'true' || input.checked === true)) || false;
    return { id: graph.id || null, checked };
  })()`;
}

export interface RawResultCard {
  carrier: string;
  text: string;
  errorText: string;
  html: string;
}

export function buildQuoteCards(raw: RawResultCard[]): NormalizedQuote[] {
  return raw
    .map((entry) => {
      const parsed = parseCardText(stripIconWords(entry.text) === '' ? entry.text : entry.text);
      return normalizeAnnual({
        ...parsed,
        carrier: entry.carrier || parsed.carrier,
        error: parsed.error ?? (entry.errorText ? entry.errorText : null),
      });
    })
    .filter((card) => card.carrier !== '' || card.premium !== null || card.error !== null);
}
