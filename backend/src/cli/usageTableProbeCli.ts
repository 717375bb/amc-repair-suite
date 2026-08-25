import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { findCandidateLinesForVendorCode } from '../writeUps/shared/vendorCodeWriteUp.js';
import { openPartOwnDetails, closePartOwnDetails } from '../writeUps/shared/partOwnDetails.js';

/**
 * `npm run diag:usage-table -- <vendorCode> [serialNumber] [--env production]`
 *
 * Reproduces ONE line's part-details open, exactly the way the write-up
 * does it, and dumps what the page actually contains. Built for the
 * 2026-08-25 report that every non-BN vendor-code line came back
 * "Expected to find times and cycles but no table was there" on pages
 * where the table is plainly visible.
 *
 * The first fix that session was wrong, or at least incomplete: it assumed
 * the details page had not finished loading. The re-run disproved that —
 * the writer now reaches InventoryDetails.jsp and STILL finds no
 * `#idTableCurrentUsage`, so the element really is missing from the page
 * being read. What this tool answers is which page that actually is.
 *
 * Read-only with respect to MXI data. It ticks the row's inventory
 * checkbox and vendor radio, which is what opening a part's details
 * requires and what the write-up already does, and it clicks Close when
 * done. Nothing is filled, submitted, authorized, issued or docked.
 */

function usage(): never {
  console.error('Usage: npm run diag:usage-table -- <vendorCode> [serialNumber] [--env production]');
  console.error('  e.g. npm run diag:usage-table -- 0t1y4 --env production');
  console.error('       npm run diag:usage-table -- 21844 1280 --env production');
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { env, rest: positional } = parseEnvFlag(argv);
  const vendorCode = positional[0];
  const wantedSerial = positional[1];
  if (!vendorCode) usage();

  const client = await createReadyMxiClient(env);
  try {
    const page = await client.getAuthenticatedPage();

    console.log(`\nSearching vendor ${vendorCode} in ${env}...`);
    const candidates = await findCandidateLinesForVendorCode(page, client.todoListUrl, vendorCode);
    console.log(`${candidates.length} candidate line(s):`);
    for (const c of candidates) {
      console.log(`  PN=${c.partNumber}  SN=${c.serialNumber}  isBnLine=${c.isBnLine}  linkText="${c.linkText}"`);
    }

    // Default to the first NON-BN line, since a BN line legitimately has no
    // usage table and would prove nothing here.
    const candidate = wantedSerial
      ? candidates.find((c) => c.serialNumber === wantedSerial)
      : candidates.find((c) => !c.isBnLine);
    if (!candidate) {
      console.error(`\nNo ${wantedSerial ? `line with serial "${wantedSerial}"` : 'non-BN line'} found for ${vendorCode}.`);
      return;
    }

    console.log(`\nOpening part details for ${candidate.partNumber} / ${candidate.serialNumber} ...`);
    console.log(`  grid URL before: ${page.url()}`);
    await openPartOwnDetails(page, candidate.linkText, candidate.serialNumber);
    console.log(`  URL after open : ${page.url()}`);

    const probe = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const idx = bodyText.indexOf('Current Usage');
      return {
        usageTablePresent: !!document.querySelector('#idTableCurrentUsage'),
        usageTableText: (document.querySelector('#idTableCurrentUsage') as HTMLElement | null)?.innerText ?? null,
        hasCurrentUsageHeading: idx >= 0,
        aroundHeading: idx >= 0 ? bodyText.slice(idx, idx + 500) : null,
        tableIds: Array.from(document.querySelectorAll('table')).map((t) => t.id || '(no id)'),
        // The page's OWN identity — the only way to tell "this part has no
        // usage" apart from "we opened a different record than we meant to".
        firstLines: bodyText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 25),
        bodyText,
      };
    });

    console.log(`\n  #idTableCurrentUsage present : ${probe.usageTablePresent}`);
    console.log(`  "Current Usage" heading      : ${probe.hasCurrentUsageHeading}`);
    console.log(`\n  --- page identity (first lines) ---`);
    probe.firstLines.forEach((l) => console.log(`    ${l}`));
    if (probe.usageTableText) {
      console.log(`\n  --- usage table text ---\n${probe.usageTableText.split('\n').map((l) => '    ' + l).join('\n')}`);
    }
    if (probe.aroundHeading) {
      console.log(`\n  --- text at the "Current Usage" heading ---`);
      probe.aroundHeading.split('\n').forEach((l) => console.log(`    ${l}`));
    }
    console.log(`\n  --- table ids on the page (${probe.tableIds.length}) ---`);
    console.log(`    ${probe.tableIds.join(', ')}`);

    const dir = path.join('data', 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `usage-probe-${candidate.partNumber}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await fs.writeFile(
      `${base}.txt`,
      [
        `URL: ${page.url()}`,
        `Requested: ${candidate.partNumber} / ${candidate.serialNumber} (isBnLine=${candidate.isBnLine})`,
        `#idTableCurrentUsage present: ${probe.usageTablePresent}`,
        `"Current Usage" heading present: ${probe.hasCurrentUsageHeading}`,
        `Table ids: ${probe.tableIds.join(', ')}`,
        '',
        '=== FULL PAGE TEXT ===',
        probe.bodyText,
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(`${base}.html`, await page.content(), 'utf-8');
    console.log(`\n  Saved: ${base}.txt / .png / .html`);

    await closePartOwnDetails(page);
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
