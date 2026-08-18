import type { InferenceRecord } from '../types.js';

/**
 * CLAUDE_CODE_PROMPT (ESD writer changes, A4) — per explicit user
 * direction: process every vendor row with real commentary, not only
 * ESD-bearing ones.
 *
 * - 'esd_write': flag === 'ok' — a usable pushed ESD exists; write it to
 *   the ESD field and the note, then reissue (existing behavior).
 * - 'note_only_reissue': no usable ESD (flag === 'no_esd_found'), but the
 *   vendor left real commentary — append the note and reissue, but the ESD
 *   field is never touched on this branch (callers must never pass `esd`
 *   for this actionType; see writeEsdAndNotes()'s own branching, which
 *   only writes the ESD field when `update.esd` is actually set).
 * - 'skipped_no_commentary': blank/placeholder notes, or a row with no
 *   confirmed CRA-side match at all (orphaned_vendor_row/orphaned_cra_row)
 *   — never actioned. Re-issuing MXI orders for junk notes, or for orders
 *   the CRA's own open-order list doesn't confirm, has a real cost.
 *
 * Pure function of already-stored fields (flag, vendorNotes) — computed
 * identically at compare-time (UI display) and write-time (the actual MXI
 * write), so the two can never drift apart. No new DB column needed.
 */
export type RowActionType = 'esd_write' | 'note_only_reissue' | 'skipped_no_commentary';

/**
 * Known non-commentary placeholder tokens (case-insensitive, matched
 * against the trimmed full note text). Deliberately a short, explicit
 * list rather than a heuristic — extend here as new placeholders turn up
 * in real vendor data, per the prompt's own "easy to extend" ask.
 */
const PLACEHOLDER_TOKENS = new Set(['PENDING', 'OPEN']);

export function hasRealCommentary(vendorNotes: string | null): boolean {
  if (!vendorNotes) return false;
  const trimmed = vendorNotes.trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_TOKENS.has(trimmed.toUpperCase());
}

export function classifyRowAction(record: Pick<InferenceRecord, 'flag' | 'vendorNotes'>): RowActionType {
  if (record.flag === 'ok') return 'esd_write';
  if (record.flag === 'no_esd_found' && hasRealCommentary(record.vendorNotes)) return 'note_only_reissue';
  return 'skipped_no_commentary';
}
