/**
 * Scrap certificate extraction — the vendor-scrap path's input.
 *
 * A scrap cert ("Scrap Certification / Notice of Destruction") is what a
 * vendor sends after physically destroying a part. It carries the two
 * identifiers the MXI flow needs: our order number (their "Customer PO")
 * and the part's serial number, which is what the Receipt & Returns step
 * clicks on.
 */
export interface ScrapCertExtraction {
  /** True only if this really is a scrap certificate. */
  isScrapCertificate: boolean;
  /** PSA repair order number — the cert's "Customer PO". */
  orderNumber: string | null;
  /** Serial number of the scrapped part. Used to select it in Receipt & Returns. */
  serialNumber: string | null;
  partNumber: string | null;
  vendorName: string | null;
  /** The vendor's own reference (e.g. "Barfield RO: WOP1134279"). */
  vendorReference: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoningNote: string;
}

export interface ScrapCertInput {
  pdfPath: string;
  fileName: string;
}

export interface ScrapCertProvider {
  extract(input: ScrapCertInput): Promise<ScrapCertExtraction>;
}
