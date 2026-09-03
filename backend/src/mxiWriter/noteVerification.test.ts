import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseNoteText, verifyNoteWrite } from './noteVerification.js';

const NBSP = String.fromCharCode(160);

// The real shapes involved. updateNoteToReceiver writes
// `${newEntry}\n\n${previousNote}` (newest first, since 2026-08-24); the
// field is read back with innerText, which reflows the blank line.
const PREVIOUS = '2.16.26 - Vendor advised unit inducted, awaiting teardown.';
const NEW_ENTRY = '8.28.26 - EQD 8/28 per vendor; ESD updated.';

test('normaliseNoteText', async (t) => {
  await t.test('treats MXI\'s &nbsp; and reflowed line breaks as no difference', () => {
    assert.equal(normaliseNoteText(`a${NBSP}b`), 'a b');
    assert.equal(normaliseNoteText('a\n\n\nb'), 'a b');
    assert.equal(normaliseNoteText('  a  b  '), 'a b');
  });

  await t.test('survives a blank or missing field', () => {
    assert.equal(normaliseNoteText(null), '');
    assert.equal(normaliseNoteText(NBSP), '');
  });
});

test('verifyNoteWrite', async (t) => {
  // THE REGRESSION THIS MODULE EXISTS FOR. Before the fix, the verification
  // expected `${previous}\n\n${new}` while the writer produces
  // `${new}\n\n${previous}` — so every note write onto an order that already
  // had history was reported as a failure, and then duplicated by the
  // self-heal. This asserts the real write order now verifies clean.
  await t.test('accepts the real newest-first order the writer produces', () => {
    const confirmed = `${NEW_ENTRY}\n\n${PREVIOUS}`;
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, confirmed);
    assert.equal(v.entryPresent, true);
    assert.equal(v.historyPreserved, true);
    assert.equal(v.occurrences, 1);
    assert.deepEqual(v.problems, []);
  });

  // Order must not matter: if the write order is ever changed back, or
  // differs per environment, the failsafe must still be correct.
  await t.test('accepts the opposite (oldest-first) order just as readily', () => {
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, `${PREVIOUS}\n\n${NEW_ENTRY}`);
    assert.equal(v.entryPresent, true);
    assert.equal(v.historyPreserved, true);
    assert.deepEqual(v.problems, []);
  });

  await t.test('accepts a field that was blank beforehand', () => {
    const v = verifyNoteWrite(null, NEW_ENTRY, NEW_ENTRY);
    assert.equal(v.entryPresent, true);
    assert.equal(v.historyPreserved, true);
  });

  await t.test('tolerates the whitespace innerText actually returns', () => {
    // Same content, reflowed: single newline, trailing nbsp, indented.
    const confirmed = `  ${NEW_ENTRY}\n   ${PREVIOUS}${NBSP}`;
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, confirmed);
    assert.deepEqual(v.problems, []);
  });

  // The two genuine failures. These must still fail — the point of loosening
  // the comparison is to stop false alarms, not to stop reporting real ones.
  await t.test('fails when the new entry never landed', () => {
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, PREVIOUS);
    assert.equal(v.entryPresent, false);
    assert.equal(v.historyPreserved, true);
    assert.match(v.problems[0], /new note entry is not in the field/);
  });

  await t.test('fails when prior history was destroyed', () => {
    // What a .fill() without the read-first step would have produced.
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, NEW_ENTRY);
    assert.equal(v.entryPresent, true);
    assert.equal(v.historyPreserved, false);
    assert.match(v.problems[0], /Prior note history is missing/);
  });

  await t.test('fails on a blank field after writing', () => {
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, null);
    assert.equal(v.entryPresent, false);
    assert.equal(v.historyPreserved, false);
    assert.equal(v.problems.length, 2);
  });

  // A duplicate is real damage worth reporting, but it is NOT a failed
  // write — the entry is there. Failing it would send the caller back into
  // the self-heal that created the duplicate in the first place.
  await t.test('counts a duplicated entry without calling the write a failure', () => {
    const confirmed = `${NEW_ENTRY}\n\n${NEW_ENTRY}\n\n${PREVIOUS}`;
    const v = verifyNoteWrite(PREVIOUS, NEW_ENTRY, confirmed);
    assert.equal(v.occurrences, 2);
    assert.equal(v.entryPresent, true);
    assert.equal(v.historyPreserved, true);
    assert.deepEqual(v.problems, []);
  });
});
