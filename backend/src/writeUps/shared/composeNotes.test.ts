import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotesForNormalLine, composeNotesForBnLine } from './vendorCodeWriteUp.js';
import type { PartOwnDetails } from './partOwnDetails.js';

const NOTES_HEADER = 'Inspect and service as required.';

function fixture(partNumber: string): PartOwnDetails {
  return {
    partDescription: 'GEARBOX ASSY, FLAP ANGLE',
    partNumber,
    serialNumber: '5435',
    usageRows: [{ label: 'CYCLES', tsn: '20714', tso: '20714', tsi: '20714' }],
    usageTableFound: true,
    barcode: null,
    rawText: '',
  };
}

describe('composeNotesForNormalLine — PN-keyed modification instruction', () => {
  it('inserts the instruction before the usage table for a -055 part', () => {
    const note = composeNotesForNormalLine(fixture('822-1939-055'), NOTES_HEADER);
    const lines = note.split('\n');
    const modifyIdx = lines.indexOf('Please modify part to -55');
    const tableIdx = lines.indexOf('Usage Parm\tTSN\tTSO\tTSI');
    assert.ok(modifyIdx >= 0, 'modify-part line should be present');
    assert.ok(modifyIdx < tableIdx, 'modify-part line must come before the usage table');
  });

  it('inserts it for the -005 variant too', () => {
    const note = composeNotesForNormalLine(fixture('822-1939-005'), NOTES_HEADER);
    assert.match(note, /Please modify part to -55/);
  });

  it('does not add the instruction for an unrelated part', () => {
    const note = composeNotesForNormalLine(fixture('D21344-195'), NOTES_HEADER);
    assert.doesNotMatch(note, /Please modify part to -55/);
  });

  it('does not change an unrelated part\'s note at all (byte-for-byte, minus the new feature)', () => {
    const note = composeNotesForNormalLine(fixture('D21344-195'), NOTES_HEADER);
    assert.equal(
      note,
      'Inspect and service as required.\n\nGEARBOX ASSY, FLAP ANGLE (PN: D21344-195, SN: 5435)\nUsage Parm\tTSN\tTSO\tTSI\nCYCLES\t20714\t20714\t20714\n',
    );
  });

  it('places the modify-part line after a removal-date line when both apply', () => {
    const note = composeNotesForNormalLine(fixture('822-1939-055'), NOTES_HEADER, 'Removal date: 27-AUG-2026');
    const lines = note.split('\n');
    const removalIdx = lines.indexOf('Removal date: 27-AUG-2026');
    const modifyIdx = lines.indexOf('Please modify part to -55');
    const tableIdx = lines.indexOf('Usage Parm\tTSN\tTSO\tTSI');
    assert.ok(removalIdx >= 0 && modifyIdx >= 0);
    assert.ok(removalIdx < modifyIdx && modifyIdx < tableIdx);
  });
});

describe('composeNotesForBnLine — PN-keyed modification instruction', () => {
  it('stays header-only when no part number is given (existing behavior, unchanged)', () => {
    assert.equal(composeNotesForBnLine(NOTES_HEADER), 'Inspect and service as required.\n');
  });

  it('stays header-only for an unrelated part number', () => {
    assert.equal(composeNotesForBnLine(NOTES_HEADER, 'D21344-195'), 'Inspect and service as required.\n');
  });

  it('appends the modify-part instruction for a -055/-005 part even on a BN line', () => {
    assert.equal(
      composeNotesForBnLine(NOTES_HEADER, '822-1939-055'),
      'Inspect and service as required.\n\nPlease modify part to -55\n',
    );
    assert.equal(
      composeNotesForBnLine(NOTES_HEADER, '822-1939-005'),
      'Inspect and service as required.\n\nPlease modify part to -55\n',
    );
  });
});
