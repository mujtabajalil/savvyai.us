/**
 * Manual smoke test: a dry run against a real EZLynx account.
 *
 *   npm run ezlynx:smoke -- --account 201601955 --quote ./quote.json
 *
 * Never submits. It still creates or modifies a real quote record on the
 * account, because EZLynx saves on every "next" click — use a dummy applicant
 * where you can. Not part of `npm test`; nothing automated may hit EZLynx.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { print } from '../src/log/logger.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const account = arg('--account');
const quote = arg('--quote');
const envFile = arg('--env-file') ?? '.env';

if (!account || !quote) {
  print('Usage: npm run ezlynx:smoke -- --account <id> --quote <path> [--env-file <path>]');
  process.exit(2);
}

if (!existsSync(resolve(quote))) {
  print(`Quote file not found: ${quote}`);
  process.exit(2);
}

print('');
print('Smoke test — DRY RUN. Nothing will be submitted to any carrier.');
print('Note: every "next" click still saves the quote in EZLynx.');
print('');

const args = [
  ...(existsSync(resolve(envFile)) ? [`--env-file=${envFile}`] : []),
  resolve('dist/src/cli.js'),
  'run',
  '--account',
  account,
  '--quote',
  resolve(quote),
  '--lob',
  'auto,home',
  '--dry-run',
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
