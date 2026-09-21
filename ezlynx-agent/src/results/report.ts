/**
 * Quote comparison output: JSON plus a Markdown table sorted by combined annual
 * premium. Errors and dropped carriers are listed separately — never merged into
 * the comparison, and never silently omitted.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NormalizedQuote } from './parse.js';
import type { DroppedCarrier } from '../flow/runner.js';

export interface QuoteReport {
  accountId: string;
  generatedAt: string;
  resultsUrl: string | null;
  quotes: NormalizedQuote[];
  errors: Array<{ carrier: string; lob: string; error: string }>;
  droppedCarriers: DroppedCarrier[];
  flags: string[];
}

export function buildReport(input: {
  accountId: string;
  resultsUrl?: string | null;
  quotes: NormalizedQuote[];
  droppedCarriers: DroppedCarrier[];
  flags: string[];
  now?: Date;
}): QuoteReport {
  const errors = input.quotes
    .filter((quote) => quote.error)
    .map((quote) => ({ carrier: quote.carrier || 'unknown', lob: quote.lob, error: quote.error! }));

  const quotes = input.quotes
    .filter((quote) => !quote.error)
    .sort((a, b) => (a.annualPremium ?? Infinity) - (b.annualPremium ?? Infinity));

  return {
    accountId: input.accountId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    resultsUrl: input.resultsUrl ?? null,
    quotes,
    errors,
    droppedCarriers: input.droppedCarriers,
    flags: input.flags,
  };
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString('en-US')}`;
}

export function renderMarkdown(report: QuoteReport): string {
  const lines: string[] = [];

  lines.push(`# Quote comparison — account ${report.accountId}`);
  lines.push('');
  lines.push(`Generated ${report.generatedAt}`);
  if (report.resultsUrl) lines.push(`Source: ${report.resultsUrl}`);
  lines.push('');

  if (report.quotes.length) {
    lines.push('## Quotes');
    lines.push('');
    lines.push('| Carrier | LOB | Premium | Term | Basis | Annual | Alt quote | Badges |');
    lines.push('|---|---|--:|--:|---|--:|---|---|');
    for (const quote of report.quotes) {
      const annual = quote.annualPremium === null
        ? '—'
        : `${money(quote.annualPremium)}${quote.annualIsEstimated ? ' *' : ''}`;
      lines.push(
        `| ${quote.carrier || '—'} | ${quote.lob} | ${money(quote.premium)} | ` +
          `${quote.termMonths ?? '—'} mo | ${quote.basis ?? '—'} | ${annual} | ` +
          `${quote.altQuoteName ?? '—'} | ${quote.badges.join(', ') || '—'} |`,
      );
    }
    lines.push('');
    if (report.quotes.some((quote) => quote.annualIsEstimated)) {
      lines.push('`*` annual figure estimated by doubling a 6-month premium.');
      lines.push('');
    }

    const packages = report.quotes.filter((quote) => quote.lob === 'package' && quote.components?.length);
    if (packages.length) {
      lines.push('### Package breakdown');
      lines.push('');
      lines.push('| Carrier | Auto | Home | Combined |');
      lines.push('|---|--:|--:|--:|');
      for (const quote of packages) {
        const auto = quote.components!.find((component) => component.lob === 'auto')?.premium ?? null;
        const home = quote.components!.find((component) => component.lob === 'home')?.premium ?? null;
        lines.push(`| ${quote.carrier || '—'} | ${money(auto)} | ${money(home)} | ${money(quote.premium)} |`);
      }
      lines.push('');
    }
  } else {
    lines.push('No quotes returned.');
    lines.push('');
  }

  if (report.errors.length) {
    lines.push('## Carrier errors');
    lines.push('');
    for (const entry of report.errors) lines.push(`- **${entry.carrier}** (${entry.lob}): ${entry.error}`);
    lines.push('');
  }

  if (report.droppedCarriers.length) {
    lines.push('## Carriers dropped during the run');
    lines.push('');
    lines.push('| Carrier | LOB | Step | Reason |');
    lines.push('|---|---|---|---|');
    for (const entry of report.droppedCarriers) {
      lines.push(`| ${entry.name} | ${entry.lob} | ${entry.step} | ${entry.reason} |`);
    }
    lines.push('');
  }

  if (report.flags.length) {
    lines.push('## Flags — verify before presenting');
    lines.push('');
    for (const flag of report.flags) lines.push(`- ${flag}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function writeReport(report: QuoteReport, directory: string): { jsonPath: string; markdownPath: string } {
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const base = `${report.accountId}-${stamp}`;
  const jsonPath = join(directory, `${base}.json`);
  const markdownPath = join(directory, `${base}.md`);

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(markdownPath, renderMarkdown(report));

  return { jsonPath, markdownPath };
}

/** Pre-submission summary shown at the confirmation gate. */
export function renderSubmissionSummary(input: {
  accountId: string;
  applicantName: string;
  driverCount: number;
  vehicleCount: number;
  effectiveDate?: string;
  selectedCarriers: Array<{ lob: string; names: string[] }>;
  droppedCarriers: DroppedCarrier[];
  flags: string[];
  creditAuthorizedBy: string;
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('='.repeat(72));
  lines.push('  SUBMIT TO CARRIERS — this can trigger credit and underwriting reports');
  lines.push('='.repeat(72));
  lines.push(`  Account:        ${input.accountId}`);
  lines.push(`  Applicant:      ${input.applicantName}`);
  lines.push(`  Drivers:        ${input.driverCount}`);
  lines.push(`  Vehicles:       ${input.vehicleCount}`);
  lines.push(`  Effective date: ${input.effectiveDate ?? '(not set)'}`);
  lines.push(`  Credit auth:    ${input.creditAuthorizedBy}`);
  lines.push('');

  for (const entry of input.selectedCarriers) {
    lines.push(`  ${entry.lob.toUpperCase()} carriers (${entry.names.length}):`);
    for (const name of entry.names) lines.push(`    + ${name}`);
  }

  if (input.droppedCarriers.length) {
    lines.push('');
    lines.push(`  Dropped (${input.droppedCarriers.length}):`);
    for (const entry of input.droppedCarriers) lines.push(`    - ${entry.name} [${entry.lob}] — ${entry.reason}`);
  }

  if (input.flags.length) {
    lines.push('');
    lines.push('  Flags:');
    for (const flag of input.flags) lines.push(`    ! ${flag}`);
  }

  lines.push('');
  lines.push('='.repeat(72));
  return lines.join('\n');
}
