import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMissingLink } from './clickActionLink.js';

// The real action bar of an MXI order page, as captured on 2026-08-28.
const REAL_ORDER_PAGE_LINKS = [
  'New Alerts',
  'Help',
  'Log Out',
  'Unauthorize Order',
  'Close Order',
  'Cancel Order',
  'Print Order',
  'Order Lines',
  'Details',
  'Filled Requests',
  'Authorization',
  'Receipt & Returns',
  'History',
];

test('describeMissingLink', async (t) => {
  // THE POINT. A 30s timeout used to say only "waiting for
  // getByRole('link', { name: 'Request Authorization' })", which reads to an
  // analyst as "the button is right there and it cannot see it". The message
  // has to name what WAS there.
  await t.test('names the links that were actually on the page', () => {
    const msg = describeMissingLink('Request Authorization', REAL_ORDER_PAGE_LINKS);
    assert.match(msg, /Could not find the "Request Authorization" action/);
    assert.match(msg, /"Unauthorize Order"/);
    assert.match(msg, /"Receipt & Returns"/);
  });

  // "Authorization" is present while "Request Authorization" is not — which
  // is exactly the already-authorized order. Surfacing the near match is
  // what turns a mystery into an explanation.
  await t.test('calls out near matches, which are usually the explanation', () => {
    const msg = describeMissingLink('Request Authorization', REAL_ORDER_PAGE_LINKS);
    assert.match(msg, /Closest matches present: "Authorization"/);
  });

  await t.test('distinguishes an empty page from a page without the link', () => {
    const msg = describeMissingLink('Request Authorization', []);
    assert.match(msg, /no links could be read from the page at all/);
    assert.match(msg, /still loading or had navigated elsewhere/);
  });

  await t.test('de-duplicates repeated names', () => {
    const msg = describeMissingLink('Issue Order', ['Close', 'Close', 'Close', 'Details']);
    assert.equal(msg.match(/"Close"/g)?.length, 1);
  });

  await t.test('caps a very long list rather than printing hundreds of links', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Link ${i}`);
    const msg = describeMissingLink('Issue Order', many);
    assert.match(msg, /\(\+35 more\)/);
  });
});
