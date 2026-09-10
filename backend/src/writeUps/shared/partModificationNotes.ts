/**
 * GIVEN a part whose PN is 822-1939-055 or 822-1939-005
 * WHEN composing this line's Note to Vendor
 * THEN insert "Please modify part to -55" before the times-and-cycles
 *      table — per explicit user direction (2026-09-10), applies engine-
 *      wide (any vendor), not scoped to one CRA.
 *
 * A plain per-PN map rather than a single hardcoded pair, so a future
 * addition is a one-line change here, same convention as
 * unassignedTasks.ts's UNASSIGNED_TASK_IGNORED_TYPES and
 * chargeToAccount.ts's HMV_ACCOUNT_BASES.
 */
const PART_MODIFICATION_NOTES: ReadonlyMap<string, string> = new Map([
  ['822-1939-055', 'Please modify part to -55'],
  ['822-1939-005', 'Please modify part to -55'],
]);

/** The note line to insert for this PN, or null if this part has no modification instruction. */
export function resolvePartModificationNoteLine(partNumber: string | null | undefined): string | null {
  if (!partNumber) return null;
  return PART_MODIFICATION_NOTES.get(partNumber.trim().toUpperCase()) ?? null;
}
