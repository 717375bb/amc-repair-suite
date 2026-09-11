export interface VendorOorRow {
  orderNumber: string;
  createDate: string | null;
  vendorName: string | null;
  partDescription: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  outboundAwb: string | null;
  roEsd: string | null;
  currentStatus: string | null;
  vendorNotes: string | null;
}

export interface CraOorRow {
  orderNumber: string;
  createDate: string | null;
  tat: string | null;
  vendorName: string | null;
  partDescription: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  orderStatus: string | null;
  mxiRoEsd: string | null;
  notes: string | null;
}

export interface VendorAssignmentRow {
  vendorCode: string | null;
  vendorName: string | null;
  certificateNumber: string | null;
  cra: string | null;
  craEmail: string | null;
}

export type MatchFlag = 'ok' | 'orphaned_vendor_row' | 'orphaned_cra_row';

export interface MatchedOrder {
  orderNumber: string;
  vendor: VendorOorRow | null;
  cra: CraOorRow | null;
  flag: MatchFlag;
  craOwnerName: string | null;
  craOwnerEmail: string | null;
}

export type EsdClassification =
  | 'explicit_date'
  | 'vendor_quote_estimate'
  | 'parts_pending'
  | 'not_esd_relevant'
  | 'quote_sent_reference'
  | 'none'
  /**
   * CRA OOR's own Order Status says the part has already been received
   * back — see inference/statusRules.ts's isOrderStatusReceived(). Set
   * deterministically, before Step 1, never by the AI — no AI call is made
   * at all for a row that hits this rule, same "don't call the AI when a
   * deterministic answer already exists" discipline Step 1's explicit_date
   * check already uses.
   */
  | 'order_received';

/**
 * `inference_unavailable` added 2026-08-28. It means the AI could not be
 * reached at all, and it is deliberately NOT folded into `no_esd_found`:
 * that flag is a statement about the vendor's notes, and using it for a
 * failed request tells the analyst something untrue about the order. Run 31
 * had 241 orders in exactly that state (corporate TLS inspection breaking
 * the API call) presented as though their notes had been read and found
 * empty.
 */
export type EsdFlag =
  | 'ok'
  | 'no_esd_found'
  | 'inference_unavailable'
  | 'orphaned_vendor_row'
  | 'orphaned_cra_row';

export interface InferenceRecord {
  orderNumber: string;
  vendorName: string | null;
  roEsdRaw: string | null;
  mxiEsdRaw: string | null;
  currentStatus: string | null;
  vendorNotes: string | null;
  orderStatus: string | null;
  /**
   * CLAUDE_CODE_PROMPT (AWB -> Inbound shipment, 2026-09-09) — the
   * OUTBOUND AWB read straight off the vendor's own report column (what WE
   * gave the vendor). Per explicit user correction (2026-09-10), this is
   * NOT what should display or get written as the inbound shipment's own
   * AWB — see inboundAwb below for that. Kept for its own sake (still a
   * real value from the report), just no longer the review table's AWB
   * display.
   */
  outboundAwb: string | null;
  /**
   * CLAUDE_CODE_PROMPT (AWB -> Inbound shipment, correction, 2026-09-10) —
   * per explicit user direction: "I wanted the AWB's to display from the
   * vendor in Vendor Notes, only if present. Any string of 12 numbers and
   * the keyword 'AWB' means that string of numbers should be written into
   * the inbound shipment line." Derived from vendorNotes via
   * inference/inboundAwb.ts's resolveInboundAwbFromNotes — the vendor's
   * OWN stated AWB for shipping the part back to us, which is what
   * actually belongs on the inbound shipment (mxiWriter/
   * awbInboundSelectors.ts's writeInboundAwb). Null when absent OR when
   * more than one distinct 12-digit candidate was found near "AWB" in the
   * notes (see inboundAwbAmbiguous) — never guessed between them.
   */
  inboundAwb: string | null;
  /** True when vendorNotes contained two or more DIFFERENT 12-digit numbers each plausibly tied to "AWB" — inboundAwb is null in this case specifically because of the ambiguity, not because nothing was found. */
  inboundAwbAmbiguous: boolean;
  classification: EsdClassification | null;
  extractedBaseDate: string | null;
  bufferDaysApplied: number | null;
  usedFallback: boolean;
  confidence: 'high' | 'medium' | 'low' | null;
  reasoningNote: string | null;
  inferredEsd: string | null;
  flag: EsdFlag;
  deltaDaysVsMxi: number | null;
  aiCallMade: boolean;
}

/**
 * Deliberately does NOT include per-classification or per-flag counts
 * (explicit_date/vendor_quote_estimate/.../no_esd_found/past_date_rejected)
 * — those overlap (classification counts span every flag; no_esd_found and
 * past_date_rejected are subsets of each other), so summing them never
 * equals `processed` and looks like a data bug when it isn't. For a real,
 * mutually exclusive breakdown, compute it directly from the records'
 * (flag, classification) pairs — see cli.ts's printFlagClassificationCrossTab.
 */
export interface RunSummary {
  processed: number;
  matched: number;
  orphanedVendor: number;
  orphanedCra: number;
  aiCallsMade: number;
  aiFallbackUsed: number;
}
