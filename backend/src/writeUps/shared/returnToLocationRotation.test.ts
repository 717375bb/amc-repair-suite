import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextRotationLocation } from './returnToLocationRotation.js';
import { getVendorConfig } from './vendorRegistry.js';

/** The real BAE rotation, in the order the user specified it. */
const BAE = ['PHL/DOCK', 'DCA/DOCK', 'CLT/DOCK', 'DAY/DOCK'] as const;

describe('nextRotationLocation', () => {
  it('starts at the first location when there is no history', () => {
    assert.equal(nextRotationLocation(null, BAE), 'PHL/DOCK');
  });

  it('advances one step per call, in the specified order', () => {
    assert.equal(nextRotationLocation('PHL/DOCK', BAE), 'DCA/DOCK');
    assert.equal(nextRotationLocation('DCA/DOCK', BAE), 'CLT/DOCK');
    assert.equal(nextRotationLocation('CLT/DOCK', BAE), 'DAY/DOCK');
  });

  it('wraps from the last location back to the first', () => {
    assert.equal(nextRotationLocation('DAY/DOCK', BAE), 'PHL/DOCK');
  });

  it('walks the full cycle and returns to the start — no location is skipped or repeated', () => {
    const seen: string[] = [];
    let current: string | null = null;
    for (let i = 0; i < BAE.length; i++) {
      current = nextRotationLocation(current, BAE);
      seen.push(current);
    }
    assert.deepEqual(seen, [...BAE]);
    assert.equal(nextRotationLocation(current, BAE), BAE[0]);
  });

  it('is case- and whitespace-tolerant on the recorded value', () => {
    assert.equal(nextRotationLocation(' phl/dock ', BAE), 'DCA/DOCK');
  });

  /**
   * Real situation: a vendor whose earlier orders predate the rotation, or
   * whose rotation list was edited afterwards. Falling back to the start is
   * always a legal dock; inheriting an index from a list that no longer
   * exists would not be.
   */
  it('restarts from the beginning when the last used location is not in the rotation', () => {
    assert.equal(nextRotationLocation('GSP/DOCK', BAE), 'PHL/DOCK');
  });

  it('refuses to invent a location when the rotation is empty', () => {
    assert.throws(() => nextRotationLocation(null, []), /empty rotation/);
  });
});

describe('BAE Systems registry entry', () => {
  it('is registered with the four docks in the specified order', () => {
    const config = getVendorConfig('63760');
    assert.equal(config.displayName, 'BAE SYSTEMS CONTROLS INC');
    assert.deepEqual(config.returnToLocationRotation?.locations, [...BAE]);
  });

  it('resolves its Purchasing Contact to Monica Gonzalez, like her other vendors', () => {
    assert.equal(getVendorConfig('63760').form.purchasingContact, '232134');
  });

  it('leaves every other vendor without a rotation — this is a per-vendor exception', () => {
    assert.equal(getVendorConfig('VC01187').returnToLocationRotation, undefined);
    assert.equal(getVendorConfig('0T1Y4').returnToLocationRotation, undefined);
  });
});
