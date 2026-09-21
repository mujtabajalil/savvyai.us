/**
 * Environment configuration, validated at startup.
 *
 * Nothing is auto-loaded from disk — the process environment is the only source.
 * Use `node --env-file=.env` to supply values (CONTRIBUTING.md forbids `dotenv`).
 */

import { z } from 'zod';

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const ConfigSchema = z.object({
  camofoxUrl: z.string().url(),
  camofoxAccessKey: z.string().default(''),
  camofoxUserId: z.string().min(1),
  camofoxSessionKey: z.string().min(1).default('default'),

  deepseekApiKey: z.string().default(''),
  deepseekBaseUrl: z.string().url(),
  deepseekModel: z.string().min(1),

  ezlynxBaseUrl: z.string().url(),

  requireSubmitConfirmation: z.boolean(),
  debugArtifacts: z.boolean(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  httpTimeoutMs: z.number().int().positive().max(600_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Set when the command will talk to DeepSeek; makes the API key mandatory. */
  requireLlm?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): Config {
  const problems: string[] = [];

  // EZLynx pages contain client PII and camofox enables crash telemetry by default.
  // This is a hard gate, not a warning.
  const crashReport = (env.CAMOFOX_CRASH_REPORT_ENABLED ?? '').trim().toLowerCase();
  if (crashReport !== 'false') {
    problems.push(
      'CAMOFOX_CRASH_REPORT_ENABLED must be set to "false". EZLynx pages contain client PII and ' +
        'camofox-browser sends crash/hang telemetry by default. Set it in the environment of BOTH ' +
        'this agent and the camofox server process.',
    );
  }

  const timeoutRaw = (env.HTTP_TIMEOUT_MS ?? '').trim();
  const httpTimeoutMs = timeoutRaw === '' ? 30_000 : Number(timeoutRaw);
  if (!Number.isFinite(httpTimeoutMs)) problems.push('HTTP_TIMEOUT_MS must be a number');

  const parsed = ConfigSchema.safeParse({
    camofoxUrl: (env.CAMOFOX_URL ?? 'http://localhost:9377').trim(),
    camofoxAccessKey: (env.CAMOFOX_ACCESS_KEY ?? '').trim(),
    camofoxUserId: (env.CAMOFOX_USER_ID ?? 'ezlynx-agent').trim(),
    camofoxSessionKey: (env.CAMOFOX_SESSION_KEY ?? 'default').trim(),

    deepseekApiKey: (env.DEEPSEEK_API_KEY ?? '').trim(),
    deepseekBaseUrl: (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').trim(),
    deepseekModel: (env.DEEPSEEK_MODEL ?? 'deepseek-flash').trim(),

    ezlynxBaseUrl: (env.EZLYNX_BASE_URL ?? 'https://app.ezlynx.com').trim(),

    requireSubmitConfirmation: boolish(true).parse(env.REQUIRE_SUBMIT_CONFIRMATION),
    debugArtifacts: boolish(false).parse(env.EZLYNX_DEBUG_ARTIFACTS),
    logLevel: ((env.LOG_LEVEL ?? 'info').trim() || 'info') as Config['logLevel'],
    httpTimeoutMs: Number.isFinite(httpTimeoutMs) ? httpTimeoutMs : 30_000,
  });

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }

  if (options.requireLlm && parsed.success && parsed.data.deepseekApiKey === '') {
    problems.push('DEEPSEEK_API_KEY is required for this command');
  }

  if (env.DEEP_SEEK_API_KEY && !env.DEEPSEEK_API_KEY) {
    problems.push('Found DEEP_SEEK_API_KEY — the correct name is DEEPSEEK_API_KEY (no underscore after DEEP)');
  }

  if (problems.length) throw new ConfigError(problems);
  return parsed.data as Config;
}

/** Redacted view for startup logging. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    camofoxUrl: config.camofoxUrl,
    camofoxUserId: config.camofoxUserId,
    camofoxSessionKey: config.camofoxSessionKey,
    camofoxAuth: config.camofoxAccessKey ? 'access-key' : 'none',
    deepseekBaseUrl: config.deepseekBaseUrl,
    deepseekModel: config.deepseekModel,
    deepseekAuth: config.deepseekApiKey ? 'configured' : 'missing',
    ezlynxBaseUrl: config.ezlynxBaseUrl,
    requireSubmitConfirmation: config.requireSubmitConfirmation,
    debugArtifacts: config.debugArtifacts,
  };
}
