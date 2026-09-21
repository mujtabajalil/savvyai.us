import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseCardText,
  normalizeAnnual,
  detectTerm,
  detectBasis,
  detectBadges,
  detectAltQuote,
  stripIconWords,
  parseMoney,
  buildQuoteCards,
} from './parse.js';
import { buildReport, renderMarkdown } from './report.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/ezlynx-recording.redacted.json');
const events: Array<{ action: string; cards?: string[]; htmlSample?: string }> = existsSync(FIXTURE)
  ? JSON.parse(readFileSync(FIXTURE, 'utf8'))
  : [];
const resultEvents = events.filter((event) => event.action === 'results');

describe('field detection', () => {
  test('term, basis and badges', () => {
    assert.equal(detectTerm('$7,509 / 12 mo'), 12);
    assert.equal(detectTerm('$1,204 / 6 mo'), 6);
    assert.equal(detectTerm('no term here'), null);

    assert.equal(detectBasis('Paid-In-Full $1,200'), 'Paid-In-Full');
    assert.equal(detectBasis('Total Premium $1,200'), 'Total Premium');

    assert.deepEqual(detectBadges('National partner Local deal $1'), ['National partner', 'Local deal']);
  });

  test('money parsing', () => {
    assert.equal(parseMoney('$6,077'), 6077);
    assert.equal(parseMoney('$1,432.00'), 1432);
    assert.equal(parseMoney('no money'), null);
  });

  test('icon ligatures are removable', () => {
    assert.equal(stripIconWords('directions_car $1 home keyboard_arrow_down'), '$1');
  });

  test('alt quote names are extracted', () => {
    assert.equal(
      detectAltQuote('National partner Local deal Alt Quote Multi Pols,IntelliDrive®,Ded Incr,Youthful directions_car $3,215 / 12 mo'),
      'Multi Pols,IntelliDrive®,Ded Incr,Youthful',
    );
    assert.equal(detectAltQuote('National partner $1,000 / 12 mo'), null);
  });
});

describe('card parsing — real strings from the recording', () => {
  test('a package card splits into auto, home and combined', () => {
    const card = parseCardText('National partner Local deal $6,077 directions_car $1,432 home $7,509 / 12 mo keyboard_arrow_down');
    assert.equal(card.lob, 'package');
    assert.equal(card.premium, 7509);
    assert.equal(card.termMonths, 12);
    assert.deepEqual(card.components, [
      { lob: 'auto', premium: 6077 },
      { lob: 'home', premium: 1432 },
    ]);
  });

  test('an auto-only alt quote is not mistaken for a package', () => {
    const card = parseCardText('National partner Local deal Alt Quote Multi Pols,IntelliDrive®,Ded Incr,Youthful directions_car $3,215 / 12 mo keyboard_arrow_down');
    assert.equal(card.lob, 'auto');
    assert.equal(card.premium, 3215);
    assert.equal(card.altQuoteName, 'Multi Pols,IntelliDrive®,Ded Incr,Youthful');
  });

  test('marketing incentive copy is never read as a premium', () => {
    // "You could earn up to $1,000 ..." is agent incentive text, not a quote.
    const card = parseCardText(
      'National partner directions_car You could earn up to $1,000 for selling this policy with Progressive’s Race for the Cash incentive. CA policies excluded. See rules for details. | home You could earn up to $1,000',
    );
    assert.equal(card.premium, null);
  });

  test('carrier errors are captured', () => {
    const card = parseCardText('Carrier Error: Unable to rate this risk | directions_car');
    assert.equal(card.error, 'Unable to rate this risk');
    assert.equal(card.premium, null);
  });
});

describe('annualisation', () => {
  test('12-month premiums pass through', () => {
    const annual = normalizeAnnual(parseCardText('$7,509 / 12 mo directions_car home $1'));
    assert.equal(annual.annualIsEstimated, false);
  });

  test('6-month premiums are doubled and flagged as estimated', () => {
    const annual = normalizeAnnual(parseCardText('directions_car $1,204 / 6 mo'));
    assert.equal(annual.annualPremium, 2408);
    assert.equal(annual.annualIsEstimated, true);
  });

  test('a missing premium does not become zero', () => {
    const annual = normalizeAnnual(parseCardText('Carrier Error: nope'));
    assert.equal(annual.annualPremium, null);
  });
});

describe('recording fixtures parse without throwing', { skip: resultEvents.length === 0 }, () => {
  test('every captured card yields a card object', () => {
    let parsed = 0;
    let withPremium = 0;
    for (const event of resultEvents) {
      for (const text of event.cards ?? []) {
        const card = parseCardText(text);
        parsed += 1;
        if (card.premium !== null) withPremium += 1;
      }
    }
    assert.ok(parsed > 50, `expected many cards, parsed ${parsed}`);
    assert.ok(withPremium > 0, 'no card produced a premium');
  });

  test('html samples were captured for the DOM parser', () => {
    assert.ok(resultEvents.every((event) => (event.htmlSample ?? '').length > 1000));
  });
});

describe('report rendering', () => {
  const report = buildReport({
    accountId: '201601955',
    resultsUrl: 'https://app.ezlynx.com/web/account/201601955/rating/quote-results/1/2',
    quotes: [
      normalizeAnnual({ ...parseCardText('$6,077 directions_car $1,432 home $7,509 / 12 mo'), carrier: 'Progressive' }),
      normalizeAnnual({ ...parseCardText('directions_car $1,204 / 6 mo'), carrier: 'GEICO' }),
      normalizeAnnual({ ...parseCardText('Carrier Error: cannot rate'), carrier: 'Travelers' }),
    ],
    droppedCarriers: [
      { carrierId: '13', name: 'Travelers', lob: 'home', reason: 'finish became valid once deselected', step: 'home/finish' },
    ],
    flags: ['Market value was not supplied — used the dwelling amount'],
    now: new Date('2026-09-16T12:00:00Z'),
  });

  test('errored carriers are separated from quotes', () => {
    assert.equal(report.quotes.length, 2);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.carrier, 'Travelers');
  });

  test('quotes sort by annual premium ascending', () => {
    assert.equal(report.quotes[0]?.carrier, 'GEICO');
    assert.equal(report.quotes[0]?.annualPremium, 2408);
  });

  test('markdown includes dropped carriers, flags and the estimate marker', () => {
    const markdown = renderMarkdown(report);
    assert.match(markdown, /## Quotes/);
    assert.match(markdown, /Carriers dropped during the run/);
    assert.match(markdown, /finish became valid once deselected/);
    assert.match(markdown, /Flags — verify before presenting/);
    assert.match(markdown, /annual figure estimated by doubling/);
    assert.match(markdown, /Package breakdown/);
  });
});

describe('buildQuoteCards', () => {
  test('carrier name comes from the img alt, not the text', () => {
    const cards = buildQuoteCards([
      { carrier: 'Progressive', text: 'National partner directions_car $3,215 / 12 mo', errorText: '', html: '' },
    ]);
    assert.equal(cards[0]?.carrier, 'Progressive');
    assert.equal(cards[0]?.premium, 3215);
  });

  test('empty shells are dropped', () => {
    const cards = buildQuoteCards([{ carrier: '', text: 'keyboard_arrow_down', errorText: '', html: '' }]);
    assert.equal(cards.length, 0);
  });
});
