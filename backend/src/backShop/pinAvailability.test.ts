import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvailabilityColumnOffsets,
  extractUsageFromRowCells,
  resolvePinDestination,
  type PinBackShopAvailability,
} from './pinAvailability.js';

test('resolvePinDestination — real recorded values pick DAY (lowest total)', () => {
  // Exact values from discovery-pins-wrong-base-recording.ts: CAK 31+0=31,
  // DAY 30+0=30, GSP 72+112=184, ORF 88+84=172. DAY is genuinely lowest,
  // matching the recording's own real outcome (it shipped to DAY).
  const rows: PinBackShopAvailability[] = [
    { base: 'CAK', usUnits: 31, inRepair: 0 },
    { base: 'DAY', usUnits: 30, inRepair: 0 },
    { base: 'GSP', usUnits: 72, inRepair: 112 },
    { base: 'ORF', usUnits: 88, inRepair: 84 },
  ];

  const result = resolvePinDestination(rows);
  assert.equal(result.destination, 'DAY');
  assert.equal(result.tied, false);
  assert.deepEqual(result.totals, { CAK: 31, DAY: 30, GSP: 184, ORF: 172 });
});

test('resolvePinDestination — a tie for lowest reports no destination rather than guessing', () => {
  const rows: PinBackShopAvailability[] = [
    { base: 'CAK', usUnits: 10, inRepair: 0 },
    { base: 'DAY', usUnits: 5, inRepair: 5 },
    { base: 'GSP', usUnits: 50, inRepair: 50 },
    { base: 'ORF', usUnits: 60, inRepair: 60 },
  ];

  const result = resolvePinDestination(rows);
  assert.equal(result.destination, null);
  assert.equal(result.tied, true);
  assert.deepEqual(result.totals, { CAK: 10, DAY: 10, GSP: 100, ORF: 120 });
});

test('resolvePinDestination — a base missing from the input reads as a 0 total', () => {
  const rows: PinBackShopAvailability[] = [
    { base: 'CAK', usUnits: 5, inRepair: 5 },
    { base: 'GSP', usUnits: 5, inRepair: 5 },
    { base: 'ORF', usUnits: 5, inRepair: 5 },
  ];

  const result = resolvePinDestination(rows);
  assert.equal(result.destination, 'DAY');
  assert.equal(result.totals.DAY, 0);
});

// --- Real bug found live 2026-09-12: reading the wrong columns produced
// a false 0-0-0-0 tie on a table that actually had decisive numbers. ---

// The user's own real captured header row (second/sub-column header,
// "Location"/"Owner"/"Restock Level"/"On Order" presumably spanning both
// header rows via rowspan and so NOT appearing in this row's own cells).
const REAL_HEADER_CELLS = [
  'Avail', 'Resvd', 'Xfer (SRV)', 'In Kit',
  'U/S', 'Quar', 'Await Insp', 'In Repair', 'Condemn', 'Xfer (U/S)', 'In Kit',
];

// The user's own real captured data rows, 2026-09-12 — full 15-cell rows
// including the label, Owner, Restock Level, On Order, and all four
// Serviceable columns before U/S.
const REAL_ROW_CAK = ['CAK (AKRON-CANTON REGIONAL)', 'PSA', '-', '-', '56', '56', '-', '-', '3', '-', '-', '28', '-', '-', '-'];
const REAL_ROW_DAY = ['DAY (DAYTON/JAMES M. COX DAYTON INTL)', 'PSA', '-', '28', '-', '56', '-', '-', '86', '-', '-', '-', '-', '-', '-'];
const REAL_ROW_GSP = ['GSP (GREER/GREENVILLE SPARTANBURG INTL)', 'PSA', '-', '-', '74', '-', '-', '-', '44', '-', '-', '56', '-', '28', '-'];
const REAL_ROW_ORF = ['ORF (NORFOLK/INTL)', 'PSA', '-', '-', '56', '140', '-', '-', '116', '-', '-', '-', '-', '-', '-'];

test('computeAvailabilityColumnOffsets — derives the real offsets from the real header row', () => {
  const offsets = computeAvailabilityColumnOffsets(REAL_HEADER_CELLS);
  assert.deepEqual(offsets, { usFromEnd: 7, inRepairFromEnd: 4 });
});

test('computeAvailabilityColumnOffsets — null when the header does not state both labels', () => {
  assert.equal(computeAvailabilityColumnOffsets(['Avail', 'Resvd']), null);
  assert.equal(computeAvailabilityColumnOffsets(['U/S']), null);
  assert.equal(computeAvailabilityColumnOffsets([]), null);
});

test('extractUsageFromRowCells — real captured rows read correctly with the derived offsets (regression pin)', () => {
  const offsets = computeAvailabilityColumnOffsets(REAL_HEADER_CELLS)!;
  assert.deepEqual(extractUsageFromRowCells(REAL_ROW_CAK, offsets), { usUnits: 3, inRepair: 28 });
  assert.deepEqual(extractUsageFromRowCells(REAL_ROW_DAY, offsets), { usUnits: 86, inRepair: 0 });
  assert.deepEqual(extractUsageFromRowCells(REAL_ROW_GSP, offsets), { usUnits: 44, inRepair: 56 });
  assert.deepEqual(extractUsageFromRowCells(REAL_ROW_ORF, offsets), { usUnits: 116, inRepair: 0 });
});

test('the real table end-to-end: CAK (31) wins, not a 0-0-0-0 tie', () => {
  const offsets = computeAvailabilityColumnOffsets(REAL_HEADER_CELLS)!;
  const rows: PinBackShopAvailability[] = [
    { base: 'CAK', ...extractUsageFromRowCells(REAL_ROW_CAK, offsets) },
    { base: 'DAY', ...extractUsageFromRowCells(REAL_ROW_DAY, offsets) },
    { base: 'GSP', ...extractUsageFromRowCells(REAL_ROW_GSP, offsets) },
    { base: 'ORF', ...extractUsageFromRowCells(REAL_ROW_ORF, offsets) },
  ];

  const result = resolvePinDestination(rows);
  assert.equal(result.tied, false, 'must not report a tie on this real table');
  assert.equal(result.destination, 'CAK');
  assert.deepEqual(result.totals, { CAK: 31, DAY: 86, GSP: 100, ORF: 116 });
});
