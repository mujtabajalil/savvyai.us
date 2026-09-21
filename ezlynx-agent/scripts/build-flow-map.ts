/**
 * Recording -> flow/ezlynx.flow.json
 *
 *   node dist/scripts/build-flow-map.js [--in <path>] [--out <path>]
 *
 * Generated output is meant to be hand-reviewed and committed. Warnings are
 * printed loudly rather than swallowed — a step with no observed next-button is
 * a step the runner cannot advance.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildFlowMap } from '../src/recording/flow-map.js';
import type { RecordedEvent } from '../src/recording/types.js';
import { print } from '../src/log/logger.js';

const DEFAULT_IN = resolve(process.cwd(), '../fixtures/private/ezlynx-recording.json');
const DEFAULT_OUT = resolve(process.cwd(), 'flow/ezlynx.flow.json');

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]!) : fallback;
}

function main(): number {
  const inPath = arg('--in', DEFAULT_IN);
  const outPath = arg('--out', DEFAULT_OUT);

  if (!existsSync(inPath)) {
    print(`Recording not found: ${inPath}`);
    return 2;
  }

  const events = JSON.parse(readFileSync(inPath, 'utf8')) as RecordedEvent[];
  const map = buildFlowMap(events);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(map, null, 2) + '\n');

  print(`\nFlow map: ${map.generatedFrom.kept}/${map.generatedFrom.events} events kept`);
  print(`Account ${map.generatedFrom.accountId}  quotes ${JSON.stringify(map.generatedFrom.quoteIds)}\n`);

  print('Steps:');
  for (const stepId of map.order) {
    const step = map.steps[stepId]!;
    const withOptions = step.fields.filter((field) => field.options?.length).length;
    print(
      `  ${stepId.padEnd(26)} fields=${String(step.fields.length).padStart(3)}` +
        `  options=${String(withOptions).padStart(2)}` +
        `  msgs=${String(step.messages.length).padStart(2)}` +
        `  next=${step.nextSelector ?? '(none)'}`,
    );
  }

  print(`\nCarriers observed: ${map.carriers.length}`);
  for (const carrier of map.carriers) {
    print(`  ${carrier.id.padStart(4)}  ${carrier.lobs.join(',').padEnd(10)} ${carrier.label}`);
  }

  if (map.dropped.length) {
    print('\nFiltered noise:');
    for (const entry of map.dropped) print(`  ${String(entry.count).padStart(3)}  ${entry.reason}  ${entry.path}`);
  }

  if (map.warnings.length) {
    print(`\nWARNINGS (${map.warnings.length}) — review before committing:`);
    for (const warning of map.warnings) print(`  ! ${warning}`);
  }

  print(`\nWrote ${outPath}`);
  return 0;
}

process.exit(main());
