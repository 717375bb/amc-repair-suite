import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The price-negotiation message an analyst sends to a vendor.
 *
 * TWO HALVES, deliberately separate:
 *
 *  - `renderNegotiationSeed` produces the text the app pre-fills the editor
 *    with. The wording lives in templates/quote-negotiation.html, not in
 *    code, for the same reason every other vendor-facing message here does:
 *    it goes out under a real person's name and they own the words.
 *
 *  - `negotiationBodyToHtml` turns whatever the analyst actually typed into
 *    the HTML that gets sent. What they see in the box is what goes out —
 *    this only escapes it and preserves their line breaks.
 *
 * The analyst edits between those two steps, so the template is a starting
 * point and never the final message. `<reason>` and `<new price>` are left
 * in the seed on purpose, as prompts for them to replace.
 */

const TEMPLATE_PATH = path.join('templates', 'quote-negotiation.html');

/** Used when the extraction found no legible sign-off. Never a guessed name. */
const FALLBACK_GREETING = 'there';

export class NegotiationTemplateError extends Error {}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strips tags and collapses the template to the plain text the editor shows. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text the negotiation editor opens with, with the vendor's own first
 * name filled in.
 */
export function renderNegotiationSeed(senderFirstName: string | null, templatePath: string = TEMPLATE_PATH): string {
  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf8');
  } catch (err) {
    throw new NegotiationTemplateError(
      `Could not read the negotiation template at "${templatePath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const greeting = senderFirstName?.trim() || FALLBACK_GREETING;
  return htmlToPlainText(raw).replace(/\{\{senderFirstName\}\}/g, greeting);
}

/**
 * Converts the analyst's typed plain text into the HTML actually sent.
 *
 * Escaped, so anything they type is delivered as written rather than
 * interpreted as markup, and line breaks are preserved so the message looks
 * on the vendor's screen the way it looked in the box.
 */
export function negotiationBodyToHtml(plainText: string): string {
  const paragraphs = plainText
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`);
  return paragraphs.join('\n');
}

/**
 * Whether the analyst has actually replaced the template's prompts.
 *
 * Sending "<reason>" or "<new price>" verbatim to a vendor would be
 * embarrassing and confusing, and it is an easy mistake when the editor
 * opens pre-filled. The endpoint refuses on this rather than trusting the
 * analyst to have noticed.
 */
export function findUnfilledPlaceholders(plainText: string): string[] {
  const found: string[] = [];
  for (const placeholder of ['<reason>', '<new price>']) {
    if (plainText.includes(placeholder)) found.push(placeholder);
  }
  return found;
}
