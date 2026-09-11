import { parseBackShopListing } from './src/backShop/backShopListingParser.js';
import { isPinPartNumber } from './src/backShop/pinRouting.js';

async function main(): Promise<void> {
  const path = 'C:/Users/717375/American Airlines, Inc/CRA - CRA Team/BackShopListing.xlsm';
  const result = await parseBackShopListing(path);
  const pins = result.rows.filter((r) => isPinPartNumber(r.partNumber));
  console.log(`Found ${pins.length} pin rows out of ${result.rows.length} total.`);
  for (const p of pins) {
    console.log(JSON.stringify(p));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
