import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendVendorTrailingNote, resolveVendorTrailingNoteLine } from './vendorTrailingNotes.js';

test('resolveVendorTrailingNoteLine — BAE Systems (63760) gets the SB compliance line', () => {
  assert.equal(
    resolveVendorTrailingNoteLine('63760'),
    'PLEASE COMPLY WITH SB 73-0035, SB 73-0036, SB 73-0044, and SB 73-0045.',
  );
});

test('resolveVendorTrailingNoteLine — every other vendor gets null', () => {
  assert.equal(resolveVendorTrailingNoteLine('76863'), null);
  assert.equal(resolveVendorTrailingNoteLine('1DH10'), null);
});

test('appendVendorTrailingNote — appends as a new paragraph after the existing note', () => {
  const notesText = 'Note To Vendor Header\n\nSome part line\nUsage Parm\tTSN\tTSO\tTSI\nCYCLES\t1\t1\t1\n';
  const result = appendVendorTrailingNote(notesText, '63760');
  assert.equal(
    result,
    'Note To Vendor Header\n\nSome part line\nUsage Parm\tTSN\tTSO\tTSI\nCYCLES\t1\t1\t1\n\n' +
      'PLEASE COMPLY WITH SB 73-0035, SB 73-0036, SB 73-0044, and SB 73-0045.\n',
  );
});

test('appendVendorTrailingNote — leaves notesText untouched for other vendors', () => {
  const notesText = 'Note To Vendor Header\n';
  assert.equal(appendVendorTrailingNote(notesText, '76863'), notesText);
});
