export const SHIPPING_BUFFER_DAYS = 3;
/**
 * Applied to the extracted EQD (estimated quote date) found in the vendor's
 * text — the anchor is that extracted date, NOT today's date. Models how
 * long an estimate typically takes to firm up into an actual ship date
 * after being quoted, not a fixed window measured from whenever inference
 * happens to run.
 */
export const QUOTE_BUFFER_DAYS = 25;
export const PARTS_PENDING_MIN_DAYS = 20;
export const PARTS_PENDING_MAX_DAYS = 30;
export const PARTS_PENDING_FALLBACK_DAYS = 20;
