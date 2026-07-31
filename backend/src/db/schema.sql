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
  flag TEXT,                 -- ok | no_esd_found | orphaned_vendor_row | orphaned_cra_row
  delta_days_vs_mxi INTEGER,
  created_at TEXT NOT NULL
);

-- Phase 2: MXI writer audit trail. Append-only, same as esd_inferences —
-- never update or delete rows here.
CREATE TABLE IF NOT EXISTS mxi_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  esd_inference_id INTEGER NOT NULL REFERENCES esd_inferences(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,        -- 'stage' | 'production'
  action TEXT NOT NULL,             -- 'approved_write' | 'rejected'
  inferred_esd TEXT,
  write_status TEXT NOT NULL,       -- 'success' | 'failed' | 'skipped'
  error_message TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);

-- Aero Repair write-up audit trail. Append-only, same pattern as
-- mxi_writes — never update or delete rows here.
CREATE TABLE IF NOT EXISTS write_up_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor TEXT NOT NULL,             -- 'aeroRepair' (future vendors add their own value, not a new table)
  part_number TEXT NOT NULL,
  target_env TEXT NOT NULL,         -- 'stage' | 'production'
  outcome TEXT NOT NULL,            -- 'pending_issue' | 'filled' | 'no_longer_eligible' | 'no_tasks_assigned' | 'multiple_candidate_tasks' | 'ad_hoc_pending_manual_continuation' | 'unrecognized_station' | 'zero_usage' | 'unassigned_task_present' | 'error'
  station_code TEXT,
  routed_location TEXT,
  filled_fields_json TEXT,          -- JSON snapshot of everything that was (or would be) filled, for manual review
  error_message TEXT,
  order_number TEXT,                -- the real generated order number, when one exists — added for the two-phase review gate
  created_at TEXT NOT NULL
);

-- The review-gate decision on a 'pending_issue' write_up_actions row.
-- Append-only, same pattern as mxi_writes/write_up_actions — never update
-- or delete rows here. Mirrors mxi_writes' relationship to esd_inferences:
-- write_up_actions records the candidate (what was filled/authorized),
-- this table records the human decision on it.
CREATE TABLE IF NOT EXISTS write_up_issue_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  write_up_action_id INTEGER NOT NULL REFERENCES write_up_actions(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,         -- 'stage' | 'production'
  action TEXT NOT NULL,             -- 'approved_issue' | 'rejected' | 'rejected_but_already_issued'
  issue_status TEXT NOT NULL,       -- 'success' | 'failed' | 'skipped'
  error_message TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL
);

-- Records the real "Move to Dock" attempt on an issued order's outbound
-- shipment — per the user's process, an issued order is not actually done
-- until physical stores has been signaled to prep it for outbound shipment
-- via this action. Append-only, same pattern as the tables above. Kept as
-- its own table (not folded into write_up_issue_decisions) because it's a
-- distinct kind of event — fulfillment of an already-issued order, not a
-- review decision on a pending one.
CREATE TABLE IF NOT EXISTS write_up_dock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  write_up_issue_decision_id INTEGER NOT NULL REFERENCES write_up_issue_decisions(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,         -- 'stage' | 'production'
  shipment_id TEXT,
  move_status TEXT NOT NULL,        -- 'success' | 'failed' | 'no_outbound_shipment_found' | 'already_docked_externally'
  error_message TEXT,
  created_at TEXT NOT NULL
);
