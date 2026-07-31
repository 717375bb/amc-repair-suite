import fs from 'node:fs/promises';
import path from 'node:path';

export const ADHOC_CONTINUATION_PROOF_FILE_PATH = path.join('data', 'aero-repair-adhoc-continuation-proof.json');

export interface AdHocContinuationProof {
  proven: true;
  env: string;
  orderNumber: string;
  partNumber: string;
  serialNumber: string;
  provenAt: string;
}

/**
 * One-time gate for the single-candidate Ad-Hoc recovery path's unproven
 * continuation (task creation is proven; the rest of the flow — Auth
 * Flow, Issue Order, Move to Dock — starting from a freshly-created
 * Ad-Hoc task is not, as of this file's creation). Durable across process
 * restarts (a file under data/, not in-memory) so the pause survives
 * between separate CLI invocations, which is the normal way this whole
 * batch flow runs.
 *
 * Scoped per-env: proving this in stage should not silently unlock
 * unattended production use, and vice versa — same reasoning as
 * eligibleLinesFile.ts's env-match safety check, since stage is already
 * documented elsewhere in this project to not reliably mirror production
 * data.
 */
export async function isAdHocContinuationProven(env: string): Promise<boolean> {
  const proof = await readProof();
  return proof !== null && proof.env === env;
}

export async function markAdHocContinuationProven(
  env: string,
  orderNumber: string,
  partNumber: string,
  serialNumber: string,
): Promise<void> {
  const proof: AdHocContinuationProof = {
    proven: true,
    env,
    orderNumber,
    partNumber,
    serialNumber,
    provenAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(ADHOC_CONTINUATION_PROOF_FILE_PATH), { recursive: true });
  await fs.writeFile(ADHOC_CONTINUATION_PROOF_FILE_PATH, JSON.stringify(proof, null, 2), 'utf-8');
}

async function readProof(): Promise<AdHocContinuationProof | null> {
  try {
    const raw = await fs.readFile(ADHOC_CONTINUATION_PROOF_FILE_PATH, 'utf-8');
    return JSON.parse(raw) as AdHocContinuationProof;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
