/**
 * Open a tab in the containerised browser so the noVNC view has something to
 * show, and report whether the saved EZLynx session is still good.
 *
 *   node --env-file=.env dist/scripts/watch.js              login page
 *   node --env-file=.env dist/scripts/watch.js --url <url>  a specific page
 *
 * A headed browser with zero pages renders nothing, so noVNC shows an empty
 * desktop until a tab exists. This creates one.
 */

import { loadConfig, ConfigError } from '../src/config.js';
import { createLogger, print } from '../src/log/logger.js';
import { CamofoxClient } from '../src/camofox/client.js';
import { checkSession } from '../src/login.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      print('Configuration problem:\n');
      for (const problem of err.problems) print(`  - ${problem}`);
      return 2;
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel });
  const client = new CamofoxClient({
    baseUrl: config.camofoxUrl,
    accessKey: config.camofoxAccessKey,
    userId: config.camofoxUserId,
    sessionKey: config.camofoxSessionKey,
    timeoutMs: config.httpTimeoutMs,
    logger,
  });

  try {
    await client.health();
  } catch {
    print(`\nCannot reach camofox at ${config.camofoxUrl}.`);
    print('Start the container:  docker compose up -d --build\n');
    return 3;
  }

  const state = await checkSession(client, config.ezlynxBaseUrl, logger);
  print('');
  print(`Session for "${config.camofoxUserId}": ${state === 'authenticated' ? 'valid' : 'needs login'}`);

  const url =
    arg('--url') ??
    (state === 'authenticated'
      ? `${config.ezlynxBaseUrl}/web/dashboard`
      : `${config.ezlynxBaseUrl}/auth/account/login`);

  print(`Opening ${url} ...`);
  const tab = await client.createTab(url);

  print('');
  print('  Watch it here:  http://localhost:6080/vnc.html');
  print('');
  if (state !== 'authenticated') {
    print('  Log in through that noVNC window — you can click and type in it.');
    print('  Nothing is typed for you; MFA is never automated.');
    print('  The session is saved to the container volume and reused afterwards.');
  } else {
    print('  Already logged in. Leave this tab open and start a run in another terminal;');
    print('  you will see every field being filled on the virtual screen.');
  }
  print('');
  print(`  tab: ${tab.tabId}`);
  print('  Use your machine normally — the browser has its own display, so window');
  print('  focus on Windows does not affect it.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`watch failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
