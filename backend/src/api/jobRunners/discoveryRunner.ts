import 'dotenv/config';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { discoverEligibleLines } from '../../writeUps/aeroRepair/batchDiscovery.js';
import { findCandidateLinesForVendorCode } from '../../writeUps/shared/vendorCodeWriteUp.js';
import { getVendorConfig } from '../../writeUps/shared/vendorRegistry.js';
import { AERO_REPAIR_VENDOR_ID, listVendors } from '../vendors.js';
import { discoveredLineToLogEvent, type RunLogEvent } from '../runLog.js';

/**
 * READ/WRITE BOUNDARY, ENFORCED STRUCTURALLY (carry-forward rule 6): this
 * file's only imports from the write-up modules are discoverEligibleLines
 * and findCandidateLinesForVendorCode — both pure grid reads, confirmed
 * read-only by their own docstrings ("no writes of any kind anywhere: no
 * checkbox checked, no radio selected, no order created, no edit mode
 * entered"). This file has NO import of processLine, runVendorCodeWriteUp,
 * or any other write/submit-capable function — it is incapable of reaching
 * one, not merely intended to stop before one.
 *
 * Emits one JSON line per stdout line — the job manager (parent process)
 * reads and parses these, never raw prose. Never calls saveEligibleLines/
 * saveVendorCodeEligibleLines — this job's own snapshot lives in the
 * parent's in-memory job registry, keyed by runId; touching the shared
 * handoff files the manual CLIs use would risk clobbering a human's own
 * concurrent CLI-driven daily workflow.
 */

interface DiscoveryEnvelope {
  type: 'line' | 'vendor-started' | 'done' | 'fatal';
  event?: RunLogEvent;
  vendorId?: string;
  message?: string;
}

function emit(envelope: DiscoveryEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): { env: MxiEnv; vendorIds: string[] } {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  const vendorsIdx = args.indexOf('--vendors');
  const rawEnv = envIdx >= 0 ? args[envIdx + 1] : undefined;
  const rawVendors = vendorsIdx >= 0 ? args[vendorsIdx + 1] : undefined;

  if (rawEnv !== 'stage' && rawEnv !== 'production') {
    throw new Error(`--env must be "stage" or "production", got: ${rawEnv}`);
  }
  if (!rawVendors) {
    throw new Error('--vendors is required (comma-separated vendor ids)');
  }
  return { env: rawEnv, vendorIds: rawVendors.split(',').filter(Boolean) };
}

async function runAeroRepairDiscovery(client: MxiClient, vendorDisplayName: string, seqRef: { seq: number }): Promise<void> {
  const lines = await discoverEligibleLines(client);
  for (const line of lines) {
    emit({ type: 'line', event: discoveredLineToLogEvent(seqRef.seq++, AERO_REPAIR_VENDOR_ID, vendorDisplayName, line) });
  }
}

async function runVendorCodeDiscovery(client: MxiClient, vendorId: string, vendorDisplayName: string, seqRef: { seq: number }): Promise<void> {
  const config = getVendorConfig(vendorId);
  const vendorCode = config.search.kind === 'vendorCode' ? config.search.vendorCode : vendorId;
  const page = await client.getAuthenticatedPage();
  const candidates = await findCandidateLinesForVendorCode(page, client.todoListUrl, vendorCode);

  for (const candidate of candidates) {
    emit({
      type: 'line',
      event: {
        seq: seqRef.seq++,
        timestamp: new Date().toISOString(),
        vendorId,
        vendorDisplayName,
        partNumber: candidate.partNumber,
        serialNumber: candidate.serialNumber,
        description: candidate.partNumber,
        status: 'completed', // discovery-time "found, selectable" — this family has no discovery-time exception classification
        summary: 'Ready to write up.',
      },
    });
  }
}

async function main(): Promise<void> {
  const { env, vendorIds } = parseArgs();
  const vendorList = listVendors();
  const seqRef = { seq: 0 };

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);

    for (const vendorId of vendorIds) {
      const vendorMeta = vendorList.find((v) => v.id === vendorId);
      const vendorDisplayName = vendorMeta?.displayName ?? vendorId;
      emit({ type: 'vendor-started', vendorId });

      if (vendorId === AERO_REPAIR_VENDOR_ID) {
        await runAeroRepairDiscovery(client, vendorDisplayName, seqRef);
      } else {
        await runVendorCodeDiscovery(client, vendorId, vendorDisplayName, seqRef);
      }
    }

    emit({ type: 'done' });
  } catch (err) {
    emit({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
