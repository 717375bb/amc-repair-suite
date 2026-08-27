import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  craOptions,
  eligibilityOf,
  exclusionReason,
  judgeFreshness,
  splitByEligibility,
  type BackShopRow,
} from './backShopRows.js';

const row = (over: Partial<BackShopRow> = {}): BackShopRow => ({
  partNumber: '110-333',
  serialNumber: '50133',
  partName: 'ANTENNA, ELT',
  cra: 'Brayden Bury',
  status: null,
  location: 'QRO/USSTG',
  workPackageNo: '52323918',
  sheetRow: 2,
  ...over,
});

describe('eligibilityOf', () => {
  it('treats a blank status as open', () => {
    assert.equal(eligibilityOf(row({ status: null })), 'open');
    assert.equal(eligibilityOf(row({ status: '' })), 'open');
  });

  it('REAL ROWS: excludes every scrap-related status on the live sheet', () => {
    // Verbatim from BackShopListing.xlsm, sheet "Today".
    for (const status of ['SCRAPPED', 'Sent to QRO for scrap', 'transfer qro scrap 8/1']) {
      assert.equal(eligibilityOf(row({ status })), 'already_handled', status);
    }
  });

  it('REAL ROWS: leaves unrelated statuses open', () => {
    for (const status of ['sourcing vendor', 'BFS, checking w proc f']) {
      assert.equal(eligibilityOf(row({ status })), 'open', status);
    }
  });

  it('REGRESSION: excluding is the safe direction, so it errs that way', () => {
    // Scrapping is irreversible and not idempotent. Over-excluding costs a
    // part not scrapped today, which is visible and recoverable;
    // under-excluding costs a double scrap, which is not.
    assert.equal(eligibilityOf(row({ status: 'scrapping today' })), 'already_handled');
    assert.equal(eligibilityOf(row({ status: 'SCRAP' })), 'already_handled');
  });

  it('does not fire on a word that merely contains "scrap"', () => {
    // Whole-word only: a longer token that merely contains "scrap" must
    // not trigger an exclusion, or unrelated notes would quietly remove
    // real work from the run.
    assert.equal(eligibilityOf(row({ status: 'scrapbook photo damage' })), 'open');
    assert.equal(eligibilityOf(row({ status: 'descrapification' })), 'open');
  });
});

describe('exclusionReason', () => {
  it('quotes the sheet verbatim rather than paraphrasing', () => {
    assert.equal(
      exclusionReason(row({ status: 'Sent to QRO for scrap' })),
      'Sheet Status already reads "Sent to QRO for scrap" — not offered again.',
    );
  });
});

describe('splitByEligibility', () => {
  it('separates handled rows from open ones, preserving order', () => {
    const rows = [
      row({ serialNumber: 'A', status: null }),
      row({ serialNumber: 'B', status: 'SCRAPPED' }),
      row({ serialNumber: 'C', status: 'sourcing vendor' }),
    ];
    const { open, alreadyHandled } = splitByEligibility(rows);
    assert.deepEqual(open.map((r) => r.serialNumber), ['A', 'C']);
    assert.deepEqual(alreadyHandled.map((r) => r.serialNumber), ['B']);
  });
});

describe('craOptions', () => {
  it('lists each CRA once, sorted', () => {
    const rows = [
      row({ cra: 'Landon Eagler' }),
      row({ cra: 'Brayden Bury' }),
      row({ cra: 'Landon Eagler' }),
      row({ cra: null }),
      row({ cra: '  ' }),
    ];
    assert.deepEqual(craOptions(rows), ['Brayden Bury', 'Landon Eagler']);
  });
});

describe('judgeFreshness', () => {
  const now = new Date(2026, 7, 27); // 27-AUG-2026

  it('accepts a sheet dated today', () => {
    const f = judgeFreshness(new Date(2026, 7, 27, 9, 30), now);
    assert.equal(f.isToday, true);
    assert.equal(f.warning, null);
  });

  it('WARNS on a stale sheet, naming both dates', () => {
    const f = judgeFreshness(new Date(2026, 7, 26), now);
    assert.equal(f.isToday, false);
    assert.match(f.warning ?? '', /26-AUG-2026/);
    assert.match(f.warning ?? '', /27-AUG-2026/);
  });

  it('REGRESSION: an unreadable date warns — it never passes as fine', () => {
    for (const bad of [null, new Date('nonsense')]) {
      const f = judgeFreshness(bad, now);
      assert.equal(f.isToday, false, 'must not be treated as today');
      assert.ok(f.warning, 'must warn');
    }
  });

  it('warns on a FUTURE-dated sheet too, not just a stale one', () => {
    assert.equal(judgeFreshness(new Date(2026, 7, 28), now).isToday, false);
  });
});
