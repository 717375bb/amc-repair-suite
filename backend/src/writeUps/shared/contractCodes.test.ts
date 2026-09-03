import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_CODES,
  buildContractChargeToAccount,
  detectContractCode,
  resolveContract,
} from './contractCodes.js';

describe('detectContractCode', () => {
  it('finds each code in real-shaped notes', () => {
    assert.equal(detectContractCode('Charge to account PARKERCPH per contract'), 'PARKERCPH');
    assert.equal(detectContractCode('FOKKERPBH applies to this unit'), 'FOKKERPBH');
  });

  it('is case-insensitive — these notes are hand-typed', () => {
    assert.equal(detectContractCode('parkercph'), 'PARKERCPH');
    assert.equal(detectContractCode('FokkerPBH'), 'FOKKERPBH');
  });

  it('requires the WHOLE string, per the user\'s wording', () => {
    assert.equal(detectContractCode('NOTPARKERCPHX'), null);
    assert.equal(detectContractCode('XFOKKERPBHY'), null);
    assert.equal(detectContractCode('PARKER'), null);
    assert.equal(detectContractCode('FOKKER'), null);
  });

  it('returns null for notes with no code, and for empty input', () => {
    assert.equal(detectContractCode('Inspect and service as required. Provide estimate for approval. Provide new 8130 with times and cycles and SFR. Provide new certificate and test data sheet.'), null);
    assert.equal(detectContractCode(''), null);
    assert.equal(detectContractCode(null), null);
    assert.equal(detectContractCode(undefined), null);
  });

  it('when both codes appear, the FIRST in the notes wins', () => {
    assert.equal(detectContractCode('FOKKERPBH — correction: PARKERCPH'), 'FOKKERPBH');
    assert.equal(detectContractCode('PARKERCPH — correction: FOKKERPBH'), 'PARKERCPH');
  });
});

describe('buildContractChargeToAccount', () => {
  it('CORRECTION 2026-08-27: keeps the line\'s own CR-prefix', () => {
    // "these accounts DO need the CR7/9 prefix just like normal". The first
    // implementation wrote the bare code with no prefix.
    assert.equal(buildContractChargeToAccount('CR7ROUTINE+NONROUTINE', 'PARKERCPH'), 'CR7PARKERCPH');
    assert.equal(buildContractChargeToAccount('CR9ROUTINE+NONROUTINE', 'FOKKERPBH'), 'CR9FOKKERPBH');
  });

  it('REGRESSION: does not throw on an autofilled value of an unexpected shape', () => {
    // "CR7HMV" was hit live. buildChargeToAccountWithSuffix THROWS on
    // anything that is not exactly "<CR-prefix>ROUTINE+NONROUTINE", which
    // would fail a contract line over the shape of a value being
    // overwritten anyway.
    assert.equal(buildContractChargeToAccount('CR7HMV', 'PARKERCPH'), 'CR7PARKERCPH');
    assert.equal(buildContractChargeToAccount('CR12ANYTHING', 'FOKKERPBH'), 'CR12FOKKERPBH');
  });

  it('falls back to CR7 when there is no recognisable prefix at all', () => {
    // Same default and same reasoning as buildDefaultRepairChargeToAccount.
    assert.equal(buildContractChargeToAccount('', 'PARKERCPH'), 'CR7PARKERCPH');
    assert.equal(buildContractChargeToAccount('something else', 'FOKKERPBH'), 'CR7FOKKERPBH');
  });
});

describe('resolveContract', () => {
  it('produces the prefixed account for a line carrying a code', () => {
    assert.deepEqual(resolveContract('account FOKKERPBH', 'CR9ROUTINE+NONROUTINE'), {
      contractCode: 'FOKKERPBH',
      chargeToAccount: 'CR9FOKKERPBH',
    });
  });

  it('does nothing for a line with no code', () => {
    assert.deepEqual(resolveContract('Inspect and service as required. Provide estimate for approval. Provide new 8130 with times and cycles and SFR. Provide new certificate and test data sheet.', 'CR7ROUTINE+NONROUTINE'), {
      contractCode: null,
      chargeToAccount: null,
    });
  });

  it('SCOPE 2026-08-27: the vendor is not consulted at all', () => {
    // Widened from a fixed Parker vendor list, which was wrong on the
    // facts: FOKKERPBH is Aerotron's (2N512), not Parker's. The codes
    // travel with the contract, so any vendor in this engine can carry one.
    assert.equal(resolveContract('FOKKERPBH', 'CR7ROUTINE+NONROUTINE').contractCode, 'FOKKERPBH');
    assert.equal(resolveContract('PARKERCPH', 'CR7ROUTINE+NONROUTINE').contractCode, 'PARKERCPH');
  });

  it('covers every declared code', () => {
    for (const code of CONTRACT_CODES) {
      assert.equal(resolveContract(`note ${code} note`, 'CR7ROUTINE+NONROUTINE').contractCode, code);
    }
  });
});
