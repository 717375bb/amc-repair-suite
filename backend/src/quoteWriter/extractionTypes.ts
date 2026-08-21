/**
 * Vendor Quote Writer — the swappable extraction seam.
 *
 * Same shape/rationale as inference/types.ts's EsdInferenceProvider: the
 * model and vendor are an implementation detail behind an interface, so a
 * dry-run provider can exercise the whole pipeline with zero API calls and
 * a different model can be swapped in without touching callers.
 */

/**
 * Why a document might not be a quote at all. Confirmed necessary by real
 * data: the first real folder sample contained a "New Receiving
 * Discrepancy" PDF and a "Shop Finding Report" sitting alongside genuine
 * quotations — one email legitimately carries several PDFs where only one
 * is the quote.
 */
export type QuoteDocumentKind = 'quote' | 'shop_finding_report' | 'other_not_a_quote';

export interface QuoteExtractionInput {
  /** Absolute path to the PDF on local disk. */
  pdfPath: string;
  /** Attachment filename — real order numbers/prices genuinely appear here. */
  fileName: string;
  /** Email subject — confirmed to very often carry the P000XXXX order number. */
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  /**
   * The email body. Real extraction input, not decoration: a confirmed
   * real message in this folder states a scrap decision only in the body
   * ("The scrap fee for P000BCSG ... is $360"), with nothing about it in
   * the attached PDF.
   */
  emailBody: string | null;
}

export interface QuoteExtractionResult {
  documentKind: QuoteDocumentKind;

  /** PSA repair order number, e.g. "P000BDY1". Null if not found anywhere. */
  orderNumber: string | null;
  /** Where the order number was actually found — real provenance, for review. */
  orderNumberSource: 'pdf_body' | 'email_subject' | 'file_name' | null;

  /** The vendor's own quote/estimate reference number, if any. */
  quoteNumber: string | null;
  vendorName: string | null;
  partNumber: string | null;
  serialNumber: string | null;

  /** Total quoted amount as a plain number (no currency symbol, no thousands separators). */
  unitPrice: number | null;
  /** ISO 4217 where determinable, e.g. "USD". */
  currency: string | null;

  /** ISO date (YYYY-MM-DD) the quote itself is dated. */
  quoteDate: string | null;
  /**
   * An explicit ship/ready/delivery date stated on the quote, ISO. Null if
   * the quote only expresses a turnaround in days.
   */
  promisedShipDate: string | null;
  /**
   * Turnaround expressed in days (e.g. "10-14 days ARO" -> 14). Null if the
   * quote states an explicit date instead. When a range is given, the
   * CONSERVATIVE (longer) end is taken — under-promising a return date to
   * the receiving side is the safer error.
   */
  leadTimeDays: number | null;

  /**
   * True when the VENDOR states the part cannot be repaired (NREP /
   * non-repairable / unserviceable / BER-declared-by-the-vendor).
   *
   * Deliberately vendor-stated only. BER (Beyond Economical Repair) is a
   * PSA-side commercial judgement made by the CRA, never something the AI
   * or the vendor decides — see quoteDisposition.ts. A vendor calling a
   * part uneconomical to repair is still recorded here as their claim, but
   * it does not make the row "BER"; only a human can do that.
   */
  vendorSaysNonRepairable: boolean;
  /** The vendor's own words supporting vendorSaysNonRepairable, verbatim. Null when false. */
  nonRepairableEvidence: string | null;

  confidence: 'high' | 'medium' | 'low';
  /** 1-2 sentence audit note. Never customer-facing. */
  reasoningNote: string;
}

export interface QuoteExtractionProvider {
  extract(input: QuoteExtractionInput): Promise<QuoteExtractionResult>;
}
