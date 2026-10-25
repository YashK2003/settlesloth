'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseChat,
  parseAmount,
  parseRepayment,
  parseExclusions,
  isAmbiguous,
  normalizeName,
  cleanDescription
} = require('../src/fallbackParser');

const { PRESETS, getPresetById, getAllPresets } = require('../src/presets');

describe('Amount Parsing (parseAmount)', () => {
  test('parses plain numbers correctly', () => {
    assert.deepEqual(parseAmount('Paid 500 for dinner'), { amount: 500, raw: '500' });
    assert.deepEqual(parseAmount('1450 on Bescom app'), { amount: 1450, raw: '1450' });
    assert.deepEqual(parseAmount('salary 3000 cash'), { amount: 3000, raw: '3000' });
  });

  test('parses k shorthand notation (1.5k, 2.4k, 0.5k)', () => {
    assert.deepEqual(parseAmount('Paid 2.4k for beach shack dinner'), { amount: 2400, raw: '2.4k' });
    assert.deepEqual(parseAmount('Spent 1.5k on fuel'), { amount: 1500, raw: '1.5k' });
    assert.deepEqual(parseAmount('Dinner was 2k'), { amount: 2000, raw: '2k' });
    assert.deepEqual(parseAmount('Sent 0.5k'), { amount: 500, raw: '0.5k' });
    assert.deepEqual(parseAmount('Package was 2.4K'), { amount: 2400, raw: '2.4K' });
  });

  test('parses currency symbols and prefixes (₹, Rs., INR)', () => {
    assert.deepEqual(parseAmount('Maybe ₹350 for scooter petrol'), { amount: 350, raw: '₹350' });
    assert.deepEqual(parseAmount('Rs. 1800 paid by card'), { amount: 1800, raw: 'Rs. 1800' });
    assert.deepEqual(parseAmount('Rs 1200 for umbrella'), { amount: 1200, raw: 'Rs 1200' });
    assert.deepEqual(parseAmount('INR 3100 via UPI'), { amount: 3100, raw: 'INR 3100' });
    assert.deepEqual(parseAmount('₹ 2.4k for dinner'), { amount: 2400, raw: '₹ 2.4k' });
  });

  test('parses decimals and comma-formatted numbers', () => {
    assert.deepEqual(parseAmount('Paid 350.50 for breakfast'), { amount: 350.5, raw: '350.50' });
    assert.deepEqual(parseAmount('Groceries came to ₹ 1,650.75'), { amount: 1650.75, raw: '₹ 1,650.75' });
    assert.deepEqual(parseAmount('Paid 10,000 for advance'), { amount: 10000, raw: '10,000' });
  });

  test('safely skips numbers attached to non-currency units', () => {
    assert.equal(parseAmount('Ready in 10 mins for watersports'), null);
    assert.equal(parseAmount('Ordered at 2am'), null);
    assert.equal(parseAmount('12 msgs in chat'), null);
    assert.equal(parseAmount('Split among 4 friends'), null);
    // Skips 20L volume but extracts subsequent 180 currency amount
    assert.deepEqual(parseAmount('Ordered drinking water 20L cans 180 yesterday'), { amount: 180, raw: '180' });
  });

  test('returns null for empty, invalid, or non-financial input', () => {
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('   '), null);
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount(undefined), null);
    assert.equal(parseAmount('Goa sunsets are amazing guys'), null);
  });
});

describe('Repayment and Exclusion Parsing', () => {
  test('extracts direct repayments and recipients', () => {
    const r1 = parseRepayment('I sent Rahul 500 on GPay yesterday for breakfast', 'Aman');
    assert.ok(r1);
    assert.equal(r1.recipient, 'Rahul');
    assert.equal(r1.rawAmount, '500');

    const r2 = parseRepayment('Sent Vikram 1000 on PhonePe for maid advance', 'Sneha');
    assert.ok(r2);
    assert.equal(r2.recipient, 'Vikram');
    assert.equal(r2.rawAmount, '1000');

    const r3 = parseRepayment('Sent Dev 400 via UPI for midnight coffees', 'Tara');
    assert.ok(r3);
    assert.equal(r3.recipient, 'Dev');
    assert.equal(r3.rawAmount, '400');

    const r4 = parseRepayment('Transferred 1.5k to Priya', 'Rahul');
    assert.ok(r4);
    assert.equal(r4.recipient, 'Priya');
    assert.equal(r4.rawAmount, '1.5k');
  });

  test('returns null for repayments where recipient cannot be determined or is self', () => {
    assert.equal(parseRepayment('Paid 1500 for dinner', 'Rahul'), null);
    assert.equal(parseRepayment('Sent 500 on GPay', 'Aman'), null);
    assert.equal(parseRepayment('Sent Aman 500', 'Aman'), null); // self-repayment rejected
  });

  test('extracts participant exclusions', () => {
    const e1 = parseExclusions("Paid 4000 for scuba package, don't count Aman he didn't do watersports");
    assert.deepEqual(e1, ['Aman']);

    const e2 = parseExclusions('Dinner was 2400, skip Sneha');
    assert.deepEqual(e2, ['Sneha']);

    const e3 = parseExclusions('Drinks came to 850 (except Vikram)');
    assert.deepEqual(e3, ['Vikram']);

    const e4 = parseExclusions('Kabir didn\'t join for pizza');
    assert.deepEqual(e4, ['Kabir']);

    const e5 = parseExclusions('Super fun trip guys!');
    assert.deepEqual(e5, []);
  });
});

describe('Ambiguity Detection (isAmbiguous)', () => {
  test('flags statements with uncertainty markers as ambiguous', () => {
    const a1 = isAmbiguous('Maybe 350 for scooter petrol? Need to check receipt');
    assert.equal(a1.isAmbiguous, true);
    assert.match(a1.reason, /uncertainty/i);
    assert.match(a1.reason, /question mark/i);

    const a2 = isAmbiguous('Water cans maybe 240? Need to verify delivery card');
    assert.equal(a2.isAmbiguous, true);
    assert.ok(a2.reason);

    const a3 = isAmbiguous('Late night Uber surge was around 220 extra? Not sure if included in receipt');
    assert.equal(a3.isAmbiguous, true);
    assert.ok(a3.reason);
  });

  test('marks clear statements as confirmed with no ambiguity reason', () => {
    const a1 = isAmbiguous('Paid 2.4k for beach shack dinner last night');
    assert.equal(a1.isAmbiguous, false);
    assert.equal(a1.reason, null);

    const a2 = isAmbiguous('Paid electricity bill 1450 on Bescom app');
    assert.equal(a2.isAmbiguous, false);
    assert.equal(a2.reason, null);
  });
});

describe('Defensive Edge Cases & Name Normalization', () => {
  test('handles normalizeName across variations', () => {
    assert.equal(normalizeName('rahul'), 'Rahul');
    assert.equal(normalizeName('PRIYA'), 'Priya');
    assert.equal(normalizeName('  Aman: '), 'Aman');
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName(null), '');
  });

  test('safely handles empty input, whitespace, and non-strings', () => {
    const emptyResult = parseChat('');
    assert.deepEqual(emptyResult.participants, []);
    assert.deepEqual(emptyResult.items, []);
    assert.deepEqual(emptyResult.unresolved, []);
    assert.equal(emptyResult.source.total_lines, 0);

    const nullResult = parseChat(null);
    assert.deepEqual(nullResult.participants, []);
    assert.deepEqual(nullResult.items, []);

    const whitespaceResult = parseChat('   \n\n\t  \n');
    assert.deepEqual(whitespaceResult.items, []);
    assert.equal(whitespaceResult.source.total_lines, 0);
  });

  test('routes messages with missing amounts to unresolved without inventing claims', () => {
    const input = 'Aman: Chalo ready in 10 mins for watersports\nNeha: Goa sunsets are amazing guys';
    const result = parseChat(input);
    assert.equal(result.items.length, 0);
    assert.equal(result.unresolved.length, 2);
    assert.equal(result.unresolved[0].line_number, 1);
    assert.match(result.unresolved[0].reason, /No financial transaction/);
  });

  test('routes messages with missing or unknown payers to unresolved', () => {
    const input = 'Paid 500 for lunch\nSomeone paid 1200 for taxi';
    const result = parseChat(input);
    assert.equal(result.items.length, 0);
    assert.equal(result.unresolved.length, 2);
    assert.match(result.unresolved[0].reason, /Payer could not be determined/);
  });

  test('assigns unique IDs and preserves line numbers for duplicate-looking claims', () => {
    const input = 'Rahul: Paid 500 for coffee\nRahul: Paid 500 for coffee';
    const result = parseChat(input);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].id, 'item-1');
    assert.equal(result.items[1].id, 'item-2');
    assert.equal(result.items[0].raw_line_number, 1);
    assert.equal(result.items[1].raw_line_number, 2);
  });

  test('supports simulateHallucination flag for QuoteGuard testing', () => {
    const input = 'Rahul: Paid 500 for coffee';
    const normalResult = parseChat(input, { simulateHallucination: false });
    assert.equal(normalResult.items.length, 1);

    const halluResult = parseChat(input, { simulateHallucination: true });
    assert.equal(halluResult.items.length, 2);
    const halluItem = halluResult.items.find((it) => it.simulated_hallucination === true);
    assert.ok(halluItem);
    assert.equal(halluItem.amount, 9999);
    assert.equal(halluItem.payer, 'Aman');
    // Ensure the hallucinated quote does NOT exist in the source input
    assert.equal(input.includes(halluItem.exact_quote), false);
  });
});

describe('Chat Presets Integration & Quote Preservation', () => {
  test('Preset 1: Goa Weekend Trip extraction and quote verification', () => {
    const preset = getPresetById('goa-trip');
    assert.ok(preset, 'Goa preset should exist');
    assert.equal(preset.participants.length, 4);

    const result = parseChat(preset.text);

    // 4 participants identified
    assert.deepEqual(result.participants, ['Aman', 'Neha', 'Priya', 'Rahul']);

    // 9 valid financial claims extracted, 3 conversational lines unresolved
    assert.equal(result.items.length, 9);
    assert.equal(result.unresolved.length, 3);
    assert.equal(result.source.total_lines, 12);

    // 2.4k shorthand verification
    const beachDinner = result.items.find((it) => it.description.includes('beach shack dinner'));
    assert.ok(beachDinner);
    assert.equal(beachDinner.amount, 2400);
    assert.equal(beachDinner.payer, 'Rahul');
    assert.equal(beachDinner.status, 'confirmed');

    // Participant exclusion verification
    const scuba = result.items.find((it) => it.description.includes('scuba'));
    assert.ok(scuba);
    assert.equal(scuba.amount, 4000);
    assert.equal(scuba.payer, 'Priya');
    assert.deepEqual(scuba.excluded, ['Aman']);

    // Direct repayment verification
    const repayment = result.items.find((it) => it.type === 'repayment');
    assert.ok(repayment);
    assert.equal(repayment.payer, 'Aman');
    assert.equal(repayment.recipient, 'Rahul');
    assert.equal(repayment.amount, 500);

    // Ambiguous ₹350 scooter petrol verification
    const petrol = result.items.find((it) => it.description.includes('scooter petrol'));
    assert.ok(petrol);
    assert.equal(petrol.amount, 350);
    assert.equal(petrol.payer, 'Neha');
    assert.equal(petrol.status, 'ambiguous');
    assert.equal(petrol.confidence, 0.4);
    assert.ok(petrol.ambiguity_reason);

    // CRITICAL REQUIREMENT: exact_quote MUST be an exact substring of rawText
    for (const item of result.items) {
      assert.ok(
        preset.text.includes(item.exact_quote),
        `exact_quote "${item.exact_quote}" must appear verbatim in preset text`
      );
    }
  });

  test('Preset 2: Bengaluru Flatmates extraction and quote verification', () => {
    const preset = getPresetById('bengaluru-flatmates');
    assert.ok(preset, 'Bengaluru preset should exist');

    const result = parseChat(preset.text);

    assert.deepEqual(result.participants, ['Arjun', 'Sneha', 'Vikram']);
    assert.equal(result.items.length, 8);
    assert.equal(result.unresolved.length, 2);
    assert.equal(result.source.total_lines, 10);

    // Check specific items
    const elec = result.items.find((it) => it.description.includes('electricity bill'));
    assert.ok(elec);
    assert.equal(elec.amount, 1450);
    assert.equal(elec.payer, 'Arjun');

    const wifi = result.items.find((it) => it.description.includes('ACT wifi'));
    assert.ok(wifi);
    assert.equal(wifi.amount, 1199);
    assert.equal(wifi.payer, 'Sneha');

    const maid = result.items.find((it) => it.description.includes('maid salary'));
    assert.ok(maid);
    assert.equal(maid.amount, 3000);
    assert.equal(maid.payer, 'Vikram');

    // Ambiguous water cans
    const waterCans = result.items.find((it) => it.description.includes('Water cans'));
    assert.ok(waterCans);
    assert.equal(waterCans.amount, 240);
    assert.equal(waterCans.payer, 'Arjun');
    assert.equal(waterCans.status, 'ambiguous');

    // Repayment from Sneha to Vikram
    const maidAdvance = result.items.find((it) => it.type === 'repayment');
    assert.ok(maidAdvance);
    assert.equal(maidAdvance.payer, 'Sneha');
    assert.equal(maidAdvance.recipient, 'Vikram');
    assert.equal(maidAdvance.amount, 1000);

    // Quote preservation
    for (const item of result.items) {
      assert.ok(
        preset.text.includes(item.exact_quote),
        `exact_quote "${item.exact_quote}" must appear verbatim in preset text`
      );
    }
  });

  test('Preset 3: Hackathon Team Midnight Run extraction and quote verification', () => {
    const preset = getPresetById('hackathon-run');
    assert.ok(preset, 'Hackathon preset should exist');

    const result = parseChat(preset.text);

    assert.deepEqual(result.participants, ['Dev', 'Kabir', 'Tara']);
    assert.equal(result.items.length, 6);
    assert.equal(result.unresolved.length, 2);
    assert.equal(result.source.total_lines, 8);

    // Domino's pizza
    const pizza = result.items.find((it) => it.description.includes("Domino's pizza"));
    assert.ok(pizza);
    assert.equal(pizza.amount, 1400);
    assert.equal(pizza.payer, 'Dev');

    // Red Bulls and snacks (ignoring 2am as time unit)
    const redBull = result.items.find((it) => it.description.includes('Red Bulls'));
    assert.ok(redBull);
    assert.equal(redBull.amount, 650);
    assert.equal(redBull.payer, 'Tara');

    // Cab
    const cab = result.items.find((it) => it.description.includes('cab'));
    assert.ok(cab);
    assert.equal(cab.amount, 950);
    assert.equal(cab.payer, 'Kabir');

    // Ambiguous Uber surge
    const surge = result.items.find((it) => it.description.includes('Uber surge'));
    assert.ok(surge);
    assert.equal(surge.amount, 220);
    assert.equal(surge.payer, 'Dev');
    assert.equal(surge.status, 'ambiguous');

    // Repayment from Tara to Dev
    const coffees = result.items.find((it) => it.type === 'repayment');
    assert.ok(coffees);
    assert.equal(coffees.payer, 'Tara');
    assert.equal(coffees.recipient, 'Dev');
    assert.equal(coffees.amount, 400);

    // Quote preservation
    for (const item of result.items) {
      assert.ok(
        preset.text.includes(item.exact_quote),
        `exact_quote "${item.exact_quote}" must appear verbatim in preset text`
      );
    }
  });

  test('getAllPresets returns all 3 configured presets', () => {
    const all = getAllPresets();
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((p) => p.id), ['goa-trip', 'bengaluru-flatmates', 'hackathon-run']);
  });
});
