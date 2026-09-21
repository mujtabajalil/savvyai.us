/**
 * Structured logger. Every field passes through `redact()` — there is no
 * unredacted path out of this module, by design.
 */

import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  sink?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: ' INFO',
  warn: ' WARN',
  error: 'ERROR',
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const json = options.json ?? false;
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;

    const merged = { ...bindings, ...(fields ?? {}) };
    const safeFields = redact(merged) as Record<string, unknown>;
    const safeMsg = redact(msg) as string;

    if (json) {
      sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: safeMsg, ...safeFields }));
      return;
    }

    const rendered = Object.entries(safeFields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    sink(`${LEVEL_TAG[lvl]}  ${safeMsg}${rendered ? '  ' + rendered : ''}`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** Writes to stdout unredacted-structure but still redacted-content; for CLI summaries. */
export function print(line = ''): void {
  process.stdout.write(line + '\n');
}
