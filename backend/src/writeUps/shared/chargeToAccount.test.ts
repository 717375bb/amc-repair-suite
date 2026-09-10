import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChargeToAccountWithSuffix,
  buildDefaultRepairChargeToAccount,
  buildHmvChargeToAccount,
  isHmvAccountBase,
} from './chargeToAccount.js';

describe('isHmvAccountBase', () => {
  it('recognizes the four real HMV bases', () => {
    for (const base of ['NQA', 'QRO', 'CKB', 'TUS']) {
      assert.equal(isHmvAccountBase(base), true, `${base} should be an HMV base`);
    }
  });

  it('rejects ordinary self-routing bases — these keep the default REPAIR account', () => {
    for (const base of ['CLT', 'DAY', 'PHL', 'DCA', 'CAK', 'DFW']) {
      assert.equal(isHmvAccountBase(base), false, `${base} should NOT be an HMV base`);
    }
  });

  it('is case-insensitive and whitespace-tolerant — MXI location casing genuinely varies by site', () => {
    assert.equal(isHmvAccountBase('nqa'), true);
    assert.equal(isHmvAccountBase(' Qro '), true);
  });

  it('treats an unreadable base as NOT an HMV base', () => {
    assert.equal(isHmvAccountBase(null), false);
    assert.equal(isHmvAccountBase(undefined), false);
    assert.equal(isHmvAccountBase(''), false);
  });
});

describe('buildHmvChargeToAccount', () => {
  it('appends the station name for NQA and QRO, per the real examples given', () => {
    assert.equal(buildHmvChargeToAccount('CR7ROUTINE+NONROUTINE', 'NQA'), 'CR7HMVNQA');
    assert.equal(buildHmvChargeToAccount('CR7ROUTINE+NONROUTINE', 'QRO'), 'CR7HMVQRO');
  });

  it('does NOT append the station name for CKB or TUS — confirmed asymmetry, not an oversight', () => {
    assert.equal(buildHmvChargeToAccount('CR7ROUTINE+NONROUTINE', 'CKB'), 'CR7HMV');
    assert.equal(buildHmvChargeToAccount('CR7ROUTINE+NONROUTINE', 'TUS'), 'CR7HMV');
  });

  it('preserves whatever CR-prefix MXI autofilled, CR9 included', () => {
    assert.equal(buildHmvChargeToAccount('CR9ROUTINE+NONROUTINE', 'NQA'), 'CR9HMVNQA');
    assert.equal(buildHmvChargeToAccount('CR9ROUTINE+NONROUTINE', 'CKB'), 'CR9HMV');
  });

  /**
   * REGRESSION: a real "CR7HMV" has already been seen live in this field.
   * The strict builder throws on it; this one must not, for the same
   * reason buildDefaultRepairChargeToAccount doesn't — the value is being
   * overwritten anyway, so failing a real line over the shape of the value
   * being replaced would be wrong.
   */
  it('never throws on an unusual autofilled value the way the strict builder does', () => {
    assert.throws(() => buildChargeToAccountWithSuffix('CR7HMV', 'REPAIR'));
    assert.equal(buildHmvChargeToAccount('CR7HMV', 'NQA'), 'CR7HMVNQA');
    assert.equal(buildHmvChargeToAccount('CR9HMVQRO', 'QRO'), 'CR9HMVQRO');
  });

  it('falls back to CR7 when the autofilled value has no recognizable CR-prefix at all', () => {
    assert.equal(buildHmvChargeToAccount('', 'NQA'), 'CR7HMVNQA');
    assert.equal(buildHmvChargeToAccount('something else entirely', 'CKB'), 'CR7HMV');
  });

  it('refuses to invent an account code for a base that is not an HMV base', () => {
    assert.throws(() => buildHmvChargeToAccount('CR7ROUTINE+NONROUTINE', 'CLT'), /not an HMV-account base/);
  });
});

describe('buildDefaultRepairChargeToAccount (unchanged behavior, pinned)', () => {
  it('still produces <prefix>REPAIR for ordinary bases', () => {
    assert.equal(buildDefaultRepairChargeToAccount('CR7ROUTINE+NONROUTINE'), 'CR7REPAIR');
    assert.equal(buildDefaultRepairChargeToAccount('CR9ROUTINE+NONROUTINE'), 'CR9REPAIR');
  });
});
