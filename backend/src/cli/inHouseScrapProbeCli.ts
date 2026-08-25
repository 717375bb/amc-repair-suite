import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { PART_DETAILS_URL_MARKER } from '../writeUps/shared/partOwnDetails.js';

/**
 * `npm run diag:inhouse-scrap -- <serialNumber> [--env production]`
 *
 * Walks the in-house scrap flow READ-ONLY as far as the work-package
 * check, reporting the browser's state after every step.
 *
 * Built for the 2026-08-25 report that the flow "completely shuts down the
 * MXI page after clicking the Open Work Package role and says there's no
 * work package, even though there is". Two claims there need separating
 * before anything is changed:
 *   - a page CLOSING is a specific, observable event, so this subscribes
 *     to it directly rather than inferring it from a downstream failure;
 *   - "no work package" is decided by `input[name="aCheck"]`, so this
 *     reports what that selector actually finds, alongside every link the
 *     page offers whose name contains "Open" and the real text around the
 *     work-package area.
 *
 * Stops BEFORE the first mutation. It only navigates, opens the item, and
 * switches tabs — it never renames, schedules, transfers, or enters the
 * password. Nothing is changed.
 */

const CLICK_DELAY_MS = 750;

function usage(): never {
  console.error('Usage: npm run diag:inhouse-scrap -- <serialNumber> [--env production]');
  console.error('  e.g. npm run diag:inhouse-scrap -- L903140 --env production');
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { env, rest } = parseEnvFlag(argv);
  const serialNumber = rest[0];
  if (!serialNumber) usage();

  const client = await createReadyMxiClient(env);
  const events: string[] = [];

  try {
    const page = await client.getAuthenticatedPage();
    const ctx = page.context();

    // The whole point: observe a close/crash directly instead of guessing.
    page.on('close', () => events.push(`!! MAIN PAGE CLOSED at ${new Date().toISOString()}`));
    page.on('crash', () => events.push(`!! MAIN PAGE CRASHED at ${new Date().toISOString()}`));
    page.on('popup', (p) => events.push(`>> popup opened: ${p.url()}`));
    ctx.on('page', (p) => events.push(`>> new page in context: ${p.url()}`));
    page.on('dialog', async (d) => {
      events.push(`>> dialog (${d.type()}): ${d.message()}`);
      await d.dismiss();
    });

    const report = async (label: string): Promise<void> => {
      const closed = page.isClosed();
      console.log(
        `\n[${label}]\n  url        : ${closed ? '(page closed)' : page.url()}\n` +
          `  pages in ctx: ${ctx.pages().length}   mainPageClosed=${closed}`,
      );
    };

    console.log(`\nProbing in-house scrap for serial ${serialNumber} in ${env} (read-only)...`);

    await page.goto(client.todoListUrl);
    await page.waitForTimeout(CLICK_DELAY_MS);
    await report('to-do list');

    await page.locator('#idMenuButton').click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await page.getByRole('link', { name: /^Unserviceable Staging Clerk\s*>/i }).click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await page.getByRole('link', { name: 'Inventory Search' }).click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await report('inventory search');

    await page.locator('input[name="aSerialNo_SERIAL"]').fill(serialNumber);
    await page.getByRole('link', { name: 'Search' }).click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await report('search results');

    const hit = page.getByRole('link', { name: serialNumber, exact: true });
    const hitCount = await hit.count();
    console.log(`  links named exactly "${serialNumber}": ${hitCount}`);
    if (hitCount === 0) {
      console.error('\nNo inventory hit — nothing further to probe.');
      return;
    }
    await hit.first().click();
    await page.waitForTimeout(CLICK_DELAY_MS);
    await report('after clicking the serial');

    const onDetails = page.url().includes(PART_DETAILS_URL_MARKER);
    console.log(`  on ${PART_DETAILS_URL_MARKER}: ${onDetails}`);

    // --- the two clicks the report singles out ---
    const openTab = page.getByRole('link', { name: 'Open', exact: true });
    console.log(`\n  links named exactly "Open": ${await openTab.count()}`);
    if ((await openTab.count()) > 0) {
      await openTab.first().click();
      await page.waitForTimeout(CLICK_DELAY_MS);
    }
    await report('after clicking "Open"');

    const owp = page.getByRole('link', { name: 'Open Work Packages' });
    console.log(`  links named "Open Work Packages": ${await owp.count()}`);
    if ((await owp.count()) > 0) {
      await owp.first().click();
      await page.waitForTimeout(CLICK_DELAY_MS);
    }
    await report('after clicking "Open Work Packages"');

    if (page.isClosed()) {
      console.log('\n*** The main page is CLOSED. Everything after this is unreadable. ***');
      console.log(events.join('\n'));
      return;
    }

    // --- what the real flow decides "no work package" from ---
    const probe = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const idx = bodyText.indexOf('Work Package');
      return {
        aCheckCount: document.querySelectorAll('input[name="aCheck"]').length,
        allCheckboxNames: Array.from(document.querySelectorAll('input[type="CHECKBOX" i]'))
          .map((i) => i.getAttribute('name') || '(no name)')
          .slice(0, 30),
        pnLinks: Array.from(document.querySelectorAll('a'))
          .map((a) => (a.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter((t) => /\(PN:/i.test(t)),
        openishLinks: Array.from(document.querySelectorAll('a'))
          .map((a) => (a.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter((t) => /open/i.test(t) && t.length < 60),
        aroundWorkPackage: idx >= 0 ? bodyText.slice(Math.max(0, idx - 200), idx + 600) : null,
        bodyText,
      };
    });

    console.log(`\n  input[name="aCheck"] count : ${probe.aCheckCount}   <-- 0 means "no work package"`);
    console.log(`  checkbox names on the page : ${probe.allCheckboxNames.join(', ') || '(none)'}`);
    console.log(`  links containing "(PN:"    : ${probe.pnLinks.length ? probe.pnLinks.join(' | ') : '(none)'}`);
    console.log(`  links mentioning "open"    : ${probe.openishLinks.join(' | ') || '(none)'}`);
    console.log(`\n  --- page text around "Work Package" ---`);
    console.log((probe.aroundWorkPackage ?? '(the phrase does not appear on this page)').split('\n').map((l) => '    ' + l).join('\n'));

    const dir = path.join('data', 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, `inhouse-scrap-${serialNumber}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await fs.writeFile(`${base}.html`, await page.content(), 'utf-8');
    await fs.writeFile(
      `${base}.txt`,
      [
        `URL: ${page.url()}`,
        `Serial: ${serialNumber}`,
        `input[name="aCheck"]: ${probe.aCheckCount}`,
        `checkbox names: ${probe.allCheckboxNames.join(', ')}`,
        `"(PN:" links: ${probe.pnLinks.join(' | ')}`,
        '',
        '=== BROWSER EVENTS ===',
        events.join('\n') || '(none — the page never closed, crashed, or opened a popup)',
        '',
        '=== FULL PAGE TEXT ===',
        probe.bodyText,
      ].join('\n'),
      'utf-8',
    );
    console.log(`\n  Saved: ${base}.txt / .png / .html`);

    console.log(`\n  --- browser events during the probe ---`);
    console.log(events.length ? events.map((e) => '    ' + e).join('\n') : '    (none — the page never closed, crashed, or opened a popup)');
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
