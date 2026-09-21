/**
 * Live spike: prove the mat-select driver works against a real EZLynx dropdown
 * before the rest of the agent is built on that assumption.
 *
 * Read-only by default. It opens a dropdown, reads the options, and reports what
 * it WOULD pick. Pass --set "<value>" to actually select, and --verify to assert
 * the readback. Nothing is submitted and no next-button is ever clicked.
 *
 *   node --env-file=.env dist/scripts/spike-matselect.js \
 *     --url "https://app.ezlynx.com/web/account/201601955/rating/auto/183176951/policy-info" \
 *     --selector "#priorCarrier"
 */

import { loadConfig, describeConfig, ConfigError } from '../src/config.js';
import { createLogger, print } from '../src/log/logger.js';
import { CamofoxClient } from '../src/camofox/client.js';
import { describeControl, setField } from '../src/camofox/controls.js';
import { openPanelOptionsExpr, waitForPanelExpr, panelClosedExpr, pageBlockedExpr, type OptionItem, type BlockedPage } from '../src/camofox/dom.js';
import { matchOption } from '../src/domain/match.js';
import { waitForOptional } from '../src/camofox/waits.js';

interface Args {
  url?: string;
  selector: string;
  set?: string;
  verify: boolean;
  keepTab: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { selector: '#priorCarrier', verify: false, keepTab: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--url' && next) { args.url = next; i++; }
    else if (flag === '--selector' && next) { args.selector = next; i++; }
    else if (flag === '--set' && next) { args.set = next; i++; }
    else if (flag === '--verify') args.verify = true;
    else if (flag === '--keep-tab') args.keepTab = true;
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

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
  logger.info('spike starting', describeConfig(config));

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
  } catch (err) {
    print(`\nCannot reach camofox at ${config.camofoxUrl}.`);
    print('Start it first, e.g.  CAMOFOX_INTERACTIVE=desktop npm start  (from the repo root)\n');
    logger.error('health check failed', { error: String(err) });
    return 3;
  }

  const tab = await client.createTab(args.url);
  logger.info('tab created', { tabId: tab.tabId, url: tab.url });

  try {
    await client.waitForPage(tab.tabId, { timeout: 20_000 });

    const current = await client.currentUrl(tab.tabId);
    const blocked = await client.evaluate<BlockedPage>(tab.tabId, pageBlockedExpr());

    if (blocked.blocked) {
      print('');
      if (blocked.kind === 'unauthorized') {
        print('EZLynx returned 403 Unauthorized Access for this account/quote.');
        print('The logged-in EZLynx user does not have permission for it — this is a');
        print('permissions problem, not an automation one. Either log in as a user who can');
        print('open this account, or point --url at an account this user can access.');
      } else if (blocked.kind === 'cloudflare') {
        print('Cloudflare blocked the request.');
        print('Use a full path such as /web/account/<id>/... — the bare domain gets blocked.');
      } else {
        print('Landed on the login page — the persisted session is missing or expired.');
        print('Start camofox with CAMOFOX_INTERACTIVE=desktop, log in by hand, then re-run.');
        print(`The session is saved per CAMOFOX_USER_ID ("${config.camofoxUserId}").`);
      }
      print(`\nPage said: ${blocked.detail}`);
      print(`URL: ${current}\n`);
      return 4;
    }

    // camofox's /wait only does networkidle + hydration. EZLynx's Angular shell
    // paints its form seconds later, so wait for the control itself to exist.
    const appeared = await waitForOptional(
      client,
      tab.tabId,
      { type: 'exists', selector: args.selector },
      { timeoutMs: 30_000, logger },
    );
    if (appeared === null) {
      print(`\nControl ${args.selector} never appeared within 30s on ${current}`);
      print('The page may still be loading, or the selector is wrong for this screen.');
      return 5;
    }

    const state = await describeControl(client, tab.tabId, args.selector);
    print('\n--- control ---');
    print(JSON.stringify({ ...state, label: state.label.slice(0, 80) }, null, 2));

    if (!state.found) {
      print(`\nSelector ${args.selector} matched nothing on ${current}`);
      return 5;
    }
    if (state.kind !== 'mat-select') {
      print(`\nControl is "${state.kind}", not mat-select. The spike targets mat-select specifically.`);
      return 0;
    }

    await client.click(tab.tabId, { selector: args.selector });
    const panel = await client.evaluate<{ ok: boolean; options: OptionItem[] }>(
      tab.tabId,
      waitForPanelExpr(8_000, args.selector),
      { timeoutMs: 20_000 },
    );

    print(`\n--- panel ---`);
    print(`opened: ${panel.ok}   options: ${panel.options.length}`);
    print(`withStableIds: ${panel.options.filter((o) => o.id).length}`);
    print('first 10:');
    for (const option of panel.options.slice(0, 10)) {
      print(`  [${String(option.index).padStart(3)}] id=${option.id ?? '(none)'}  "${option.text}"`);
    }

    const virtualised = await client.evaluate<boolean>(
      tab.tabId,
      '(() => !!document.querySelector(".cdk-overlay-container cdk-virtual-scroll-viewport"))()',
    );
    print(`virtualised: ${virtualised}`);

    if (args.set) {
      const texts = panel.options.map((o) => o.text);
      const match = matchOption(args.set, texts);
      print(`\n--- match "${args.set}" ---`);
      print(`tier=${match.tier} confidence=${match.confidence.toFixed(3)} index=${match.index}`);
      print(`matched: ${match.matched ?? '(none)'}`);
      if (match.candidates.length) print(`candidates: ${match.candidates.slice(0, 5).join(' | ')}`);

      if (args.verify) {
        await client.press(tab.tabId, 'Escape').catch(() => undefined);
        await client.evaluate<boolean>(tab.tabId, panelClosedExpr(3_000));

        const started = Date.now();
        const result = await setField(client, tab.tabId, args.selector, args.set, { logger });
        print(`\n--- setField ---`);
        print(JSON.stringify(result, null, 2));
        print(`elapsed: ${Date.now() - started}ms`);
      } else {
        print('\n(dry — pass --verify to actually select and read back)');
        await client.press(tab.tabId, 'Escape').catch(() => undefined);
      }
    } else {
      await client.press(tab.tabId, 'Escape').catch(() => undefined);
      const reread = await client.evaluate<OptionItem[]>(tab.tabId, openPanelOptionsExpr(args.selector));
      print(`\npanel after Escape: ${reread.length} options (expect 0)`);
    }

    print('\nSpike complete.');
    return 0;
  } finally {
    if (!args.keepTab) {
      await client.closeTab(tab.tabId).catch(() => undefined);
    } else {
      print(`\nTab left open: ${tab.tabId}`);
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`spike failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
