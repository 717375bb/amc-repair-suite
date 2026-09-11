import 'dotenv/config';
import { createReadyMxiClient } from './src/mxiWriter/cliMxiClient.js';
import { openPinByBn } from './src/backShop/pinRouting.js';

async function main(): Promise<void> {
  const client = await createReadyMxiClient('production');
  const page = await client.getAuthenticatedPage();
  try {
    const bn = 'BN 398528';
    await openPinByBn(page, client.todoListUrl, bn);

    await page.getByRole('link', { name: 'Schedule Work Package' }).click();
    await page.waitForTimeout(1500);

    console.log('URL:', page.url());
    await page.screenshot({ path: 'data/diag-schedule-wp.png', fullPage: true });

    const links = await page.getByRole('link').evaluateAll((els) => els.map((el) => el.textContent?.trim()).filter(Boolean));
    console.log('LINKS:', JSON.stringify(links));
  } finally {
    // Deliberately NOT clicking anything else — read-only inspection only.
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
