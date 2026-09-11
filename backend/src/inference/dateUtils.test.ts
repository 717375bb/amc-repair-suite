import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatISO } from 'date-fns';
import { parseFlexibleDate } from './dateUtils.js';

test('parseFlexibleDate — a bare ISO date is unaffected (existing, correct behavior)', () => {
  const parsed = parseFlexibleDate('2026-09-02');
  assert.ok(parsed);
  assert.equal(formatISO(parsed!, { representation: 'date' }), '2026-09-02');
});

test('parseFlexibleDate — an Excel-cell midnight-UTC ISO string reads as that SAME calendar date, not one day earlier', () => {
  // Exactly what cleanCell() (parsers/cellUtils.ts) produces for a
  // Date-typed Excel cell showing September 2, via .toISOString() —
  // real bug found live: this used to come back as 2026-09-01 in any
  // timezone behind UTC (every US timezone).
  const parsed = parseFlexibleDate('2026-09-02T00:00:00.000Z');
  assert.ok(parsed);
  assert.equal(formatISO(parsed!, { representation: 'date' }), '2026-09-02');
});

test('parseFlexibleDate — the midnight-UTC fix does not misfire on a genuinely non-midnight timestamp', () => {
  // A real, meaningful time component (not the Excel-cell artifact shape)
  // must be left alone — only the exact T00:00:00[.000]Z form is special-cased.
  const parsed = parseFlexibleDate('2026-09-02T14:30:00.000Z');
  assert.ok(parsed);
  // Whatever this resolves to locally, it must NOT be silently truncated
  // to a bare date the way the midnight case is.
  assert.equal(parsed!.getUTCHours(), 14);
});

test('parseFlexibleDate — common vendor date formats still parse correctly', () => {
  assert.equal(formatISO(parseFlexibleDate('9/2/2026')!, { representation: 'date' }), '2026-09-02');
  assert.equal(formatISO(parseFlexibleDate('09/02/2026')!, { representation: 'date' }), '2026-09-02');
  assert.equal(formatISO(parseFlexibleDate('September 2, 2026')!, { representation: 'date' }), '2026-09-02');
});

test('parseFlexibleDate — null/blank input returns null', () => {
  assert.equal(parseFlexibleDate(null), null);
  assert.equal(parseFlexibleDate(undefined), null);
  assert.equal(parseFlexibleDate('   '), null);
});
