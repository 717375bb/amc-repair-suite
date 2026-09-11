import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInboundAwbFromNotes } from './inboundAwb.js';

test('resolveInboundAwbFromNotes — AWB followed by 12 digits', () => {
  assert.deepEqual(resolveInboundAwbFromNotes('Shipped back. AWB# 123456789012'), {
    awb: '123456789012',
    ambiguous: false,
  });
});

test('resolveInboundAwbFromNotes — 12 digits followed by AWB', () => {
  assert.deepEqual(resolveInboundAwbFromNotes('Tracking 123456789012 (AWB)'), {
    awb: '123456789012',
    ambiguous: false,
  });
});

test('resolveInboundAwbFromNotes — no AWB keyword at all returns null', () => {
  assert.deepEqual(resolveInboundAwbFromNotes('Part will ship 6/10, no tracking yet.'), {
    awb: null,
    ambiguous: false,
  });
});

test('resolveInboundAwbFromNotes — AWB keyword with no 12-digit number nearby returns null', () => {
  assert.deepEqual(resolveInboundAwbFromNotes('AWB pending, vendor has not provided one yet.'), {
    awb: null,
    ambiguous: false,
  });
});

test('resolveInboundAwbFromNotes — an unrelated 11 or 13 digit number near AWB is not matched', () => {
  assert.deepEqual(resolveInboundAwbFromNotes('AWB 1234567890123'), { awb: null, ambiguous: false });
  assert.deepEqual(resolveInboundAwbFromNotes('AWB 12345678901'), { awb: null, ambiguous: false });
});

test('resolveInboundAwbFromNotes — a 12-digit number far from any AWB mention is not matched', () => {
  const notes =
    'PO 123456789012 confirmed. '.padEnd(80, '.') + 'AWB to follow once shipped.';
  assert.deepEqual(resolveInboundAwbFromNotes(notes), { awb: null, ambiguous: false });
});

test('resolveInboundAwbFromNotes — two different 12-digit AWB candidates are flagged ambiguous, not guessed', () => {
  assert.deepEqual(
    resolveInboundAwbFromNotes('AWB 123456789012 for the first box, AWB 987654321098 for the second.'),
    { awb: null, ambiguous: true },
  );
});

test('resolveInboundAwbFromNotes — the same AWB mentioned twice is not ambiguous', () => {
  assert.deepEqual(
    resolveInboundAwbFromNotes('AWB 123456789012. Confirming AWB 123456789012 again.'),
    { awb: '123456789012', ambiguous: false },
  );
});

test('resolveInboundAwbFromNotes — null/empty input returns null', () => {
  assert.deepEqual(resolveInboundAwbFromNotes(null), { awb: null, ambiguous: false });
  assert.deepEqual(resolveInboundAwbFromNotes(undefined), { awb: null, ambiguous: false });
  assert.deepEqual(resolveInboundAwbFromNotes(''), { awb: null, ambiguous: false });
});
