/**
 * fixtures/private/ezlynx-recording.json -> fixtures/ezlynx-recording.redacted.json
 *
 *   node dist/scripts/redact-recording.js [--in <path>] [--out <path>]
 *
 * Fails loudly if any sensitive source value survives into the output.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { redactRecording, collectSensitiveValues, findResidualPii } from '../src/recording/redact.js';
import { inferContext, filterNoise, type RecordedEvent } from '../src/recording/types.js';
import { print } from '../src/log/logger.js';

const DEFAULT_IN = resolve(process.cwd(), '../fixtures/private/ezlynx-recording.json');
const DEFAULT_OUT = resolve(process.cwd(), 'fixtures/ezlynx-recording.redacted.json');

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]!) : fallback;
}

function main(): number {
  const inPath = arg('--in', DEFAULT_IN);
  const outPath = arg('--out', DEFAULT_OUT);

  if (!existsSync(inPath)) {
    print(`Recording not found: ${inPath}`);
    print('Place the private recording there, or pass --in <path>.');
    return 2;
  }

  const events = JSON.parse(readFileSync(inPath, 'utf8')) as RecordedEvent[];
  const context = inferContext(events);
  const { dropped } = filterNoise(events, context);

  const sensitive = collectSensitiveValues(events);
  const { events: redacted, replacements } = redactRecording(events);

  const serialized = JSON.stringify(redacted, null, 2);

  // Guard: nothing sensitive may survive. This is the whole point of the script.
  //
  // Word-boundary matching, not substring: a client surname can be a substring
  // of a carrier name such as "Michigan Millers Mutual Insurance Company", which is public
  // business data and must stay in the fixture.
  const survivors = sensitive.filter((value) => {
    if (value.length < 5 || /^\d{1,2}$/.test(value)) return false;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /^[\w]/.test(value) ? '\\b' : '';
    const trailing = /[\w]$/.test(value) ? '\\b' : '';
    return new RegExp(`${boundary}${escaped}${trailing}`).test(serialized);
  });

  if (survivors.length) {
    print(`\nREFUSING TO WRITE — ${survivors.length} sensitive value(s) survived redaction:`);
    for (const value of survivors.slice(0, 10)) print(`  - ${value.slice(0, 4)}… (${value.length} chars)`);
    print('\nAdd a matching rule to src/recording/redact.ts and re-run.');
    return 1;
  }

  // Second, independent check that does not rely on the selector rules.
  const residual = findResidualPii(serialized);
  if (residual.length) {
    print(`\nREFUSING TO WRITE — ${residual.length} PII-shaped value(s) found in the output:`);
    const shown = new Set<string>();
    for (const finding of residual) {
      if (shown.has(finding.sample)) continue;
      shown.add(finding.sample);
      print(`  - [${finding.kind}] ${finding.sample.slice(0, 6)}…`);
      if (shown.size >= 10) break;
    }
    print('\nThe selector rules missed these. Fix src/recording/redact.ts and re-run.');
    return 1;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized + '\n');

  print(`Redacted ${events.length} events (${replacements} value replacements)`);
  print(`Account ${context.accountId}  quotes ${JSON.stringify(context.quoteIds)}`);
  print(`Noise filtered: ${dropped.reduce((sum, entry) => sum + entry.count, 0)} events across ${dropped.length} paths`);
  print(`Wrote ${outPath}`);
  return 0;
}

process.exit(main());
