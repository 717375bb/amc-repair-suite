import test from 'node:test';
import assert from 'node:assert/strict';
import { noteStatesAYear, resolveExtractedDateYear, resolveNearestYear } from './bareDateYear.js';

// The day the EQD problem was diagnosed, so the fixtures below read the way
// they did on the real run.
const TODAY = new Date(2026, 7, 28); // 2026-08-28

test('noteStatesAYear', async (t) => {
  await t.test('says no for the real bare EQD notes from the live runs', () => {
    for (const note of ['EQD 8/26', 'EQD 9/2', 'EQD 8/28', 'EQD 7/21', 'Quote will follow']) {
      assert.equal(noteStatesAYear(note), false, `${note} states no year`);
    }
  });

  await t.test('says yes when the note really does carry a year', () => {
    for (const note of ['EQD 8/26/2026', 'EQD 8/26/26', 'ship date 2026-09-15', 'promised in 2027', '8-26-26']) {
      assert.equal(noteStatesAYear(note), true, `${note} states a year`);
    }
  });

  await t.test('handles a missing note', () => {
    assert.equal(noteStatesAYear(null), false);
    assert.equal(noteStatesAYear(undefined), false);
  });
});

test('resolveNearestYear', async (t) => {
  await t.test('keeps a date that is already the nearest occurrence', () => {
    assert.equal(resolveNearestYear('2026-08-28', TODAY), '2026-08-28');
  });

  // THE REAL REGRESSION: run 19 turned "EQD 7/21" into 2024-07-21, two years
  // out, which is what pushed every EQD into "No ESD Found".
  await t.test('pulls a model-invented past year back to the nearest occurrence', () => {
    assert.equal(resolveNearestYear('2024-07-21', TODAY), '2026-07-21');
    assert.equal(resolveNearestYear('2024-08-26', TODAY), '2026-08-26');
  });

  await t.test('a date a few days past stays in the past, per the agreed rule', () => {
    // 8/21 is a week ago; it must NOT roll forward to next year.
    assert.equal(resolveNearestYear('2024-08-21', TODAY), '2026-08-21');
  });

  await t.test('rolls into next year only when that is genuinely nearer', () => {
    // Late December is closer to next January than to last January.
    assert.equal(resolveNearestYear('2020-01-05', new Date(2026, 11, 20)), '2027-01-05');
  });

  await t.test('leaves an unparseable value alone rather than inventing one', () => {
    assert.equal(resolveNearestYear('not-a-date', TODAY), 'not-a-date');
  });

  await t.test('does not shift a Feb 29 date onto Mar 1', () => {
    // 2026 and 2027 are not leap years; 2028 is out of the considered range,
    // so the date is returned untouched rather than silently moved a day.
    const out = resolveNearestYear('2024-02-29', TODAY);
    assert.equal(out, '2024-02-29');
  });
});

test('resolveExtractedDateYear', async (t) => {
  await t.test('re-anchors the real "EQD 8/26" case and says it did', () => {
    const r = resolveExtractedDateYear('EQD 8/26', '2024-08-26', TODAY);
    assert.equal(r.iso, '2026-08-26');
    assert.equal(r.reanchored, true);
    assert.equal(r.originalIso, '2024-08-26');
  });

  // The asymmetry that matters: when the vendor DID state a year, it is the
  // vendor's date and must not be moved.
  await t.test('leaves the year alone when the note states one', () => {
    const r = resolveExtractedDateYear('EQD 8/26/2024', '2024-08-26', TODAY);
    assert.equal(r.iso, '2024-08-26');
    assert.equal(r.reanchored, false);
  });

  await t.test('reports no change when the model already had the nearest year', () => {
    const r = resolveExtractedDateYear('EQD 8/26', '2026-08-26', TODAY);
    assert.equal(r.iso, '2026-08-26');
    assert.equal(r.reanchored, false);
    assert.equal(r.originalIso, null);
  });

  await t.test('handles a null extracted date', () => {
    assert.equal(resolveExtractedDateYear('EQD 8/26', null, TODAY).iso, '');
  });
});
