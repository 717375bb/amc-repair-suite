import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePartModificationNoteLine } from './partModificationNotes.js';

describe('resolvePartModificationNoteLine', () => {
  it('returns the instruction for both real PN variants', () => {
    assert.equal(resolvePartModificationNoteLine('822-1939-055'), 'Please modify part to -55');
    assert.equal(resolvePartModificationNoteLine('822-1939-005'), 'Please modify part to -55');
  });

  it('is not scoped to any particular vendor — applies wherever this PN shows up', () => {
    // No vendor parameter exists on this function at all — this test just
    // documents that fact so a future change adding vendor-scoping would
    // have to touch this test too.
    assert.equal(resolvePartModificationNoteLine('822-1939-055'), 'Please modify part to -55');
  });

  it('returns null for an unrelated part number', () => {
    assert.equal(resolvePartModificationNoteLine('D21344-195'), null);
  });

  it('returns null for blank input', () => {
    assert.equal(resolvePartModificationNoteLine(null), null);
    assert.equal(resolvePartModificationNoteLine(undefined), null);
    assert.equal(resolvePartModificationNoteLine(''), null);
  });
});
