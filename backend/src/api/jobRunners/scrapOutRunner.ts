import 'dotenv/config';
import path from 'node:path';
import { insertScrapOut, openDb, serialAlreadyScrapped } from '../../db/db.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import { writeVendorScrap } from '../../mxiWriter/writeVendorScrap.js';
import { writeInHouseScrap } from '../../mxiWriter/writeInHouseScrap.js';
import { AnthropicScrapCertProvider } from '../../scrapWriter/anthropicCertProvider.js';
import { getSecretProvider } from '../../security/secretProvider.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('scrap');

/**
 * Scrap-out runner — physically scraps parts in MXI.
 *
 * VENDOR path: reads the uploaded scrap certificate for the order number
 * and serial, then runs the full vendor-scrap sequence for that one part.
 * IN-HOUSE path: takes one or more serials directly and processes them in
 * order; there is no certificate because the scrap is PSA's own decision.
 *
 * This is the most destructive action in the whole project — irreversible
 * and NOT idempotent. Guards, none of which depend on the caller behaving:
 *   1. A vendor run refuses to proceed unless the uploaded PDF genuinely
 *      reads as a scrap certificate, with both identifiers legible.
 *   2. serialAlreadyScrapped() blocks a second successful scrap of the
 *      same serial, checked per-serial inside the loop rather than once up
 *      front — an earlier serial in the same batch can change that answer.
 *   3. Every outcome is recorded append-only, including which of the
 *      recording's intermittent steps actually fired.
 *   4. Cancellation is honoured BETWEEN serials, never mid-part: stopping
 *      halfway through one part's sequence would leave it partially
 *      processed.
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
  serialNumbers: string[];
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

  // Accepts --serials (JSON array, the normal path) or a single --serial,
  // which keeps the one-off CLI invocation used for the first live test working.
  const rawSerials = get('--serials');
  const singleSerial = get('--serial');
  let serialNumbers: string[] = [];
  if (rawSerials) {
    const parsed = JSON.parse(rawSerials) as unknown;
    if (!Array.isArray(parsed)) throw new Error('--serials must be a JSON array.');
    serialNumbers = parsed.map(String).map((s) => s.trim()).filter(Boolean);
  } else if (singleSerial) {
    serialNumbers = [singleSerial.trim()];
  }

  return {
    env,
    kind,
    certPath: get('--cert-path') ?? null,
    certFileName: get('--cert-file-name') ?? null,
    serialNumbers,
    performedBy: get('--performed-by') ?? null,
  };
}

async function main(): Promise<void> {
  const { env, kind, certPath, certFileName, serialNumbers, performedBy } = parseArgs();
  const db = openDb(path.join('data', 'audit.db'));

  const cancelSignal = watchStdinForCancellation();
  const client = await createReadyMxiClient(env);
  const password = env === 'production' ? process.env.MXI_PROD_PASSWORD : process.env.MXI_STAGE_PASSWORD;

  try {
    if (kind === 'vendor') {
      await runVendorScrap({ db, client, password: password ?? '', env, certPath, certFileName, performedBy });
    } else {
      await runInHouseScraps({ db, client, password: password ?? '', env, serialNumbers, performedBy, cancelSignal });
    }
  } finally {
    await client.shutdown();
    db.close();
  }

  emit({ type: 'done' });
}

type Db = ReturnType<typeof openDb>;
type Client = Awaited<ReturnType<typeof createReadyMxiClient>>;

async function runVendorScrap(ctx: {
  db: Db;
  client: Client;
  password: string;
  env: MxiEnv;
  certPath: string | null;
  certFileName: string | null;
  performedBy: string | null;
}): Promise<void> {
  const { db, client, password, env, certPath, certFileName, performedBy } = ctx;

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

  // Guard 1: never scrap off a document that isn't actually a certificate.
  if (!cert.isScrapCertificate) {
    emit({
      type: 'result',
      status: 'failed',
      errorMessage: `The uploaded file does not read as a scrap certificate — nothing was scrapped. ${cert.reasoningNote}`,
    });
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
    return;
  }

  emit({
    type: 'phase',
    phase: 'certificate-read',
    orderNumber: cert.orderNumber,
    serialNumber: cert.serialNumber,
    partNumber: cert.partNumber,
    vendorName: cert.vendorName,
    confidence: cert.confidence,
  });

  if (serialAlreadyScrapped(db, cert.serialNumber, env)) {
    emit({
      type: 'result',
      status: 'failed',
      orderNumber: cert.orderNumber,
      serialNumber: cert.serialNumber,
      errorMessage: `Serial ${cert.serialNumber} already has a successful scrap recorded in ${env} — not attempting it again.`,
    });
    return;
  }

  emit({ type: 'phase', phase: 'scrapping', orderNumber: cert.orderNumber, serialNumber: cert.serialNumber });
  const result = await writeVendorScrap(client, cert.orderNumber, cert.serialNumber, certPath, password);

  insertScrapOut(db, {
    kind: 'vendor',
    orderNumber: cert.orderNumber,
    serialNumber: cert.serialNumber,
    partNumber: cert.partNumber,
    vendorName: cert.vendorName,
    certFileName,
    targetEnv: env,
    status: result.status,
    stepsTaken: result.stepsTaken,
    certAttached: result.certAttached,
    locationUsed: null,
    errorMessage: result.errorMessage,
    performedBy,
  });

  emit({
    type: 'result',
    status: result.status,
    orderNumber: cert.orderNumber,
    serialNumber: cert.serialNumber,
    partNumber: cert.partNumber,
    vendorName: cert.vendorName,
    stepsTaken: result.stepsTaken,
    certAttached: result.certAttached,
    errorMessage: result.errorMessage,
  });
  log.info({ orderNumber: cert.orderNumber, serial: cert.serialNumber, status: result.status, env }, 'vendor scrap complete');
}

async function runInHouseScraps(ctx: {
  db: Db;
  client: Client;
  password: string;
  env: MxiEnv;
  serialNumbers: string[];
  performedBy: string | null;
  cancelSignal: { aborted: boolean };
}): Promise<void> {
  const { db, client, password, env, serialNumbers, performedBy, cancelSignal } = ctx;

  if (serialNumbers.length === 0) {
    emit({ type: 'fatal', message: 'At least one serial number is required for an in-house scrap.' });
    process.exitCode = 1;
    return;
  }

  emit({ type: 'phase', phase: 'scrapping', totalRequested: serialNumbers.length });

  for (const serial of serialNumbers) {
    // Guard 4: checked BETWEEN parts only. Stopping mid-sequence would
    // leave a part half-processed, which is worse than finishing it.
    if (cancelSignal.aborted) {
      log.info({ remaining: serialNumbers.length }, 'in-house scrap cancelled between serials');
      break;
    }

    // Guard 2: re-checked per serial rather than once up front — a serial
    // could legitimately have been scrapped by an earlier entry in this
    // same batch (duplicates are stripped in the UI, but not everything
    // reaches this runner through the UI).
    if (serialAlreadyScrapped(db, serial, env)) {
      emit({
        type: 'result',
        status: 'failed',
        serialNumber: serial,
        errorMessage: `Serial ${serial} already has a successful scrap recorded in ${env} — not attempting it again.`,
      });
      continue;
    }

    const result = await writeInHouseScrap(client, serial, password);

    insertScrapOut(db, {
      kind: 'in_house',
      orderNumber: null,
      serialNumber: serial,
      partNumber: null,
      vendorName: null,
      certFileName: null,
      targetEnv: env,
      status: result.status,
      stepsTaken: result.stepsTaken,
      certAttached: false,
      locationUsed: result.locationUsed,
      errorMessage: result.errorMessage,
      performedBy,
    });

    emit({
      type: 'result',
      status: result.status,
      serialNumber: serial,
      stepsTaken: result.stepsTaken,
      locationUsed: result.locationUsed,
      errorMessage: result.errorMessage,
    });
    log.info({ serial, status: result.status, env }, 'in-house scrap complete');
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ error: message }, 'scrap-out runner failed');
  emit({ type: 'fatal', message });
  process.exitCode = 1;
});
