import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOVAL_DATE_NOT_FOUND,
  composeRemovalDateLine,
  formatRemovalDate,
  pickMostRecentRemovalEvent,
  type HistoryEvent,
} from './removalDate.js';

/**
 * Shaped after the real recording
 * (discovery-find-removal-date-recording.ts), which highlighted
 * "Removal of BATTERY, APU (" against "…-AUG-2026 00:37 EDT".
 */
const ev = (name: string, rawDate: string): HistoryEvent => ({ name, rawDate });

describe('formatRemovalDate', () => {
  it('takes the DD-MMM-YYYY portion off a real MXI date cell', () => {
    assert.equal(formatRemovalDate('27-AUG-2026 00:37 EDT'), '27-AUG-2026');
  });

  it('zero-pads a single-digit day', () => {
    assert.equal(formatRemovalDate('7-AUG-2026 00:37 EDT'), '07-AUG-2026');
  });

  it('uppercases the month', () => {
    assert.equal(formatRemovalDate('27-Aug-2026 00:37 EDT'), '27-AUG-2026');
  });

  it('returns null when there is no date token', () => {
    assert.equal(formatRemovalDate(''), null);
    assert.equal(formatRemovalDate(null), null);
    assert.equal(formatRemovalDate(undefined), null);
    assert.equal(formatRemovalDate('no date here'), null);
  });

  it('REGRESSION: does not shift the calendar day', () => {
    // A 00:37 EDT timestamp is the exact case where a timezone round-trip
    // through a date library would render the previous day. The date is
    // taken verbatim off the page rather than reformatted.
    assert.equal(formatRemovalDate('01-JAN-2026 00:37 EDT'), '01-JAN-2026');
    assert.equal(formatRemovalDate('31-DEC-2026 23:59 EST'), '31-DEC-2026');
  });
});

describe('pickMostRecentRemovalEvent', () => {
  it('picks the removal even when a NEWER non-removal event exists', () => {
    // The rule that actually matters, per the user: "not necessarily the
    // most recent, but rather the most recent one with removal in its name".
    const events = [
      ev('Installation of BATTERY, APU (12345)', '12-SEP-2026 09:14 EDT'),
      ev('Removal of BATTERY, APU (12345)', '27-AUG-2026 00:37 EDT'),
      ev('Inspection', '05-SEP-2026 11:00 EDT'),
    ];
    const picked = pickMostRecentRemovalEvent(events);
    assert.equal(picked?.formatted, '27-AUG-2026');
    assert.match(picked?.event.name ?? '', /^Removal of/);
  });

  it('picks the most recent among several removals', () => {
    const events = [
      ev('Removal of BATTERY, APU (12345)', '27-AUG-2026 00:37 EDT'),
      ev('Removal of BATTERY, APU (12345)', '02-FEB-2024 08:00 EST'),
      ev('Removal of BATTERY, APU (12345)', '14-MAY-2025 16:20 EDT'),
    ];
    assert.equal(pickMostRecentRemovalEvent(events)?.formatted, '27-AUG-2026');
  });

  it('is case-insensitive on the event name', () => {
    assert.equal(pickMostRecentRemovalEvent([ev('REMOVAL OF WIDGET', '01-MAR-2026 10:00 EST')])?.formatted, '01-MAR-2026');
    assert.equal(pickMostRecentRemovalEvent([ev('removal of widget', '01-MAR-2026 10:00 EST')])?.formatted, '01-MAR-2026');
  });

  it('requires a whole word, so "removals"/"nonremoval" do not match', () => {
    assert.equal(pickMostRecentRemovalEvent([ev('Preremovalcheck', '01-MAR-2026 10:00 EST')]), null);
  });

  it('returns null when the history holds no removal at all', () => {
    const events = [ev('Installation of WIDGET', '12-SEP-2026 09:14 EDT'), ev('Inspection', '05-SEP-2026 11:00 EDT')];
    assert.equal(pickMostRecentRemovalEvent(events), null);
  });

  it('returns null for an empty history', () => {
    assert.equal(pickMostRecentRemovalEvent([]), null);
  });

  it('ignores a removal row whose date cannot be read', () => {
    // Half-known is not known — a removal with no readable date tells us
    // nothing, and must not beat a removal that does have one.
    const events = [ev('Removal of WIDGET', 'no date'), ev('Removal of WIDGET', '14-MAY-2025 16:20 EDT')];
    assert.equal(pickMostRecentRemovalEvent(events)?.formatted, '14-MAY-2025');
    assert.equal(pickMostRecentRemovalEvent([ev('Removal of WIDGET', 'no date')]), null);
  });

  it('on a same-day tie, keeps the first row in page order', () => {
    // MXI renders this table newest-first, so first-wins keeps the newer.
    const events = [
      ev('Removal of WIDGET (newer entry)', '27-AUG-2026 09:00 EDT'),
      ev('Removal of WIDGET (older entry)', '27-AUG-2026 01:00 EDT'),
    ];
    assert.match(pickMostRecentRemovalEvent(events)?.event.name ?? '', /newer/);
  });
});

describe('composeRemovalDateLine', () => {
  it('renders the exact wording the user specified', () => {
    assert.equal(composeRemovalDateLine('27-AUG-2026'), 'Removal date: 27-AUG-2026');
  });

  it('falls back to the placeholder when the history genuinely has no removal', () => {
    assert.equal(composeRemovalDateLine(null), `Removal date: ${REMOVAL_DATE_NOT_FOUND}`);
  });
});
