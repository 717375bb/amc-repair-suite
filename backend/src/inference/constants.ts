// CLAUDE_CODE_PROMPT (ESD writer changes, A3) — raised from 3 to 7, per
// explicit user direction: vendor says ESD 8/24 -> written/displayed value
// is 8/31.
export const SHIPPING_BUFFER_DAYS = 7;
/**
 * Applied to the extracted EQD (estimated quote date) found in the vendor's
 * text — the anchor is that extracted date, NOT today's date. Models how
 * long an estimate typically takes to firm up into an actual ship date
 * after being quoted, not a fixed window measured from whenever inference
 * happens to run.
 *
 * CLAUDE_CODE_PROMPT (ESD writer changes, A3) — changed from 25 to 14, per
 * explicit user direction (confirmed directly against this file's real
 * value, not the "~10 days" the originating prompt assumed).
 */
export const QUOTE_BUFFER_DAYS = 14;
export const PARTS_PENDING_MIN_DAYS = 20;
export const PARTS_PENDING_MAX_DAYS = 30;
export const PARTS_PENDING_FALLBACK_DAYS = 20;
