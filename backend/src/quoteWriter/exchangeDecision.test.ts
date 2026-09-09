import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeOrigin, exchangeOriginLabel, resolveIsExchange } from './exchangeDecision.js';
import { isHumanSettableDisposition, isWritable, resolveWriteAction } from './quoteDisposition.js';

test('resolveIsExchange', async (t) => {
  await t.test('uses the vendor document when the analyst has not decided', () => {
    assert.equal(resolveIsExchange({ vendorSuggested: true, humanDecision: null }), true);
    assert.equal(resolveIsExchange({ vendorSuggested: false, humanDecision: null }), false);
  });

  // The whole point of the addition: the AI missing an exchange must not be
  // the end of the matter.
  await t.test('an analyst can set an exchange the model did not find', () => {
    assert.equal(resolveIsExchange({ vendorSuggested: false, humanDecision: true }), true);
  });

  // And the reverse, because a one-way override leaves a wrong positive
  // with no remedy.
  await t.test('an analyst can clear an exchange the model wrongly found', () => {
    assert.equal(resolveIsExchange({ vendorSuggested: true, humanDecision: false }), false);
  });
});

test('exchangeOrigin keeps the source of the decision visible', async (t) => {
  await t.test('distinguishes all four states', () => {
    assert.equal(exchangeOrigin({ vendorSuggested: true, humanDecision: null }), 'vendor');
    assert.equal(exchangeOrigin({ vendorSuggested: false, humanDecision: true }), 'analyst_set');
    assert.equal(exchangeOrigin({ vendorSuggested: true, humanDecision: false }), 'analyst_cleared');
    assert.equal(exchangeOrigin({ vendorSuggested: false, humanDecision: null }), 'none');
  });

  await t.test('labels read as plain English', () => {
    assert.match(exchangeOriginLabel('analyst_set'), /set by analyst/);
    assert.match(exchangeOriginLabel('vendor'), /vendor offered/);
  });
});

test('the negotiating disposition holds a row out of the write set', async (t) => {
  await t.test('is not writable', () => {
    assert.equal(isWritable('negotiating'), false);
    // The states around it are unchanged.
    assert.equal(isWritable('pending'), true);
    assert.equal(isWritable('excluded_nrep'), true);
    assert.equal(isWritable('excluded_other'), false);
  });

  // It outranks even an exchange: a negotiation means PSA has asked for a
  // different price, so nothing should be committed on this row yet.
  await t.test('resolves to no action, even when the vendor offered an exchange', () => {
    assert.equal(resolveWriteAction('negotiating', false), 'none');
    assert.equal(resolveWriteAction('negotiating', true), 'none');
  });

  await t.test('does not disturb the existing precedence', () => {
    assert.equal(resolveWriteAction('excluded_other', true), 'none');
    assert.equal(resolveWriteAction('excluded_ber', true), 'scrap_price');
    assert.equal(resolveWriteAction('excluded_nrep', true), 'exchange');
    assert.equal(resolveWriteAction('excluded_nrep', false), 'scrap_price');
    assert.equal(resolveWriteAction('pending', false), 'price_line');
  });
});

test('NREP is now a decision an analyst may make', async (t) => {
  // Changed 2026-09-04. It was deliberately excluded before, as
  // vendor-derived only.
  await t.test('accepts excluded_nrep from a human', () => {
    assert.equal(isHumanSettableDisposition('excluded_nrep'), true);
  });

  await t.test('accepts negotiating, so a row can be released again', () => {
    assert.equal(isHumanSettableDisposition('negotiating'), true);
    assert.equal(isHumanSettableDisposition('pending'), true);
  });

  await t.test('still refuses anything that is not a real disposition', () => {
    assert.equal(isHumanSettableDisposition('scrapped'), false);
    assert.equal(isHumanSettableDisposition(''), false);
  });
});
