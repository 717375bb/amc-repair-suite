/**
 * Detects a vendor-supplied INBOUND AWB (the shipment bringing the part
 * back FROM the vendor) inside the free-text Vendor Notes field. Per
 * explicit user direction (2026-09-10): "Any string of 12 numbers and the
 * keyword 'AWB' means that string of numbers should be written into the
 * inbound shipment line." This is a different value from the "Outbound
 * AWB" column already read off the vendor's own report (outboundAwb on
 * InferenceRecord) — that one is what WE gave the vendor; this is what the
 * vendor is giving back to us, which is what actually belongs on the
 * inbound shipment (see mxiWriter/awbInboundSelectors.ts's writeInboundAwb).
 */

/**
 * A run of exactly 12 digits, not itself part of a longer digit run (so a
 * 13+ digit number never gets truncated into a false 12-digit match), that
 * appears within a short window of the literal word "AWB" on either side.
 * The window (30 non-digit characters) covers ordinary phrasings like
 * "AWB# 123456789012", "AWB NUMBER: 123456789012", and
 * "shipped via AWB 123456789012" without also picking up an unrelated
 * 12-digit number (a PO number, a tracking ID) that merely happens to
 * appear elsewhere in a longer notes field with no real connection to AWB.
 */
const INBOUND_AWB_PATTERN =
  /AWB[^\d]{0,30}(?<!\d)(\d{12})(?!\d)|(?<!\d)(\d{12})(?!\d)[^\d]{0,30}AWB/gi;

export interface InboundAwbDetection {
  /** The single detected 12-digit AWB, or null if none (or more than one distinct candidate) was found. */
  awb: string | null;
  /** True when the text contains two or more DIFFERENT 12-digit numbers each plausibly tied to "AWB" — never guessed between them. */
  ambiguous: boolean;
}

/**
 * Scans vendorNotes for the AWB pattern above. Returns null (not a guess)
 * when nothing matches, and flags `ambiguous` rather than picking
 * arbitrarily when more than one DISTINCT 12-digit candidate is found —
 * writing the wrong AWB into a real MXI inbound shipment is worse than not
 * writing one at all.
 */
export function resolveInboundAwbFromNotes(vendorNotes: string | null | undefined): InboundAwbDetection {
  if (!vendorNotes) return { awb: null, ambiguous: false };

  const candidates = new Set<string>();
  for (const match of vendorNotes.matchAll(INBOUND_AWB_PATTERN)) {
    const digits = match[1] ?? match[2];
    if (digits) candidates.add(digits);
  }

  if (candidates.size === 0) return { awb: null, ambiguous: false };
  if (candidates.size > 1) return { awb: null, ambiguous: true };
  return { awb: [...candidates][0], ambiguous: false };
}
