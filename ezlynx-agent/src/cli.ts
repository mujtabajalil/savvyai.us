#!/usr/bin/env node
/**
 * ezlynx-agent CLI.
 *
 *   ezlynx-agent extract --rce ./rce.pdf --input ./client.json --out ./quote.json
 *   ezlynx-agent run --account 201601955 --quote ./quote.json --lob auto,home [--dry-run]
 *   ezlynx-agent results --url <quote-results-url>
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { loadConfig, describeConfig, ConfigError, type Config } from './config.js';
import { createLogger, print, type Logger } from './log/logger.js';
import { CamofoxClient } from './camofox/client.js';
import { DeepSeekClient } from './llm/deepseek.js';
import { extractDocumentPrompt } from './llm/prompts.js';
import { QuoteRequestSchema, DraftQuoteSchema, type QuoteRequest } from './domain/schema.js';
import { mergeQuoteSources, formatProvenance, loadDefaults, loadCarriers } from './domain/defaults.js';
import { chooseEffectiveDate } from './recovery/rules.js';
import { runStep, ReauthenticationRequired, NotAuthorized, type StepContext, type DroppedCarrier } from './flow/runner.js';
import { accountStep, createApplicantStep, applicantDetailsStep, autoSteps, homeSteps } from './flow/steps.js';
import { pruneUntilValid } from './flow/carriers.js';
import { collectResults, collectFromUrl, readSelectedCarrierNames } from './results/collect.js';
import { buildReport, writeReport, renderSubmissionSummary } from './results/report.js';
import { normalizeDate } from './domain/normalize.js';
import { checkSession, interactiveLogin } from './login.js';

const PACKAGE_ROOT = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function configOrExit(options: { requireLlm?: boolean } = {}): Config {
  try {
    return loadConfig(process.env, options);
  } catch (err) {
    if (err instanceof ConfigError) {
      print('\nConfiguration problem:\n');
      for (const problem of err.problems) print(`  - ${problem}`);
      print('\nSee .env.example. Load a file with: node --env-file=.env dist/src/cli.js ...\n');
      process.exit(2);
    }
    throw err;
  }
}

function readJson(path: string): Record<string, unknown> {
  const full = resolve(path);
  if (!existsSync(full)) {
    print(`\nFile not found: ${full}`);
    print('If you do not have a quote file yet, start from the bundled example:');
    print('  copy examples\\test-applicant.json quote.json      (Windows)');
    print('  cp examples/test-applicant.json quote.json         (POSIX)\n');
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    print(`\n${full} is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

function makeAskHuman(logger: Logger) {
  return async (question: string): Promise<string | null> => {
    print('\n' + question);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('> ');
      logger.info('operator answered', { answered: answer.trim() !== '' });
      return answer.trim() === '' ? null : answer;
    } finally {
      rl.close();
    }
  };
}

const program = new Command();
program.name('ezlynx-agent').description('EZLynx Auto + Home quoting agent').version('0.1.0');

program
  .command('extract')
  .description('Extract quote data from source documents and merge with input + defaults')
  .option('--rce <path>', 'RCE PDF or text file')
  .option('--doc <path...>', 'additional source documents')
  .option('--input <path>', 'input JSON that overrides everything extracted')
  .option('--out <path>', 'where to write the merged quote', './quote.json')
  .action(async (options: { rce?: string; doc?: string[]; input?: string; out: string }) => {
    const needsLlm = Boolean(options.rce || options.doc?.length);
    const config = configOrExit({ requireLlm: needsLlm });
    const logger = createLogger({ level: config.logLevel });

    const defaults = loadDefaults(join(PACKAGE_ROOT, 'config/defaults.json'));
    const input = options.input ? readJson(options.input) : {};
    let extracted: Record<string, unknown> = {};

    if (needsLlm) {
      const llm = new DeepSeekClient({
        apiKey: config.deepseekApiKey,
        baseUrl: config.deepseekBaseUrl,
        model: config.deepseekModel,
        logger,
      });

      const documents: Array<{ path: string; kind: 'rce' | 'dec-page' | 'notes' }> = [];
      if (options.rce) documents.push({ path: options.rce, kind: 'rce' });
      for (const path of options.doc ?? []) documents.push({ path, kind: 'notes' });

      for (const document of documents) {
        if (!existsSync(resolve(document.path))) {
          print(`Document not found: ${document.path}`);
          process.exit(2);
        }
        const text = readFileSync(resolve(document.path), 'utf8');
        if (/^%PDF/.test(text.slice(0, 5))) {
          print(`\n${document.path} looks like a binary PDF.`);
          print('Convert it to text first (e.g. `pdftotext rce.pdf rce.txt`) and pass the .txt file.');
          print('Binary PDF parsing is deliberately not bundled — see README.\n');
          process.exit(2);
        }

        logger.info('extracting document', { kind: document.kind });
        const result = await llm.complete(
          extractDocumentPrompt({
            documentText: text,
            documentKind: document.kind,
            ...(typeof input.ratingState === 'string' ? { ratingState: input.ratingState } : {}),
          }),
        );
        extracted = { ...extracted, ...(result.quote as Record<string, unknown>) };
        for (const note of result.notes) print(`  note: ${note}`);
        for (const missing of result.unresolved) print(`  missing: ${missing}`);
      }
    }

    try {
      const merged = mergeQuoteSources({
        input,
        extracted,
        defaults: defaults.quote,
        schema: DraftQuoteSchema,
      });

      // Agency ICQ answers are selector-keyed, so they merge into carrierAnswers
      // rather than into a named field.
      const icq = defaults.policy.icq ?? {};
      const quote = Object.keys(icq).length
        ? { ...merged.quote, carrierAnswers: { ...icq, ...(merged.quote.carrierAnswers ?? {}) } }
        : merged.quote;

      print('');
      print(formatProvenance(merged));
      writeFileSync(resolve(options.out), JSON.stringify(quote, null, 2) + '\n');
      print(`\nWrote ${options.out}`);
      print('Add --account when you run; the account id is not part of the quote file.');
    } catch (err) {
      print('\nThe merged quote is not valid yet:\n');
      print(String(err instanceof Error ? err.message : err));
      print('\nFill the missing fields in your input JSON and re-run.');
      print('Note: creditAuthorization has no default — it must come from the client.\n');
      process.exit(1);
    }
  });

program
  .command('run')
  .description('Fill the EZLynx rater for an account')
  .option('--account <id>', 'existing EZLynx account id (omit with --create)')
  .requiredOption('--quote <path>', 'quote JSON from `extract`')
  .option('--lob <list>', 'comma-separated: auto,home', 'auto,home')
  .option('--create', 'create a new Personal Lines applicant instead of using --account', false)
  .option('--dry-run', 'fill and validate every step but never submit', false)
  .option('--trace', 'record a Playwright trace (screenshot + DOM per action) for timing review', false)
  .option('--headed', 'assume a visible browser (informational only)', false)
  .action(async (options: { account?: string; quote: string; lob: string; create: boolean; dryRun: boolean; trace: boolean }) => {
    const config = configOrExit();
    const logger = createLogger({ level: config.logLevel });
    const lobs = options.lob.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

    if (!options.create && !options.account) {
      print('\nProvide --account <id>, or --create to make a new applicant.\n');
      process.exit(2);
    }

    // The account id does not exist yet when creating; a placeholder satisfies
    // the schema and is replaced with the real id once EZLynx assigns it.
    const accountIdForSchema = options.account ?? '0';

    let quote: QuoteRequest;
    try {
      quote = QuoteRequestSchema.parse({ ...readJson(options.quote), accountId: accountIdForSchema });
    } catch (err) {
      print('\nQuote JSON is invalid:\n');
      print(String(err instanceof Error ? err.message : err));
      process.exit(1);
      return;
    }

    if (!quote.creditAuthorization.authorized) {
      print('\nRefusing to run: creditAuthorization.authorized is false.');
      print('Submitting can trigger credit and underwriting reports; explicit client authorisation is required.\n');
      process.exit(1);
    }

    const carriers = loadCarriers(join(PACKAGE_ROOT, 'config/carriers.json'));
    const defaults = loadDefaults(join(PACKAGE_ROOT, 'config/defaults.json'));

    if (!quote.effectiveDate) {
      const chosen = chooseEffectiveDate(quote, defaults.policy.effectiveDate ?? {});
      if (chosen) {
        quote = { ...quote, effectiveDate: chosen.value };
        logger.info('effective date chosen', { reason: chosen.reason });
      }
    } else {
      quote = { ...quote, effectiveDate: normalizeDate(quote.effectiveDate) };
    }

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
      print('Start it from camofox/, e.g.  CAMOFOX_INTERACTIVE=desktop npm start\n');
      process.exit(3);
    }

    const llm = config.deepseekApiKey
      ? new DeepSeekClient({
          apiKey: config.deepseekApiKey,
          baseUrl: config.deepseekBaseUrl,
          model: config.deepseekModel,
          logger,
        })
      : undefined;
    if (!llm) logger.warn('DEEPSEEK_API_KEY not set — deterministic rules only, unknowns will ask you');

    // Check the session before starting: a quote run takes many minutes and
    // failing on step one for an expired cookie wastes all of it.
    const sessionState = await checkSession(client, config.ezlynxBaseUrl, logger);
    if (sessionState === 'login-required') {
      print('\nThe saved EZLynx session has expired — nothing was changed.');
      print('Refresh it, then re-run:');
      print('  1. restart camofox in desktop mode:  set "CAMOFOX_INTERACTIVE=desktop" && npm start');
      print('  2. node --env-file=.env dist/src/cli.js login');
      print('  3. restart camofox headless:         set "CAMOFOX_INTERACTIVE=off" && npm start');
      print('\nDevice trust is remembered, so this is usually just username + password — not MFA.\n');
      process.exit(4);
    }

    const startUrl = options.create
      ? `${config.ezlynxBaseUrl}/web/account/create/personal`
      : `${config.ezlynxBaseUrl}/web/account/${options.account}/details`;

    let accountId = options.account ?? '(pending)';

    const tab = await client.createTab(startUrl, { trace: options.trace });
    if (options.trace) logger.info('tracing enabled; the trace is written when the session closes');
    const context: StepContext = {
      client,
      tabId: tab.tabId,
      quote,
      logger,
      recovery: { ...(llm ? { llm } : {}), logger, askHuman: makeAskHuman(logger) },
      dryRun: options.dryRun,
      droppedCarriers: [],
      flags: [],
    };

    const exitCode = await (async (): Promise<number> => {
      try {
        await client.waitForPage(tab.tabId, { timeout: 30_000 });

        // Creating goes through two screens: the create form saves and lands on
        // the account's details page, and the rater is entered from there.
        // "Go to auto" is a silent no-op until the account actually exists.
        const definitions = [
          ...(options.create ? [createApplicantStep(lobs), applicantDetailsStep(lobs)] : [accountStep]),
          ...(lobs.includes('auto') ? autoSteps() : []),
          ...(lobs.includes('home') ? homeSteps() : []),
        ];

        for (const definition of definitions) {
          logger.info('step', { id: definition.id, title: definition.title });
          const result = await runStep(definition, context);

          // EZLynx assigns the account id on save, but the SPA route changes a
          // moment after the click returns — poll rather than reading once.
          if (definition.id === 'account/create' && result.advanced) {
            let created: string | undefined;
            const deadline = Date.now() + 45_000;
            let lastUrl = '';
            while (Date.now() < deadline) {
              lastUrl = await client.currentUrl(tab.tabId).catch(() => lastUrl);
              created = lastUrl.match(/\/web\/account\/(\d+)\//)?.[1];
              if (created) break;
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            }

            if (!created) {
              logger.warn('no account id in the URL after save', { url: lastUrl.replace(/\/\d{6,}/g, '/{id}') });
            }
            if (created) {
              accountId = created;
              context.quote = { ...context.quote, accountId: created };
              print(`\nCreated applicant — account ${created}`);
              logger.info('applicant created', { accountId: created });
            } else {
              print('\nThe save button was clicked but EZLynx never navigated to an account page.');
              print(`Last URL seen: ${lastUrl || '(unknown)'}`);
              print('Either the save was rejected, or the page is still loading. Check the browser.');
              return 1;
            }
          }

          if (result.errors.length) {
            print(`\nStep ${definition.id} could not be completed:`);
            for (const error of [...new Set(result.errors)]) print(`  - ${error}`);

            // A step that never advanced leaves the browser on the wrong page,
            // so every later step fails for an unrelated reason. Stop here even
            // in a dry run rather than emit a misleading cascade.
            if (!result.advanced) {
              print(`\nStopped: the run is still on "${definition.id}" and cannot continue.`);
              return 1;
            }
            if (!options.dryRun) return 1;
          }

          if (definition.id.endsWith('/finish')) {
            const lob = definition.id.startsWith('home') ? 'home' : 'auto';
            const prune = await pruneUntilValid({
              client,
              tabId: tab.tabId,
              lob,
              logger,
              goToRating: async () => {
                await client.navigate(
                  tab.tabId,
                  `${config.ezlynxBaseUrl}/web/account/${accountId}/rating/${lob}/${await currentQuoteId(client, tab.tabId)}/rating`,
                );
                await client.waitForPage(tab.tabId, { timeout: 20_000 });
              },
              goToFinish: async () => {
                await client.navigate(
                  tab.tabId,
                  `${config.ezlynxBaseUrl}/web/account/${accountId}/rating/${lob}/${await currentQuoteId(client, tab.tabId)}/finish`,
                );
                await client.waitForPage(tab.tabId, { timeout: 20_000 });
              },
            });
            context.droppedCarriers.push(...prune.dropped);
            if (prune.restored.length) {
              logger.info('carriers restored after proving innocent', { carriers: prune.restored });
            }
            if (!prune.valid) {
              print(`\n${lob} finish step is still invalid. Dropped: ${prune.dropped.map((d) => d.name).join(', ') || 'none'}`);
              if (!options.dryRun) return 1;
            }
          }
        }

        if (options.dryRun) {
          print('\nDry run complete — nothing was submitted.');
          printDropped(context.droppedCarriers, context.flags);
          return 0;
        }

        const selected = await readSelectedCarrierNames(client, tab.tabId);
        print(
          renderSubmissionSummary({
            accountId,
            applicantName: `${quote.applicant.firstName} ${quote.applicant.lastName}`,
            driverCount: quote.drivers.length,
            vehicleCount: quote.vehicles.length,
            ...(quote.effectiveDate ? { effectiveDate: quote.effectiveDate } : {}),
            selectedCarriers: [{ lob: lobs.join('+'), names: selected }],
            droppedCarriers: context.droppedCarriers,
            flags: context.flags,
            creditAuthorizedBy: `${quote.creditAuthorization.obtainedFrom} on ${quote.creditAuthorization.obtainedOn}`,
          }),
        );

        if (config.requireSubmitConfirmation && !(await confirm('Submit to carriers?'))) {
          print('Aborted — nothing submitted.');
          return 0;
        }

        await client.click(tab.tabId, { selector: '#submit-to-carriers-btn' });
        await client.waitForPage(tab.tabId, { timeout: 30_000 });
        await client.click(tab.tabId, { selector: '#submit-carriers-btn' }).catch(() => undefined);
        await client.waitForPage(tab.tabId, { timeout: 60_000 });

        const collected = await collectResults({
          client,
          tabId: tab.tabId,
          quote,
          logger,
          recovery: context.recovery,
        });

        const report = buildReport({
          accountId,
          resultsUrl: await client.currentUrl(tab.tabId),
          quotes: collected.quotes,
          droppedCarriers: [...context.droppedCarriers, ...collected.droppedCarriers],
          flags: [...context.flags, ...collected.flags],
        });

        const written = writeReport(report, join(PACKAGE_ROOT, 'results'));
        print(`\nWrote ${written.jsonPath}`);
        print(`Wrote ${written.markdownPath}`);
        return 0;
      } catch (err) {
        if (err instanceof NotAuthorized) {
          print(`
${err.message}
`);
          return 5;
        }
        if (err instanceof ReauthenticationRequired) {
          print(`\n${err.message}\n`);
          return 4;
        }
        logger.error('run failed', { error: err instanceof Error ? err.message : String(err) });
        print(`\nRun failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      } finally {
        await client.closeTab(tab.tabId).catch(() => undefined);

        if (options.trace) {
          // Tracing is flushed when the session closes, not the tab.
          await client.destroySession().catch(() => undefined);
          const traces = await client.listTraces().catch(() => null);
          const newest = traces?.traces?.[traces.traces.length - 1];
          print('');
          if (newest) {
            print(`Trace: ${config.camofoxUrl}/sessions/${config.camofoxUserId}/traces/${newest.filename}`);
            print('Download it, then open at https://trace.playwright.dev — every action has a');
            print('screenshot, a DOM snapshot and a timing.');
          } else {
            print(`Traces: ${config.camofoxUrl}/sessions/${config.camofoxUserId}/traces`);
          }
        }
      }
    })();

    process.exit(exitCode);
  });

program
  .command('login')
  .description('Open the EZLynx login page and save the session for later headless runs')
  .option('--check', 'only report whether the saved session is still valid', false)
  .action(async (options: { check: boolean }) => {
    const config = configOrExit();
    const logger = createLogger({ level: config.logLevel });

    const client = new CamofoxClient({
      baseUrl: config.camofoxUrl,
      accessKey: config.camofoxAccessKey,
      userId: config.camofoxUserId,
      sessionKey: config.camofoxSessionKey,
      timeoutMs: config.httpTimeoutMs,
      logger,
    });

    const state = await checkSession(client, config.ezlynxBaseUrl, logger);

    if (state === 'unreachable') {
      print(`\nCannot reach camofox at ${config.camofoxUrl}. Start it first.\n`);
      process.exit(3);
    }
    if (state === 'authenticated') {
      print(`\nSession for "${config.camofoxUserId}" is valid — no login needed.\n`);
      process.exit(0);
    }

    print(`\nSession for "${config.camofoxUserId}" has expired.`);
    if (options.check) {
      print('Run `ezlynx-agent login` (with camofox in desktop mode) to refresh it.\n');
      process.exit(1);
    }

    const ok = await interactiveLogin({
      client,
      ezlynxBaseUrl: config.ezlynxBaseUrl,
      logger,
      print,
    });
    process.exit(ok ? 0 : 1);
  });

program
  .command('results')
  .description('Parse an existing quote-results page')
  .requiredOption('--url <url>', 'quote results URL')
  .option('--account <id>', 'account id for the report filename')
  .action(async (options: { url: string; account?: string }) => {
    const config = configOrExit();
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
      const quotes = await collectFromUrl(client, options.url, logger);
      const accountId = options.account ?? options.url.match(/\/account\/(\d+)\//)?.[1] ?? 'unknown';
      const report = buildReport({
        accountId,
        resultsUrl: options.url,
        quotes,
        droppedCarriers: [],
        flags: [],
      });
      const written = writeReport(report, join(PACKAGE_ROOT, 'results'));
      print(`\nWrote ${written.jsonPath}`);
      print(`Wrote ${written.markdownPath}`);
    } catch (err) {
      print(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

function printDropped(dropped: DroppedCarrier[], flags: string[]): void {
  if (dropped.length) {
    print('\nCarriers dropped:');
    for (const entry of dropped) print(`  - ${entry.name} [${entry.lob}] at ${entry.step}: ${entry.reason}`);
  }
  if (flags.length) {
    print('\nFlags:');
    for (const flag of flags) print(`  ! ${flag}`);
  }
}

async function currentQuoteId(client: CamofoxClient, tabId: string): Promise<string> {
  const url = await client.currentUrl(tabId);
  return url.match(/\/rating\/(?:auto|home)\/(\d+)\//)?.[1] ?? '';
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
