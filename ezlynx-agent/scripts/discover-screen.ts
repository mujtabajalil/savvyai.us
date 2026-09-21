/**
 * Discover a screen's controls so a step definition can be written from
 * observation rather than guesswork.
 *
 * Navigates to a URL, optionally clicks a path of selectors to reach a screen
 * that has no URL of its own (e.g. a "new applicant" modal), then dumps every
 * form control: literal selector, kind, label, required, current value, and the
 * full option list for each dropdown.
 *
 * Read-only apart from the clicks you ask for. It never submits anything.
 *
 *   node --env-file=.env dist/scripts/discover-screen.js \
 *     --url "https://app.ezlynx.com/web/account/<id>/details" \
 *     --out discovery/applicant-details.json
 *
 *   # reach a modal by clicking, and capture each hop along the way
 *   node --env-file=.env dist/scripts/discover-screen.js \
 *     --url "https://app.ezlynx.com/web/dashboard" \
 *     --click "#new-applicant-btn" --click "text=Personal Lines" \
 *     --out discovery/new-applicant.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';
import { createLogger, print } from '../src/log/logger.js';
import { CamofoxClient } from '../src/camofox/client.js';
import {
  scanStepExpr,
  openPanelOptionsExpr,
  panelClosedExpr,
  pageBlockedExpr,
  waitForPanelExpr,
  isCssSelector,
  clickablesExpr,
  type StepScan,
  type OptionItem,
  type BlockedPage,
  type Clickable,
} from '../src/camofox/dom.js';

interface Args {
  url: string;
  clicks: string[];
  out: string;
  options: boolean;
  keepTab: boolean;
  settleMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: '', clicks: [], out: '', options: true, keepTab: false, settleMs: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--url' && next) { args.url = next; i++; }
    else if (flag === '--click' && next) { args.clicks.push(next); i++; }
    else if (flag === '--out' && next) { args.out = next; i++; }
    else if (flag === '--no-options') args.options = false;
    else if (flag === '--keep-tab') args.keepTab = true;
    else if (flag === '--settle' && next) { args.settleMs = Number(next); i++; }
  }
  return args;
}

interface Capture {
  label: string;
  url: string;
  title: string;
  controls: StepScan['controls'];
  clickables: Clickable[];
  errors: StepScan['errors'];
  carrierRequirements: string[];
}

interface Discovery {
  startUrl: string;
  clicks: string[];
  captures: Capture[];
  dropdownOptions: Record<string, string[]>;
  playwrightDialectSelectors: string[];
  notes: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    print('Usage: discover-screen --url <url> [--click <selector>]... --out <file.json> [--no-options]');
    return 2;
  }

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
    print(`\nCannot reach camofox at ${config.camofoxUrl}. Start it first.\n`);
    return 3;
  }

  const tab = await client.createTab(args.url);
  const discovery: Discovery = {
    startUrl: args.url,
    clicks: args.clicks,
    captures: [],
    dropdownOptions: {},
    playwrightDialectSelectors: [],
    notes: [],
  };

  try {
    await client.waitForPage(tab.tabId, { timeout: 30_000 });
    await sleep(args.settleMs);

    const blocked = await client.evaluate<BlockedPage>(tab.tabId, pageBlockedExpr());
    if (blocked.blocked) {
      print(`\nBlocked (${blocked.kind}): ${blocked.detail}`);
      if (blocked.kind === 'unauthorized') print('The logged-in EZLynx user cannot access that URL.');
      if (blocked.kind === 'login') print('Log in via the Camoufox window first.');
      return 4;
    }

    const capture = async (label: string): Promise<Capture> => {
      const scan = await client.evaluate<StepScan>(tab.tabId, scanStepExpr({}));
      const clickables = await client.evaluate<Clickable[]>(tab.tabId, clickablesExpr());
      const title = await client.evaluate<string>(tab.tabId, '(() => document.title)()');
      const entry: Capture = {
        label,
        url: scan.url,
        title,
        controls: scan.controls,
        clickables,
        errors: scan.errors,
        carrierRequirements: scan.carrierRequirements,
      };
      discovery.captures.push(entry);
      print(`\n[${label}] ${scan.url}`);
      print(`  title: ${title}`);
      print(`  controls: ${scan.controls.length}  (required: ${scan.controls.filter((c) => c.required).length})`);
      print(`  clickables: ${clickables.length}`);
      return entry;
    };

    const previous = await capture('initial');
    let priorClickables = previous.clickables;

    for (const [index, selector] of args.clicks.entries()) {
      print(`\nclicking: ${selector}`);
      try {
        await client.click(tab.tabId, { selector });
      } catch (err) {
        print(`  click failed: ${err instanceof Error ? err.message : String(err)}`);
        discovery.notes.push(`click "${selector}" failed: ${String(err)}`);
        break;
      }
      await client.waitForPage(tab.tabId, { timeout: 20_000 }).catch(() => undefined);
      await sleep(args.settleMs);
      const next = await capture(`after-click-${index + 1}`);

      // What a click *revealed* is the useful part when hunting an entry point.
      const key = (item: Clickable) => `${item.tag}|${item.id}|${item.text}|${item.href}`;
      const before = new Set(priorClickables.map(key));
      const revealed = next.clickables.filter((item) => !before.has(key(item)));
      priorClickables = next.clickables;

      if (revealed.length) {
        print(`  revealed ${revealed.length} new clickable(s):`);
        for (const item of revealed.slice(0, 30)) {
          print(`    <${item.tag}> ${item.selector ?? '(no id)'}  aria=${item.aria ?? '-'}  "${item.text}"  href=${item.href ?? '-'}`);
        }
      } else {
        print('  (click revealed nothing new)');
      }
    }

    const last = discovery.captures[discovery.captures.length - 1];
    if (!last) return 5;

    for (const control of last.controls) {
      if (!isCssSelector(control.selector)) discovery.playwrightDialectSelectors.push(control.selector);
    }

    // Open each dropdown once to capture its real option list.
    if (args.options) {
      const dropdowns = last.controls.filter(
        (control) => control.kind === 'mat-select' && control.visible && !control.disabled && isCssSelector(control.selector),
      );
      print(`\nreading ${dropdowns.length} dropdown option list(s)...`);

      for (const control of dropdowns) {
        try {
          await client.click(tab.tabId, { selector: control.selector });
          const panel = await client.evaluate<{ ok: boolean; options: OptionItem[] }>(
            tab.tabId,
            waitForPanelExpr(5_000, control.selector),
            { timeoutMs: 15_000 },
          );
          if (panel.ok) {
            discovery.dropdownOptions[control.selector] = panel.options.map((option) => option.text);
            print(`  ${control.selector.padEnd(46)} ${panel.options.length} options`);
          } else {
            discovery.notes.push(`${control.selector}: panel did not open`);
            print(`  ${control.selector.padEnd(46)} (panel did not open)`);
          }
        } catch (err) {
          discovery.notes.push(`${control.selector}: ${String(err)}`);
        } finally {
          await client.press(tab.tabId, 'Escape').catch(() => undefined);
          await client.evaluate<boolean>(tab.tabId, panelClosedExpr(2_500)).catch(() => undefined);
        }
      }
    }

    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(discovery, null, 2) + '\n');

    print('\n--- summary ---');
    print(`captures: ${discovery.captures.length}`);
    print(`controls on final screen: ${last.controls.length}`);
    print(`dropdowns captured: ${Object.keys(discovery.dropdownOptions).length}`);
    if (discovery.playwrightDialectSelectors.length) {
      print(`playwright-dialect selectors: ${discovery.playwrightDialectSelectors.length}`);
    }
    if (discovery.notes.length) {
      print('notes:');
      for (const note of discovery.notes) print(`  ! ${note}`);
    }
    print(`\nWrote ${outPath}`);
    print('This file contains whatever was on screen — treat it as private if the account held real client data.');
    return 0;
  } finally {
    if (!args.keepTab) await client.closeTab(tab.tabId).catch(() => undefined);
    else print(`\nTab left open: ${tab.tabId}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`discover failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
