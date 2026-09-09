import Database from 'better-sqlite3';
import path from 'node:path';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

/**
 * CLAUDE_CODE_PROMPT (BAE Systems return-to rotation, 2026-09-10) — per
 * explicit user direction: this vendor's parts must go back to exactly one
 * of four docks, on a fixed indexed rotation, and "the last location a part
 * was sent to is always kept track of even between sessions (albeit, on the
 * same device)."
 *
 * WHERE THE POINTER LIVES, and why it isn't a counter.
 *
 * The rotation is derived from the real write-up history in
 * `data/audit.db`, not from a stored index. Two reasons, both concrete:
 *
 * 1. It gives the user's chosen semantics for free. They asked that the
 *    rotation advance ONLY when a line genuinely succeeds. The return-to
 *    location is persisted (inside `write_up_actions.filled_fields_json`)
 *    by exactly the five order-bearing outcomes and by nothing else — a
 *    line that failed before its order existed records no location, so it
 *    consumes no slot and the next line reuses that dock. A separate
 *    counter would have to be incremented somewhere, and every choice of
 *    where to increment it gets this rule subtly wrong.
 *
 * 2. `audit.db` is append-only today — there is no mutable-state table in
 *    it at all, and its own schema comments say so repeatedly. Introducing
 *    the first updatable counter row (with the read-modify-write race that
 *    implies across the concurrent runner processes this project already
 *    runs) is a real architectural change; deriving from history needs no
 *    schema change and no new write path.
 *
 * The history row is also self-documenting in a way a counter is not: it
 * records the dock that was actually typed into MXI, so "which location did
 * this part go back to" is answerable from the audit trail forever, not
 * just "what number was the pointer on".
 *
 * KNOWN, ACCEPTED GAP: the `authorization_not_confirmed` outcome does
 * create a real order (so a real dock was typed in) but persists only the
 * serial number and the authorization status, not the filled fields. Such a
 * line therefore does not advance the rotation, and the next line reuses
 * its dock. That matches the letter of "only advance on success" — it is a
 * needs-manual-review outcome — but it is a deliberate choice, not an
 * oversight, and it is the one case where the four docks can go briefly
 * uneven.
 *
 * Scoped per environment: a stage rehearsal must never move the production
 * rotation, and vice versa.
 */

export interface ReturnToLocationRotation {
  /** Human-readable id for logging/audit, e.g. "BAE_FOUR_DOCK_ROTATION". */
  id: string;
  /** The rotation, in the exact order it must cycle. */
  locations: readonly string[];
}

/**
 * The pure decision: given the location the previous successful line used,
 * which comes next. Separated from all DB access so the rule itself is
 * unit-testable with no database and no browser.
 *
 * Starts at the first location when there is no history, and also when the
 * last recorded location isn't part of the rotation at all — which is the
 * real situation for a vendor whose earlier orders predate this feature, or
 * whose rotation list is later edited. Falling back to the start is the
 * safe answer there: it is always a legal dock, and it never silently
 * inherits an index from a list that no longer exists.
 */
export function nextRotationLocation(lastUsed: string | null, locations: readonly string[]): string {
  if (locations.length === 0) {
    throw new Error('nextRotationLocation called with an empty rotation — refusing to invent a return-to location.');
  }
  if (!lastUsed) return locations[0];

  const normalized = lastUsed.trim().toUpperCase();
  const lastIndex = locations.findIndex((loc) => loc.trim().toUpperCase() === normalized);
  if (lastIndex < 0) return locations[0];

  return locations[(lastIndex + 1) % locations.length];
}

/**
 * Read-only handle onto the same audit DB every runner writes to, opened
 * lazily and reused for the life of the process.
 *
 * Deliberately NOT `openDb()`: that applies the schema and runs the
 * `ensureColumn` retrofits, which is a write path and entirely unnecessary
 * for a single lookup. `readonly: true` makes it structurally impossible
 * for this rotation lookup to modify the audit trail it is reading.
 */
let readonlyDb: Database.Database | null = null;

function getReadonlyAuditDb(): Database.Database | null {
  if (readonlyDb) return readonlyDb;
  try {
    readonlyDb = new Database(path.join('data', 'audit.db'), { readonly: true, fileMustExist: true });
    return readonlyDb;
  } catch (err) {
    // A missing/unreadable audit DB is survivable here — the caller falls
    // back to the start of the rotation. Never fail a real write-up over a
    // history lookup.
    log.warn(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      '[return-rotation] could not open the audit DB read-only — starting the rotation from the beginning',
    );
    return null;
  }
}

/**
 * The most recent return-to location this vendor actually used in this
 * environment, or null if it has none yet.
 *
 * `vendor` matches `write_up_actions.vendor`, which
 * vendorCodeOutcomeLogging.ts writes as `config.id` (the lowercased vendor
 * code), not the raw MXI code.
 */
function readLastUsedLocation(vendorConfigId: string, env: string): string | null {
  const db = getReadonlyAuditDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT json_extract(filled_fields_json, '$.returnToLocation') AS loc
           FROM write_up_actions
          WHERE vendor = ?
            AND target_env = ?
            AND json_extract(filled_fields_json, '$.returnToLocation') IS NOT NULL
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get(vendorConfigId, env) as { loc: string | null } | undefined;
    return row?.loc ?? null;
  } catch (err) {
    log.warn(
      { vendorConfigId, env, errorMessage: err instanceof Error ? err.message : String(err) },
      '[return-rotation] history lookup failed — starting the rotation from the beginning',
    );
    return null;
  }
}

/**
 * Resolves the return-to location for a vendor on a fixed rotation. Logs
 * the previous value, the chosen value and the rotation id win-or-lose,
 * same as resolveShipsetCase — a dispatch decision that affects a real
 * production write should be diagnosable from the run log alone.
 */
export function resolveRotatedReturnToLocation(
  rotation: ReturnToLocationRotation,
  vendorConfigId: string,
  env: string,
): string {
  const lastUsed = readLastUsedLocation(vendorConfigId, env);
  const chosen = nextRotationLocation(lastUsed, rotation.locations);
  log.info(
    { vendorConfigId, env, rotationId: rotation.id, lastUsed, chosen, rotation: rotation.locations },
    '[return-rotation] return-to location chosen by rotation',
  );
  return chosen;
}
