import 'dotenv/config';
import { createReadyMxiClient } from './src/mxiWriter/cliMxiClient.js';
import { openPinByBn } from './src/backShop/pinRouting.js';

async function main(): Promise<void> {
  const client = await createReadyMxiClient('production');
  const page = await client.getAuthenticatedPage();
  try {
    const bn = 'BN 398528';
    await openPinByBn(page, client.todoListUrl, bn);
    console.log('URL after openPinByBn:', page.url());

    const repairLinks = await page.getByRole('link', { name: /^Repair PIN/i }).evaluateAll((els) =>
      els.map((el) => el.textContent?.trim()),
    );
    console.log('REPAIR PIN LINKS:', JSON.stringify(repairLinks, null, 2));

    await page.screenshot({ path: 'data/diag-open-work-packages.png', fullPage: true });
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
