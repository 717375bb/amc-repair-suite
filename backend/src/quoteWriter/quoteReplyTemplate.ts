import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads and renders the vendor-facing APPROVAL reply template.
 *
 * The wording itself is deliberately not in code — it is sent to real
 * vendors under a real person's name, so it lives in an editable template
 * file the user owns (templates/quote-approval-reply.html).
 *
 * There is intentionally NO deny/rejection template. Per explicit user
 * direction, a denial is a CRA's own judgement communicated by hand; this
 * tool only ever sends approvals.
 */

export const TEMPLATE_NOT_CONFIGURED_MARKER = 'CLAUDE_TEMPLATE_NOT_CONFIGURED';

const DEFAULT_TEMPLATE_PATH = path.join('templates', 'quote-approval-reply.html');

export class ReplyTemplateNotConfiguredError extends Error {}

export interface QuoteReplyFields {
  orderNumber: string;
  quoteNumber: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  price: string;
  currency: string | null;
  esd: string;
  vendorName: string | null;
  /** First name for the greeting. The caller must ensure this is non-null before rendering. */
  senderFirstName: string;
}

/**
 * Minimal HTML escaping for substituted values.
 *
 * These values come from a PDF an outside party sent us. They are
 * interpolated into an HTML email — so a vendor name or quote reference
 * containing markup must not be able to alter the message structure.
 * Low likelihood, but the cost of being wrong is a malformed or misleading
 * email going out under the user's name.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Reads the template and refuses loudly if it hasn't been filled in yet.
 *
 * This is the guard that makes it impossible for placeholder wording to
 * reach a vendor: the marker is only removed when a human writes the real
 * text, and until then every reply attempt fails with a clear instruction
 * rather than drafting something meaningless.
 */
export function loadApprovalTemplate(templatePath: string = DEFAULT_TEMPLATE_PATH): string {
  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf8');
  } catch (err) {
    throw new ReplyTemplateNotConfiguredError(
      `Could not read the approval reply template at "${templatePath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Strip HTML comments FIRST, then check for the marker.
  //
  // Order matters, and getting it wrong was a real bug: the file's own
  // instruction comment explains what the marker does, so checking the raw
  // text made a fully-configured template fail its own guard. Only the
  // marker appearing in the real BODY means "not configured".
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();

  if (body.includes(TEMPLATE_NOT_CONFIGURED_MARKER)) {
    throw new ReplyTemplateNotConfiguredError(
      `The approval reply template (${templatePath}) still contains the ` +
        `${TEMPLATE_NOT_CONFIGURED_MARKER} marker in its body — it has not been given real wording yet. ` +
        `Replace the placeholder body with the approved text and delete that marker. ` +
        `No reply will be drafted or sent until then.`,
    );
  }

  if (!body) {
    throw new ReplyTemplateNotConfiguredError(
      `The approval reply template (${templatePath}) is empty once comments are stripped — ` +
        `there is no wording to send.`,
    );
  }

  return body;
}

/**
 * Best-effort first name from an Outlook display name — the fallback when
 * the AI found no sign-off in the body.
 *
 * Real formats confirmed in the live Quotes folder: "Rowland, Brennan"
 * (Exchange last-first), "Garcia, Ana T." (last-first with a middle
 * initial), and "Alyssa Bailey" (plain first-last). Returns null rather
 * than guessing on anything else — a wrong greeting to a real vendor is
 * worse than no reply at all.
 */
export function firstNameFromDisplayName(displayName: string | null): string | null {
  if (!displayName) return null;
  const cleaned = displayName.replace(/["']/g, '').trim();
  if (!cleaned) return null;

  // "Rowland, Brennan" / "Garcia, Ana T." -> the part AFTER the comma.
  if (cleaned.includes(',')) {
    const after = cleaned.split(',')[1]?.trim() ?? '';
    const first = after.split(/\s+/)[0] ?? '';
    return isPlausibleFirstName(first) ? first : null;
  }

  // "Alyssa Bailey" -> the part BEFORE the space.
  const first = cleaned.split(/\s+/)[0] ?? '';
  return isPlausibleFirstName(first) ? first : null;
}

/**
 * Rejects things that clearly aren't a person's given name — an email
 * address, an all-caps company token, a single initial. Conservative on
 * purpose: this text is the first word a vendor reads.
 */
function isPlausibleFirstName(candidate: string): boolean {
  const value = candidate.replace(/[.]/g, '').trim();
  if (value.length < 2) return false;
  if (value.includes('@')) return false;
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(value)) return false;
  // Reject ALL-CAPS tokens longer than two letters. Real caught case:
  // "AEROREPAIR CORP" parsed as the first name "AEROREPAIR". Display names
  // for actual people are conventionally title-cased, so an all-caps token
  // is far more likely a company or a shared mailbox. Erring here only
  // costs a skipped reply, never a wrong greeting.
  if (value.length > 2 && value === value.toUpperCase()) return false;
  return true;
}

/**
 * Formats a plain amount for a human-facing email: thousands separators and
 * exactly two decimals ("3116.35" -> "3,116.35"). The template supplies the
 * "$" itself, matching the user's own wording.
 */
export function formatPriceForEmail(price: string): string {
  const numeric = Number(price);
  if (!Number.isFinite(numeric)) return price;
  return numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderApprovalReply(template: string, fields: QuoteReplyFields): string {
  const values: Record<string, string> = {
    orderNumber: fields.orderNumber,
    quoteNumber: fields.quoteNumber ?? '',
    partNumber: fields.partNumber ?? '',
    serialNumber: fields.serialNumber ?? '',
    price: fields.price,
    currency: fields.currency ?? '',
    esd: fields.esd,
    vendorName: fields.vendorName ?? '',
    senderFirstName: fields.senderFirstName,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? escapeHtml(values[key]) : match,
  );
}
