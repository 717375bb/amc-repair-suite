import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { InferenceRecord } from '../types.js';

// Mirrors schema.sql. Inlined (rather than read from disk) so the schema is
// applied identically whether running via tsx (src/) or a tsc build (dist/).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  vendor_oor_file TEXT NOT NULL,
  cra_oor_file TEXT NOT NULL,
  row_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS esd_inferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  order_number TEXT NOT NULL,
  vendor_name TEXT,
  ro_esd_raw TEXT,
  mxi_esd_raw TEXT,
  current_status TEXT,
  vendor_notes TEXT,
  order_status TEXT,
  classification TEXT,
  extracted_base_date TEXT,
  buffer_days_applied INTEGER,
  used_fallback INTEGER,
  confidence TEXT,
  reasoning_note TEXT,
  inferred_esd TEXT,
  flag TEXT,
  delta_days_vs_mxi INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mxi_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  esd_inference_id INTEGER NOT NULL REFERENCES esd_inferences(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,
  action TEXT NOT NULL,
  inferred_esd TEXT,
  write_status TEXT NOT NULL,
  error_message TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS write_up_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor TEXT NOT NULL,
  part_number TEXT NOT NULL,
  target_env TEXT NOT NULL,
  outcome TEXT NOT NULL,
  station_code TEXT,
  routed_location TEXT,
  filled_fields_json TEXT,
  error_message TEXT,
  order_number TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS write_up_issue_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  write_up_action_id INTEGER NOT NULL REFERENCES write_up_actions(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,
  action TEXT NOT NULL,
  issue_status TEXT NOT NULL,
  error_message TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS write_up_dock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  write_up_issue_decision_id INTEGER NOT NULL REFERENCES write_up_issue_decisions(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,
  shipment_id TEXT,
  move_status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL
);

-- CLAUDE_CODE_PROMPT (Invoice Price Writer) — same runs+writes two-table
-- pattern as runs/esd_inferences: one row per uploaded sheet, one row per
-- order line processed from it (append-only, never updated/deleted).
CREATE TABLE IF NOT EXISTS invoice_price_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  source_file TEXT NOT NULL,
  row_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_price_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES invoice_price_runs(id),
  order_number TEXT NOT NULL,
  serial_number_sheet TEXT NOT NULL,
  serial_number_mxi TEXT,
  original_price TEXT,
  new_price TEXT NOT NULL,
  target_env TEXT NOT NULL,
  outcome TEXT NOT NULL,
  write_status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL
);

-- Vendor Quote Writer (docs/VENDOR_QUOTE_WRITER_SPEC.md). Same append-only
-- run/extraction/write shape as runs/esd_inferences/mxi_writes.
CREATE TABLE IF NOT EXISTS quote_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  scanned_count INTEGER NOT NULL,
  pdf_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES quote_runs(id),
  -- Outlook's own stable per-message id; what mark-outlook-mail-read targets.
  source_entry_id TEXT NOT NULL,
  subject TEXT,
  sender_name TEXT,
  sender_email TEXT,
  received_time TEXT,
  file_name TEXT NOT NULL,
  saved_path TEXT NOT NULL,
  document_kind TEXT NOT NULL,
  order_number TEXT,
  order_number_source TEXT,
  quote_number TEXT,
  vendor_name TEXT,
  part_number TEXT,
  serial_number TEXT,
  unit_price REAL,
  currency TEXT,
  quote_date TEXT,
  promised_ship_date TEXT,
  lead_time_days INTEGER,
  -- Derived by quoteEsd.ts, stored so the write step never re-derives it.
  resolved_esd TEXT,
  esd_basis TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  -- Vendor-stated non-repairable (NREP). An extraction FACT read off their
  -- document, not a human decision — human decisions live in
  -- quote_dispositions below.
  vendor_says_non_repairable INTEGER NOT NULL DEFAULT 0,
  non_repairable_evidence TEXT,
  -- First name from the email's sign-off, for the approval reply greeting.
  sender_first_name TEXT,
  -- Vendor is offering a replacement unit rather than repairing ours.
  -- Routes the write to Convert Repair To Exchange instead of a price line.
  suggests_exchange INTEGER NOT NULL DEFAULT 0,
  exchange_evidence TEXT,
  -- The disposition this row STARTED at (auto-derived from the NREP flag).
  -- The effective disposition is this, overridden by the latest
  -- quote_dispositions row if one exists.
  initial_disposition TEXT NOT NULL DEFAULT 'pending',
  confidence TEXT,
  reasoning_note TEXT,
  created_at TEXT NOT NULL
);

-- Human review decisions on an extracted quote (BER / plain exclude /
-- putting a row back to pending). Append-only, latest row wins — the same
-- shape as mxi_writes and write_up_issue_decisions, so who decided what,
-- and when, stays fully auditable rather than being overwritten in place.
CREATE TABLE IF NOT EXISTS quote_dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_extraction_id INTEGER NOT NULL REFERENCES quote_extractions(id),
  disposition TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL
);

-- Scrap-out runs (docs: the scrap tab). One row per attempt, append-only.
CREATE TABLE IF NOT EXISTS scrap_outs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'vendor' or 'in_house'
  order_number TEXT,               -- vendor path only (from the certificate)
  serial_number TEXT NOT NULL,
  part_number TEXT,
  vendor_name TEXT,
  cert_file_name TEXT,             -- vendor path only
  target_env TEXT NOT NULL,
  status TEXT NOT NULL,
  steps_taken TEXT,                -- JSON array; which intermittent steps actually fired
  cert_attached INTEGER NOT NULL DEFAULT 0,
  location_used TEXT,              -- in-house path only
  error_message TEXT,
  performed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_extraction_id INTEGER NOT NULL REFERENCES quote_extractions(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,
  written_price TEXT,
  written_esd TEXT,
  write_status TEXT NOT NULL,
  error_message TEXT,
  -- Whether the source email was successfully marked read afterwards.
  marked_read INTEGER NOT NULL DEFAULT 0,
  -- Approval reply: 'drafted', 'sent', 'failed', or 'skipped'. Separate from
  -- write_status because a reply failure must never make a committed MXI
  -- write look like it failed.
  reply_status TEXT,
  reply_error TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);
`;

/**
 * CREATE TABLE IF NOT EXISTS has no effect on a table that already exists
 * with an older column set — real consequence here: this project's actual
 * data/audit.db already had write_up_actions rows before order_number was
 * added. Adds the column if it's missing, so existing real databases pick
 * up the new column instead of silently keeping the old schema.
 */
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  ensureColumn(db, 'write_up_actions', 'order_number', 'TEXT');
  // quote_extractions already has real rows in the live audit.db from runs
  // predating the NREP/disposition work — CREATE TABLE IF NOT EXISTS won't
  // add these, so they're added explicitly (same reason as order_number above).
  ensureColumn(db, 'quote_extractions', 'vendor_says_non_repairable', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'quote_extractions', 'non_repairable_evidence', 'TEXT');
  ensureColumn(db, 'quote_extractions', 'initial_disposition', "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, 'quote_extractions', 'sender_first_name', 'TEXT');
  ensureColumn(db, 'quote_extractions', 'suggests_exchange', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'quote_extractions', 'exchange_evidence', 'TEXT');
  ensureColumn(db, 'quote_writes', 'reply_status', 'TEXT');
  ensureColumn(db, 'quote_writes', 'reply_error', 'TEXT');
  return db;
}

export function insertRun(
  db: Database.Database,
  params: { startedAt: string; vendorOorFile: string; craOorFile: string; rowCount: number },
): number {
  const stmt = db.prepare(
    'INSERT INTO runs (started_at, vendor_oor_file, cra_oor_file, row_count) VALUES (?, ?, ?, ?)',
  );
  const result = stmt.run(params.startedAt, params.vendorOorFile, params.craOorFile, params.rowCount);
  return Number(result.lastInsertRowid);
}

export function insertInferenceRecords(
  db: Database.Database,
  runId: number,
  records: InferenceRecord[],
): void {
  const stmt = db.prepare(`
    INSERT INTO esd_inferences (
      run_id, order_number, vendor_name, ro_esd_raw, mxi_esd_raw, current_status,
      vendor_notes, order_status, classification, extracted_base_date, buffer_days_applied,
      used_fallback, confidence, reasoning_note, inferred_esd, flag, delta_days_vs_mxi, created_at
    ) VALUES (
      @runId, @orderNumber, @vendorName, @roEsdRaw, @mxiEsdRaw, @currentStatus,
      @vendorNotes, @orderStatus, @classification, @extractedBaseDate, @bufferDaysApplied,
      @usedFallback, @confidence, @reasoningNote, @inferredEsd, @flag, @deltaDaysVsMxi, @createdAt
    )
  `);

  const insertMany = db.transaction((rows: InferenceRecord[]) => {
    const createdAt = new Date().toISOString();
    for (const row of rows) {
      stmt.run({
        runId,
        orderNumber: row.orderNumber,
        vendorName: row.vendorName,
        roEsdRaw: row.roEsdRaw,
        mxiEsdRaw: row.mxiEsdRaw,
        currentStatus: row.currentStatus,
        vendorNotes: row.vendorNotes,
        orderStatus: row.orderStatus,
        classification: row.classification,
        extractedBaseDate: row.extractedBaseDate,
        bufferDaysApplied: row.bufferDaysApplied,
        usedFallback: row.usedFallback ? 1 : 0,
        confidence: row.confidence,
        reasoningNote: row.reasoningNote,
        inferredEsd: row.inferredEsd,
        flag: row.flag,
        deltaDaysVsMxi: row.deltaDaysVsMxi,
        createdAt,
      });
    }
  });

  insertMany(records);
}

export interface EsdInferenceDbRow {
  id: number;
  runId: number;
  orderNumber: string;
  vendorName: string | null;
  roEsdRaw: string | null;
  mxiEsdRaw: string | null;
  currentStatus: string | null;
  vendorNotes: string | null;
  orderStatus: string | null;
  classification: string | null;
  extractedBaseDate: string | null;
  bufferDaysApplied: number | null;
  usedFallback: boolean;
  confidence: string | null;
  reasoningNote: string | null;
  inferredEsd: string | null;
  flag: string;
  deltaDaysVsMxi: number | null;
  createdAt: string;
}

interface RawEsdInferenceRow {
  id: number;
  run_id: number;
  order_number: string;
  vendor_name: string | null;
  ro_esd_raw: string | null;
  mxi_esd_raw: string | null;
  current_status: string | null;
  vendor_notes: string | null;
  order_status: string | null;
  classification: string | null;
  extracted_base_date: string | null;
  buffer_days_applied: number | null;
  used_fallback: number;
  confidence: string | null;
  reasoning_note: string | null;
  inferred_esd: string | null;
  flag: string;
  delta_days_vs_mxi: number | null;
  created_at: string;
}

function rowToEsdInference(row: RawEsdInferenceRow): EsdInferenceDbRow {
  return {
    id: row.id,
    runId: row.run_id,
    orderNumber: row.order_number,
    vendorName: row.vendor_name,
    roEsdRaw: row.ro_esd_raw,
    mxiEsdRaw: row.mxi_esd_raw,
    currentStatus: row.current_status,
    vendorNotes: row.vendor_notes,
    orderStatus: row.order_status,
    classification: row.classification,
    extractedBaseDate: row.extracted_base_date,
    bufferDaysApplied: row.buffer_days_applied,
    usedFallback: !!row.used_fallback,
    confidence: row.confidence,
    reasoningNote: row.reasoning_note,
    inferredEsd: row.inferred_esd,
    flag: row.flag,
    deltaDaysVsMxi: row.delta_days_vs_mxi,
    createdAt: row.created_at,
  };
}

/**
 * The most recent run's esd_inferences rows where flag = 'ok' and no
 * mxi_writes row exists yet (i.e. not yet approved or rejected).
 */
export function getPendingEsdUpdates(db: Database.Database): EsdInferenceDbRow[] {
  const rows = db
    .prepare(
      `
    SELECT ei.* FROM esd_inferences ei
    WHERE ei.run_id = (SELECT MAX(id) FROM runs)
      AND ei.flag = 'ok'
      AND NOT EXISTS (SELECT 1 FROM mxi_writes mw WHERE mw.esd_inference_id = ei.id)
    ORDER BY ei.order_number
  `,
    )
    .all() as RawEsdInferenceRow[];
  return rows.map(rowToEsdInference);
}

/**
 * The most recent run's esd_inferences row for a given order number, if it
 * has flag = 'ok'. Used by /approve and /reject. Deliberately does NOT
 * exclude orders that already have an mxi_writes row — re-approving or
 * re-rejecting the same order is allowed and appends a new audit row rather
 * than being blocked; only the /pending-esd-updates *list* hides
 * already-actioned orders.
 */
export function getActionableEsdInference(
  db: Database.Database,
  orderNumber: string,
): EsdInferenceDbRow | null {
  const row = db
    .prepare(
      `
    SELECT * FROM esd_inferences
    WHERE run_id = (SELECT MAX(id) FROM runs)
      AND order_number = ?
      AND flag = 'ok'
    ORDER BY id DESC
    LIMIT 1
  `,
    )
    .get(orderNumber) as RawEsdInferenceRow | undefined;
  return row ? rowToEsdInference(row) : null;
}

export interface MxiWriteInsert {
  esdInferenceId: number;
  orderNumber: string;
  targetEnv: string;
  // CLAUDE_CODE_PROMPT (ESD writer changes, A4) — 'approved_note_only_write'
  // added alongside the existing two: a real MXI write (note + reissue)
  // that deliberately never touches the ESD field, distinct from
  // 'approved_write' so the audit trail can tell the two apart. `action`
  // is a free-text column at the SQL level (see schema below) — no
  // migration needed, same pattern this project already uses for
  // write_up_actions.outcome.
  action: 'approved_write' | 'approved_note_only_write' | 'rejected';
  inferredEsd: string | null;
  writeStatus: 'success' | 'failed' | 'skipped';
  errorMessage: string | null;
  approvedBy: string | null;
}

/**
 * Distinct target_env values this order number has ANY prior mxi_writes
 * history under. Order numbers are confirmed NOT unique across
 * environments (found live: a stage test order coincidentally matched an
 * unrelated real production order). For the ESD writer specifically, real
 * historical data shows the more common case is a *legitimate*
 * test-in-stage-then-deploy-to-production pattern on the SAME real order —
 * so this is surfaced as a warning for the caller to print, not a hard
 * block (unlike aeroRepair's approve-issue/reject-issue, where the
 * colliding orders were freshly-created test artifacts, not the same
 * real-world thing).
 */
export function getPriorMxiWriteEnvironments(db: Database.Database, orderNumber: string): string[] {
  const rows = db
    .prepare('SELECT DISTINCT target_env FROM mxi_writes WHERE order_number = ?')
    .all(orderNumber) as Array<{ target_env: string }>;
  return rows.map((r) => r.target_env);
}

/** Always an INSERT. mxi_writes is append-only — never update or delete rows here. */
export function insertMxiWrite(db: Database.Database, params: MxiWriteInsert): number {
  const stmt = db.prepare(`
    INSERT INTO mxi_writes (
      esd_inference_id, order_number, target_env, action, inferred_esd,
      write_status, error_message, approved_by, created_at
    ) VALUES (
      @esdInferenceId, @orderNumber, @targetEnv, @action, @inferredEsd,
      @writeStatus, @errorMessage, @approvedBy, @createdAt
    )
  `);
  const result = stmt.run({ ...params, createdAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

// CLAUDE_CODE_PROMPT (Invoice Price Writer) — same runs+writes two-table
// append-only pattern as runs/insertMxiWrite above.
export function insertInvoicePriceRun(
  db: Database.Database,
  params: { startedAt: string; sourceFile: string; rowCount: number },
): number {
  const stmt = db.prepare(
    'INSERT INTO invoice_price_runs (started_at, source_file, row_count) VALUES (?, ?, ?)',
  );
  const result = stmt.run(params.startedAt, params.sourceFile, params.rowCount);
  return Number(result.lastInsertRowid);
}

export interface InvoicePriceWriteInsert {
  runId: number;
  orderNumber: string;
  serialNumberSheet: string;
  serialNumberMxi: string | null;
  originalPrice: string | null;
  newPrice: string;
  targetEnv: string;
  outcome: string;
  writeStatus: 'success' | 'failed' | 'skipped';
  errorMessage: string | null;
}

/** Always an INSERT. invoice_price_writes is append-only — never update or delete rows here. */
export function insertInvoicePriceWrite(db: Database.Database, params: InvoicePriceWriteInsert): number {
  const stmt = db.prepare(`
    INSERT INTO invoice_price_writes (
      run_id, order_number, serial_number_sheet, serial_number_mxi, original_price,
      new_price, target_env, outcome, write_status, error_message, created_at
    ) VALUES (
      @runId, @orderNumber, @serialNumberSheet, @serialNumberMxi, @originalPrice,
      @newPrice, @targetEnv, @outcome, @writeStatus, @errorMessage, @createdAt
    )
  `);
  const result = stmt.run({ ...params, createdAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

export interface InvoicePriceRetryRow {
  orderNumber: string;
  serialNumberSheet: string;
  newPrice: string;
}

/**
 * CLAUDE_CODE_PROMPT (Invoice Price Writer, retry) — reconstructs the
 * original per-row request (serial number, new price) for a retry from
 * this run's own append-only write history, since the uploaded sheet
 * itself is gone by the time a retry happens (its staged copy is deleted
 * once the original job finishes — see invoicePriceJobManager.ts's
 * cleanup()). Uses SQLite's documented "bare column takes the value from
 * the row with the MAX()" behavior to get each order's most recent
 * attempt without a separate subquery. Excludes any order number that has
 * ALREADY succeeded under this run, regardless of what the caller asked
 * for — same defense-in-depth as esdWriteRunner.ts's "never re-attempt a
 * real success."
 */
export function getInvoicePriceRetryRows(
  db: Database.Database,
  runId: number,
  orderNumbers: string[],
): InvoicePriceRetryRow[] {
  if (orderNumbers.length === 0) return [];
  const placeholders = orderNumbers.map(() => '?').join(',');

  const alreadySucceeded = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT order_number FROM invoice_price_writes
           WHERE run_id = ? AND write_status = 'success' AND order_number IN (${placeholders})`,
        )
        .all(runId, ...orderNumbers) as Array<{ order_number: string }>
    ).map((r) => r.order_number),
  );

  const rows = db
    .prepare(
      `SELECT order_number, serial_number_sheet, new_price, MAX(id) FROM invoice_price_writes
       WHERE run_id = ? AND order_number IN (${placeholders})
       GROUP BY order_number`,
    )
    .all(runId, ...orderNumbers) as Array<{ order_number: string; serial_number_sheet: string; new_price: string }>;

  return rows
    .filter((r) => !alreadySucceeded.has(r.order_number))
    .map((r) => ({ orderNumber: r.order_number, serialNumberSheet: r.serial_number_sheet, newPrice: r.new_price }));
}

export interface WriteUpActionInsert {
  vendor: string;
  partNumber: string;
  targetEnv: string;
  outcome:
    | 'pending_issue'
    | 'filled'
    | 'no_longer_eligible'
    | 'no_tasks_assigned'
    | 'multiple_candidate_tasks'
    | 'ad_hoc_pending_manual_continuation'
    | 'unrecognized_station'
    | 'zero_usage'
    | 'unassigned_task_present'
    | 'error'
    // Vendor 0T1Y4 additions, per VENDOR_MODULE_REFACTOR_SPEC.md section 4 —
    // outcome is a free-text TEXT column with no DB-level enum constraint
    // (confirmed via schema above), so this is a TS-level extension only,
    // same pattern as every prior outcome addition.
    | 'authorized_only'
    | 'issued_and_docked'
    // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 5) — a
    // genuinely distinct terminal state: issued for real, but Move to Dock
    // deliberately skipped this run. See vendorCodeWriteUp.ts's
    // VendorCodeWriteUpOutcome docstring for why this can't reuse
    // 'issued_and_docked'.
    | 'issued_not_docked'
    // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — the RO was
    // created but Request Authorization/Issue Order/Move to Dock were
    // never reached; a DO NOT SHIP note was recorded on the real order
    // instead. Distinct from every existing outcome — never conflated
    // with a normal completion or with the original blocking exception it
    // replaces for this one allowlisted condition.
    | 'order_created_do_not_ship'
    // CLAUDE_CODE_PROMPT (#1, RMA framework) — a genuinely distinct
    // terminal state from 'order_created_do_not_ship': written by a pure
    // vendor-membership rule (not a per-line data condition), and the real
    // MXI note text differs ("AWAITING RMA" vs "DO NOT SHIP ..."). Dormant
    // for now — the RMA vendor membership list is empty, see
    // shared/rmaVendors.ts.
    | 'order_created_awaiting_rma'
    | 'no_candidate_lines'
    | 'base_not_approved'
    // CLAUDE_CODE_PROMPT (Addition 3, preferred-vendor check) — a
    // legitimate, expected business-outcome skip: another vendor is
    // preferred for this part, so this vendor's bid was skipped before any
    // write. Never conflated with a failure — logged the same success-path
    // way as no_candidate_lines above.
    | 'vendor_not_preferred'
    | 'usage_table_absent_unexpected'
    // CLAUDE_CODE_PROMPT (new vendor batch, 2026-08-14) — receiving notes
    // (shared/partDetailsReceivingNotes.ts) mention "account"; flagged for
    // manual review rather than risking a write to the wrong Charge To
    // Account, per explicit user instruction.
    | 'receiving_notes_flagged_account'
    | 'authorization_not_confirmed'
    | 'no_removal_task_info_found'
    | 'grid_state_indeterminate'
    // CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2 additions — the old
    // 'unassigned_task_present' terminal SKIP (still above) is superseded
    // going forward: a genuine unassigned task is now auto-assigned and
    // the same pass continues, recorded via the new
    // 'unassigned_task_assigned' row (see processLine.ts) rather than a
    // terminal outcome. Only the genuinely ambiguous/suspect shapes below
    // still short-circuit.
    | 'unassigned_task_assigned'
    | 'unassigned_task_multiple_present'
    | 'unassigned_task_detection_suspect'
    // CLAUDE_CODE_PROMPT (Addition 1, Create Work Package) — REPLACES the
    // old 'No Work Package (Bad From Stock)' terminal exception: a line
    // with no work package now gets one created, then continues the normal
    // write-up in the SAME pass. Distinct, append-only audit row (same
    // pattern as 'unassigned_task_assigned' — additive to whatever the
    // line's own eventual outcome is), so creation frequency is auditable.
    | 'work_package_created'
    | 'work_package_created_pending_manual_continuation'
    // CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — a non-terminal,
    // audit-only row: a main-pass line hit a retryable failure (indeterminate
    // read, target not found in an incomplete grid, etc.) and was set aside
    // for the automatic end-of-run second pass rather than immediately
    // recorded as a final outcome. Every quarantined line gets exactly one
    // more real outcome row later (from the second-pass processLine call) —
    // querying both rows together for the same part/serial shows which
    // lines were quarantined, which recovered, and which still needed
    // review after the second attempt.
    | 'quarantined';
  stationCode: string | null;
  routedLocation: string | null;
  filledFieldsJson: string | null;
  errorMessage: string | null;
  orderNumber: string | null;
}

/** Always an INSERT. write_up_actions is append-only — never update or delete rows here. */
export function insertWriteUpAction(db: Database.Database, params: WriteUpActionInsert): number {
  const stmt = db.prepare(`
    INSERT INTO write_up_actions (
      vendor, part_number, target_env, outcome, station_code, routed_location,
      filled_fields_json, error_message, order_number, created_at
    ) VALUES (
      @vendor, @partNumber, @targetEnv, @outcome, @stationCode, @routedLocation,
      @filledFieldsJson, @errorMessage, @orderNumber, @createdAt
    )
  `);
  const result = stmt.run({ ...params, createdAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

export interface WriteUpActionDbRow {
  id: number;
  vendor: string;
  partNumber: string;
  targetEnv: string;
  outcome: string;
  stationCode: string | null;
  routedLocation: string | null;
  filledFieldsJson: string | null;
  errorMessage: string | null;
  orderNumber: string | null;
  createdAt: string;
}

interface RawWriteUpActionRow {
  id: number;
  vendor: string;
  part_number: string;
  target_env: string;
  outcome: string;
  station_code: string | null;
  routed_location: string | null;
  filled_fields_json: string | null;
  error_message: string | null;
  order_number: string | null;
  created_at: string;
}

function rowToWriteUpAction(row: RawWriteUpActionRow): WriteUpActionDbRow {
  return {
    id: row.id,
    vendor: row.vendor,
    partNumber: row.part_number,
    targetEnv: row.target_env,
    outcome: row.outcome,
    stationCode: row.station_code,
    routedLocation: row.routed_location,
    filledFieldsJson: row.filled_fields_json,
    errorMessage: row.error_message,
    orderNumber: row.order_number,
    createdAt: row.created_at,
  };
}

/**
 * Every write_up_actions row with outcome='pending_issue' and no
 * write_up_issue_decisions row yet for its order_number — i.e. real orders
 * that have cleared Auth Flow confirmation and are awaiting the separate
 * human review/approve-issue step. Same shape as getPendingEsdUpdates.
 */
export function getPendingIssueOrders(db: Database.Database): WriteUpActionDbRow[] {
  const rows = db
    .prepare(
      `
    SELECT wa.* FROM write_up_actions wa
    WHERE wa.outcome = 'pending_issue'
      AND wa.order_number IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM write_up_issue_decisions wid WHERE wid.order_number = wa.order_number)
    ORDER BY wa.created_at
  `,
    )
    .all() as RawWriteUpActionRow[];
  return rows.map(rowToWriteUpAction);
}

/**
 * The latest 'pending_issue' write_up_actions row for a given order
 * number. Deliberately does NOT exclude orders that already have a
 * write_up_issue_decisions row — same reasoning as
 * getActionableEsdInference: re-approving/re-rejecting appends a new
 * decision row rather than being blocked; only the pending *list* hides
 * already-decided orders.
 */
export function getActionableWriteUpAction(db: Database.Database, orderNumber: string): WriteUpActionDbRow | null {
  const row = db
    .prepare(
      `
    SELECT * FROM write_up_actions
    WHERE order_number = ?
      AND outcome = 'pending_issue'
    ORDER BY id DESC
    LIMIT 1
  `,
    )
    .get(orderNumber) as RawWriteUpActionRow | undefined;
  return row ? rowToWriteUpAction(row) : null;
}

export interface WriteUpIssueDecisionInsert {
  writeUpActionId: number;
  orderNumber: string;
  targetEnv: string;
  /**
   * 'rejected_but_already_issued' is distinct from 'rejected' on purpose:
   * a plain 'rejected' means the reviewer's decision is what determined
   * the order's fate (it stayed pending, untouched). If the order turns
   * out to already be ISSUED by the time reject-issue runs (e.g. an
   * earlier approve-issue already ran), recording plain 'rejected' would
   * misrepresent what actually happened — the reject decision had no
   * effect, the order was already issued beforehand.
   */
  action: 'approved_issue' | 'rejected' | 'rejected_but_already_issued';
  issueStatus: 'success' | 'failed' | 'skipped';
  errorMessage: string | null;
  reviewedBy: string | null;
}

/** Always an INSERT. write_up_issue_decisions is append-only — never update or delete rows here. */
export function insertWriteUpIssueDecision(db: Database.Database, params: WriteUpIssueDecisionInsert): number {
  const stmt = db.prepare(`
    INSERT INTO write_up_issue_decisions (
      write_up_action_id, order_number, target_env, action, issue_status,
      error_message, reviewed_by, created_at
    ) VALUES (
      @writeUpActionId, @orderNumber, @targetEnv, @action, @issueStatus,
      @errorMessage, @reviewedBy, @createdAt
    )
  `);
  const result = stmt.run({ ...params, createdAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

export interface WriteUpIssueDecisionDbRow {
  id: number;
  writeUpActionId: number;
  orderNumber: string;
  targetEnv: string;
  action: string;
  issueStatus: string;
  errorMessage: string | null;
  reviewedBy: string | null;
  createdAt: string;
}

interface RawWriteUpIssueDecisionRow {
  id: number;
  write_up_action_id: number;
  order_number: string;
  target_env: string;
  action: string;
  issue_status: string;
  error_message: string | null;
  reviewed_by: string | null;
  created_at: string;
}

function rowToWriteUpIssueDecision(row: RawWriteUpIssueDecisionRow): WriteUpIssueDecisionDbRow {
  return {
    id: row.id,
    writeUpActionId: row.write_up_action_id,
    orderNumber: row.order_number,
    targetEnv: row.target_env,
    action: row.action,
    issueStatus: row.issue_status,
    errorMessage: row.error_message,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
  };
}

/**
 * The latest genuinely-issued decision for an order — action='approved_issue'
 * AND issue_status='success'. Move to Dock only makes sense against an order
 * that is actually issued in MXI; a rejected order, a failed issue attempt,
 * or an order with no decision at all has no outbound shipment to move.
 */
export function getIssuedDecisionForOrder(db: Database.Database, orderNumber: string): WriteUpIssueDecisionDbRow | null {
  const row = db
    .prepare(
      `
    SELECT * FROM write_up_issue_decisions
    WHERE order_number = ?
      AND action = 'approved_issue'
      AND issue_status = 'success'
    ORDER BY id DESC
    LIMIT 1
  `,
    )
    .get(orderNumber) as RawWriteUpIssueDecisionRow | undefined;
  return row ? rowToWriteUpIssueDecision(row) : null;
}

export interface WriteUpDockMoveInsert {
  writeUpIssueDecisionId: number;
  orderNumber: string;
  targetEnv: string;
  shipmentId: string | null;
  /**
   * 'already_docked_externally' is distinct from 'success' on purpose:
   * both mean the real shipment genuinely IS at or past dock, but
   * 'success' means THIS invocation's own click did it, while
   * 'already_docked_externally' means the read-only pre-check found it
   * already there — done by a human (or a prior automation run that
   * wasn't recorded) outside this specific call. Real, confirmed case:
   * P000BAL4 was moved to dock AND received by the vendor by someone
   * else, entirely outside this automation, between sessions —
   * write_up_dock_moves cannot be trusted as sole source of truth for
   * whether an order has actually been docked in the real world, only
   * for whether THIS automation did it. Both values count as "done" for
   * getOrdersAwaitingDockMove's purposes (see its query below).
   */
  moveStatus: 'success' | 'failed' | 'no_outbound_shipment_found' | 'already_docked_externally';
  errorMessage: string | null;
}

/** Always an INSERT. write_up_dock_moves is append-only — never update or delete rows here. */
export function insertWriteUpDockMove(db: Database.Database, params: WriteUpDockMoveInsert): number {
  const stmt = db.prepare(`
    INSERT INTO write_up_dock_moves (
      write_up_issue_decision_id, order_number, target_env, shipment_id,
      move_status, error_message, created_at
    ) VALUES (
      @writeUpIssueDecisionId, @orderNumber, @targetEnv, @shipmentId,
      @moveStatus, @errorMessage, @createdAt
    )
  `);
  const result = stmt.run({ ...params, createdAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

/**
 * Every order that is genuinely issued (approved_issue/success) but has no
 * write_up_dock_moves row showing it's actually at or past dock yet —
 * 'success' (this automation did it) or 'already_docked_externally' (a
 * live pre-check found it already there, done by someone/something else)
 * both count as done here; only their absence means genuinely awaiting.
 * Real orders with neither would otherwise be silently mistaken for "done"
 * when physical stores has never actually been signaled to prep the part
 * for outbound shipment.
 */
export function getOrdersAwaitingDockMove(db: Database.Database): WriteUpIssueDecisionDbRow[] {
  const rows = db
    .prepare(
      `
    SELECT wid.* FROM write_up_issue_decisions wid
    WHERE wid.action = 'approved_issue'
      AND wid.issue_status = 'success'
      AND NOT EXISTS (
        SELECT 1 FROM write_up_dock_moves wdm
        WHERE wdm.order_number = wid.order_number
          AND wdm.move_status IN ('success', 'already_docked_externally')
      )
    ORDER BY wid.created_at
  `,
    )
    .all() as RawWriteUpIssueDecisionRow[];
  return rows.map(rowToWriteUpIssueDecision);
}

// ---------------------------------------------------------------------------
// Vendor Quote Writer — docs/VENDOR_QUOTE_WRITER_SPEC.md
// ---------------------------------------------------------------------------

export interface QuoteRunInsert {
  startedAt: string;
  folderPath: string;
  scannedCount: number;
  pdfCount: number;
}

export function insertQuoteRun(db: Database.Database, params: QuoteRunInsert): number {
  const stmt = db.prepare(
    'INSERT INTO quote_runs (started_at, folder_path, scanned_count, pdf_count) VALUES (?, ?, ?, ?)',
  );
  const result = stmt.run(params.startedAt, params.folderPath, params.scannedCount, params.pdfCount);
  return Number(result.lastInsertRowid);
}

export interface QuoteExtractionInsert {
  runId: number;
  sourceEntryId: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  receivedTime: string | null;
  fileName: string;
  savedPath: string;
  documentKind: string;
  orderNumber: string | null;
  orderNumberSource: string | null;
  quoteNumber: string | null;
  vendorName: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  unitPrice: number | null;
  currency: string | null;
  quoteDate: string | null;
  promisedShipDate: string | null;
  leadTimeDays: number | null;
  resolvedEsd: string | null;
  esdBasis: string | null;
  needsReview: boolean;
  vendorSaysNonRepairable: boolean;
  nonRepairableEvidence: string | null;
  senderFirstName: string | null;
  suggestsExchange: boolean;
  exchangeEvidence: string | null;
  initialDisposition: string;
  confidence: string | null;
  reasoningNote: string | null;
}

/** Always an INSERT — quote_extractions is append-only, same as every other audit table here. */
export function insertQuoteExtraction(db: Database.Database, params: QuoteExtractionInsert): number {
  const stmt = db.prepare(`
    INSERT INTO quote_extractions (
      run_id, source_entry_id, subject, sender_name, sender_email, received_time,
      file_name, saved_path, document_kind, order_number, order_number_source,
      quote_number, vendor_name, part_number, serial_number, unit_price, currency,
      quote_date, promised_ship_date, lead_time_days, resolved_esd, esd_basis,
      needs_review, vendor_says_non_repairable, non_repairable_evidence,
      sender_first_name, suggests_exchange, exchange_evidence,
      initial_disposition, confidence, reasoning_note, created_at
    ) VALUES (
      @runId, @sourceEntryId, @subject, @senderName, @senderEmail, @receivedTime,
      @fileName, @savedPath, @documentKind, @orderNumber, @orderNumberSource,
      @quoteNumber, @vendorName, @partNumber, @serialNumber, @unitPrice, @currency,
      @quoteDate, @promisedShipDate, @leadTimeDays, @resolvedEsd, @esdBasis,
      @needsReview, @vendorSaysNonRepairable, @nonRepairableEvidence,
      @senderFirstName, @suggestsExchange, @exchangeEvidence,
      @initialDisposition, @confidence, @reasoningNote, @createdAt
    )
  `);
  const result = stmt.run({
    ...params,
    needsReview: params.needsReview ? 1 : 0,
    vendorSaysNonRepairable: params.vendorSaysNonRepairable ? 1 : 0,
    suggestsExchange: params.suggestsExchange ? 1 : 0,
    createdAt: new Date().toISOString(),
  });
  return Number(result.lastInsertRowid);
}

/**
 * Records a human disposition decision (BER / plain exclude / back to
 * pending). Always an INSERT — quote_dispositions is append-only, latest
 * row wins, so the full decision history survives.
 */
export function insertQuoteDisposition(
  db: Database.Database,
  params: { quoteExtractionId: number; disposition: string; decidedBy: string | null },
): number {
  const stmt = db.prepare(
    'INSERT INTO quote_dispositions (quote_extraction_id, disposition, decided_by, created_at) VALUES (?, ?, ?, ?)',
  );
  const result = stmt.run(
    params.quoteExtractionId,
    params.disposition,
    params.decidedBy,
    new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

/**
 * Effective disposition per extraction for one run: the row's own
 * initial_disposition, overridden by its most recent quote_dispositions
 * entry if any. Computed here rather than in the caller so the write path
 * and the UI can never disagree about what's writable.
 */
export function getEffectiveQuoteDispositions(
  db: Database.Database,
  runId: number,
): Map<number, { disposition: string; decidedBy: string | null; wasHumanSet: boolean }> {
  const rows = db
    .prepare(
      `
    SELECT e.id AS extraction_id,
           e.initial_disposition,
           d.disposition AS human_disposition,
           d.decided_by
    FROM quote_extractions e
    LEFT JOIN quote_dispositions d
      ON d.id = (
        SELECT id FROM quote_dispositions
        WHERE quote_extraction_id = e.id
        ORDER BY id DESC LIMIT 1
      )
    WHERE e.run_id = ?
  `,
    )
    .all(runId) as Array<{
    extraction_id: number;
    initial_disposition: string;
    human_disposition: string | null;
    decided_by: string | null;
  }>;

  const result = new Map<number, { disposition: string; decidedBy: string | null; wasHumanSet: boolean }>();
  for (const row of rows) {
    result.set(row.extraction_id, {
      disposition: row.human_disposition ?? row.initial_disposition,
      decidedBy: row.decided_by,
      wasHumanSet: row.human_disposition !== null,
    });
  }
  return result;
}

export interface QuoteWriteInsert {
  quoteExtractionId: number;
  orderNumber: string;
  targetEnv: string;
  writtenPrice: string | null;
  writtenEsd: string | null;
  writeStatus: 'success' | 'failed' | 'skipped';
  errorMessage: string | null;
  markedRead: boolean;
  replyStatus: 'drafted' | 'sent' | 'failed' | 'skipped' | null;
  replyError: string | null;
  approvedBy: string | null;
}

/** Always an INSERT. quote_writes is append-only — never update or delete rows here. */
export function insertQuoteWrite(db: Database.Database, params: QuoteWriteInsert): number {
  const stmt = db.prepare(`
    INSERT INTO quote_writes (
      quote_extraction_id, order_number, target_env, written_price, written_esd,
      write_status, error_message, marked_read, reply_status, reply_error,
      approved_by, created_at
    ) VALUES (
      @quoteExtractionId, @orderNumber, @targetEnv, @writtenPrice, @writtenEsd,
      @writeStatus, @errorMessage, @markedRead, @replyStatus, @replyError,
      @approvedBy, @createdAt
    )
  `);
  const result = stmt.run({
    ...params,
    markedRead: params.markedRead ? 1 : 0,
    createdAt: new Date().toISOString(),
  });
  return Number(result.lastInsertRowid);
}

/**
 * True if this extraction already has a successful write — the same
 * structural retry guard esdWriteRunner.ts uses. Writing a price/ESD twice
 * is not harmless (it reissues the order again), so "only write what hasn't
 * been written" must not depend on the caller getting it right.
 */
export function quoteExtractionAlreadyWritten(db: Database.Database, quoteExtractionId: number): boolean {
  const row = db
    .prepare(`SELECT 1 FROM quote_writes WHERE quote_extraction_id = ? AND write_status = 'success' LIMIT 1`)
    .get(quoteExtractionId);
  return !!row;
}

// ---------------------------------------------------------------------------
// Scrap-out (the scrap tab) — vendor and in-house paths
// ---------------------------------------------------------------------------

export interface ScrapOutInsert {
  kind: 'vendor' | 'in_house';
  orderNumber: string | null;
  serialNumber: string;
  partNumber: string | null;
  vendorName: string | null;
  certFileName: string | null;
  targetEnv: string;
  status: 'success' | 'failed';
  stepsTaken: string[];
  certAttached: boolean;
  locationUsed: string | null;
  errorMessage: string | null;
  performedBy: string | null;
}

/** Always an INSERT — scrap_outs is append-only, like every other audit table here. */
export function insertScrapOut(db: Database.Database, params: ScrapOutInsert): number {
  const stmt = db.prepare(`
    INSERT INTO scrap_outs (
      kind, order_number, serial_number, part_number, vendor_name, cert_file_name,
      target_env, status, steps_taken, cert_attached, location_used, error_message,
      performed_by, created_at
    ) VALUES (
      @kind, @orderNumber, @serialNumber, @partNumber, @vendorName, @certFileName,
      @targetEnv, @status, @stepsTaken, @certAttached, @locationUsed, @errorMessage,
      @performedBy, @createdAt
    )
  `);
  const result = stmt.run({
    ...params,
    stepsTaken: JSON.stringify(params.stepsTaken),
    certAttached: params.certAttached ? 1 : 0,
    createdAt: new Date().toISOString(),
  });
  return Number(result.lastInsertRowid);
}

/**
 * True if this serial already has a successful scrap-out recorded.
 *
 * Scrapping is irreversible and NOT idempotent — running it twice on the
 * same part would attempt a second destruction of something already gone.
 * Same structural guard as quoteExtractionAlreadyWritten().
 */
export function serialAlreadyScrapped(db: Database.Database, serialNumber: string, targetEnv: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM scrap_outs WHERE serial_number = ? AND target_env = ? AND status = 'success' LIMIT 1`,
    )
    .get(serialNumber.trim().toUpperCase(), targetEnv);
  return !!row;
}
