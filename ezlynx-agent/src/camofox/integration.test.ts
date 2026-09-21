/**
 * Integration tests against a mock camofox server.
 *
 * The mock runs the real `/evaluate` expressions against a jsdom-free, hand-rolled
 * DOM stub is not viable, so instead it answers the expressions the way a real
 * page would, and asserts the client/controls layer drives the right REST calls
 * in the right order. Nothing here touches EZLynx or DeepSeek.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { CamofoxClient, CamofoxError } from './client.js';
import { setField, cssEscapeId } from './controls.js';
import { waitFor, WaitTimeout } from './waits.js';
import type { ControlState, OptionItem } from './dom.js';

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

/** Scripted camofox: each /evaluate returns the next queued answer. */
class MockCamofox {
  readonly calls: RecordedCall[] = [];
  private readonly evaluateQueue: unknown[] = [];
  private repeating: { value: unknown } | null = null;
  /** Modelled page state: is an option panel currently covering the page? */
  panelOpen = false;
  private server?: Server;
  port = 0;

  queueEvaluate(...values: unknown[]): void {
    this.evaluateQueue.push(...values);
  }

  /** Answer every /evaluate with the same value — for polling loops. */
  repeatEvaluate(value: unknown): void {
    this.repeating = { value };
  }

  stopRepeating(): void {
    this.repeating = null;
  }

  get evaluateRemaining(): number {
    return this.evaluateQueue.length;
  }

  clicks(): string[] {
    return this.calls.filter((call) => call.path.endsWith('/click')).map((call) => String(call.body.selector ?? call.body.ref));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const path = req.url ?? '';
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        this.calls.push({ path, body });

        res.setHeader('content-type', 'application/json');

        if (path === '/health') return res.end(JSON.stringify({ status: 'ok' }));
        if (path === '/tabs' && req.method === 'POST') return res.end(JSON.stringify({ tabId: 'tab-1', url: 'about:blank' }));
        if (path.endsWith('/evaluate')) {
          // Panel-state probes are bookkeeping, not scripted steps — answer them
          // from a modelled "nothing is open" page so they do not consume the
          // queue and shift every subsequent expectation.
          const expression = String(body.expression ?? '');
          if (expression.includes('scrollIntoView')) {
            return res.end(JSON.stringify({ ok: true, result: true }));
          }
          if (expression.includes('cdk-overlay-backdrop')) {
            return res.end(JSON.stringify({ ok: true, result: this.panelOpen }));
          }
          if (expression.includes('if (!anyPanelOpen())')) {
            this.panelOpen = false;
            return res.end(JSON.stringify({ ok: true, result: true }));
          }

          if (this.evaluateQueue.length) {
            const next = this.evaluateQueue.shift() as { options?: unknown[] } | undefined;
            if (next && Array.isArray(next.options) && next.options.length) this.panelOpen = true;
            return res.end(JSON.stringify({ ok: true, result: next }));
          }
          if (this.repeating) {
            return res.end(JSON.stringify({ ok: true, result: this.repeating.value }));
          }
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: 'mock ran out of queued evaluate answers' }));
        }
        if (path.endsWith('/select')) {
          const option = String(body.option ?? '');
          if (option === 'NOT-A-NATIVE-OPTION') {
            res.statusCode = 422;
            return res.end(JSON.stringify({ error: 'not an option', code: 'element_not_actionable' }));
          }
          return res.end(JSON.stringify({ ok: true }));
        }
        if (path.endsWith('/type')) {
          if (body.text === '__NOT_FILLABLE__') {
            res.statusCode = 422;
            return res.end(JSON.stringify({ error: 'Element is not fillable', code: 'element_not_actionable' }));
          }
          return res.end(JSON.stringify({ ok: true }));
        }
        return res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function control(overrides: Partial<ControlState>): ControlState {
  return {
    found: true,
    kind: 'mat-select',
    selector: '#priorCarrier',
    resolvedSelector: '#priorCarrier',
    id: 'priorCarrier',
    value: '',
    checked: null,
    disabled: false,
    required: true,
    visible: true,
    label: 'Prior Carrier',
    error: null,
    matches: 1,
    ...overrides,
  };
}

function options(...texts: string[]): OptionItem[] {
  return texts.map((text, index) => ({
    index,
    id: `mat-option-${index}`,
    text,
    disabled: false,
    selected: false,
  }));
}

let mock: MockCamofox;
let client: CamofoxClient;

before(async () => {
  mock = new MockCamofox();
  await mock.start();
  client = new CamofoxClient({ baseUrl: `http://127.0.0.1:${mock.port}`, userId: 'test', timeoutMs: 5_000 });
});

after(async () => {
  await mock.stop();
});

describe('mat-select driver', () => {
  test('opens, matches, clicks the option by id, and verifies', async () => {
    mock.calls.length = 0;
    mock.queueEvaluate(
      control({ value: 'State Farm' }),                                   // describe
      { ok: true, options: options('--Select--', 'Progressive', 'State Farm') }, // panel
      control({ value: 'Progressive' }),                                  // verify
    );

    const result = await setField(client, 'tab-1', '#priorCarrier', 'Progressive');

    assert.equal(result.applied, true);
    assert.equal(result.value, 'Progressive');
    assert.equal(result.tier, 'exact');
    assert.deepEqual(mock.clicks(), ['#priorCarrier', '#mat-option-1']);
  });

  test('a control already showing the desired value is left alone', async () => {
    mock.calls.length = 0;
    mock.queueEvaluate(control({ value: 'Progressive' }));

    const result = await setField(client, 'tab-1', '#priorCarrier', 'Progressive');

    assert.equal(result.applied, false);
    assert.equal(result.skipped, 'already-set');
    assert.deepEqual(mock.clicks(), [], 'no clicks for an already-correct field');
  });

  test('a disabled control is skipped, not forced', async () => {
    mock.queueEvaluate(control({ disabled: true, value: 'Insured' }));
    const result = await setField(client, 'tab-1', '#driver-0-relationship', 'Spouse');
    assert.equal(result.skipped, 'disabled');
  });

  test('failed verification is an error, not a silent pass', async () => {
    mock.queueEvaluate(
      control({ value: '' }),
      { ok: true, options: options('--Select--', 'Progressive') },
      control({ value: '' }), // control did not take the value
    );

    await assert.rejects(
      () => setField(client, 'tab-1', '#priorCarrier', 'Progressive'),
      /Verification failed/,
    );
  });

  test('an unmatched option escapes the panel and reports candidates', async () => {
    mock.calls.length = 0;
    mock.queueEvaluate(
      control({ value: '' }),
      { ok: true, options: options('Liberty Mutual', 'Safeco') },
    );

    await assert.rejects(
      () => setField(client, 'tab-1', '#priorCarrier', 'Some Regional Mutual'),
      /No option matches/,
    );
    assert.ok(mock.calls.some((call) => call.path.endsWith('/press')), 'pressed Escape to close the panel');
    assert.equal(mock.panelOpen, false, 'left no backdrop to poison the next field');
  });

  test('a panel that never renders options fails clearly', async () => {
    // The driver retries the open once, so both attempts must fail.
    mock.queueEvaluate(control({ value: '' }), { ok: false, options: [] }, { ok: false, options: [] });
    await assert.rejects(() => setField(client, 'tab-1', '#priorCarrier', 'Progressive'), /did not open/);
  });

  test('the LLM resolver is consulted only when deterministic tiers fail', async () => {
    mock.queueEvaluate(
      control({ value: '' }),
      { ok: true, options: options('Liberty Mutual', 'Safeco') },
      control({ value: 'Safeco' }),
    );

    let consulted = 0;
    const result = await setField(client, 'tab-1', '#priorCarrier', 'Liberty Mutual (formerly Safeco)', {
      resolveOption: async (context) => {
        consulted += 1;
        assert.deepEqual(context.options, ['Liberty Mutual', 'Safeco']);
        return 'Safeco';
      },
    });

    assert.equal(consulted, 1);
    assert.equal(result.value, 'Safeco');
  });

  test('the resolver is not consulted for an exact match', async () => {
    mock.queueEvaluate(
      control({ value: '' }),
      { ok: true, options: options('Progressive') },
      control({ value: 'Progressive' }),
    );

    let consulted = 0;
    await setField(client, 'tab-1', '#priorCarrier', 'Progressive', {
      resolveOption: async () => {
        consulted += 1;
        return null;
      },
    });
    assert.equal(consulted, 0);
  });
});

describe('other control kinds', () => {
  test('native selects go through /select, not the panel dance', async () => {
    mock.calls.length = 0;
    mock.queueEvaluate(
      control({ kind: 'native-select', selector: '#SelectedPolicyId', value: '' }),
      control({ kind: 'native-select', selector: '#SelectedPolicyId', value: 'Today' }),
    );

    const result = await setField(client, 'tab-1', '#SelectedPolicyId', 'Today');
    assert.equal(result.kind, 'native-select');
    assert.ok(mock.calls.some((call) => call.path.endsWith('/select')));
    assert.deepEqual(mock.clicks(), []);
  });

  test('text fields report a reformatted readback instead of failing', async () => {
    mock.queueEvaluate(
      control({ kind: 'text', selector: '#effectiveDateNewPolicy', value: '' }),
      control({ kind: 'text', selector: '#effectiveDateNewPolicy', value: '11/14/2026' }),
    );

    const result = await setField(client, 'tab-1', '#effectiveDateNewPolicy', '11-14-2026');
    assert.equal(result.applied, true);
    assert.match(result.note ?? '', /wrote "11-14-2026", field shows "11\/14\/2026"/);
  });

  test('a mis-classified text control surfaces the 422 clearly', async () => {
    mock.queueEvaluate(control({ kind: 'text', selector: '#priorCarrier', value: '' }));
    await assert.rejects(
      () => setField(client, 'tab-1', '#priorCarrier', '__NOT_FILLABLE__'),
      /not fillable/i,
    );
  });

  test('toggles are clicked once and verified', async () => {
    mock.calls.length = 0;
    mock.queueEvaluate(
      control({ kind: 'toggle', selector: '#carrier-613-aaa-button', value: 'false', checked: false }),
      control({ kind: 'toggle', selector: '#carrier-613-aaa-button', value: 'true', checked: true }),
    );

    const result = await setField(client, 'tab-1', '#carrier-613-aaa-button', true);
    assert.equal(result.applied, true);
    assert.equal(mock.clicks().length, 1);
  });

  test('a toggle that does not move is an error', async () => {
    mock.queueEvaluate(
      control({ kind: 'toggle', value: 'false', checked: false }),
      control({ kind: 'toggle', value: 'false', checked: false }),
    );
    await assert.rejects(() => setField(client, 'tab-1', '#x', true), /did not reach/);
  });

  test('a missing control is reported, not thrown', async () => {
    mock.queueEvaluate(control({ found: false, matches: 0 }));
    const result = await setField(client, 'tab-1', '#nope', 'x');
    assert.equal(result.skipped, 'not-found');
  });
});

describe('waits', () => {
  test('resolves as soon as the condition holds', async () => {
    mock.queueEvaluate({ ok: true, value: '2019' });
    const value = await waitFor(client, 'tab-1', { type: 'value-not-empty', selector: '#year-0' }, { timeoutMs: 3_000 });
    assert.equal(value, '2019');
  });

  test('times out with the condition and last value attached', async () => {
    // The poll loop iterates until the deadline, so the stub must answer every time.
    mock.repeatEvaluate({ ok: false, value: 'partial' });
    try {
      await assert.rejects(
        () => waitFor(client, 'tab-1', { type: 'value-not-empty', selector: '#year-0' }, { timeoutMs: 150 }),
        (err: unknown) => {
          assert.ok(err instanceof WaitTimeout, `expected WaitTimeout, got ${String(err)}`);
          assert.equal((err as WaitTimeout).condition.selector, '#year-0');
          assert.equal((err as WaitTimeout).lastValue, 'partial');
          return true;
        },
      );
    } finally {
      mock.stopRepeating();
    }
  });
});

describe('client error classification', () => {
  test('409 and 410 are distinguishable from a plain 404', () => {
    assert.equal(new CamofoxError('x', 409).isStale, true);
    assert.equal(new CamofoxError('x', 410, 'browser_restarted').isGone, true);
    assert.equal(new CamofoxError('x', 404).isNotFound, true);
    assert.equal(new CamofoxError('x', 422, 'element_not_actionable').isNotActionable, true);
  });
});

describe('css escaping for real EZLynx ids', () => {
  test('parentheses, ampersands and asterisks are escaped', () => {
    assert.equal(cssEscapeId('carrier-35-liberty-mutual-(formerly-safeco)'), 'carrier-35-liberty-mutual-\\(formerly-safeco\\)');
    assert.equal(cssEscapeId('prior_liabilityasi*MN'), 'prior_liabilityasi\\*MN');
    assert.equal(cssEscapeId('universal-property-&-casualty'), 'universal-property-\\&-casualty');
  });
});
