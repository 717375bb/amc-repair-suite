import 'dotenv/config';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { writeScrapPriceLines } from '../mxiWriter/writeScrapPriceLines.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Scrap pricing — one order, from the terminal.
 *
 * Exists so the first real run of a brand-new kind of production write can
 * be done deliberately and watched, per this project's standing discipline.
 * Requires --confirm before it touches anything.
 *
 * Usage:
 *   npm run scrap:price -- <orderNumber> <scrapFee> [--env stage] [--confirm]
 *
 * Without --confirm it only prints what it would do.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const confirm = rest.includes('--confirm');
  const args = rest.filter((a) => a !== '--confirm');
  const [orderNumber, scrapFee] = args;

  if (!orderNumber || !scrapFee || !Number.isFinite(Number(scrapFee))) {
    log.error('Usage: npm run scrap:price -- <orderNumber> <scrapFee> [--env stage] [--confirm]');
    process.exitCode = 1;
    return;
  }

  const password = env === 'production' ? process.env.MXI_PROD_PASSWORD : process.env.MXI_STAGE_PASSWORD;

  console.log(`\nScrap pricing for ${orderNumber} in ${env.toUpperCase()}`);
  console.log(`  new scrap line : ${Number(scrapFee).toFixed(2)}  (type SCRAP)`);
  console.log(`  original line  : zeroed to 0.00 (type SCRAP)`);
  console.log(`  charge account : copied from the original line`);
  console.log(`  promised by    : today + 2 days, on BOTH lines`);
  console.log(`  then           : authorize if required, and issue\n`);

  if (!confirm) {
    console.log('Nothing written. Re-run with --confirm to actually do this.\n');
    return;
  }

  const client = await createReadyMxiClient(env);
  try {
    const result = await writeScrapPriceLines(client, orderNumber, Number(scrapFee).toFixed(2), password ?? '');
    console.log(`\nstatus      : ${result.status.toUpperCase()}`);
    if (result.accountUsed) console.log(`account     : ${result.accountUsed}`);
    if (result.promisedBy) console.log(`promised by : ${result.promisedBy}`);
    if (result.issueDetail) console.log(`issue       : ${result.issueDetail}`);
    if (result.skipReason) console.log(`skipped     : ${result.skipReason}`);
    if (result.errorMessage) console.log(`error       : ${result.errorMessage}`);
    console.log('');
    if (result.status === 'failed') process.exitCode = 1;
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  log.error({ error: err instanceof Error ? err.message : String(err) }, 'scrap price CLI failed');
  process.exitCode = 1;
});
