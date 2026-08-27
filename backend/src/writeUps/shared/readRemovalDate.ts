/// <reference lib="dom" />
import type { Page } from 'playwright';
import { pickMostRecentRemovalEvent, type HistoryEvent } from './removalDate.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;
const TAB_TIMEOUT_MS = 30_000;

/**
 * Real URL markers, captured from production by
 * `npm run diag:removal-date -- 090520025353A`:
 *   after "Historical"  -> ...&aTab=Historical
 *   after "Additional"  -> ...&aTab=Historical.idTabAdditionalHistory
 * The first is a prefix of the second, which is fine — reaching Additional
 * necessarily means Historical was reached.
 */
const HISTORICAL_TAB_MARKER = 'aTab=Historical';
const ADDITIONAL_TAB_MARKER = 'aTab=Historical.idTabAdditionalHistory';

/** The real events table, confirmed by that same capture. */
const HISTORY_TABLE_SELECTOR = '#idTableAdditionalHistory';

/** The header cell naming the column that holds the event's own date. */
const EVENT_DATE_HEADER = 'Event Date';

/**
 * Fallback column index for the event date.
 *
 * The real header row reads "Event | Recorded By | Reason | Note | Event
 * Date | Usage at Event(colspan 3)", so summing colspans puts Event Date at
 * index 4 — which every captured data row confirms. Used only if the header
 * cannot be located at all.
 */
const EVENT_DATE_FALLBACK_INDEX = 4;

export type RemovalDateReadStatus =
  /** History read; the most recent "Removal ..." event's date is in `formatted`. */
  | 'found'
  /** History read successfully and genuinely holds no removal event. */
  | 'no_removal_event'
  /** The history could NOT be read. Never a placeholder — see below. */
  | 'unreadable';

export interface RemovalDateReadResult {
  status: RemovalDateReadStatus;
  /** DD-MMM-YYYY, only when status is 'found'. */
  formatted: string | null;
  /** How many event rows were parsed — 0 with status 'unreadable' means nothing was seen. */
  rowsSeen: number;
  /** Analyst-facing detail for the 'unreadable' case. */
  error: string | null;
}

/**
 * Reads a part's removal date from its Historical > Additional view.
 *
 * MUST be called with the part's own Inventory Details page already open.
 *
 * WHY 'unreadable' IS NOT A PLACEHOLDER: the caller writes
 * "Removal date: (not found)" when the history genuinely holds no removal
 * event, which is a real and legitimate answer. If a broken selector also
 * produced that, every Aerotron note would quietly carry "(not found)" and
 * look exactly like a correct one. The two are kept apart so a fault fails
 * the line instead.
 *
 * RETURNS THE PAGE TO THE DETAILS TAB before finishing. That is not
 * housekeeping — MXI remembers the active tab per session, and leaving it
 * on Historical would make the NEXT part open there too, where
 * `#idTableCurrentUsage` does not exist and the usage read would fail. That
 * exact mechanism caused a real bug in the in-house scrap flow on
 * 2026-08-25.
 */
export async function readRemovalDate(page: Page): Promise<RemovalDateReadResult> {
  const fail = (error: string): RemovalDateReadResult => ({ status: 'unreadable', formatted: null, rowsSeen: 0, error });

  try {
    // --- Historical, then Additional ---
    for (const [label, marker] of [
      ['Historical', HISTORICAL_TAB_MARKER],
      ['Additional', ADDITIONAL_TAB_MARKER],
    ] as const) {
      if (page.url().includes(ADDITIONAL_TAB_MARKER)) break;
      const link = page.getByRole('link', { name: label, exact: true });
      try {
        await link.first().waitFor({ state: 'visible', timeout: TAB_TIMEOUT_MS });
      } catch {
        return fail(`The "${label}" tab never became available on ${page.url()}.`);
      }
      await link.first().click();
      try {
        await page.waitForURL((url) => url.href.includes(marker), { timeout: TAB_TIMEOUT_MS });
      } catch {
        return fail(`Clicked "${label}" but the page never reached ${marker} (still on ${page.url()}).`);
      }
      await page.waitForTimeout(CLICK_DELAY_MS);
    }

    // --- read the events table ---
    const probe = await page.evaluate(
      ({ tableSelector, dateHeader, fallbackIndex }: { tableSelector: string; dateHeader: string; fallbackIndex: number }) => {
        const table = document.querySelector(tableSelector);
        if (!table) return { tableFound: false, events: [] as { name: string; rawDate: string }[] };

        // NO named helper functions in here. tsx/esbuild compiles this file
        // with keepNames, which wraps a const-assigned arrow in a
        // `__name(...)` helper that does not exist inside the page — a
        // factored-out helper dies at runtime with "__name is not defined".
        // Caught by replaying this reader against the real captured page
        // before it ever ran live; the same trap is documented in
        // createWorkPackage.ts.

        // Locate the Event Date column from the HEADER rather than trusting
        // a fixed index. This matters: the Note column frequently contains
        // dates of its own ("release date modified from ... to ..."), so
        // anything like "first cell holding a date" would read the wrong one
        // on those rows.
        let dateIndex = -1;
        const rows = Array.from(table.querySelectorAll('tr'));
        for (const row of rows) {
          let column = 0;
          let hit = -1;
          for (const cell of Array.from(row.querySelectorAll(':scope > td, :scope > th'))) {
            const headerText = ((cell as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
            if (headerText === dateHeader) {
              hit = column;
              break;
            }
            column += Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1;
          }
          if (hit >= 0) {
            dateIndex = hit;
            break;
          }
        }
        if (dateIndex < 0) dateIndex = fallbackIndex;

        const events: { name: string; rawDate: string }[] = [];
        for (const row of rows) {
          if (row.querySelectorAll('tr').length > 0) continue; // wrapper row
          const cells = Array.from(row.querySelectorAll(':scope > td, :scope > th'));
          if (cells.length <= dateIndex) continue;
          const name = ((cells[0] as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
          const rawDate = ((cells[dateIndex] as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
          if (!name || !rawDate) continue;
          events.push({ name, rawDate });
        }
        return { tableFound: true, events };
      },
      { tableSelector: HISTORY_TABLE_SELECTOR, dateHeader: EVENT_DATE_HEADER, fallbackIndex: EVENT_DATE_FALLBACK_INDEX },
    );

    if (!probe.tableFound) {
      return fail(`The event history table (${HISTORY_TABLE_SELECTOR}) was not on the page at ${page.url()}.`);
    }
    if (probe.events.length === 0) {
      // A rendered-but-empty table is not a confirmed "no removal" —
      // an empty parse is the same shape a broken column read produces.
      return fail(`The event history table was present but no event rows could be parsed from it.`);
    }

    // Rows are supplied in page order (MXI renders newest first), which is
    // what pickMostRecentRemovalEvent's tie-breaking relies on.
    const picked = pickMostRecentRemovalEvent(probe.events as HistoryEvent[]);
    if (!picked) {
      log.info({ rowsSeen: probe.events.length }, '[removal-date] history read, but it holds no "removal" event');
      return { status: 'no_removal_event', formatted: null, rowsSeen: probe.events.length, error: null };
    }

    log.info(
      { rowsSeen: probe.events.length, removalDate: picked.formatted, event: picked.event.name.slice(0, 80) },
      '[removal-date] most recent removal event found',
    );
    return { status: 'found', formatted: picked.formatted, rowsSeen: probe.events.length, error: null };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    // Always hand the page back on the Details tab — see the docstring.
    // Best-effort: a cleanup failure must not turn a good read into a bad
    // result, and the usage reader downstream re-selects Details itself if
    // it has to.
    try {
      const details = page.getByRole('link', { name: 'Details', exact: true });
      if ((await details.count()) > 0) {
        await details.first().click();
        await page.waitForTimeout(CLICK_DELAY_MS);
      }
    } catch {
      /* nothing to do — downstream re-checks which tab it is on */
    }
  }
}
