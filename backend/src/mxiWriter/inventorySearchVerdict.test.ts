import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchVerdict } from './inventorySearchVerdict.js';

// Both fixtures are verbatim slices of real production pages captured on
// 2026-08-27 (an inventory search for a deliberately bogus serial, and one
// for BN 397172 which a discovery run had wrongly reported as not found).
const EMPTY_PAGE =
  'Search Clear All Inventory Found 0 of 0 inventory items were found. Part Name OEM Part No ' +
  'Manufacturer Qty Serial No / Batch No Installed On Condition Issued Location Owner ' +
  'No inventory items were found. Close';

const ONE_HIT_PAGE =
  'Search Clear All Inventory Found 1 inventory item was found. Part Name OEM Part No Manufacturer ' +
  'Qty Serial No / Batch No Installed On Condition Issued Location Owner ASSY, CHART HOLDER ' +
  '14700AA 1SN56 1 EA BN 397172 REPREQ ORF/USSTG PSA Close';

// The search form before Search has been clicked, and mid-navigation: no
// verdict stated anywhere.
const NOT_YET = 'Inventory Search Search Criteria Search Type: Serial No / Batch No: Maximum Rows: 10 100 1000 Search Clear All';

test('parseSearchVerdict', async (t) => {
  await t.test('reads the real zero-result phrasing', () => {
    const v = parseSearchVerdict(EMPTY_PAGE);
    assert.deepEqual(v, { shown: 0, total: 0, raw: '0 of 0 inventory items were found' });
  });

  await t.test('reads the real single-result phrasing, which omits the "N of M" prefix', () => {
    const v = parseSearchVerdict(ONE_HIT_PAGE);
    assert.equal(v?.shown, 1);
    assert.equal(v?.total, null);
  });

  await t.test('reads a multi-result phrasing', () => {
    assert.deepEqual(parseSearchVerdict('10 of 57 inventory items were found.'), {
      shown: 10,
      total: 57,
      raw: '10 of 57 inventory items were found',
    });
  });

  // THE WHOLE POINT: a page that has not answered yet must be
  // distinguishable from a page that answered "none". Returning a zero-ish
  // value here is what produced the 2026-08-27 false "not found" on four
  // real parts that existed.
  await t.test('returns null - not zero - when the page has not stated an outcome', () => {
    assert.equal(parseSearchVerdict(NOT_YET), null);
    assert.equal(parseSearchVerdict(''), null);
  });

  await t.test('is not fooled by the trailing "No inventory items were found." sentence alone', () => {
    // That sentence carries no digits, so it can never be read as a count.
    assert.equal(parseSearchVerdict('No inventory items were found.'), null);
  });

  await t.test('tolerates the whitespace a page-text read actually produces', () => {
    assert.equal(parseSearchVerdict('0\n  of\n  0\n  inventory items\n  were found.')?.shown, 0);
  });
});
