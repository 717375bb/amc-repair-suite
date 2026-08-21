import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logging/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('quote');

const REPLY_TIMEOUT_MS = 90 * 1000;

export type QuoteReplyMode = 'draft' | 'send';

export interface QuoteReplyResult {
  ok: boolean;
  mode: QuoteReplyMode | null;
  subject: string | null;
  recipients: string[];
  error: string | null;
}

/**
 * Resolves the reply mode from configuration.
 *
 * **Defaults to 'draft', and anything other than the exact string 'send'
 * resolves to 'draft'.** A typo, a stray value, or an unset variable can
 * therefore never cause mail to be sent — the failure direction is always
 * "a draft you have to send yourself", never "an email already gone to a
 * vendor". Same case-sensitive, no-shorthand strictness as this project's
 * MXI_ENV guard, and for the same reason.
 */
export function resolveReplyMode(): QuoteReplyMode {
  return process.env.QUOTE_REPLY_MODE === 'send' ? 'send' : 'draft';
}

/**
 * Creates a Reply All to one message with the supplied HTML body, either
 * saving it to Drafts or sending it.
 *
 * Never throws — a reply failure must not turn an already-committed MXI
 * write into a reported failure. The outcomes are recorded separately on
 * quote_writes so "the price landed but the reply didn't draft" stays
 * visible as exactly that.
 *
 * The body is handed over via a temp FILE rather than a command-line
 * argument: approval wording is long, contains HTML and quotes, and
 * argument escaping is exactly the kind of thing that silently corrupts a
 * vendor-facing message. The temp file is always cleaned up.
 */
export async function createOutlookReply(
  entryId: string,
  bodyHtml: string,
  mode: QuoteReplyMode,
): Promise<QuoteReplyResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'quote-reply-'));
  const bodyPath = path.join(dir, 'body.html');

  try {
    // Explicit utf8 — the PowerShell side reads it with -Encoding UTF8 to
    // match (this project has already shipped mojibake from an encoding
    // mismatch once).
    writeFileSync(bodyPath, bodyHtml, 'utf8');

    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join('scripts', 'create-outlook-reply.ps1'),
      '-EntryId',
      entryId,
      '-BodyHtmlPath',
      bodyPath,
      '-Mode',
      mode,
    ];

    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: REPLY_TIMEOUT_MS,
      windowsHide: true,
    });

    const parsed = parseEnvelope(stdout);
    if (!parsed) {
      return { ok: false, mode: null, subject: null, recipients: [], error: `Unparseable reply response: ${stdout.slice(0, 300)}` };
    }
    if (!parsed.ok) {
      return { ok: false, mode: null, subject: null, recipients: [], error: parsed.error ?? 'Unknown reply failure.' };
    }

    log.info({ entryId, mode: parsed.mode, recipients: parsed.recipients }, '[outlook] approval reply created');
    return {
      ok: true,
      mode: (parsed.mode as QuoteReplyMode) ?? mode,
      subject: parsed.subject ?? null,
      recipients: parsed.recipients ?? [],
      error: null,
    };
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    const parsed = parseEnvelope(e.stdout ?? '');
    const error = parsed?.error ?? e.message ?? 'Unknown error invoking the reply script.';
    log.warn({ entryId, error }, '[outlook] could not create approval reply');
    return { ok: false, mode: null, subject: null, recipients: [], error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ReplyEnvelope {
  ok: boolean;
  mode?: string;
  subject?: string;
  recipients?: string[];
  error?: string;
}

function parseEnvelope(stdout: string): ReplyEnvelope | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as ReplyEnvelope;
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}
