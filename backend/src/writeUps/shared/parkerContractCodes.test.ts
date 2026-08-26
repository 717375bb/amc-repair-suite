import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARKER_VENDOR_CODES,
  detectParkerContractCode,
  isParkerVendor,
  resolveParkerContract,
} from './parkerContractCodes.js';
import { getVendorConfig, VENDOR_REGISTRY } from './vendorRegistry.js';

describe('isParkerVendor', () => {
  it('matches every registered Parker vendor code', () => {
    for (const code of PARKER_VENDOR_CODES) assert.equal(isParkerVendor(code), true, code);
  });

  it('matches case-insensitively, since registry ids are lowercased', () => {
    assert.equal(isParkerVendor('3h889'), true);
    assert.equal(isParkerVendor(' 26433 '), true);
  });

  it('does not match other vendors', () => {
    for (const code of ['0T1Y4', '6MXR1', '21844', 'VC00664', '1JYM3']) {
      assert.equal(isParkerVendor(code), false, code);
    }
  });

  it('every Parker code is genuinely in the registry', () => {
    // Guards against the list here drifting from the real registry — a
    // typo would silently mean the rule never fires for that vendor.
    for (const code of PARKER_VENDOR_CODES) {
      assert.ok(VENDOR_REGISTRY[code], `${code} must exist in VENDOR_REGISTRY`);
    }
  });
});

describe('detectParkerContractCode', () => {
  it('finds each code in real-shaped notes', () => {
    assert.equal(detectParkerContractCode('Charge to account PARKERCPH per contract'), 'PARKERCPH');
    assert.equal(detectParkerContractCode('FOKKERPBH applies to this unit'), 'FOKKERPBH');
  });

  it('is case-insensitive — these notes are hand-typed', () => {
    assert.equal(detectParkerContractCode('parkercph'), 'PARKERCPH');
    assert.equal(detectParkerContractCode('FokkerPBH'), 'FOKKERPBH');
  });

  it('returns null for notes with no code, and for empty input', () => {
    assert.equal(detectParkerContractCode('Inspect and service as required.'), null);
    assert.equal(detectParkerContractCode(''), null);
    assert.equal(detectParkerContractCode(null), null);
    assert.equal(detectParkerContractCode(undefined), null);
  });

  it('requires a whole word, so a longer token does not trigger it', () => {
    assert.equal(detectParkerContractCode('NOTPARKERCPHX'), null);
    assert.equal(detectParkerContractCode('XFOKKERPBHY'), null);
  });

  it('when both codes appear, the FIRST in the notes wins', () => {
    // A note that names one code then corrects it reads in document order.
    assert.equal(detectParkerContractCode('FOKKERPBH — correction: PARKERCPH'), 'FOKKERPBH');
    assert.equal(detectParkerContractCode('PARKERCPH — correction: FOKKERPBH'), 'PARKERCPH');
  });
});

describe('resolveParkerContract', () => {
  it('uses the contract code VERBATIM as the charge to account, with no CR-prefix', () => {
    // Per explicit user direction. NOT "CR7PARKERCPH".
    assert.deepEqual(resolveParkerContract('3H889', 'account PARKERCPH'), {
      contractCode: 'PARKERCPH',
      chargeToAccount: 'PARKERCPH',
    });
    assert.deepEqual(resolveParkerContract('86329', 'FOKKERPBH'), {
      contractCode: 'FOKKERPBH',
      chargeToAccount: 'FOKKERPBH',
    });
  });

  it('does nothing for a Parker line whose notes carry no code', () => {
    assert.deepEqual(resolveParkerContract('3H889', 'Inspect and service as required.'), {
      contractCode: null,
      chargeToAccount: null,
    });
  });

  it('REGRESSION: does nothing for a NON-Parker vendor, even with the code present', () => {
    // The first implementation applied to every vendor in the shared
    // engine. An unrelated vendor whose notes happened to mention a code
    // would have had its account changed AND started issuing orders that
    // should have stopped at authorization-only.
    assert.deepEqual(resolveParkerContract('0T1Y4', 'account PARKERCPH'), {
      contractCode: null,
      chargeToAccount: null,
    });
  });
});

describe('REGRESSION: the rule must not mutate the shared vendor registry', () => {
  it('resolving a contract leaves the registry config untouched', () => {
    // The first implementation did `config.form.chargeToAccountSuffix =
    // 'PARKERCPH'`. Object.freeze on VENDOR_REGISTRY is SHALLOW, so
    // config.form stayed mutable and that assignment permanently re-coded
    // the vendor for the rest of the process: once ONE line carried the
    // code, every later line for that vendor inherited it whether or not
    // its own notes said so.
    const before = getVendorConfig('3H889').form.chargeToAccountSuffix;
    assert.equal(before, 'REPAIR', 'precondition: Parker starts on the warranty REPAIR suffix');

    resolveParkerContract('3H889', 'account PARKERCPH');
    resolveParkerContract('3H889', 'account FOKKERPBH');

    // A FRESH lookup, standing in for the next line in the same process.
    assert.equal(
      getVendorConfig('3H889').form.chargeToAccountSuffix,
      'REPAIR',
      'the registry must be unchanged — a contract line must not re-code later lines',
    );
  });
});
