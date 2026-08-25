import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UsageParmRow } from './partOwnDetails.js';
import { createLogger } from '../../logging/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('writeup');

const DRAFT_TIMEOUT_MS = 90 * 1000;

/** Fixed by the user: always this DL, always this subject. */
export const MAINTENANCE_RECORDS_EMAIL = 'DL_PSA_MaintenanceRecords@psaairlines.com';
export const MAINTENANCE_RECORDS_SUBJECT = 'Times and Cycles';

export type MaintenanceRecordsMode = 'draft' | 'send';

export interface MaintenanceRecordsDraftInput {
  partNumber: string;
  serialNumber: string;
  usageRows: UsageParmRow[];
}

export interface MaintenanceRecordsDraftResult {
  ok: boolean;
  mode: MaintenanceRecordsMode | null;
  subject: string | null;
  recipients: string[];
  /** Whether Outlook resolved the DL to a real recipient. */
  resolved: boolean;
  /** The created draft's Outlook EntryID — logged so a specific draft is identifiable afterwards. */
  entryId: string | null;
  error: string | null;
}

/**
 * Resolves the mode from configuration.
 *
 * **Defaults to 'draft', and anything other than the exact string 'send'
 * resolves to 'draft'.** Same case-sensitive, no-shorthand strictness as
 * QUOTE_REPLY_MODE and MXI_ENV, for the same reason: a typo, a stray
 * value, or an unset variable can never cause mail to leave the mailbox.
 * The failure direction is always "a draft you send yourself".
 *
 * Nothing sets MAINTENANCE_RECORDS_MODE today — the send path exists only
 * so it can be switched on deliberately later, per explicit user choice
 * ("draft now, add a send toggle later"). An internal DL is still a real
 * email that cannot be unsent.
 */
export function resolveMaintenanceRecordsMode(): MaintenanceRecordsMode {
  return process.env.MAINTENANCE_RECORDS_MODE === 'send' ? 'send' : 'draft';
}

/**
 * Composes the message body.
 *
 * PURE, and exported for that reason — the wording and the table shape are
 * the parts a human actually reads, so they are unit-tested rather than
 * only ever seen in a live Outlook draft.
 *
 * THE PART IDENTITY LIVES HERE, NOT IN THE SUBJECT. The previous mailto:
 * version put "PN x / SN y" in the subject line and nowhere in the body;
 * with the subject now fixed at "Times and Cycles" for every message, that
 * would have left the records team with no idea which part was meant.
 *
 * The table is the same plain-text "Usage Parm\tTSN\tTSO\tTSI" shape this
 * codebase already writes into real Notes to Vendor
 * (composeNotesForNormalLine) — not a new format to learn.
 */
export function composeMaintenanceRecordsBody(input: MaintenanceRecordsDraftInput): string {
  const lines = [
    'Good morning Maintenance Records team!',
    '',
    'This part is showing with zero times and cycles. Can you please have this corrected? Thank you!',
    '',
    `PN: ${input.partNumber}    SN: ${input.serialNumber}`,
    'Usage Parm\tTSN\tTSO\tTSI',
    ...input.usageRows.map((row) => `${row.label}\t${row.tsn}\t${row.tso}\t${row.tsi}`),
  ];
  return lines.join('\n');
}

/**
 * Creates the Outlook draft for one zero-times-and-cycles part.
 *
 * Never throws. A drafting failure is reported, not raised: this runs off
 * an exception that has ALREADY been recorded, and losing that record
 * because Outlook was closed would be worse than the missing draft.
 *
 * The body goes over as a temp FILE rather than a command-line argument —
 * it contains tabs, newlines and a data table, and argument escaping is
 * exactly what silently corrupts those. Same approach, and same reasoning,
 * as outlookReply.ts. The temp file is always cleaned up.
 */
export async function createMaintenanceRecordsDraft(
  input: MaintenanceRecordsDraftInput,
  mode: MaintenanceRecordsMode = resolveMaintenanceRecordsMode(),
): Promise<MaintenanceRecordsDraftResult> {
  if (input.usageRows.length === 0) {
    return {
      ok: false,
      mode: null,
      subject: null,
      recipients: [],
      resolved: false,
      entryId: null,
      error: 'No times-and-cycles rows were captured for this part, so there is nothing to report. No draft created.',
    };
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'maint-records-'));
  const bodyPath = path.join(dir, 'body.txt');

  try {
    // Explicit utf8, matched by -Encoding UTF8 on the PowerShell side.
    writeFileSync(bodyPath, composeMaintenanceRecordsBody(input), 'utf8');

    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join('scripts', 'create-outlook-mail.ps1'),
      '-To',
      MAINTENANCE_RECORDS_EMAIL,
      '-Subject',
      MAINTENANCE_RECORDS_SUBJECT,
      '-BodyPath',
      bodyPath,
      '-Mode',
      mode,
    ];

    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: DRAFT_TIMEOUT_MS,
      windowsHide: true,
    });

    const parsed = parseEnvelope(stdout);
    if (!parsed) {
      return {
        ok: false,
        mode: null,
        subject: null,
        recipients: [],
        resolved: false,
        entryId: null,
        error: `Unparseable response from the Outlook script: ${stdout.slice(0, 300)}`,
      };
    }
    if (!parsed.ok) {
      return { ok: false, mode: null, subject: null, recipients: [], resolved: false, entryId: null, error: parsed.error ?? 'Unknown drafting failure.' };
    }

    log.info(
      { partNumber: input.partNumber, serialNumber: input.serialNumber, mode: parsed.mode, resolved: parsed.resolved, entryId: parsed.entryId },
      '[outlook] maintenance-records draft created',
    );
    return {
      ok: true,
      mode: (parsed.mode as MaintenanceRecordsMode) ?? mode,
      subject: parsed.subject ?? MAINTENANCE_RECORDS_SUBJECT,
      recipients: parsed.recipients ?? [MAINTENANCE_RECORDS_EMAIL],
      resolved: parsed.resolved === true,
      entryId: parsed.entryId ?? null,
      error: null,
    };
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    const parsed = parseEnvelope(e.stdout ?? '');
    const error = parsed?.error ?? e.message ?? 'Unknown error invoking the Outlook script.';
    log.warn({ partNumber: input.partNumber, serialNumber: input.serialNumber, error }, '[outlook] could not create maintenance-records draft');
    return { ok: false, mode: null, subject: null, recipients: [], resolved: false, entryId: null, error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface DraftEnvelope {
  ok: boolean;
  mode?: string;
  subject?: string;
  recipients?: string[];
  resolved?: boolean;
  entryId?: string;
  error?: string;
}

/** Same last-JSON-line-wins parse as outlookReply.ts — PowerShell can emit diagnostics around it. */
function parseEnvelope(stdout: string): DraftEnvelope | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as DraftEnvelope;
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}
