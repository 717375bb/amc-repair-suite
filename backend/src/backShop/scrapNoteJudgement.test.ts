import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeScrapNote, noScrapNoteReason, normaliseNote } from './scrapNoteJudgement.js';

const NBSP = String.fromCharCode(160); // MXI ends every note cell with &nbsp;

// Both are the real #idCellPartNote contents of real production parts,
// captured 2026-08-27 while finding where the scrap wording actually lives.
const SCRAP_NOTE = `REPAIRS - HIGH SCRAP RATE. SEND TO DAY BACKSHOP MG 3.9.26${NBSP}`;
const NON_SCRAP_NOTE =
  `OOPP part CA\n\nSTORES - SEND TO TYS FOR REPAIR IF REPRQD - BACKSHOP: wire needs ` +
  `soldered or contact reattached per Jason Williams.${NBSP}`;

test('normaliseNote', async (t) => {
  await t.test('drops the trailing &nbsp; MXI appends to every note cell', () => {
    assert.equal(normaliseNote(`${NBSP}`), '');
    assert.equal(normaliseNote(`SCRAP IT${NBSP}`), 'SCRAP IT');
  });

  await t.test('collapses the newlines a <br>-separated note turns into', () => {
    assert.equal(normaliseNote('one\n\ntwo'), 'one two');
  });

  await t.test('survives a missing cell', () => {
    assert.equal(normaliseNote(null), '');
    assert.equal(normaliseNote(undefined), '');
  });
});

test('judgeScrapNote', async (t) => {
  await t.test('recommends on the real production scrap note, and quotes it', () => {
    const j = judgeScrapNote(SCRAP_NOTE);
    assert.equal(j.recommendation, 'scrap_recommended');
    assert.equal(j.evidence, 'REPAIRS - HIGH SCRAP RATE. SEND TO DAY BACKSHOP MG 3.9.26');
  });

  await t.test('does not recommend on the real production note that says something else', () => {
    assert.equal(judgeScrapNote(NON_SCRAP_NOTE).recommendation, 'no_scrap_note');
  });

  await t.test('recommends on word forms, not just the bare word', () => {
    for (const text of ['SCRAP', 'Scrapped at station', 'scrapping approved', 'to be SCRAPPED']) {
      assert.equal(
        judgeScrapNote(text).recommendation,
        'scrap_recommended',
        `expected "${text}" to recommend`,
      );
    }
  });

  await t.test('does not recommend on an empty or absent note', () => {
    for (const empty of [NBSP, '', null, undefined]) {
      const j = judgeScrapNote(empty);
      assert.equal(j.recommendation, 'no_scrap_note');
      assert.equal(j.evidence, null);
    }
  });

  // THE TWO REAL FALSE POSITIVES the live probes caught on 2026-08-27. The
  // word test matches both outright, as these assert — which is precisely
  // why safety comes from SCOPE: readPartScrapNote hands over the part note
  // cell alone, so neither string is ever a candidate.
  await t.test('would match the page chrome, which is why only the note cell is ever read', () => {
    const inventoryActionBar = 'Edit Inventory Quarantine Inventory Condemn Inventory Scrap Inventory';
    const partReliabilitySection = 'MTBR: MTBUR: MTBF: MTTR: Scrap Rate: 100% Financial';
    assert.equal(judgeScrapNote(inventoryActionBar).recommendation, 'scrap_recommended');
    assert.equal(judgeScrapNote(partReliabilitySection).recommendation, 'scrap_recommended');
  });
});

// Every string below is the real #idCellPartNote text of a real part from
// the 2026-08-27 back-shop listing, trimmed only in length. They are kept
// verbatim because the whole risk here is real notes phrased in ways a
// contrived fixture would never be.
test('judgeScrapNote against real production notes', async (t) => {
  await t.test('recommends the genuine scrap instructions', () => {
    const genuine: Array<[string, string]> = [
      ['CHP-400-1014-09A', 'SCRAP UPON REMOVAL - PLEASE DO NOT TURN IN. JN UNABLE TO TURN OFF REPAIR FLAG DUE TO TRANSACTIONS OPEN.'],
      ['C688123MJ103', 'REPAIRS - HIGH SCRAP RATE. SEND TO DAY BACKSHOP MG 3.9.26'],
      ['CDSP1814-515', 'REPAIRS - SCRAP IN-HOUSE. ITEM IS SCRAPPING AT OEM. THESE ARE NON-REP DUE TO PIECE PART.'],
      ['P01202-201WC', 'REPAIRS - DO NOT SEND OUT FOR SERVICE. THIS PN IS BEING REMOVED FROM FLEET. STORES TO SCRAP PER CONFIG CONTROL DH 3/24/23'],
      ['2LA006419-71', 'DO NOT SEND OUT FOR REPAIR - SCRAP UPON REMOVAL. JN T.O. Number: 33-079-001-23'],
      ['9326752-501', 'REPAIR - NON-REP CLASSIFIED UNIT - OEM NOT REPAIRING ONLY OFFERING REPLACEMENTS. DO NOT SEND OUT FOR REPAIR. SCRAP IN PSA INTERNAL SHOPS.'],
      // THE ONE THAT PINS THE LOOKBACK WINDOW: a "NOT" sits five words
      // before the word, in a different sentence, and means something else
      // entirely. Suppressing this would drop a part that must be scrapped.
      ['DK120', 'REPAIRS - ITEM BEING REPLACED WITH DK120/90. OEM DOES NOT WANT THIS SENT IN. SCRAP IN-HOUSE.'],
    ];
    for (const [part, note] of genuine) {
      assert.equal(judgeScrapNote(note).recommendation, 'scrap_recommended', `${part} should be recommended`);
    }
  });

  // THE REAL FALSE POSITIVE, caught on live data before this was wired to
  // anything: a bare word match pre-selected this part for an irreversible
  // scrap when its note forbids exactly that.
  await t.test('does NOT recommend the part whose note forbids scrapping', () => {
    const note = 'Vendor Code:6MXR1W -Natalia K 6/24/2026 In review for bench test with MeasureTech. Repairs do not scrap. 07/27';
    const j = judgeScrapNote(note);
    assert.equal(j.recommendation, 'scrap_negated');
    assert.match(noScrapNoteReason(note), /Note says NOT to scrap/);
  });

  await t.test('does not recommend the real notes that simply say something else', () => {
    const others = [
      'REPAIRABLE. ALT 4/16/14 PN CC670-33093-3 APPROVED BY VR. 2/8/16. JGD.',
      'THIS IS NOT A REPAIRABLE ITEM. FLAG NEEDS TO BE REMOVED. DH 1/26/2023 NON-REP. ALT 1/17/19',
      'REPAIRS - SEND TO DAY BACKSHOP FOR SERVICE. DH 12/5/23',
      'NON-REPAIRABLE. ALT 5/22/14',
      'REPAIR - REPAIR IN DAY REPAIR SHOP2',
    ];
    for (const note of others) {
      assert.equal(judgeScrapNote(note).recommendation, 'no_scrap_note', `should not recommend: ${note}`);
    }
  });

  // PINS A DELIBERATE LIMIT, not an oversight. Recognising BER / NREP /
  // NON-REP / non-repairable as meaning "scrap" was built on 2026-08-27 and
  // reverted the same day: scrapping is permanent, and those words sit on
  // real parts that are not to be scrapped. Against the live list it moved
  // 5 more parts into the PRE-SELECTED set, including three serials of
  // WE3876352-1 whose note is about test-only handling and pricing. If this
  // is ever revisited, it needs the analyst's explicit go-ahead — these
  // notes staying unrecommended is the intended behaviour.
  await t.test('does NOT infer a scrap from BER / NREP / non-repairable wording', () => {
    const impliesButDoesNotSay = [
      'NON-REPAIRABLE. ALT 5/22/14',
      'NON-REP/TEST ONLY. NOT COVERED UNDER SA AGREEMENT FOR REPAIR. Price of new $13,059. BBD 8/2022',
      'NREP per engineering 8/26',
      'Unit came back BER from vendor.',
      'WILL NEED TO MONITOR SVC ACTIVITY FOR BERs.',
    ];
    for (const note of impliesButDoesNotSay) {
      assert.equal(judgeScrapNote(note).recommendation, 'no_scrap_note', `should NOT be inferred a scrap: ${note}`);
    }
  });

  await t.test('treats a contradictory note as a candidate rather than resolving it silently', () => {
    const j = judgeScrapNote('Do not scrap. Scrap in-house per config control.');
    assert.equal(j.recommendation, 'scrap_recommended');
  });

  await t.test('catches the common negation phrasings', () => {
    for (const note of ['Do not scrap.', "Don't scrap this.", 'Never scrap - repair only.', 'No scrapping.']) {
      assert.equal(judgeScrapNote(note).recommendation, 'scrap_negated', `should be negated: ${note}`);
    }
  });
});

test('noScrapNoteReason', async (t) => {
  await t.test('distinguishes "no note at all" from "a note that does not say scrap"', () => {
    assert.match(noScrapNoteReason(NBSP), /No part note in MXI at all/);
    assert.match(noScrapNoteReason(NON_SCRAP_NOTE), /does not mention scrap: "OOPP part CA STORES/);
  });
});
