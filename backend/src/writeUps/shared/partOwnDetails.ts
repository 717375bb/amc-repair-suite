import type { Page } from 'playwright';
import { waitForBodyTextIncludes } from './taskRecovery.js';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/partDetails.ts — confirmed vendor-agnostic by
 * a second real vendor (0T1Y4's own recordings open a part's own details
 * view the identical way: check the target line's inventory checkbox,
 * click the identifier link, read, then Close). Pure relocation, no
 * behavior change — re-exported from aeroRepair/partDetails.ts so every
 * existing call site keeps working unchanged.
 */

export interface UsageParmRow {
  /** e.g. "CYCLES" | "HOURS" — as literal a label as the real page shows, not assumed to be only these two. */
  label: string;
  tsn: string;
  tso: string;
  tsi: string;
}

export interface PartOwnDetails {
  partDescription: string;
  partNumber: string;
  serialNumber: string;
  usageRows: UsageParmRow[];
  /** Full raw text of the page at the moment of reading — the reliable field for cross-checking. */
  rawText: string;
}

const USAGE_ROW_LABELS = ['CYCLES', 'HOURS'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cross-checked live: the raw candidate line reads e.g. "Inventory Details
 * WHEEL ASSY, NLG (PN: 5013640, SN: JUL14-3229)" — a page-title fragment
 * glued to the front, and the same "(PN: X, SN: Y)" segment notes
 * composition already appends on its own. Left unstripped, that segment
 * gets duplicated verbatim in composed Notes text (a real, previously
 * fixed bug) — strips both the leading page-title fragment and the
 * trailing "(PN: ..., SN: ...)" suffix, leaving just the clean part name.
 */
export function extractCleanPartDescription(
  candidateLine: string | undefined,
  partNumber: string,
  serialNumber: string,
): string {
  if (!candidateLine) return '';
  const suffixPattern = new RegExp(
    `\\s*\\(PN:\\s*${escapeRegExp(partNumber)},\\s*(?:SN|BN):\\s*${escapeRegExp(serialNumber)}\\)\\s*$`,
  );
  return candidateLine
    .replace(/^Inventory Details\s+/i, '')
    .replace(suffixPattern, '')
    .trim();
}

/**
 * Best-effort parse only. Looks for a line starting with one of the known
 * usage-parameter labels followed by whitespace-separated numeric tokens.
 */
function parseUsageRows(rawText: string): UsageParmRow[] {
  const rows: UsageParmRow[] = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    for (const label of USAGE_ROW_LABELS) {
      if (trimmed.toUpperCase().startsWith(label)) {
        const numbers = trimmed
          .slice(label.length)
          .trim()
          .split(/\s+/)
          .filter((token) => /^-?\d+(\.\d+)?$/.test(token));
        if (numbers.length >= 3) {
          rows.push({ label, tsn: numbers[0], tso: numbers[1], tsi: numbers[2] });
        }
      }
    }
  }
  return rows;
}

/**
 * Opens the part's own details view: checks the target line's inventory
 * checkbox and a vendor radio (scoped to the row matching the known-unique
 * repair-link text, if any radio is present), then clicks the identifier
 * link (serial number, or a BN value) to open the details page.
 */
export async function openPartOwnDetails(page: Page, linkText: string, identifierLinkText: string): Promise<void> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');

  await targetTr.locator('input[name="aInventory"]').check();
  await pace(page);

  const vendorRadios = targetTr.getByRole('radio');
  if ((await vendorRadios.count()) > 0) {
    await vendorRadios.first().check();
    await pace(page);
  }

  await page.getByRole('link', { name: identifierLinkText, exact: true }).click();
  await pace(page);
}

/** Closes the part-details view opened by openPartOwnDetails(). Lands back on the filtered grid. */
export async function closePartOwnDetails(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * Reads the part's own details view via direct DOM text extraction. No
 * specific container ID is assumed — reads the whole page body, matching
 * this project's rule against fabricating selectors for content not
 * directly inspected. partNumber/serialNumber are passed in from the
 * caller rather than re-parsed from this page.
 */
export async function readPartOwnDetails(
  page: Page,
  partNumber: string,
  serialNumber: string,
): Promise<PartOwnDetails> {
  await waitForBodyTextIncludes(page, serialNumber, `Part own details for ${partNumber}/${serialNumber}`);
  const rawText = await page.locator('body').innerText();

  const descriptionLine = rawText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(partNumber) && line.includes(serialNumber));

  return {
    partDescription: extractCleanPartDescription(descriptionLine, partNumber, serialNumber),
    partNumber,
    serialNumber,
    usageRows: parseUsageRows(rawText),
    rawText,
  };
}
