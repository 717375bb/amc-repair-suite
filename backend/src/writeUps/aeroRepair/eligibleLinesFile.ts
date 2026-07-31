import fs from 'node:fs/promises';
import path from 'node:path';

export const ELIGIBLE_LINES_FILE_PATH = path.join('data', 'aero-repair-eligible-lines.json');

export interface EligibleLineTarget {
  partNumber: string;
  serialNumber: string;
}

export interface EligibleLinesFile {
  generatedAt: string;
  env: string;
  lines: EligibleLineTarget[];
}

/**
 * Handoff file between batch-discovery and batch-execute: lets
 * batch-execute run with no positional args (`npm run aero-repair:batch-execute
 * -- --env production`) instead of requiring every partNumber:serialNumber
 * pair typed out by hand. Written unconditionally by batch-discovery, even
 * when the eligible count is 0 — that's a real, valid result batch-execute
 * needs to see (nothing to do), not an absent file.
 */
export async function saveEligibleLines(env: string, lines: EligibleLineTarget[]): Promise<void> {
  const contents: EligibleLinesFile = { generatedAt: new Date().toISOString(), env, lines };
  await fs.mkdir(path.dirname(ELIGIBLE_LINES_FILE_PATH), { recursive: true });
  await fs.writeFile(ELIGIBLE_LINES_FILE_PATH, JSON.stringify(contents, null, 2), 'utf-8');
}

export async function loadEligibleLines(): Promise<EligibleLinesFile | null> {
  try {
    const raw = await fs.readFile(ELIGIBLE_LINES_FILE_PATH, 'utf-8');
    return JSON.parse(raw) as EligibleLinesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
