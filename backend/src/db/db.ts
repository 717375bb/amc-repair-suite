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
  action: 'approved_write' | 'rejected';
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
    | 'usage_table_absent_unexpected'
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
