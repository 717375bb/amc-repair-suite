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
  | 'none';

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
