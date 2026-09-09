/**
 * CLAUDE_CODE_PROMPT (part NAME in write-up lines, 2026-09-10) — per
 * explicit user direction: the write-up line's description should show the
 * part's real NAME, not its part number. "The name is in the work package,
 * and it's everything between the word 'Repair' and 'PN'."
 *
 * Real example of the link text this parses:
 *   "Repair (1) LIFEVEST - CREW CRJ (PN: D21344-195, SN: L903140)"
 *                -> "LIFEVEST - CREW CRJ"
 *
 * Three deliberate details, each from real behavior in this codebase
 * rather than a guess:
 *
 * 1. EITHER leading verb is stripped, not just "Repair". A work package
 *    this suite itself renames during an in-house scrap reads
 *    "Scrap (1) …" — and REPAIR_LINK_PATTERN (vendorCodeWriteUp.ts) was
 *    deliberately broadened on 2026-08-25 to stop requiring the "Repair "
 *    prefix precisely so those lines are still found. A `^Repair `-only
 *    strip would silently leave "Scrap " in the displayed name for exactly
 *    those lines. Same two-verb handling as inHouseScrapParsing.ts.
 *
 * 2. MXI's own duplicate marker — the leading "(1)", "(2)" … — is removed,
 *    per explicit user choice. It identifies a repeated work package, not
 *    the part, so it is noise in a name column. Note the in-house scrap
 *    rename path deliberately PRESERVES it (dropping it there would stop
 *    the renamed package matching the one MXI created) — that is a
 *    different job from displaying a name, which is why this is its own
 *    function rather than a shared transform.
 *
 * 3. Returns '' rather than throwing when nothing usable is left, so every
 *    caller can apply its own fallback (part number, or the
 *    no-work-package description) with a plain `||`.
 */
const LEADING_VERB = /^(?:repair|scrap)\s+/i;
const DUPLICATE_MARKER = /^\(\d+\)\s*/;
const PN_SUFFIX = /\s*\(PN:.*$/i;

export function extractPartName(linkText: string | null | undefined): string {
  if (!linkText) return '';
  return linkText
    .trim()
    .replace(LEADING_VERB, '')
    .replace(DUPLICATE_MARKER, '')
    .replace(PN_SUFFIX, '')
    .trim();
}
