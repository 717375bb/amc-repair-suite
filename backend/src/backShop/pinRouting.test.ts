import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMxiDateString, isPinBackShop, isPinPartNumber } from './pinRouting.js';

test('toMxiDateString — DD-MMM-YYYY, uppercased, zero-padded day', () => {
  assert.equal(toMxiDateString(new Date(2026, 5, 10)), '10-JUN-2026'); // June is month index 5
  assert.equal(toMxiDateString(new Date(2026, 0, 3)), '03-JAN-2026');
  assert.equal(toMxiDateString(new Date(2026, 11, 31)), '31-DEC-2026');
});

test('isPinBackShop — recognizes all four repair shops, case-insensitively', () => {
  assert.equal(isPinBackShop('CAK'), true);
  assert.equal(isPinBackShop('day'), true);
  assert.equal(isPinBackShop('Gsp'), true);
  assert.equal(isPinBackShop('ORF'), true);
  assert.equal(isPinBackShop('PNS'), false);
  assert.equal(isPinBackShop(null), false);
  assert.equal(isPinBackShop(undefined), false);
});

test('isPinPartNumber — matches the pin PN regardless of case/whitespace', () => {
  assert.equal(isPinPartNumber('4114T06P03'), true);
  assert.equal(isPinPartNumber('4114t06p03'), true);
  assert.equal(isPinPartNumber(' 4114T06P03 '), true);
});

test('isPinPartNumber — anything else, or missing, is not a pin', () => {
  assert.equal(isPinPartNumber('766383C'), false);
  assert.equal(isPinPartNumber(''), false);
  assert.equal(isPinPartNumber(null), false);
  assert.equal(isPinPartNumber(undefined), false);
});
