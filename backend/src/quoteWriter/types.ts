/**
 * Vendor Quote Writer — shared domain types.
 * See docs/VENDOR_QUOTE_WRITER_SPEC.md.
 */

/** One PDF attachment, already saved to the local staging directory. */
export interface QuoteAttachment {
  fileName: string;
  savedPath: string;
  sizeBytes: number;
}

/**
 * One message from the configured Outlook folder, as emitted by
 * scripts/read-outlook-quotes.ps1. Only messages with >=1 PDF appear.
 */
export interface OutlookMessage {
  /** Outlook's own stable per-message identifier — what mark-as-read later targets. */
  entryId: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  /** ISO 8601, or null if Outlook wouldn't give one up. */
  receivedTime: string | null;
  isRead: boolean;
  attachments: QuoteAttachment[];
}

export interface OutlookReadResult {
  ok: true;
  folderPath: string;
  scannedCount: number;
  messages: OutlookMessage[];
  attachmentDir: string;
}

export interface OutlookReadFailure {
  ok: false;
  error: string;
}

export type OutlookReadEnvelope = OutlookReadResult | OutlookReadFailure;
