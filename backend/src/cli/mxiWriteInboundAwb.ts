import 'dotenv/config';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { writeInboundAwb } from '../mxiWriter/awbInboundSelectors.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Direct, one-order-at-a-time smoke test for the AWB -> Inbound shipment
 * writer (awbInboundSelectors.ts) — mirrors mxiWriteEsd.ts's own pattern and
 * the same "never wired into a batch/automatic path until proven live"
 * discipline this project uses for every new writer.
 *
 * **This has never been run against real MXI.** Run it once, watched,
 * against a known stage order that has a real inbound shipment (Receipt &
 * Returns already showing a shipment record back from the vendor) before
 * trusting it for anything else — see awbInboundSelectors.ts's own
 * docstring for exactly what's proven vs. inferred so far.
 *
 * Usage: npm run mxi:write-inbound-awb -- <orderNumber> <awb> [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const orderNumber = rest[0];
  const awb = rest[1];

  if (!orderNumber || !awb) {
    log.error('Usage: npm run mxi:write-inbound-awb -- <orderNumber> <awb> [--env production]');
    process.exitCode = 1;
    return;
  }

  log.info({ env: env.toUpperCase(), orderNumber, awb }, 'Target MXI environment / write');

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    const result = await writeInboundAwb(client, orderNumber, awb);

    if (result.status === 'success') {
      log.info({ orderNumber, shipmentId: result.shipmentId, awb }, 'Write succeeded and was independently re-verified');
    } else if (result.status === 'no_inbound_shipment_found') {
      log.warn({ orderNumber }, 'No inbound shipment (Ship To .../DOCK) found for this order — nothing written');
      process.exitCode = 1;
    } else if (result.status === 'skipped') {
      log.warn({ orderNumber, shipmentId: result.shipmentId, errorMessage: result.errorMessage }, 'Skipped — not overwritten');
      process.exitCode = 1;
    } else {
      log.error({ orderNumber, shipmentId: result.shipmentId, errorMessage: result.errorMessage }, 'Write FAILED');
      process.exitCode = 1;
    }
  } catch (err) {
    log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'Smoke test failed');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
