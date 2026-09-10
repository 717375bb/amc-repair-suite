import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPartName } from './partName.js';

describe('extractPartName', () => {
  it('pulls the name out of a real work-package link text', () => {
    assert.equal(
      extractPartName('Repair (1) LIFEVEST - CREW CRJ (PN: D21344-195, SN: L903140)'),
      'LIFEVEST - CREW CRJ',
    );
  });

  it('handles a link with no duplicate marker', () => {
    assert.equal(
      extractPartName('Repair GEARBOX ASSY, FLAP ANGLE (PN: 766379, SN: 5435)'),
      'GEARBOX ASSY, FLAP ANGLE',
    );
  });

  it('handles a BN-labelled line — the label is inside the stripped suffix either way', () => {
    assert.equal(extractPartName('Repair STARTER MOTOR (PN: 2704554-3, BN: 440)'), 'STARTER MOTOR');
  });

  /**
   * REGRESSION: REPAIR_LINK_PATTERN was broadened on 2026-08-25 to stop
   * requiring a "Repair " prefix, specifically so packages this suite
   * renamed to "Scrap …" are still found. A ^Repair-only strip would leave
   * the verb in the displayed name for exactly those lines.
   */
  it('strips a Scrap prefix too, not just Repair', () => {
    assert.equal(
      extractPartName('Scrap (1) LIFEVEST - CREW CRJ (PN: D21344-195, SN: L903140)'),
      'LIFEVEST - CREW CRJ',
    );
  });

  it('keeps a name that contains parentheses of its own', () => {
    assert.equal(
      extractPartName('Repair BATTERY, APU (MODEL 40178-24) (PN: 40178-24, SN: 090520025353A)'),
      'BATTERY, APU (MODEL 40178-24)',
    );
  });

  it('returns an empty string when there is nothing usable, so callers can fall back', () => {
    assert.equal(extractPartName(''), '');
    assert.equal(extractPartName(null), '');
    assert.equal(extractPartName(undefined), '');
    assert.equal(extractPartName('Repair (PN: 12345, SN: 678)'), '');
  });

  it('does not mangle a name that never had a verb or a PN suffix', () => {
    assert.equal(extractPartName('WHEEL ASSY'), 'WHEEL ASSY');
  });

  it('does not strip a leading word that merely starts with the verb', () => {
    assert.equal(extractPartName('Repairable Widget (PN: X, SN: Y)'), 'Repairable Widget');
  });
});
