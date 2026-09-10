import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findUnfilledPlaceholders,
  negotiationBodyToHtml,
  renderNegotiationSeed,
} from './negotiationTemplate.js';

test('renderNegotiationSeed', async (t) => {
  await t.test('produces the analyst\'s own wording with the name filled in', () => {
    const seed = renderNegotiationSeed('Brennan');
    assert.equal(
      seed,
      [
        'Hello Brennan!',
        '',
        'Thank you for getting this quote sent over. Due to <reason>, is it possible you could get this repair down to <new price>? Thank you again!',
      ].join('\n'),
    );
  });

  // The extraction returns null rather than guessing when there is no
  // legible sign-off, so the seed has to cope with that without producing
  // "Hello null!" or "Hello !".
  await t.test('falls back to a neutral greeting when there is no name', () => {
    for (const missing of [null, '', '   ']) {
      assert.match(renderNegotiationSeed(missing), /^Hello there!/);
    }
  });

  // Left in on purpose — they are prompts for the analyst, not values we
  // can fill.
  await t.test('leaves <reason> and <new price> for the analyst to replace', () => {
    const seed = renderNegotiationSeed('Brennan');
    assert.ok(seed.includes('<reason>'));
    assert.ok(seed.includes('<new price>'));
  });

  await t.test('fails loudly when the template file is missing', () => {
    assert.throws(
      () => renderNegotiationSeed('Brennan', 'templates/does-not-exist.html'),
      /Could not read the negotiation template/,
    );
  });
});

test('negotiationBodyToHtml', async (t) => {
  await t.test('preserves the paragraph and line breaks the analyst typed', () => {
    const html = negotiationBodyToHtml('Hello Brennan!\n\nLine one\nLine two');
    assert.equal(html, '<p>Hello Brennan!</p>\n<p>Line one<br>Line two</p>');
  });

  // The analyst is typing free text that goes into an HTML email. A stray
  // angle bracket must arrive as an angle bracket, not as markup.
  await t.test('escapes anything that would otherwise be read as markup', () => {
    const html = negotiationBodyToHtml('Price is < 500 & "firm" <b>now</b>');
    assert.ok(html.includes('&lt; 500 &amp; &quot;firm&quot;'));
    assert.ok(!html.includes('<b>'));
  });

  await t.test('drops empty blocks rather than emitting empty paragraphs', () => {
    assert.equal(negotiationBodyToHtml('One\n\n\n\nTwo'), '<p>One</p>\n<p>Two</p>');
  });
});

test('findUnfilledPlaceholders', async (t) => {
  // The editor opens pre-filled, so sending the prompts verbatim to a
  // vendor is an easy and embarrassing mistake. The endpoint refuses on it.
  await t.test('catches a seed sent without being edited', () => {
    assert.deepEqual(findUnfilledPlaceholders(renderNegotiationSeed('Brennan')), [
      '<reason>',
      '<new price>',
    ]);
  });

  await t.test('catches a half-edited message', () => {
    const half = 'Hello Brennan!\n\nDue to the labor hours, can you get it to <new price>?';
    assert.deepEqual(findUnfilledPlaceholders(half), ['<new price>']);
  });

  await t.test('passes a properly filled message', () => {
    const done = 'Hello Brennan!\n\nDue to the labor hours, can you get this down to $1,200?';
    assert.deepEqual(findUnfilledPlaceholders(done), []);
  });
});
