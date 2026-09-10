import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_FLOW_REPAIR } from './vendorConfig.js';
import { getVendorConfig, VENDOR_REGISTRY } from './vendorRegistry.js';

const ANDRES_BATCH: readonly string[] = [
  '7WVJ2', 'VC00800', '89305', '0CAM5', '75818', '99167', '83014',
  'VC00462', 'VC00730', 'VC00679', 'VC00201', '1SMU4', '6FVE5', '4X623',
];

const FLIGHTSENSE_VENDORS: readonly string[] = ['0CAM5', '75818', '99167'];

/**
 * Per explicit user direction (2026-09-10): "nothing out of Ham Sund,
 * Hamilton Sundstrand, Ham Care, or anything in the Rockwell family goes
 * through warranty flow. They just get sent through repair flow, and then
 * issued and NOT moved to dock." Collins - VT (89305) confirmed explicitly
 * to count as the same lineage despite having no "Rockwell" in its name.
 */
const REPAIR_FLOW_VENDORS: readonly string[] = ['89305', '0CAM5', '75818', '99167', '1SMU4', '6FVE5', '4X623'];

describe('Andres Sabido vendor batch', () => {
  it('registers all 14 new vendors', () => {
    for (const code of ANDRES_BATCH) {
      assert.doesNotThrow(() => getVendorConfig(code), `${code} should be registered`);
    }
  });

  it('every vendor in the batch skips Move to Dock', () => {
    for (const code of ANDRES_BATCH) {
      assert.equal(getVendorConfig(code).skipMoveToDock, true, `${code} should have skipMoveToDock: true`);
    }
  });

  it('Rockwell - Seattle (already registered) also now skips Move to Dock', () => {
    assert.equal(getVendorConfig('76863').skipMoveToDock, true);
  });

  it('SKYPAXXX (7A9Y2) shipset case already skips Move to Dock via its own mechanism', () => {
    assert.equal(getVendorConfig('7A9Y2').shipsetCase?.moveToDockOnInitialRun, false);
  });

  it('the three FLIGHTSENSE vendors carry that charge-to-account suffix', () => {
    for (const code of FLIGHTSENSE_VENDORS) {
      assert.equal(getVendorConfig(code).form.chargeToAccountSuffix, 'FLIGHTSENSE', `${code} should use FLIGHTSENSE`);
    }
  });

  it('vendors outside the FLIGHTSENSE list use the ordinary family suffix', () => {
    assert.equal(getVendorConfig('7WVJ2').form.chargeToAccountSuffix, 'REPAIR');
    assert.equal(getVendorConfig('83014').form.chargeToAccountSuffix, 'REPAIR');
  });

  it('does NOT register Intelsat or Collins - Monroe — explicitly excluded', () => {
    assert.equal(VENDOR_REGISTRY['1NQ67'], undefined, 'Intelsat (1NQ67) must not be registered');
    assert.equal(VENDOR_REGISTRY['3TAH8'], undefined, 'Collins - Monroe (3TAH8) must not be registered');
  });

  it('Ham Sund/Hamilton Sundstrand/Ham Care/Rockwell-Collins/Collins-VT go through repair flow, issued and not docked', () => {
    for (const code of REPAIR_FLOW_VENDORS) {
      const config = getVendorConfig(code);
      assert.equal(config.authFlowPolicy.default, AUTH_FLOW_REPAIR, `${code} should default to REPAIR auth flow`);
      assert.equal(config.defaultTerminalState, 'ISSUE_AND_DOCK', `${code} should reach ISSUE_AND_DOCK`);
      assert.equal(config.skipMoveToDock, true, `${code} should still skip the actual Move to Dock step`);
    }
  });

  it('matches Rockwell - Seattle (76863), the vendor this rule was already proven against', () => {
    const rockwellSeattle = getVendorConfig('76863');
    for (const code of REPAIR_FLOW_VENDORS) {
      const config = getVendorConfig(code);
      assert.equal(config.authFlowPolicy.default, rockwellSeattle.authFlowPolicy.default);
      assert.equal(config.defaultTerminalState, rockwellSeattle.defaultTerminalState);
    }
  });

  it('vendors NOT in the Ham*/Rockwell/Collins-VT list keep the standard warranty flow', () => {
    const stillWarranty = getVendorConfig('7WVJ2');
    assert.notEqual(stillWarranty.authFlowPolicy.default, AUTH_FLOW_REPAIR);
    assert.equal(stillWarranty.defaultTerminalState, 'AUTHORIZATION_ONLY');
  });

  it('each new vendor resolves its Purchasing Contact to Andres Sabido', () => {
    for (const code of ANDRES_BATCH) {
      assert.equal(getVendorConfig(code).form.purchasingContact, '232275', `${code} should resolve to Andres's CRA code`);
    }
  });
});
