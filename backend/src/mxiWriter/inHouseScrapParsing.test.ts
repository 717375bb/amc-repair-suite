import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  looksLikeDetailsTab,
  parseCurrentLocation,
  pickWorkPackageNameFieldIndex,
  toScrapWorkPackageName,
} from './inHouseScrapParsing.js';
import { repairLocationCandidates } from './scrapFlowHelpers.js';

/**
 * Real production page text, verbatim from the Inventory Details DETAILS
 * tab of part 820CE02Y01 / SN 403, captured by `npm run diag:usage-table`.
 * Trimmed only in length — the "Location:" line is exactly as MXI renders
 * it, tabs/spacing included.
 */
const REAL_DETAILS_TAB = [
  'Inventory Details  BOARD, PC, CONTACTOR INTERFACE (PN: 820CE02Y01, SN: 403)',
  'Help | Log Out | BRAYDEN BURY (PSA ADMIN)',
  'Loaded at 25-AUG-2026 08:49 EDT',
  'Details Open Historical Sub Inventory Timeline',
  'Inventory Information',
  'Condition:  REPREQ (Unserviceable)  Serviceable:',
  'Received Date:              Last Received Condition:        UNKNOWN (Unknown)',
  'ICN:                OEM Batch No:',
  'Location:   DAY/USSTG (Unserviceable Staging)',
  'Authority:',
  'Owner:      PSA (PSA Airlines)',
].join('\n');

/**
 * The real capture that produced the reported bug: serial L903140 read
 * while MXI had restored the session's previous tab (aTab=Open.OpenChecks).
 * Loaded from disk rather than inlined so the test is pinned to genuine
 * evidence, and skipped (not silently passed) if the file is ever removed.
 */
const CAPTURE_DIR = path.join('data', 'diagnostics');
function loadOpenTabCapture(): string | null {
  if (!fs.existsSync(CAPTURE_DIR)) return null;
  const hit = fs
    .readdirSync(CAPTURE_DIR)
    .filter((f) => f.startsWith('inhouse-scrap-L903140-') && f.endsWith('.txt'))
    .sort()
    .pop();
  if (!hit) return null;
  const raw = fs.readFileSync(path.join(CAPTURE_DIR, hit), 'utf8');
  const marker = '=== FULL PAGE TEXT ===';
  const idx = raw.indexOf(marker);
  return idx >= 0 ? raw.slice(idx + marker.length) : raw;
}

describe('parseCurrentLocation', () => {
  it('reads the base station off the real Details tab', () => {
    assert.equal(parseCurrentLocation(REAL_DETAILS_TAB), 'DAY/USSTG');
  });

  it('resolves that location to the right repair shops', () => {
    // DAY is the documented special case: DAY/REPAIR2/SHOP2, not REPAIR1.
    assert.deepEqual(repairLocationCandidates(parseCurrentLocation(REAL_DETAILS_TAB)), [
      'DAY/REPAIR2/SHOP2',
      'DAY/REPAIR1/SHOP1',
      'DAY/REPAIR',
    ]);
  });

  it('handles the label and value being split across lines', () => {
    // innerText puts separate table cells on separate lines sometimes.
    assert.equal(parseCurrentLocation('Condition: REPREQ\nLocation:\n\nPNS/USSTG (Unserviceable Staging)'), 'PNS/USSTG');
  });

  it('accepts mixed-case locations, which MXI genuinely renders', () => {
    // Confirmed live: PNS/Repair1/Shop1 alongside DFW/REPAIR1/SHOP1.
    assert.equal(parseCurrentLocation('Location: PNS/Repair1 (shop)'), 'PNS/Repair1');
  });

  it('takes only the base station and sub-location, not deeper segments', () => {
    assert.equal(parseCurrentLocation('Location: CLT/USSTG/RACK1'), 'CLT/USSTG');
  });

  it('returns empty for a page that states no location', () => {
    assert.equal(parseCurrentLocation('Inventory Details\nSome other page entirely'), '');
  });

  it('REGRESSION: never picks up another item\'s location from a grid', () => {
    // The old bare-token fallback returned PNS/STORE here — a DIFFERENT
    // item's location — which would have sent a real part to the wrong
    // site's repair shop. Failing visibly is the required behaviour.
    const searchGrid = 'Inventory Search Results\nPNS/STORE/017   L903140   another row  CLT/USSTG';
    assert.equal(parseCurrentLocation(searchGrid), '');
  });

  it('REGRESSION: "Work Location" column headers must not match', () => {
    // The Open Work Packages tab has a "Work Location" column. It must not
    // be mistaken for the item's own "Location:" field.
    assert.equal(parseCurrentLocation('Work Package  Due  Work Location  Start Date'), '');
  });
});

describe('looksLikeDetailsTab', () => {
  it('is true for the real Details tab', () => {
    assert.equal(looksLikeDetailsTab(REAL_DETAILS_TAB), true);
  });

  it('is false for the real Open.OpenChecks capture that caused the bug', () => {
    const openTab = loadOpenTabCapture();
    if (openTab === null) {
      // Never silently pass — say so loudly instead.
      throw new Error(
        `Missing evidence fixture: no inhouse-scrap-L903140-*.txt in ${CAPTURE_DIR}. ` +
          `Regenerate with: npm run diag:inhouse-scrap -- L903140 --env production`,
      );
    }
    assert.equal(looksLikeDetailsTab(openTab), false, 'the Open tab capture must NOT look like the Details tab');
    assert.equal(parseCurrentLocation(openTab), '', 'and it must yield no location at all');
    // This is precisely what the flow used to do next, and why it blamed
    // the part instead of the tab.
    assert.deepEqual(repairLocationCandidates(parseCurrentLocation(openTab)), []);
  });
});

/**
 * The real work-package name for the reported serial, verbatim from the
 * production capture (`inhouse-scrap-L903140-*.txt`). Note MXI's own "(1)"
 * duplicate marker — that has to survive the rename.
 */
const REAL_WP_NAME = 'Repair (1) LIFEVEST - CREW CRJ (PN: D21344-195, SN: L903140)';

describe('toScrapWorkPackageName', () => {
  it('renames the real captured work package', () => {
    assert.equal(
      toScrapWorkPackageName(REAL_WP_NAME),
      'Scrap (1) LIFEVEST - CREW CRJ (PN: D21344-195, SN: L903140)',
    );
  });

  it('preserves MXI\'s "(1)" duplicate marker', () => {
    assert.ok(toScrapWorkPackageName(REAL_WP_NAME).includes('(1)'));
  });

  it('is idempotent — a re-run never yields "Scrap Scrap"', () => {
    const once = toScrapWorkPackageName(REAL_WP_NAME);
    assert.equal(toScrapWorkPackageName(once), once);
    assert.ok(!/Scrap\s+Scrap/i.test(toScrapWorkPackageName(once)));
  });

  it('handles a name with no leading verb at all', () => {
    assert.equal(toScrapWorkPackageName('WIDGET (PN: X, SN: Y)'), 'Scrap WIDGET (PN: X, SN: Y)');
  });
});

describe('pickWorkPackageNameFieldIndex', () => {
  it('finds the field holding the current name', () => {
    const values = ['', 'SOME-CODE', REAL_WP_NAME, 'a description'];
    assert.equal(pickWorkPackageNameFieldIndex(values, REAL_WP_NAME), 2);
  });

  it('tolerates whitespace differences between the link text and the field', () => {
    const values = ['', '  Repair (1)   LIFEVEST - CREW CRJ (PN: D21344-195, SN: L903140) '];
    assert.equal(pickWorkPackageNameFieldIndex(values, REAL_WP_NAME), 1);
  });

  it('falls back to shape when the current name is not known exactly', () => {
    const values = ['CR7REPAIR', 'Repair WIDGET (PN: A, SN: B)', 'notes here'];
    assert.equal(pickWorkPackageNameFieldIndex(values, 'something else entirely'), 1);
  });

  it('does not grab an unrelated populated field', () => {
    // "CR7REPAIR" starts with no verb and has no (PN: — must not match.
    assert.equal(pickWorkPackageNameFieldIndex(['CR7REPAIR', 'scrap as NREP'], 'unknown'), -1);
  });

  it('REGRESSION: returns -1 rather than a wrong guess when nothing matches', () => {
    // -1 must make the caller FAIL. The bug was skipping the rename
    // silently and still reporting it as done.
    assert.equal(pickWorkPackageNameFieldIndex(['', '', ''], REAL_WP_NAME), -1);
  });

  it('matches an already-renamed package, so a retry still finds the field', () => {
    const renamed = toScrapWorkPackageName(REAL_WP_NAME);
    assert.equal(pickWorkPackageNameFieldIndex(['', renamed], renamed), 1);
  });
});
