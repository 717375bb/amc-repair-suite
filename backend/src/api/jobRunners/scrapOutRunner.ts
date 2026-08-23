import 'dotenv/config';
import path from 'node:path';
import { insertScrapOut, openDb, serialAlreadyScrapped } from '../../db/db.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import { writeVendorScrap } from '../../mxiWriter/writeVendorScrap.js';
import { writeInHouseScrap } from '../../mxiWriter/writeInHouseScrap.js';
import { AnthropicScrapCertProvider } from '../../scrapWriter/anthropicCertProvider.js';
import { getSecretProvider } from '../../security/secretProvider.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('scrap');

/**
 * Scrap-out runner — physically scraps a part in MXI.
 *
 * VENDOR path: reads the uploaded scrap certificate for the order number
 * and serial, then runs the full vendor-scrap sequence.
 * IN-HOUSE path: takes a serial directly; no certificate exists because
 * the scrap is PSA's own decision.
 *
 * This is the most destructive action in the whole project — it is
 * irreversible and NOT idempotent. Guards, none of which depend on the
 * caller behaving:
 *   1. A vendor run refuses to proceed unless the uploaded PDF genuinely
 *      reads as a scrap certificate, with both identifiers legible.
 *   2. serialAlreadyScrapped() blocks a second successful scrap of the
 *      same serial in the same environment.
 *   3. Every outcome is recorded append-only, including which of the
 *      recording's intermittent steps actually fired.
 */

interface Envelope {
  type: 'phase' | 'result' | 'fatal' | 'done';
  [key: string]: unknown;
}

function emit(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): {
  env: MxiEnv;
  kind: 'vendor' | 'in_house';
  certPath: string | null;
  certFileName: string | null;
  serialNumber: string | null;
  performedBy: string | null;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const env = get('--env');
  if (env !== 'stage' && env !== 'production') throw new Error('--env must be exactly "stage" or "production".');
  const kind = get('--kind');
  if (kind !== 'vendor' && kind !== 'in_house') throw new Error('--kind must be "vendor" or "in_house".');
  return {
    env,
    kind,
    certPath: get('--cert-path') ?? null,
    certFileName: get('--cert-file-name') ?? null,
    serialNumber: get('--serial') ?? null,
    performedBy: get('--performed-by') ?? null,
  };
}

async function main(): Promise<void> {
  const { env, kind, certPath, certFileName, serialNumber, performedBy } = parseArgs();
  const db = openDb(path.join('data', 'audit.db'));

  let orderNumber: string | null = null;
  let serial: string | null = serialNumber;
  let partNumber: string | null = null;
  let vendorName: string | null = null;

  // --- Vendor path: the certificate is the source of truth ---
  if (kind === 'vendor') {
    if (!certPath) {
      emit({ type: 'fatal', message: 'A scrap certificate is required for a vendor scrap.' });
      process.exitCode = 1;
      return;
    }
    emit({ type: 'phase', phase: 'reading-certificate' });

    const secretProvider = getSecretProvider();
    await secretProvider.init();
    const provider = new AnthropicScrapCertProvider(secretProvider.get('ANTHROPIC_API_KEY'));
    const cert = await provider.extract({ pdfPath: certPath, fileName: certFileName ?? 'certificate.pdf' });

    // Guard 1: never scrap off a document that isn't actually a cert.
    if (!cert.isScrapCertificate) {
      emit({
        type: 'result',
        status: 'failed',
        errorMessage:
          `The uploaded file does not read as a scrap certificate — nothing was scrapped. ${cert.reasoningNote}`,
      });
      emit({ type: 'done' });
      return;
    }
    if (!cert.orderNumber || !cert.serialNumber) {
      const missing = [!cert.orderNumber && 'order number', !cert.serialNumber && 'serial number']
        .filter(Boolean)
        .join(' and ');
      emit({
        type: 'result',
        status: 'failed',
        errorMessage: `The certificate is missing a legible ${missing} — refusing to guess. Nothing was scrapped.`,
      });
      emit({ type: 'done' });
      return;
    }

    orderNumber = cert.orderNumber;
    serial = cert.serialNumber;
    partNumber = cert.partNumber;
    vendorName = cert.vendorName;
    emit({
      type: 'phase',
      phase: 'certificate-read',
      orderNumber,
      serialNumber: serial,
      partNumber,
      vendorName,
      confidence: cert.confidence,
    });
  }

  if (!serial) {
    emit({ type: 'fatal', message: 'A serial number is required.' });
    process.exitCode = 1;
    return;
  }

  // Guard 2: scrapping is irreversible and not idempotent.
  if (serialAlreadyScrapped(db, serial, env)) {
    emit({
      type: 'result',
      status: 'failed',
      orderNumber,
      serialNumber: serial,
      errorMessage: `Serial ${serial} already has a successful scrap recorded in ${env} — not attempting it again.`,
    });
    emit({ type: 'done' });
    db.close();
    return;
  }

  emit({ type: 'phase', phase: 'scrapping', orderNumber, serialNumber: serial });

  const client = await createReadyMxiClient(env);
  const password = env === 'production' ? process.env.MXI_PROD_PASSWORD : process.env.MXI_STAGE_PASSWORD;

  try {
    const result =
      kind === 'vendor'
        ? await writeVendorScrap(client, orderNumber!, serial, certPath!, password ?? '')
        : await writeInHouseScrap(client, serial, password ?? '');

    const locationUsed = 'locationUsed' in result ? result.locationUsed : null;
    const certAttached = 'certAttached' in result ? result.certAttached : false;

    insertScrapOut(db, {
      kind,
      orderNumber,
      serialNumber: serial,
      partNumber,
      vendorName,
      certFileName,
      targetEnv: env,
      status: result.status,
      stepsTaken: result.stepsTaken,
      certAttached,
      locationUsed,
      errorMessage: result.errorMessage,
      performedBy,
    });

    emit({
      type: 'result',
      status: result.status,
      orderNumber,
      serialNumber: serial,
      partNumber,
      vendorName,
      stepsTaken: result.stepsTaken,
      certAttached,
      locationUsed,
      errorMessage: result.errorMessage,
    });
    log.info({ kind, orderNumber, serial, status: result.status, env }, 'scrap-out complete');
  } finally {
    await client.shutdown();
    db.close();
  }

  emit({ type: 'done' });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ error: message }, 'scrap-out runner failed');
  emit({ type: 'fatal', message });
  process.exitCode = 1;
});
