import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertWriteUpAction } from '../../db/db.js';
import { findDoNotShipCandidates } from './doNotShipRecheck.js';
import { ZERO_USAGE_DO_NOT_SHIP_REASON } from './createOrderOnly.js';

function freshDb() {
  return openDb(':memory:');
}

test('findDoNotShipCandidates — finds an order whose latest row is order_created_do_not_ship with the zero-usage reason', () => {
  const db = freshDb();
  insertWriteUpAction(db, {
    vendor: '76863',
    partNumber: 'PN123',
    targetEnv: 'production',
    outcome: 'order_created_do_not_ship',
    stationCode: null,
    routedLocation: null,
    filledFieldsJson: JSON.stringify({ serialNumber: 'SN456', reason: ZERO_USAGE_DO_NOT_SHIP_REASON }),
    errorMessage: null,
    orderNumber: 'P000AAAA',
  });

  const candidates = findDoNotShipCandidates(db, 'production', 50);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    writeUpActionId: candidates[0].writeUpActionId,
    orderNumber: 'P000AAAA',
    partNumber: 'PN123',
    serialNumber: 'SN456',
  });
});

test('findDoNotShipCandidates — an order later cleared no longer appears (latest-row-wins)', () => {
  const db = freshDb();
  insertWriteUpAction(db, {
    vendor: '76863',
    partNumber: 'PN123',
    targetEnv: 'production',
    outcome: 'order_created_do_not_ship',
    stationCode: null,
    routedLocation: null,
    filledFieldsJson: JSON.stringify({ serialNumber: 'SN456', reason: ZERO_USAGE_DO_NOT_SHIP_REASON }),
    errorMessage: null,
    orderNumber: 'P000AAAA',
  });
  insertWriteUpAction(db, {
    vendor: 'DO_NOT_SHIP_RECHECK',
    partNumber: 'PN123',
    targetEnv: 'production',
    outcome: 'do_not_ship_note_cleared',
    stationCode: null,
    routedLocation: null,
    filledFieldsJson: null,
    errorMessage: null,
    orderNumber: 'P000AAAA',
  });

  assert.equal(findDoNotShipCandidates(db, 'production', 50).length, 0);
});

test('findDoNotShipCandidates — a DO NOT SHIP row for a different reason is excluded', () => {
  const db = freshDb();
  insertWriteUpAction(db, {
    vendor: '76863',
    partNumber: 'PN123',
    targetEnv: 'production',
    outcome: 'order_created_do_not_ship',
    stationCode: null,
    routedLocation: null,
    filledFieldsJson: JSON.stringify({ serialNumber: 'SN456', reason: 'SOME OTHER REASON' }),
    errorMessage: null,
    orderNumber: 'P000AAAA',
  });

  assert.equal(findDoNotShipCandidates(db, 'production', 50).length, 0);
});

test('findDoNotShipCandidates — scoped to the given target_env', () => {
  const db = freshDb();
  insertWriteUpAction(db, {
    vendor: '76863',
    partNumber: 'PN123',
    targetEnv: 'stage',
    outcome: 'order_created_do_not_ship',
    stationCode: null,
    routedLocation: null,
    filledFieldsJson: JSON.stringify({ serialNumber: 'SN456', reason: ZERO_USAGE_DO_NOT_SHIP_REASON }),
    errorMessage: null,
    orderNumber: 'P000AAAA',
  });

  assert.equal(findDoNotShipCandidates(db, 'production', 50).length, 0);
  assert.equal(findDoNotShipCandidates(db, 'stage', 50).length, 1);
});

test('findDoNotShipCandidates — respects the limit', () => {
  const db = freshDb();
  for (const order of ['P000A', 'P000B', 'P000C']) {
    insertWriteUpAction(db, {
      vendor: '76863',
      partNumber: 'PN123',
      targetEnv: 'production',
      outcome: 'order_created_do_not_ship',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber: 'SN456', reason: ZERO_USAGE_DO_NOT_SHIP_REASON }),
      errorMessage: null,
      orderNumber: order,
    });
  }

  assert.equal(findDoNotShipCandidates(db, 'production', 2).length, 2);
});

test('findDoNotShipCandidates — a row with unparseable filled_fields_json is skipped, not thrown', () => {
  const db = freshDb();
  insertWriteUpAction(db, {
    vendor: '76863',
    partNumber: 'PN123',
    targetEnv: 'production',
    outcome: 'order_created_do_not_ship',
    stationCode: null,
    routedLocation: null,
    filledFieldsJson: 'not json',
    errorMessage: null,
    orderNumber: 'P000AAAA',
  });

  assert.doesNotThrow(() => findDoNotShipCandidates(db, 'production', 50));
  assert.equal(findDoNotShipCandidates(db, 'production', 50).length, 0);
});
