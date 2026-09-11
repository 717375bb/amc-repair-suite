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

    const popupPromise = page.waitForEvent('popup');
    popupPromise.catch(() => {});
    await page.locator('#idEditFieldScheduledLocationLink').click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    console.log('Popup URL:', popup.url());
    await popup.screenshot({ path: 'data/diag-schedule-loc-popup.png', fullPage: true });

    const cellTexts = await popup.locator('td').allInnerTexts();
    const locationLike = [...new Set(cellTexts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.includes('/') && t.length < 60))];
    console.log('LOCATION-LIKE CELLS:', JSON.stringify(locationLike, null, 2));

    await popup.close();
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
