/**
 * Vendor-keyed note appended AFTER the whole composed Note To Vendor, per
 * explicit user direction (2026-09-10): "anything from BAE systems needs
 * this note written after the default note in the write up." Distinct
 * from partModificationNotes.ts's PN-keyed line, which is SPLICED INTO
 * the note (before the usage table) rather than appended at the very end
 * — two different insertion points for two different kinds of rule.
 */
const VENDOR_TRAILING_NOTES: ReadonlyMap<string, string> = new Map([
  // BAE SYSTEMS CONTROLS INC (63760) — see craAssignments.ts/vendorRegistry.ts.
  ['63760', 'PLEASE COMPLY WITH SB 73-0035, SB 73-0036, SB 73-0044, and SB 73-0045.'],
]);

export function resolveVendorTrailingNoteLine(vendorCode: string): string | null {
  return VENDOR_TRAILING_NOTES.get(vendorCode.trim().toUpperCase()) ?? null;
}

/** Appends the vendor's trailing note (if any) as its own paragraph after whatever notesText already ends with. */
export function appendVendorTrailingNote(notesText: string, vendorCode: string): string {
  const trailingNote = resolveVendorTrailingNoteLine(vendorCode);
  if (!trailingNote) return notesText;
  return `${notesText.replace(/\n+$/, '')}\n\n${trailingNote}\n`;
}
