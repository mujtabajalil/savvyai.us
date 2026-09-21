/**
 * DeepSeek client (OpenAI-compatible chat completions, JSON output mode).
 *
 * Contract enforced here, not hoped for:
 *  - response_format json_object, with the word "json" and a schema example in
 *    the prompt (both are documented requirements of the API)
 *  - explicit max_tokens, because a truncated response is invalid JSON
 *  - zod validation of every response; one re-ask on failure, then fail loudly
 *  - the documented empty-content edge case is treated as a failure, not as {}
 *
 * The LLM is never given SSNs, and callers pass the smallest useful slice of
 * quote data. Prompts are logged only through the redacting logger.
 */

import type { z } from 'zod';
import type { Logger } from '../log/logger.js';

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly kind: 'transport' | 'http' | 'empty' | 'invalid-json' | 'schema' | 'config',
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface CompletionRequest<T> {
  /** Short label for logs and metrics, e.g. "map-option". */
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Shown to the model as the required output shape. */
  schemaExample: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly log?: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) {
      throw new DeepSeekError('DEEPSEEK_API_KEY is not set', 'config');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.log = options.logger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async complete<T>(request: CompletionRequest<T>): Promise<T> {
    const instruction = buildJsonInstruction(request.schemaExample);

    const attempt = async (extra?: string): Promise<T> => {
      const content = await this.rawCompletion({
        system: `${request.system}\n\n${instruction}`,
        user: extra ? `${request.user}\n\n${extra}` : request.user,
        maxTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0,
        task: request.task,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(content));
      } catch (err) {
        throw new DeepSeekError(`Response was not valid JSON: ${String(err)}`, 'invalid-json', content.slice(0, 400));
      }

      const result = request.schema.safeParse(parsed);
      if (!result.success) {
        throw new DeepSeekError(
          `Response did not match the schema: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          'schema',
          parsed,
        );
      }
      return result.data;
    };

    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof DeepSeekError) || !['invalid-json', 'schema', 'empty'].includes(err.kind)) throw err;

      this.log?.warn('deepseek response rejected, re-asking once', { task: request.task, kind: err.kind });

      // One corrective re-ask, then give up loudly rather than degrade silently.
      return attempt(
        'Your previous reply was rejected: ' +
          err.message +
          '\nReply again with ONLY a valid json object matching the required shape. No prose, no code fence.',
      );
    }
  }

  private async rawCompletion(args: {
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
    task: string;
  }): Promise<string> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: args.maxTokens,
      temperature: args.temperature,
      stream: false,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
            lastError = new DeepSeekError(`HTTP ${response.status}`, 'http', text.slice(0, 300));
            await backoff(attempt);
            continue;
          }
          throw new DeepSeekError(`DeepSeek returned HTTP ${response.status}`, 'http', text.slice(0, 300));
        }

        const payload = (await response.json()) as ChatResponse;
        const choice = payload.choices?.[0];
        const content = choice?.message?.content ?? '';

        this.log?.debug('deepseek completion', {
          task: args.task,
          model: this.model,
          finish: choice?.finish_reason,
          promptTokens: payload.usage?.prompt_tokens,
          completionTokens: payload.usage?.completion_tokens,
        });

        if (choice?.finish_reason === 'length') {
          throw new DeepSeekError('Response hit max_tokens and is truncated', 'invalid-json', content.slice(0, 200));
        }

        // Documented DeepSeek edge case: JSON mode can return empty content.
        if (content.trim() === '') {
          throw new DeepSeekError('DeepSeek returned empty content', 'empty');
        }
        return content;
      } catch (err) {
        if (err instanceof DeepSeekError) throw err;
        lastError = err;
        const aborted = err instanceof Error && err.name === 'AbortError';
        if (attempt < this.maxRetries) {
          this.log?.debug('deepseek retry', { task: args.task, attempt, reason: aborted ? 'timeout' : String(err) });
          await backoff(attempt);
          continue;
        }
        throw new DeepSeekError(
          aborted ? `DeepSeek request timed out after ${this.timeoutMs}ms` : `DeepSeek request failed: ${String(err)}`,
          'transport',
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new DeepSeekError('DeepSeek request failed', 'transport');
  }
}

function buildJsonInstruction(example: Record<string, unknown>): string {
  return [
    'You must reply with a single valid json object and nothing else.',
    'Do not wrap it in a code fence. Do not add commentary.',
    'The json object must have exactly this shape:',
    JSON.stringify(example, null, 2),
  ].join('\n');
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence?.[1] ?? trimmed;
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(8000, 500 * 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
