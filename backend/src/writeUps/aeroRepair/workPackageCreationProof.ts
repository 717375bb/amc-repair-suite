import fs from 'node:fs/promises';
import path from 'node:path';

export const WORK_PACKAGE_CREATION_PROOF_FILE_PATH = path.join('data', 'aero-repair-work-package-creation-proof.json');

export interface WorkPackageCreationProof {
  proven: true;
  env: string;
  partNumber: string;
  serialNumber: string;
  workPackageName: string;
  provenAt: string;
}

/**
 * One-time gate for Addition 1 (Create Work Package), per this project's
 * standing discipline #8 ("build -> test in MXI stage if representative
 * data exists -> one closely-watched production line with independent
 * verification -> then trust") and the prompt's own explicit Sequence
 * instruction to build this addition last and prove it most carefully.
 *
 * This gate is required regardless of selector confidence — it exists
 * because this is a genuinely new WRITE path (creating real work packages
 * against live MXI) that has never run for real, not because of any
 * unresolved ambiguity. `partDetails.ts`'s createWorkPackageForLine()
 * follows the source recording (discovery-work-package-recording.ts)
 * literally, confirmed complete: the real mechanism is the `aName` field
 * committing/navigating on blur (a `Tab` press after `.fill()`), not a
 * submit click — there is no separate OK/Save link in this flow. Pausing
 * here, once per env, before letting the REST of the write-up (task-paste,
 * Schedule Work Package, Authorization, Issue, Dock) continue automatically
 * past a freshly-created work package mirrors adHocContinuationProof.ts's
 * own gate exactly — same reasoning, same durability (a data/ file, not
 * in-memory, so the pause survives across separate CLI invocations), same
 * per-env scoping (proving this in stage must not silently unlock
 * unattended production use).
 */
export async function isWorkPackageCreationProven(env: string): Promise<boolean> {
  const proof = await readProof();
  return proof !== null && proof.env === env;
}

export async function markWorkPackageCreationProven(
  env: string,
  partNumber: string,
  serialNumber: string,
  workPackageName: string,
): Promise<void> {
  const proof: WorkPackageCreationProof = {
    proven: true,
    env,
    partNumber,
    serialNumber,
    workPackageName,
    provenAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(WORK_PACKAGE_CREATION_PROOF_FILE_PATH), { recursive: true });
  await fs.writeFile(WORK_PACKAGE_CREATION_PROOF_FILE_PATH, JSON.stringify(proof, null, 2), 'utf-8');
}

async function readProof(): Promise<WorkPackageCreationProof | null> {
  try {
    const raw = await fs.readFile(WORK_PACKAGE_CREATION_PROOF_FILE_PATH, 'utf-8');
    return JSON.parse(raw) as WorkPackageCreationProof;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
