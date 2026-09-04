import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINTENANCE_RECORDS_EMAIL,
  MAINTENANCE_RECORDS_SUBJECT,
  composeMaintenanceRecordsBody,
  resolveMaintenanceRecordsMode,
} from './maintenanceRecordsDraft.js';

/**
 * A real zero-usage part, in the shape the write-up actually reports it:
 * the usage table exists and every value is zero, which is the whole
 * reason the records team is being written to.
 */
const REAL_INPUT = {
  partNumber: 'D21344-195',
  serialNumber: 'L903140',
  usageRows: [
    { label: 'CYCLES', tsn: '0', tso: '0', tsi: '0' },
    { label: 'HOURS', tsn: '0', tso: '0', tsi: '0' },
  ],
};

describe('maintenance records draft — fixed fields', () => {
  it('always addresses the Maintenance Records DL', () => {
    assert.equal(MAINTENANCE_RECORDS_EMAIL, 'DL_PSA_MaintenanceRecords@psaairlines.com');
  });

  it('always uses the exact subject the user specified', () => {
    assert.equal(MAINTENANCE_RECORDS_SUBJECT, 'Times and Cycles');
  });
});

describe('composeMaintenanceRecordsBody', () => {
  it('produces the full message', () => {
    assert.equal(
      composeMaintenanceRecordsBody(REAL_INPUT),
      [
        'Good morning Maintenance Records team!',
        '',
        'This part is showing with zero times and cycles. Can you please have this corrected? Thank you!',
        '',
        'PN: D21344-195    SN: L903140',
        'Usage Parm\tTSN\tTSO\tTSI',
        'CYCLES\t0\t0\t0',
        'HOURS\t0\t0\t0',
      ].join('\n'),
    );
  });

  it('places the barcode above the table and the order number below it', () => {
    // The layout the analyst specified on 2026-09-04: barcode immediately
    // before the table, order number after it behind a blank line so it
    // cannot read as another data row.
    assert.equal(
      composeMaintenanceRecordsBody({
        ...REAL_INPUT,
        barcode: 'IRFKE00070C2',
        orderNumber: 'P000BFXN',
      }),
      [
        'Good morning Maintenance Records team!',
        '',
        'This part is showing with zero times and cycles. Can you please have this corrected? Thank you!',
        '',
        'PN: D21344-195    SN: L903140',
        'Barcode: IRFKE00070C2',
        'Usage Parm\tTSN\tTSO\tTSI',
        'CYCLES\t0\t0\t0',
        'HOURS\t0\t0\t0',
        '',
        'Order Number: P000BFXN',
      ].join('\n'),
    );
  });

  // Per the analyst: omit, never "(not found)". A placeholder the records
  // team cannot act on is noise in a message they have to read.
  it('omits either line entirely when the value is unavailable', () => {
    const noBarcode = composeMaintenanceRecordsBody({ ...REAL_INPUT, orderNumber: 'P000BFXN' });
    assert.ok(!noBarcode.includes('Barcode'), 'no Barcode line when there is no barcode');
    assert.ok(noBarcode.includes('Order Number: P000BFXN'));

    const noOrder = composeMaintenanceRecordsBody({ ...REAL_INPUT, barcode: 'IRFKE00070C2' });
    assert.ok(!noOrder.includes('Order Number'), 'no Order Number line when there is no order');
    assert.ok(noOrder.includes('Barcode: IRFKE00070C2'));

    // Blank/whitespace values are treated as absent, not printed empty.
    const blank = composeMaintenanceRecordsBody({ ...REAL_INPUT, barcode: '   ', orderNumber: '' });
    assert.ok(!blank.includes('Barcode'));
    assert.ok(!blank.includes('Order Number'));
  });

  it('still produces the original message when neither is supplied', () => {
    // The pre-2026-09-04 shape, unchanged — proof this addition is additive.
    const body = composeMaintenanceRecordsBody(REAL_INPUT);
    assert.ok(body.endsWith('HOURS\t0\t0\t0'));
  });

  it('REGRESSION: names the part IN THE BODY', () => {
    // The subject is now fixed at "Times and Cycles" for every one of
    // these. The old mailto: version carried PN/SN in the SUBJECT and
    // nowhere else, so fixing the subject without this change would have
    // left the records team unable to tell which part was meant.
    const body = composeMaintenanceRecordsBody(REAL_INPUT);
    assert.ok(body.includes('PN: D21344-195'), 'body must name the part number');
    assert.ok(body.includes('SN: L903140'), 'body must name the serial number');
  });

  it('keeps the tab-separated table shape the records team reads', () => {
    const body = composeMaintenanceRecordsBody(REAL_INPUT);
    assert.ok(body.includes('Usage Parm\tTSN\tTSO\tTSI'));
    // Tabs, not spaces — the draft is sent as plain text precisely so the
    // columns survive.
    assert.ok(body.includes('CYCLES\t0\t0\t0'));
  });

  it('carries whatever usage parameters the part actually has', () => {
    // Never assume only CYCLES/HOURS — partOwnDetails.ts extracts rows
    // structurally and real parts show others (ADGHours, IDGDisconectTime).
    const body = composeMaintenanceRecordsBody({
      partNumber: 'X',
      serialNumber: 'Y',
      usageRows: [{ label: 'ADGDeployments', tsn: '0', tso: '0', tsi: '0' }],
    });
    assert.ok(body.includes('ADGDeployments\t0\t0\t0'));
    assert.ok(!body.includes('CYCLES'));
  });

  it('has no trailing blank line that would render as dead space', () => {
    assert.equal(composeMaintenanceRecordsBody(REAL_INPUT).endsWith('\n'), false);
  });
});

describe('resolveMaintenanceRecordsMode', () => {
  const withEnv = (value: string | undefined, run: () => void): void => {
    const previous = process.env.MAINTENANCE_RECORDS_MODE;
    if (value === undefined) delete process.env.MAINTENANCE_RECORDS_MODE;
    else process.env.MAINTENANCE_RECORDS_MODE = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.MAINTENANCE_RECORDS_MODE;
      else process.env.MAINTENANCE_RECORDS_MODE = previous;
    }
  };

  it('defaults to draft when unset', () => {
    withEnv(undefined, () => assert.equal(resolveMaintenanceRecordsMode(), 'draft'));
  });

  it('SAFETY: anything other than the exact string "send" is a draft', () => {
    // A typo or stray value must never cause mail to leave the mailbox.
    for (const value of ['Send', 'SEND', 'send ', 'true', '1', 'yes', '']) {
      withEnv(value, () =>
        assert.equal(resolveMaintenanceRecordsMode(), 'draft', `"${value}" must resolve to draft`),
      );
    }
  });

  it('only the exact string "send" enables sending', () => {
    withEnv('send', () => assert.equal(resolveMaintenanceRecordsMode(), 'send'));
  });
});
