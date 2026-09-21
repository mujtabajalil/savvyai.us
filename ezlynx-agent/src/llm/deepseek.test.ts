import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DeepSeekClient, DeepSeekError } from './deepseek.js';
import { mapOptionPrompt, resolveErrorPrompt, OptionChoiceSchema } from './prompts.js';

const Schema = z.object({ option: z.string().nullable(), confidence: z.number() });

interface StubCall {
  body: Record<string, unknown>;
}

function stubFetch(replies: Array<{ status?: number; content?: string | null; json?: unknown }>) {
  const calls: StubCall[] = [];
  let index = 0;

  const impl = (async (_url: string, init?: { body?: string }) => {
    calls.push({ body: JSON.parse(init?.body ?? '{}') });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;

    const status = reply?.status ?? 200;
    const payload = reply?.json ?? { choices: [{ message: { content: reply?.content ?? '' }, finish_reason: 'stop' }] };

    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function client(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new DeepSeekClient({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.test',
    model: 'deepseek-flash',
    fetchImpl,
    maxRetries: 0,
    ...overrides,
  });
}

const REQUEST = {
  task: 'test',
  system: 'be helpful',
  user: 'do the thing',
  schema: Schema,
  schemaExample: { option: 'text', confidence: 0 },
};

describe('request shape', () => {
  test('sends json mode, the model, and a zero temperature by default', async () => {
    const { impl, calls } = stubFetch([{ content: '{"option":"Progressive","confidence":0.9}' }]);
    await client(impl).complete(REQUEST);

    const body = calls[0]!.body;
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.temperature, 0);
    assert.ok(typeof body.max_tokens === 'number' && (body.max_tokens as number) > 0);
  });

  test('the word "json" and a shape example are in the system prompt', async () => {
    const { impl, calls } = stubFetch([{ content: '{"option":null,"confidence":0}' }]);
    await client(impl).complete(REQUEST);

    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    const system = messages.find((message) => message.role === 'system')!.content;
    assert.match(system, /json/i);
    assert.match(system, /"option"/);
  });
});

describe('response handling', () => {
  test('valid json is parsed and validated', async () => {
    const { impl } = stubFetch([{ content: '{"option":"Progressive","confidence":0.92}' }]);
    const result = await client(impl).complete(REQUEST);
    assert.deepEqual(result, { option: 'Progressive', confidence: 0.92 });
  });

  test('a code fence is tolerated', async () => {
    const { impl } = stubFetch([{ content: '```json\n{"option":"GEICO","confidence":1}\n```' }]);
    const result = await client(impl).complete(REQUEST);
    assert.equal(result.option, 'GEICO');
  });

  test('invalid json triggers exactly one re-ask, then succeeds', async () => {
    const { impl, calls } = stubFetch([
      { content: 'not json at all' },
      { content: '{"option":"Acuity","confidence":0.8}' },
    ]);
    const result = await client(impl).complete(REQUEST);
    assert.equal(result.option, 'Acuity');
    assert.equal(calls.length, 2);
    assert.match((calls[1]!.body.messages as Array<{ content: string }>)[1]!.content, /previous reply was rejected/i);
  });

  test('a second invalid reply fails loudly rather than degrading', async () => {
    const { impl, calls } = stubFetch([{ content: 'still not json' }]);
    await assert.rejects(() => client(impl).complete(REQUEST), (err: unknown) => {
      assert.ok(err instanceof DeepSeekError);
      assert.equal((err as DeepSeekError).kind, 'invalid-json');
      return true;
    });
    assert.equal(calls.length, 2, 're-asked exactly once');
  });

  test('schema violations are rejected, not passed through', async () => {
    const { impl } = stubFetch([{ content: '{"option":"X"}' }]);
    await assert.rejects(() => client(impl).complete(REQUEST), /schema|confidence/i);
  });

  test('the documented empty-content case is an error, not an empty object', async () => {
    const { impl } = stubFetch([{ content: '' }]);
    await assert.rejects(() => client(impl).complete(REQUEST), (err: unknown) => {
      assert.ok(err instanceof DeepSeekError);
      return true;
    });
  });

  test('truncation by max_tokens is detected', async () => {
    const { impl } = stubFetch([
      { json: { choices: [{ message: { content: '{"option":"Pro' }, finish_reason: 'length' }] } },
    ]);
    await assert.rejects(() => client(impl).complete(REQUEST), /truncated/i);
  });

  test('http errors surface with the status', async () => {
    const { impl } = stubFetch([{ status: 401, json: { error: 'bad key' } }]);
    await assert.rejects(() => client(impl).complete(REQUEST), /HTTP 401/);
  });
});

describe('configuration', () => {
  test('a missing api key fails at construction', () => {
    assert.throws(
      () => new DeepSeekClient({ apiKey: '', baseUrl: 'https://x.test', model: 'deepseek-flash' }),
      /DEEPSEEK_API_KEY/,
    );
  });
});

describe('prompts', () => {
  test('map-option forbids inventing options and allows null', () => {
    const prompt = mapOptionPrompt({
      label: 'Prior Carrier',
      selector: '#priorCarrier',
      desired: 'Safeco',
      options: ['Liberty Mutual', 'Safeco'],
      candidates: ['Safeco'],
    });
    assert.match(prompt.system, /never invent/i);
    assert.match(prompt.system, /null/i);
    assert.match(prompt.user, /Safeco/);
    assert.equal(OptionChoiceSchema.safeParse({ option: null, confidence: 0, reason: 'x' }).success, true);
  });

  test('resolve-error prefers asking over guessing client facts', () => {
    const prompt = resolveErrorPrompt({
      selector: '#effectiveDateNewPolicy',
      label: 'Effective Date',
      errorText: 'Date can not be the in past.',
      context: { ratingState: 'MN' },
    });
    assert.match(prompt.system, /ask_human/);
    assert.match(prompt.system, /never guess/i);
  });

  test('prompts carry no SSN field', () => {
    const prompt = resolveErrorPrompt({
      selector: '#x',
      label: 'y',
      errorText: 'z',
      context: { ratingState: 'MN', vehicleCount: 2 },
    });
    assert.ok(!/ssn|socialSecurity/i.test(prompt.user));
  });
});
