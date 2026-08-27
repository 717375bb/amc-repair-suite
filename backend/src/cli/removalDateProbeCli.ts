import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { PART_DETAILS_URL_MARKER } from '../writeUps/shared/partOwnDetails.js';
import { pickMostRecentRemovalEvent } from '../writeUps/shared/removalDate.js';

/**
 * `npm run diag:removal-date -- <serialNumber> [--env production]`
 *
 * Opens one part's Historical > Additional view and dumps every event row
 * it finds, so the real removal-date reader can be built against the actual
 * DOM instead of guessed at from a codegen recording.
 *
 * Built for Aerotron's requirement (2026-08-27): the Note To Vendor must
 * carry "Removal date: DD-MMM-YYYY", taken from the most recent event whose
 * NAME contains "removal" — which is not necessarily the most recent event
 * overall.
 *
 * Read-only. It searches inventory, opens the item, and switches tabs.
 * Nothing is filled, submitted, renamed, scheduled or transferred.
 */

const CLICK_DELAY_MS = 750;

function usage(): never {
  console.error('Usage: npm run diag:removal-date -- <serialNumber> [--env production]');
  console.error('  e.g. npm run diag:removal-date -- 090520025353A --env production');
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { env, rest } = parseEnvFlag(argv);
  const serialNumber = rest[0];
  if (!serialNumber) usage();

  const client = await createReadyMxiClient(env);
  try {
    const page = await client.getAuthenticatedPage();

    console.log(`\nProbing removal date for serial ${serialNumber} in ${env} (read-only)...`);

    // Inventory Search by serial — the same route writeInHouseScrap uses,
    // so this works without needing to know the part's vendor code.
    await page.goto(client.todoListUrl);
    await page.waitForTimeout(CLICK_DELAY_MS);
    await page.locator('#idMenuButton').click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await page.getByRole('link', { name: /^Unserviceable Staging Clerk\s*>/i }).click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await page.getByRole('link', { name: 'Inventory Search' }).click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await page.locator('input[name="aSerialNo_SERIAL"]').fill(serialNumber);
    await page.getByRole('link', { name: 'Search' }).click();
    await page.waitForTimeout(CLICK_DELAY_MS);

    const hit = page.getByRole('link', { name: serialNumber, exact: true });
    if ((await hit.count()) === 0) {
      console.error(`\nNo inventory item found for serial "${serialNumber}".`);
      return;
    }
    await hit.first().click();

    // Confirm we actually landed on the details page before reading tabs —
    // same discipline as the usage-table and in-house-scrap readers.
    try {
      await page.waitForFunction(
        ({ marker, sn }) =>
          window.location.href.includes(marker) &&
          document.readyState === 'complete' &&
          (document.body?.innerText ?? '').includes(sn),
        { marker: PART_DETAILS_URL_MARKER, sn: serialNumber },
        { timeout: 30_000, polling: 250 },
      );
    } catch {
      console.error(`\nNever reached the inventory details page — still on "${page.url()}".`);
      return;
    }
    console.log(`  details page: ${page.url()}`);

    // --- Historical > Additional, per discovery-find-removal-date-recording.ts ---
    for (const tab of ['Historical', 'Additional']) {
      const link = page.getByRole('link', { name: tab, exact: true });
      const count = await link.count();
      console.log(`  link "${tab}": ${count} match(es)`);
      if (count === 0) {
        console.error(`\nCould not find the "${tab}" link. Dumping what IS on the page below.`);
        break;
      }
      await link.first().click();
      await page.waitForTimeout(CLICK_DELAY_MS * 2);
      console.log(`  after "${tab}": ${page.url()}`);
    }

    // Dump every table and every plausible event row, so the real
    // structure is visible rather than inferred.
    const probe = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table')).map((t) => ({
        id: t.id || '(no id)',
        rowCount: t.querySelectorAll('tr').length,
        firstRowText: ((t.querySelector('tr') as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      }));

      // Any row carrying a DD-MMM-YYYY token is a candidate event row.
      const dateRe = /\b(\d{1,2}-[A-Za-z]{3}-\d{4})\b/;
      const rows: { tableId: string; cells: string[]; text: string }[] = [];
      for (const tr of Array.from(document.querySelectorAll('tr'))) {
        const text = (tr.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (!dateRe.test(text)) continue;
        if (tr.querySelectorAll('tr').length > 0) continue; // wrapper row
        rows.push({
          tableId: (tr.closest('table') as HTMLTableElement | null)?.id || '(no id)',
          cells: Array.from(tr.querySelectorAll(':scope > td, :scope > th')).map((c) =>
            ((c as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim(),
          ),
          text,
        });
      }
      return { tables, rows, bodyText: document.body?.innerText ?? '' };
    });

    console.log(`\n  --- tables on the page (${probe.tables.length}) ---`);
    for (const t of probe.tables) console.log(`    ${t.id.padEnd(38)} rows=${String(t.rowCount).padStart(3)}  ${t.firstRowText}`);

    console.log(`\n  --- rows carrying a DD-MMM-YYYY date (${probe.rows.length}) ---`);
    for (const r of probe.rows) {
      console.log(`    [${r.tableId}] ${JSON.stringify(r.cells)}`);
    }

    // What the real rule WOULD pick, run against what was actually found.
    const events = probe.rows.map((r) => ({ name: r.cells.join(' | '), rawDate: r.text }));
    const picked = pickMostRecentRemovalEvent(events);
    console.log(`\n  --- what the rule would choose ---`);
    console.log(`    ${picked ? `${picked.formatted}   (from: ${picked.event.name.slice(0, 90)})` : '(no row whose name contains "removal")'}`);

    const dir = path.join('data', 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, `removal-date-${serialNumber}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await fs.writeFile(`${base}.html`, await page.content(), 'utf-8');
    await fs.writeFile(
      `${base}.txt`,
      [
        `URL: ${page.url()}`,
        `Serial: ${serialNumber}`,
        '',
        '=== TABLES ===',
        ...probe.tables.map((t) => `${t.id}  rows=${t.rowCount}  ${t.firstRowText}`),
        '',
        '=== DATE-BEARING ROWS (cells) ===',
        ...probe.rows.map((r) => `[${r.tableId}] ${JSON.stringify(r.cells)}`),
        '',
        '=== FULL PAGE TEXT ===',
        probe.bodyText,
      ].join('\n'),
      'utf-8',
    );
    console.log(`\n  Saved: ${base}.txt / .png / .html`);
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
