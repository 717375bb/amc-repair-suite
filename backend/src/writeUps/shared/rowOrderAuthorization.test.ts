import test from 'node:test';
import assert from 'node:assert/strict';
import { isAwaitingRequestedAuthorization, parseRowOrderState } from './rowOrderAuthorization.js';

// Real rows from a captured 0T1Y4 grid (2026-09-04), as cell texts in DOM
// order. Note both groups: the order's own Status/Authorization, and the
// LATER Vendors/Shops group whose Status is also "APPROVED".
const ROW_WITH_APPROVED_ORDER = [
  '',
  'BOARD, PC, CONTACTOR INTERFACE',
  '820CE02Y01',
  'INTERCHG',
  '403',
  'PSA (PSA Airlines)',
  'Repair BOARD, PC, CONTACTOR INTERFACE (PN: 820CE02Y01, SN: 403)',
  'P000BFXN',
  'AUTH',
  'APPROVED',
  'DAY/USSTG',
  '',
  '',
  '',
  '0T1Y4 (BARFIELD PRECISION ELECTRONICS LLC)',
  'REPAIR',
  'APPROVED',
];

const ROW_WITH_NO_ORDER = [
  '',
  'CHART HOLDER SIDEWALL',
  '513-81-01',
  'INTERCHG',
  'BN 397338',
  'PSA (PSA Airlines)',
  'Repair CHART HOLDER SIDEWALL (PN: 513-81-01, SN: BN 397338)',
  '',
  '',
  '',
  'CKB/USSTG',
  '',
  '',
  '',
  '0T1Y4 (BARFIELD PRECISION ELECTRONICS LLC)',
  'REPAIR',
  'APPROVED',
];

test('parseRowOrderState', async (t) => {
  await t.test('reads the order number, status and authorization from a real row', () => {
    assert.deepEqual(parseRowOrderState(ROW_WITH_APPROVED_ORDER), {
      orderNumber: 'P000BFXN',
      orderStatus: 'AUTH',
      authorizationStatus: 'APPROVED',
    });
  });

  await t.test('returns nulls for a line that has no order yet', () => {
    assert.deepEqual(parseRowOrderState(ROW_WITH_NO_ORDER), {
      orderNumber: null,
      orderStatus: null,
      authorizationStatus: null,
    });
  });

  // THE TRAP THIS PARSER EXISTS TO AVOID. The Vendors/Shops group's own
  // Status is "APPROVED" on essentially every row, and it sits AFTER the
  // order group. Reading the row's text for /APPROVED|REQUESTED/, or
  // counting cells from either end, would pick up the wrong one.
  await t.test('does not mistake the vendor Status for the order Authorization', () => {
    const row = [...ROW_WITH_APPROVED_ORDER];
    row[9] = 'REQUESTED'; // the ORDER's authorization
    // row[16] stays 'APPROVED' — the VENDOR's status
    const state = parseRowOrderState(row);
    assert.equal(state.authorizationStatus, 'REQUESTED');
  });

  await t.test('a row with no order is unaffected by a vendor status of APPROVED', () => {
    assert.equal(parseRowOrderState(ROW_WITH_NO_ORDER).authorizationStatus, null);
  });

  await t.test('tolerates a truncated row rather than throwing', () => {
    assert.deepEqual(parseRowOrderState(['P000BFXN']), {
      orderNumber: 'P000BFXN',
      orderStatus: null,
      authorizationStatus: null,
    });
  });
});

test('isAwaitingRequestedAuthorization', async (t) => {
  await t.test('excludes an existing order whose authorization is only REQUESTED', () => {
    const row = [...ROW_WITH_APPROVED_ORDER];
    row[9] = 'REQUESTED';
    assert.equal(isAwaitingRequestedAuthorization(parseRowOrderState(row)), true);
  });

  // Both halves are required — this is the part most likely to be loosened
  // by mistake later.
  await t.test('does NOT exclude an existing order that is already APPROVED', () => {
    assert.equal(isAwaitingRequestedAuthorization(parseRowOrderState(ROW_WITH_APPROVED_ORDER)), false);
  });

  await t.test('does NOT exclude a line with no order at all', () => {
    assert.equal(isAwaitingRequestedAuthorization(parseRowOrderState(ROW_WITH_NO_ORDER)), false);
  });

  await t.test('is case-insensitive on the authorization value', () => {
    assert.equal(
      isAwaitingRequestedAuthorization({
        orderNumber: 'P000BFXN',
        orderStatus: 'AUTH',
        authorizationStatus: 'requested',
      }),
      true,
    );
  });
});
