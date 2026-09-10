import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePathSegment, vendorFolderKey } from './saveApprovedQuotePdf.js';

describe('sanitizePathSegment', () => {
  it('leaves real vendor names essentially intact', () => {
    assert.equal(sanitizePathSegment('Barfield Precision Electronics, LLC'), 'Barfield Precision Electronics, LLC');
    assert.equal(sanitizePathSegment('AK-STRUCTURES, LLC'), 'AK-STRUCTURES, LLC');
  });

  it('leaves a real order number untouched', () => {
    assert.equal(sanitizePathSegment('P000BB8K'), 'P000BB8K');
  });

  /**
   * Windows drops trailing dots/spaces on directory names, so the folder
   * we create and the folder we later look for would disagree.
   * "AeroRepair Corp." is a real value from the live DB.
   */
  it('strips a trailing dot so the created and looked-up folder names agree', () => {
    assert.equal(sanitizePathSegment('AeroRepair Corp.'), 'AeroRepair Corp');
  });

  it('removes path separators — this input is model-extracted free text', () => {
    assert.equal(sanitizePathSegment('Acme/Parts'), 'Acme Parts');
    assert.equal(sanitizePathSegment('Acme\\Parts'), 'Acme Parts');
  });

  it('cannot be used to climb out of the Quotes folder', () => {
    assert.equal(sanitizePathSegment('..'), '');
    assert.equal(sanitizePathSegment('.'), '');
    assert.equal(sanitizePathSegment('../../etc'), 'etc');
  });

  it('removes the other Windows-illegal characters', () => {
    assert.equal(sanitizePathSegment('A<B>C:D"E|F?G*H'), 'A B C D E F G H');
  });

  it('drops control characters', () => {
    assert.equal(sanitizePathSegment(`Acme${String.fromCharCode(7)}Parts`), 'AcmeParts');
  });

  it('suffixes reserved Windows device names so the folder is creatable', () => {
    assert.equal(sanitizePathSegment('CON'), 'CON_');
    assert.equal(sanitizePathSegment('nul'), 'nul_');
  });

  it('returns empty for nothing usable, so the caller can fall back to _Unsorted', () => {
    assert.equal(sanitizePathSegment(null), '');
    assert.equal(sanitizePathSegment(undefined), '');
    assert.equal(sanitizePathSegment('   '), '');
    assert.equal(sanitizePathSegment('///'), '');
  });
});

describe('vendorFolderKey', () => {
  /**
   * The real reason this exists: the live DB holds three spellings of one
   * vendor. Without an equivalence key, auto-creating a folder per name
   * would scatter one vendor across three folders.
   */
  it('treats the real spelling variants of one vendor as the same folder', () => {
    const key = vendorFolderKey('Measure Tech');
    assert.equal(vendorFolderKey('MeasureTech'), key);
    assert.equal(vendorFolderKey('measure tech'), key);
  });

  it('collapses punctuation differences', () => {
    assert.equal(vendorFolderKey('Barfield, Inc.'), vendorFolderKey('Barfield Inc'));
  });

  it('does NOT merge genuinely different vendor entities', () => {
    assert.notEqual(vendorFolderKey('AeroRepair Corp.'), vendorFolderKey('AeroRepair South, LLC'));
  });
});
