import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTransportationOverride, LONG_FREIGHT_TRANSPORTATION, FADEC_TRANSPORTATION } from './shipmentMethod.js';

// Monica Gonzalez's real vendor VC01187 (craAssignments.ts) — in scope for the oversized-structure rule.
const MONICA_VENDOR = 'VC01187';
// 0T1Y4 belongs to a different CRA (717375, Brayden Bury per craAssignments.ts) — out of scope for it.
const OTHER_CRA_VENDOR = '0T1Y4';
// A vendor code with no craAssignments.ts row at all.
const UNASSIGNED_VENDOR = 'ZZZZZ';

describe('resolveTransportationOverride — FADEC (broadly applicable)', () => {
  it('overrides to FEDEX-P1 for any vendor, not just Monica Gonzalez', () => {
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, 'FADEC'), FADEC_TRANSPORTATION);
    assert.equal(resolveTransportationOverride(OTHER_CRA_VENDOR, 'FADEC'), FADEC_TRANSPORTATION);
    assert.equal(resolveTransportationOverride(UNASSIGNED_VENDOR, 'FADEC'), FADEC_TRANSPORTATION);
  });

  it('matches as a substring and case-insensitively', () => {
    assert.equal(resolveTransportationOverride(OTHER_CRA_VENDOR, 'fadec unit'), FADEC_TRANSPORTATION);
    assert.equal(resolveTransportationOverride(OTHER_CRA_VENDOR, 'ELECTRONIC ENGINE CONTROL (FADEC)'), FADEC_TRANSPORTATION);
  });
});

describe('resolveTransportationOverride — oversized nacelle structures (Monica Gonzalez only)', () => {
  it('overrides to FEDEX-LT for Monica Gonzalez vendors', () => {
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, 'TRANSCOWL ASSY'), LONG_FREIGHT_TRANSPORTATION);
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, 'REVERSER GA UNIT'), LONG_FREIGHT_TRANSPORTATION);
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, 'INLET COWLING'), LONG_FREIGHT_TRANSPORTATION);
  });

  it('does NOT override for the same keyword on a vendor outside Monica Gonzalez — this scoping is load-bearing', () => {
    assert.equal(resolveTransportationOverride(OTHER_CRA_VENDOR, 'TRANSCOWL ASSY'), null);
  });

  it('does not override for an unregistered/unassigned vendor code', () => {
    assert.equal(resolveTransportationOverride(UNASSIGNED_VENDOR, 'TRANSCOWL ASSY'), null);
  });

  it('tolerates whitespace differences in hand-maintained descriptions', () => {
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, 'REVERSER  GA'), LONG_FREIGHT_TRANSPORTATION);
  });
});

describe('resolveTransportationOverride — no match', () => {
  it('returns null for an ordinary description', () => {
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, 'WHEEL ASSY'), null);
  });

  it('returns null for blank/missing descriptions', () => {
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, null), null);
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, undefined), null);
    assert.equal(resolveTransportationOverride(MONICA_VENDOR, ''), null);
  });
});
