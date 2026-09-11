import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { insertMxiWrite } from '../../db/db.js';
import { classifyRowAction } from '../../inference/classifyRowAction.js';
import { resolveInboundAwbFromNotes } from '../../inference/inboundAwb.js';
import { writeInboundAwb } from '../../mxiWriter/awbInboundSelectors.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { assembleNoteText, toMxiDateFormat } from '../../mxiWriter/esdFormatting.js';
import { writeEsdAndNotes } from '../../mxiWriter/writeEsdAndNotes.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';
import type { EsdFlag } from '../../types.js';

const log = createLogger('esd');

/**
 * Open Order ESD Finder — write job runner. Spawned by
 * esdFinderJobManager.ts (same spawnRunner discipline as every other
 * runner in this project).
 *
 * CRITICAL DESIGN POINT: this creates its OWN MxiClient via
 * createReadyMxiClient(env) using the `env` this specific job was started
 * with — it never touches server.ts's single, server-lifetime `mxiClient`
 * (which is fixed to whatever MXI_ENV the server happened to boot with,
 * currently 'production'). That shared client is exactly what NOT to reuse
 * here: the whole point of this file existing separately is that the
 * environment selector must genuinely control where the write lands, not
 * be cosmetic. `target_env` on every mxi_writes row below is this same
 * explicit `env` value, not read back from any client's own config.
 *
 * Calls writeEsdAndNotes() unchanged — the exact same function
 * server.ts's /esd-updates/:orderNumber/approve and mxiWriteEsd.ts already
 * use. No reimplementation of the write/verify logic itself.
 */

interface EsdWriteEnvelope {
  type: 'order-result' | 'done' | 'fatal';
  orderNumber?: string;
  status?: 'success' | 'failed' | 'skipped';
  errorMessage?: string | null;
  message?: string;
  /**
   * CLAUDE_CODE_PROMPT (AWB -> Inbound shipment, correction, 2026-09-10) —
   * present only when this order's (possibly analyst-edited) notes
   * contained a detected inbound AWB and the ESD write above succeeded.
   * Optional/additive on the existing 'order-result' envelope rather than
   * a new envelope type, so this is a backward-compatible extension.
   */
  inboundAwb?: string | null;
  inboundAwbStatus?: 'success' | 'failed' | 'skipped' | 'no_inbound_shipment_found' | null;
  inboundAwbError?: string | null;
}

function emit(envelope: EsdWriteEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

interface EsdInferenceRowForWrite {
  id: number;
  order_number: string;
  // CLAUDE_CODE_PROMPT (ESD writer changes, A4) — inferred_esd is now
  // nullable at this call site: a note_only_reissue row (flag =
  // 'no_esd_found') genuinely has no usable ESD, by definition.
  inferred_esd: string | null;
  /**
   * The vendor's own stated/extracted ESD, BEFORE any buffer — what the
   * Notes to Receiver entry states (see esdFormatting.ts's assembleNoteText,
   * corrected 2026-08-20). Distinct from inferred_esd, which is this date
   * plus the buffer and is what actually gets written into the ESD field.
   */
  extracted_base_date: string | null;
  vendor_notes: string | null;
  flag: string;
}

/**
 * An analyst's typed correction for one order, from the review table.
 *
 * Both fields are optional and independent: correcting a misread ESD does
 * not force a note edit, and vice versa. An absent or blank field means
 * "leave this one alone" — never "write a blank", which would clear a real
 * value in MXI.
 */
export interface EsdWriteOverride {
  /** ISO YYYY-MM-DD. Already validated and normalised server-side. */
  esd?: string;
  /** Replaces the vendor-notes text inside the composed note entry. */
  note?: string;
}

function parseArgs(): {
  env: MxiEnv;
  dbRunId: number;
  orderNumbers: string[];
  overrides: Record<string, EsdWriteOverride>;
} {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  const runIdIdx = args.indexOf('--esd-run-id');
  const ordersIdx = args.indexOf('--order-numbers');
  const overridesIdx = args.indexOf('--overrides');
  const rawEnv = envIdx >= 0 ? args[envIdx + 1] : undefined;
  const rawRunId = runIdIdx >= 0 ? args[runIdIdx + 1] : undefined;
  const rawOrders = ordersIdx >= 0 ? args[ordersIdx + 1] : undefined;
  const rawOverrides = overridesIdx >= 0 ? args[overridesIdx + 1] : undefined;

  if (rawEnv !== 'stage' && rawEnv !== 'production') {
    throw new Error(`--env must be exactly "stage" or "production", got: ${rawEnv}`);
  }
  if (!rawRunId) throw new Error('--esd-run-id is required.');
  if (!rawOrders) throw new Error('--order-numbers is required (JSON array of order number strings).');

  const dbRunId = Number(rawRunId);
  const orderNumbers = JSON.parse(rawOrders) as string[];
  if (!Number.isFinite(dbRunId)) throw new Error(`--esd-run-id must be a number, got: ${rawRunId}`);
  if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
    throw new Error('--order-numbers must be a non-empty JSON array.');
  }
  // Absent is normal — an untouched review table sends none.
  const overrides = rawOverrides ? (JSON.parse(rawOverrides) as Record<string, EsdWriteOverride>) : {};
  return { env: rawEnv, dbRunId, orderNumbers, overrides };
}

async function main(): Promise<void> {
  const { env, dbRunId, orderNumbers, overrides } = parseArgs();
  const db = new Database(path.join('data', 'audit.db'));

  // CLAUDE_CODE_PROMPT (ESD writer changes, A4) — broadened from
  // flag='ok'-only to also include flag='no_esd_found' rows, since those
  // can now be genuinely actionable (note_only_reissue). Scoped to the
  // SPECIFIC compare run, never "whatever the latest run happens to be"
  // (getActionableEsdInference's own hardcoded MAX(id) semantics would be
  // wrong here: a later, unrelated run could exist by the time a write
  // actually happens) — unchanged from before.
  const placeholders = orderNumbers.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, order_number, inferred_esd, extracted_base_date, vendor_notes, flag FROM esd_inferences
       WHERE run_id = ? AND flag IN ('ok', 'no_esd_found') AND order_number IN (${placeholders})`,
    )
    .all(dbRunId, ...orderNumbers) as EsdInferenceRowForWrite[];

  const foundOrderNumbers = new Set(rows.map((r) => r.order_number));
  for (const orderNumber of orderNumbers) {
    if (!foundOrderNumbers.has(orderNumber)) {
      emit({
        type: 'order-result',
        orderNumber,
        status: 'skipped',
        errorMessage: `Not found as an actionable (flag='ok' or 'no_esd_found') row under run ${dbRunId} — refusing to write it.`,
      });
    }
  }

  // CLAUDE_CODE_PROMPT (ESD writer changes, A4) — the SQL flag filter above
  // is a coarse pre-filter; classifyRowAction() is the single source of
  // truth for whether a row is actually writable (it also excludes
  // placeholder/blank commentary and orphaned rows). Re-derived here from
  // the same (flag, vendorNotes) inputs esdCompareRunner.ts used at
  // compare-time, never trusted from the caller — a row this project's own
  // UI never offered as actionable still can't be forced through by a
  // stray/replayed order number.
  //
  // CLAUDE_CODE_PROMPT (manual actionable override, 2026-09-09) — per
  // explicit user direction: a row the pipeline classified
  // 'skipped_no_commentary' (no usable ESD, no real vendor commentary) can
  // still be written if the analyst typed their OWN ESD for it in the
  // review table. This is the one exception to "never trusted from the
  // caller" above — it is a deliberate, visible human decision to promote
  // a specific row, not a bypass: it requires override.esd specifically
  // (not just any override), the promoted row is still routed through the
  // exact same esd_write branch/write path/audit trail as a naturally
  // actionable row, and it's recorded under its OWN mxi_writes `action`
  // value (approved_manual_override_write) so it's never indistinguishable
  // from a pipeline-derived write after the fact.
  const writableRows: Array<EsdInferenceRowForWrite & { actionType: 'esd_write' | 'note_only_reissue'; isManualPromotion: boolean }> = [];
  for (const row of rows) {
    const naturalActionType = classifyRowAction({ flag: row.flag as EsdFlag, vendorNotes: row.vendor_notes });
    const override = overrides[row.order_number];
    const isManualPromotion = naturalActionType === 'skipped_no_commentary' && !!override?.esd;
    const actionType = isManualPromotion ? 'esd_write' : naturalActionType;

    if (actionType === 'skipped_no_commentary') {
      log.info({ orderNumber: row.order_number, flag: row.flag }, 'esd write skipped: no real commentary');
      emit({
        type: 'order-result',
        orderNumber: row.order_number,
        status: 'skipped',
        errorMessage: 'No usable ESD and no real vendor commentary — refusing to write it.',
      });
      continue;
    }
    if (isManualPromotion) {
      log.info({ orderNumber: row.order_number, flag: row.flag }, 'esd write: manually promoted via analyst-typed ESD override');
    }
    writableRows.push({ ...row, actionType, isManualPromotion });
  }

  if (writableRows.length === 0) {
    db.close();
    emit({ type: 'done' });
    return;
  }

  // CLAUDE_CODE_PROMPT (cancel button) — checked before each order, never
  // mid-write. See cancellationWatcher.ts's docstring for the mechanism.
  const cancelSignal = watchStdinForCancellation();

  const client = await createReadyMxiClient(env);
  try {
    for (const row of writableRows) {
      if (cancelSignal.aborted) break;
      // Defense-in-depth for the retry-only-failed-orders requirement:
      // never re-attempt an order this esd_inference_id already has a real
      // successful mxi_writes row for, regardless of what the caller
      // requested. Notes to Receiver is an accumulating log — a second
      // real submit would duplicate the entry and reissue the order again
      // for no reason, the same risk already documented for aeroRepair's
      // writeEsdAndNotes-equivalent. This makes "only retry what actually
      // failed" a structural guarantee, not just a UI convention the
      // frontend has to get right every time.
      const alreadySucceeded = db
        .prepare(`SELECT 1 FROM mxi_writes WHERE esd_inference_id = ? AND write_status = 'success' LIMIT 1`)
        .get(row.id);
      if (alreadySucceeded) {
        emit({
          type: 'order-result',
          orderNumber: row.order_number,
          status: 'skipped',
          errorMessage: 'Already successfully written previously under this run — not re-attempted.',
        });
        continue;
      }

      // CLAUDE_CODE_PROMPT (ESD writer changes, A2/A4) — the actionType
      // branch below is what STRUCTURALLY guarantees the ESD field is
      // never touched on the note_only_reissue path: `esd` is only ever
      // set on the esd_write branch, never merely omitted-but-computed. A
      // future edit to this function can't accidentally push an ESD onto
      // a note-only row without touching this exact branch.
      // The analyst's own corrections, typed in the review table. Applied
      // here rather than by rewriting the stored inference, so the audit
      // record still shows what the pipeline concluded AND the write shows
      // what the human decided — the two stay distinguishable.
      const override = overrides[row.order_number] ?? {};
      const effectiveEsd = override.esd ?? row.inferred_esd;
      const effectiveNotes = override.note ?? row.vendor_notes;
      if (override.esd || override.note) {
        log.info(
          { orderNumber: row.order_number, esdOverridden: !!override.esd, noteOverridden: !!override.note },
          'applying analyst correction from the review table',
        );
      }

      let writeUpdate: { esd?: string; noteText?: string };
      let mxiWriteAction: 'approved_write' | 'approved_note_only_write' | 'approved_manual_override_write';
      if (row.actionType === 'esd_write') {
        if (!effectiveEsd) {
          // Invariant violated for a naturally-classified row:
          // classifyRowAction() only returns 'esd_write' for flag === 'ok',
          // and applyInferenceRules.ts never leaves inferred_esd null while
          // flag stays 'ok'. For a manually-promoted row this can't happen
          // either — isManualPromotion is only ever set when override.esd
          // is truthy, which is exactly what effectiveEsd falls back to.
          // Fail loudly rather than silently write a blank/garbage ESD.
          throw new Error(
            `Row ${row.order_number} classified as esd_write but has no usable ESD (inferred or overridden) — this should be impossible.`,
          );
        }
        writeUpdate = {
          // The ESD FIELD still gets the buffered date (inferred_esd) —
          // unchanged. Only the NOTE changes, to state the vendor's own
          // pre-buffer assumed date instead (corrected 2026-08-20).
          //
          // An analyst-typed ESD replaces the inferred one outright: a
          // human correcting a misread is the more reliable source, and it
          // is written exactly as typed rather than re-buffered, since they
          // are stating the ship date they want, not a vendor's raw promise.
          esd: toMxiDateFormat(effectiveEsd),
          noteText:
            assembleNoteText(effectiveNotes, override.esd ?? row.extracted_base_date) ?? undefined,
        };
        mxiWriteAction = row.isManualPromotion ? 'approved_manual_override_write' : 'approved_write';
      } else {
        writeUpdate = { noteText: assembleNoteText(effectiveNotes, null) ?? undefined };
        mxiWriteAction = 'approved_note_only_write';
      }

      log.info(
        { orderNumber: row.order_number, actionType: row.actionType, env },
        'attempting esd write',
      );

      const result = await writeEsdAndNotes(client, row.order_number, writeUpdate);

      insertMxiWrite(db, {
        esdInferenceId: row.id,
        orderNumber: row.order_number,
        targetEnv: env,
        action: mxiWriteAction,
        // The value actually written — row.inferred_esd is null for a
        // manually-promoted row (the pipeline never inferred one), so
        // recording it here instead of effectiveEsd would leave the audit
        // trail silent about what really landed in MXI.
        inferredEsd: row.actionType === 'esd_write' ? effectiveEsd : null,
        writeStatus: result.status,
        errorMessage: result.errorMessage,
        approvedBy: 'esd-finder-ui',
      });

      // CLAUDE_CODE_PROMPT (AWB -> Inbound shipment, correction, 2026-09-10)
      // — per explicit user direction: a 12-digit number tied to the
      // keyword "AWB" in Vendor Notes is the vendor's OWN inbound AWB and
      // should be written into the order's inbound shipment. Deliberately
      // a SEPARATE step and a SEPARATE audit row from the ESD write above
      // (different MXI screen entirely — Receipt & Returns, not Schedule
      // Work Package), and only attempted once that write has already
      // succeeded, since a failed ESD write can leave the page in an
      // unconfirmed state this shouldn't build on. `ambiguous` (two
      // different 12-digit candidates found) is treated the same as "not
      // found" here — never guessed between them.
      //
      // **awbInboundSelectors.ts's own writeInboundAwb has never been run
      // against real MXI** (see that module's docstring) — this wiring
      // makes it reachable from the batch write flow for the first time.
      // Per this project's own established discipline for every other MXI
      // writer, this needs one real, watched smoke test (`npm run
      // mxi:write-inbound-awb` against a known order with a real inbound
      // shipment) before this path should be trusted unattended.
      let inboundAwbEnvelopeFields: Pick<EsdWriteEnvelope, 'inboundAwb' | 'inboundAwbStatus' | 'inboundAwbError'> = {};
      if (result.status === 'success') {
        const inboundAwbDetection = resolveInboundAwbFromNotes(effectiveNotes);
        if (inboundAwbDetection.awb) {
          log.info(
            { orderNumber: row.order_number, inboundAwb: inboundAwbDetection.awb },
            'detected inbound AWB in vendor notes — attempting to write it to the inbound shipment',
          );
          const awbResult = await writeInboundAwb(client, row.order_number, inboundAwbDetection.awb);
          insertMxiWrite(db, {
            esdInferenceId: row.id,
            orderNumber: row.order_number,
            targetEnv: env,
            action: 'approved_inbound_awb_write',
            inferredEsd: null,
            // No DB-level status for 'no_inbound_shipment_found' — recorded
            // as 'skipped' with the real reason in errorMessage instead of
            // widening writeStatus's own enum for one caller.
            writeStatus: awbResult.status === 'no_inbound_shipment_found' ? 'skipped' : awbResult.status,
            errorMessage:
              awbResult.status === 'no_inbound_shipment_found'
                ? `Detected AWB ${inboundAwbDetection.awb} in vendor notes, but this order has no inbound shipment (Ship To .../DOCK) yet.`
                : awbResult.errorMessage,
            approvedBy: 'esd-finder-ui',
          });
          inboundAwbEnvelopeFields = {
            inboundAwb: inboundAwbDetection.awb,
            inboundAwbStatus: awbResult.status,
            inboundAwbError: awbResult.errorMessage,
          };
        } else if (inboundAwbDetection.ambiguous) {
          log.warn(
            { orderNumber: row.order_number },
            'vendor notes contain two or more different 12-digit AWB candidates — not writing any of them',
          );
        }
      }

      emit({
        type: 'order-result',
        orderNumber: row.order_number,
        status: result.status,
        errorMessage: result.errorMessage,
        ...inboundAwbEnvelopeFields,
      });
    }
  } finally {
    await client.shutdown();
    db.close();
  }

  emit({ type: 'done' });
}

main().catch((err) => {
  emit({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
