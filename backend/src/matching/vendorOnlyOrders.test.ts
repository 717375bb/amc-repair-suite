import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVendorOnlyOrders } from './vendorOnlyOrders.js';
import { matchOrders } from './matchOrders.js';
import type { VendorOorRow } from '../types.js';

const vendorRow = (overrides: Partial<VendorOorRow> = {}): VendorOorRow => ({
  orderNumber: 'P000AG1D',
  createDate: '2026-01-05',
  vendorName: 'AERO REPAIR',
  partDescription: 'WHEEL ASSY',
  partNumber: '5013640',
  serialNumber: 'JUL14-3229',
  outboundAwb: null,
  roEsd: '19-FEB-2026',
  currentStatus: 'IN WORK',
  vendorNotes: 'ESD 19FEB26',
  ...overrides,
});

describe('buildVendorOnlyOrders', () => {
  it('produces one order per vendor row, in the same order', () => {
    const rows = [vendorRow({ orderNumber: 'A' }), vendorRow({ orderNumber: 'B' }), vendorRow({ orderNumber: 'C' })];
    assert.deepEqual(buildVendorOnlyOrders(rows).map((o) => o.orderNumber), ['A', 'B', 'C']);
  });

  it('carries the vendor row through untouched — it holds every field the inference reads', () => {
    const row = vendorRow();
    const [order] = buildVendorOnlyOrders([row]);
    assert.equal(order.vendor, row);
    assert.equal(order.vendor?.roEsd, '19-FEB-2026');
    assert.equal(order.vendor?.currentStatus, 'IN WORK');
    assert.equal(order.vendor?.vendorNotes, 'ESD 19FEB26');
  });

  it('has no CRA side', () => {
    assert.equal(buildVendorOnlyOrders([vendorRow()])[0].cra, null);
  });

  it('REGRESSION: every row is flagged ok, never orphaned', () => {
    // The match flag becomes the row's ESD flag verbatim in
    // applyInferenceRules. Anything other than 'ok' here would make every
    // row non-actionable and the tab would silently write nothing.
    for (const order of buildVendorOnlyOrders([vendorRow(), vendorRow({ orderNumber: 'X' })])) {
      assert.equal(order.flag, 'ok');
    }
  });

  it('REGRESSION: matchOrders with an empty CRA list is NOT a substitute', () => {
    // Pins the reason this function exists at all.
    const viaMatch = matchOrders([vendorRow()], []);
    assert.equal(viaMatch[0].flag, 'orphaned_vendor_row', 'matchOrders orphans them — which is why it is not reused');
    assert.equal(buildVendorOnlyOrders([vendorRow()])[0].flag, 'ok');
  });

  it('applies vendor-assignment enrichment without dropping rows', () => {
    const assignments = [
      { vendorCode: 'X', vendorName: 'aero repair', certificateNumber: null, cra: 'Alex Morales', craEmail: 'a@psa.com' },
    ];
    const orders = buildVendorOnlyOrders([vendorRow(), vendorRow({ vendorName: 'SOMEONE ELSE' })], assignments);
    assert.equal(orders.length, 2, 'enrichment must never filter');
    assert.equal(orders[0].craOwnerName, 'Alex Morales');
    assert.equal(orders[1].craOwnerName, null);
  });

  it('handles a row with no vendor name', () => {
    const orders = buildVendorOnlyOrders([vendorRow({ vendorName: null })], []);
    assert.equal(orders[0].craOwnerName, null);
  });

  it('returns an empty array for no rows', () => {
    assert.deepEqual(buildVendorOnlyOrders([]), []);
  });
});
