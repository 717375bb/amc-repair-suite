import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logging/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('quote');

const FORWARD_TIMEOUT_MS = 90 * 1000;

/**
 * PSA's warranty department.
 *
 * FIXED HERE, SERVER-SIDE, and deliberately not a parameter the browser can
 * supply — the same rule the Maintenance Records draft follows. A recipient
 * the client could choose would turn one button into an arbitrary
 * mail-sending endpoint on a machine holding real MXI credentials.
 */
export const WARRANTY_DEPARTMENT_EMAIL = 'psa-warranty@oliverwyman.com';

export type ForwardMode = 'draft' | 'send';

export interface ForwardResult {
  ok: boolean;
  mode: ForwardMode | null;
  subject: string | null;
  recipients: string[];
  /** Whether Outlook resolved the address. An unresolved send silently fails to deliver. */
  resolved: boolean;
  /** How many attachments travelled with it — the quote PDF is the point. */
  attachmentCount: number | null;
  error: string | null;
}

interface Envelope {
  ok: boolean;
  mode?: string;
  subject?: string;
  recipients?: string[];
  resolved?: boolean;
  attachmentCount?: number;
  error?: string;
}

/** Last JSON line wins — PowerShell can emit diagnostics around it. */
function parseEnvelope(stdout: string): Envelope | null {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as Envelope;
    } catch {
      /* not this line */
    }
  }
  return null;
}

/**
 * Forwards one quote email — attachments included — to the warranty
 * department.
 *
 * Never throws. A forward is a side errand from reviewing a quote; a
 * failure here must be reported, not allowed to take down the review.
 *
 * `mode` is passed explicitly by the caller rather than read from
 * QUOTE_REPLY_MODE, because forwarding internally to a PSA distribution
 * list is a different act from replying to an outside vendor and should not
 * be governed by the same switch.
 */
export async function forwardToWarrantyDepartment(
  entryId: string,
  bodyHtml: string | null,
  mode: ForwardMode,
): Promise<ForwardResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'quote-forward-'));
  const bodyPath = path.join(dir, 'body.html');

  const failure = (error: string): ForwardResult => ({
    ok: false,
    mode: null,
    subject: null,
    recipients: [],
    resolved: false,
    attachmentCount: null,
    error,
  });

  try {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join('scripts', 'forward-outlook-mail.ps1'),
      '-EntryId',
      entryId,
      '-To',
      WARRANTY_DEPARTMENT_EMAIL,
      '-Mode',
      mode,
    ];

    if (bodyHtml && bodyHtml.trim()) {
      // utf8 explicitly, matched by -Encoding UTF8 on the PowerShell side.
      writeFileSync(bodyPath, bodyHtml, 'utf8');
      args.push('-BodyHtmlPath', bodyPath);
    }

    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: FORWARD_TIMEOUT_MS,
      windowsHide: true,
    });

    const parsed = parseEnvelope(stdout);
    if (!parsed) return failure(`Unparseable forward response: ${stdout.slice(0, 300)}`);
    if (!parsed.ok) return failure(parsed.error ?? 'Unknown forward failure.');

    // An unresolved recipient is reported rather than treated as success:
    // Outlook will accept the send and the mail simply never arrives.
    if (parsed.resolved === false) {
      log.warn({ entryId, to: WARRANTY_DEPARTMENT_EMAIL }, '[outlook] warranty address did not resolve');
    }

    log.info(
      { entryId, mode: parsed.mode, attachmentCount: parsed.attachmentCount, resolved: parsed.resolved },
      '[outlook] forwarded quote to the warranty department',
    );
    return {
      ok: true,
      mode: (parsed.mode as ForwardMode) ?? mode,
      subject: parsed.subject ?? null,
      recipients: parsed.recipients ?? [WARRANTY_DEPARTMENT_EMAIL],
      resolved: parsed.resolved !== false,
      attachmentCount: parsed.attachmentCount ?? null,
      error: null,
    };
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    const parsed = parseEnvelope(e.stdout ?? '');
    const error = parsed?.error ?? e.message ?? 'Unknown error invoking the forward script.';
    log.warn({ entryId, error }, '[outlook] could not forward to the warranty department');
    return failure(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
