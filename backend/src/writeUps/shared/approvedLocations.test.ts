import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVED_BASES,
  evaluateBaseStation,
  extractBaseStation,
  isApprovedBase,
  routeBaseStation,
} from './approvedLocations.js';
import { transformReturnToLocation } from './scheduleWorkPackageForm.js';

/** Exactly the list the user gave on 2026-08-27. */
const USER_LIST = ['CAK', 'DCA', 'PHL', 'PNS', 'CVG', 'DAY', 'SAV', 'CLT', 'NQA', 'QRO', 'CKB', 'DFW', 'GSP', 'ORF', 'TYS', 'TUS'];

describe('APPROVED_BASES', () => {
  it('is exactly the list given, no more and no less', () => {
    assert.deepEqual([...APPROVED_BASES].sort(), [...USER_LIST].sort());
  });

  it('REGRESSION: contains TUS, not TUC', () => {
    // The 2026-08-26 code routed TUC (Tucumán, Argentina) to CLT. TUS
    // (Tucson International) is the real base; confirmed with the user.
    assert.ok(APPROVED_BASES.includes('TUS'));
    assert.ok(!APPROVED_BASES.includes('TUC'));
    assert.equal(isApprovedBase('TUC'), false);
  });
});

describe('extractBaseStation', () => {
  it('reads the base off a real location value', () => {
    assert.equal(extractBaseStation('DAY/USSTG'), 'DAY');
    assert.equal(extractBaseStation('PNS/Repair1/Shop1'), 'PNS');
  });

  it('uppercases, because MXI casing varies by site', () => {
    assert.equal(extractBaseStation('pns/Repair1'), 'PNS');
  });

  it('returns null when there is no "<CODE>/" shape at all', () => {
    assert.equal(extractBaseStation('no slash here'), null);
    assert.equal(extractBaseStation(''), null);
    assert.equal(extractBaseStation(null), null);
    assert.equal(extractBaseStation(undefined), null);
  });
});

describe('isApprovedBase', () => {
  it('accepts every base on the list', () => {
    for (const b of USER_LIST) assert.equal(isApprovedBase(b), true, b);
  });

  it('accepts them case-insensitively', () => {
    assert.equal(isApprovedBase('day'), true);
    assert.equal(isApprovedBase(' clt '), true);
  });

  it('rejects bases PSA does not operate out of', () => {
    // Real airports, deliberately not on the list.
    for (const b of ['BOS', 'JFK', 'LAX', 'ATL', 'MIA', 'TUC']) {
      assert.equal(isApprovedBase(b), false, b);
    }
  });

  it('rejects an empty or missing base', () => {
    assert.equal(isApprovedBase(''), false);
    assert.equal(isApprovedBase(null), false);
  });
});

describe('routeBaseStation', () => {
  it('routes NQA, QRO, CKB and TUS to CLT', () => {
    for (const b of ['NQA', 'QRO', 'CKB', 'TUS']) assert.equal(routeBaseStation(b), 'CLT', b);
  });

  it('routes every other approved base to itself', () => {
    for (const b of ['CAK', 'DCA', 'PNS', 'CVG', 'DAY', 'SAV', 'CLT', 'DFW', 'GSP', 'ORF', 'TYS']) {
      assert.equal(routeBaseStation(b), b, b);
    }
  });

  it('CHANGE 2026-08-27: PHL routes to ITSELF, not CLT', () => {
    // The 2026-08-26 code sent PHL to CLT. The user's approved list names
    // only NQA/QRO/CKB/TUS as CLT-handled, and confirmed PHL routes to
    // itself. This is a real change to where PHL parts are sent.
    assert.equal(routeBaseStation('PHL'), 'PHL');
  });
});

describe('evaluateBaseStation', () => {
  it('approves an ordinary base and routes it to itself', () => {
    assert.deepEqual(evaluateBaseStation('DAY/USSTG'), {
      baseStation: 'DAY',
      approved: true,
      routedTo: 'DAY',
      reason: null,
    });
  });

  it('approves a CLT-handled base and routes it to CLT', () => {
    assert.deepEqual(evaluateBaseStation('TUS/USSTG'), {
      baseStation: 'TUS',
      approved: true,
      routedTo: 'CLT',
      reason: null,
    });
  });

  it('rejects a non-approved base, naming it', () => {
    const result = evaluateBaseStation('BOS/USSTG');
    assert.equal(result.approved, false);
    assert.equal(result.baseStation, 'BOS');
    assert.equal(result.routedTo, null);
    assert.match(result.reason ?? '', /BOS is not a base PSA creates repair orders out of/);
  });

  it('REGRESSION: an unreadable location is NOT approved', () => {
    // "We could not tell which base this is" must never become "create the
    // order anyway".
    for (const bad of [null, undefined, '', 'no slash here']) {
      const result = evaluateBaseStation(bad);
      assert.equal(result.approved, false, String(bad));
      assert.equal(result.routedTo, null);
      assert.ok(result.reason);
    }
  });
});

describe('transformReturnToLocation shares one source of truth with the approval check', () => {
  it('sends CLT-handled bases to CLT/DOCK', () => {
    for (const b of ['NQA', 'QRO', 'CKB', 'TUS']) {
      assert.equal(transformReturnToLocation(`${b}/USSTG`), 'CLT/DOCK', b);
    }
  });

  it('sends every other approved base to its own dock', () => {
    assert.equal(transformReturnToLocation('DAY/USSTG'), 'DAY/DOCK');
    assert.equal(transformReturnToLocation('PHL/USSTG'), 'PHL/DOCK');
  });

  it('agrees with routeBaseStation for every approved base', () => {
    // The base a line is ACCEPTED for must never disagree with the base its
    // order is actually created against.
    for (const b of APPROVED_BASES) {
      assert.equal(transformReturnToLocation(`${b}/USSTG`), `${routeBaseStation(b)}/DOCK`, b);
    }
  });

  it('still throws on a value with no station shape', () => {
    assert.throws(() => transformReturnToLocation('garbage'), /Could not extract a station code/);
  });
});
