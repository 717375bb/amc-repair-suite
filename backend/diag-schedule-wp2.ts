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

    const locationRelated = await page.locator('[id*="Location" i], [name*="Location" i]').evaluateAll((els) =>
      els.map((el) => ({
        tag: el.tagName,
        id: el.getAttribute('id'),
        name: el.getAttribute('name'),
        type: (el as HTMLInputElement).type,
        src: el.tagName === 'IMG' ? el.getAttribute('src') : undefined,
      })),
    );
    console.log('LOCATION-RELATED ELEMENTS:', JSON.stringify(locationRelated, null, 2));
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
