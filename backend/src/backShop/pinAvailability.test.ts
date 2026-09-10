import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePinDestination, type PinBackShopAvailability } from './pinAvailability.js';

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
