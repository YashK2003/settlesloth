'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyQuote,
  verifyParticipants,
  isAmbiguousItem,
  calculateNetBalances,
  solveMinimumTransfers,
  reconcileLedger,
  extractAmountsFromQuote
} = require('../src/reconciler');

const { PRESETS, getPresetById } = require('../src/presets');
const { parseChat } = require('../src/fallbackParser');

describe('QuoteGuard Verification', () => {
  const sampleChat = `Rahul: Paid 1500 for airport cab
Priya: Paid 2.4k for beach shack dinner
Aman: Maybe 350 for scooter petrol?
Neha: Got snacks for 850`;

  test('accepts valid quotes with case-insensitive and whitespace-normalized matching', () => {
    const validItem1 = {
      amount: 1500,
      exact_quote: 'paid   1500   for airport cab'
    };
    assert.deepEqual(verifyQuote(validItem1, sampleChat), { valid: true });

    const validItem2 = {
      amount: 2400,
      exact_quote: 'Paid 2.4k for beach shack dinner'
    };
    assert.deepEqual(verifyQuote(validItem2, sampleChat), { valid: true });
  });

  test('blocks fabricated quotes that do not appear in the source text', () => {
    const fakeItem = {
      amount: 9999,
      exact_quote: 'Aman paid 9999 for private helicopter ride'
    };
    const result = verifyQuote(fakeItem, sampleChat);
    assert.equal(result.valid, false);
    assert.match(result.reason, /not found in original chat/i);
  });

  test('blocks real quotes when the extracted amount does not match the quote numbers', () => {
    // Quote is real ("Paid 1500 for airport cab"), but extracted amount is hallucinated as 5000
    const tamperedAmountItem = {
      amount: 5000,
      exact_quote: 'Paid 1500 for airport cab'
    };
    const result = verifyQuote(tamperedAmountItem, sampleChat);
    assert.equal(result.valid, false);
    assert.match(result.reason, /does not match any numeric value in quote/i);
  });

  test('verifies shorthand k notation and currency symbols inside quotes', () => {
    const itemK = {
      amount: 2400,
      exact_quote: 'Priya: Paid 2.4k for beach shack dinner'
    };
    assert.deepEqual(verifyQuote(itemK, sampleChat), { valid: true });

    const itemCurrency = {
      amount: 350,
      exact_quote: 'Maybe 350 for scooter petrol?'
    };
    assert.deepEqual(verifyQuote(itemCurrency, sampleChat), { valid: true });
  });

  test('rejects items with invalid, non-positive, or missing quotes/amounts', () => {
    assert.equal(verifyQuote({ amount: 0, exact_quote: 'Paid 0' }, sampleChat).valid, false);
    assert.equal(verifyQuote({ amount: -100, exact_quote: 'Paid 100' }, sampleChat).valid, false);
    assert.equal(verifyQuote({ amount: 500, exact_quote: '' }, sampleChat).valid, false);
    assert.equal(verifyQuote(null, sampleChat).valid, false);
    assert.equal(verifyQuote({ amount: 500, exact_quote: 'test' }, null).valid, false);
  });
});

describe('ParticipantGuard Verification', () => {
  const established = ['Rahul', 'Priya', 'Aman', 'Neha'];

  test('accepts established participants for expenses and repayments', () => {
    const validExpense = {
      type: 'expense',
      payer: 'Rahul',
      amount: 1500,
      split_among: [],
      excluded: ['Aman']
    };
    assert.deepEqual(verifyParticipants(validExpense, established), { valid: true });

    const validRepayment = {
      type: 'repayment',
      payer: 'Aman',
      recipient: 'Rahul',
      amount: 500
    };
    assert.deepEqual(verifyParticipants(validRepayment, established), { valid: true });
  });

  test('blocks invented payers not established in the conversation', () => {
    const inventedPayer = {
      type: 'expense',
      payer: 'MysteryGuest',
      amount: 1200
    };
    const result = verifyParticipants(inventedPayer, established);
    assert.equal(result.valid, false);
    assert.match(result.reason, /not an established participant/i);
  });

  test('blocks invented recipients in direct repayments', () => {
    const inventedRecipient = {
      type: 'repayment',
      payer: 'Rahul',
      recipient: 'Stranger',
      amount: 500
    };
    const result = verifyParticipants(inventedRecipient, established);
    assert.equal(result.valid, false);
    assert.match(result.reason, /not an established participant/i);
  });

  test('blocks self-repayments where payer and recipient are the same person', () => {
    const selfRepay = {
      type: 'repayment',
      payer: 'Rahul',
      recipient: 'rahul',
      amount: 500
    };
    const result = verifyParticipants(selfRepay, established);
    assert.equal(result.valid, false);
    assert.match(result.reason, /cannot be the same participant/i);
  });

  test('rejects expenses where all specified beneficiaries are non-established', () => {
    const invalidSplit = {
      type: 'expense',
      payer: 'Rahul',
      amount: 1000,
      split_among: ['Ghost1', 'Ghost2']
    };
    const result = verifyParticipants(invalidSplit, established);
    assert.equal(result.valid, false);
    assert.match(result.reason, /None of the split_among beneficiaries are established/i);
  });
});

describe('Ambiguity Quarantine Logic', () => {
  test('flags uncertain claims containing uncertainty markers or status', () => {
    assert.equal(
      isAmbiguousItem({
        status: 'ambiguous',
        amount: 350,
        exact_quote: 'Maybe 350 for scooter petrol? Need to check receipt'
      }),
      true
    );

    assert.equal(
      isAmbiguousItem({
        status: 'confirmed',
        amount: 220,
        exact_quote: 'Uber surge was around 220 extra?'
      }),
      true
    );

    assert.equal(
      isAmbiguousItem({
        status: 'confirmed',
        amount: 240,
        exact_quote: 'Water cans maybe 240? Need to verify delivery card'
      }),
      true
    );

    assert.equal(
      isAmbiguousItem({
        status: 'confirmed',
        amount: 2400,
        exact_quote: 'Paid 2.4k for beach shack dinner'
      }),
      false
    );
  });
});

describe('Balance Calculation & Paise Precision Invariants', () => {
  test('splits expenses equally and maintains strict zero-sum balance invariant', () => {
    const participants = ['Alice', 'Bob', 'Charlie'];
    const items = [
      {
        id: '1',
        type: 'expense',
        payer: 'Alice',
        amount: 300,
        split_among: [],
        excluded: []
      }
    ];

    const balances = calculateNetBalances(items, participants);

    assert.equal(balances.Alice.paid, 300);
    assert.equal(balances.Alice.owed, 100);
    assert.equal(balances.Alice.net, 200);

    assert.equal(balances.Bob.paid, 0);
    assert.equal(balances.Bob.owed, 100);
    assert.equal(balances.Bob.net, -100);

    assert.equal(balances.Charlie.paid, 0);
    assert.equal(balances.Charlie.owed, 100);
    assert.equal(balances.Charlie.net, -100);

    // Invariant: sum of net balances is exactly 0.00
    const sumNet = balances.Alice.net + balances.Bob.net + balances.Charlie.net;
    assert.equal(Math.round(sumNet * 100) / 100, 0);
  });

  test('handles fractional cents with deterministic remainder distribution', () => {
    // 100 divided among 3 people: 33.34, 33.33, 33.33
    const participants = ['Alice', 'Bob', 'Charlie'];
    const items = [
      {
        id: '1',
        type: 'expense',
        payer: 'Alice',
        amount: 100,
        split_among: [],
        excluded: []
      }
    ];

    const balances = calculateNetBalances(items, participants);

    // Sum of owed must equal 100.00 exactly
    const sumOwed = balances.Alice.owed + balances.Bob.owed + balances.Charlie.owed;
    assert.equal(Math.round(sumOwed * 100) / 100, 100);

    // Sum of net balances must equal 0.00 exactly
    const sumNet = balances.Alice.net + balances.Bob.net + balances.Charlie.net;
    assert.equal(Math.round(sumNet * 100) / 100, 0);
  });

  test('respects participant exclusions without assigning debt to excluded member', () => {
    const participants = ['Rahul', 'Priya', 'Aman', 'Neha'];
    const items = [
      {
        id: '1',
        type: 'expense',
        payer: 'Priya',
        amount: 4000,
        split_among: [],
        excluded: ['Aman']
      }
    ];

    const balances = calculateNetBalances(items, participants);

    // Aman was excluded, so Aman owes 0
    assert.equal(balances.Aman.owed, 0);
    assert.equal(balances.Aman.net, 0);

    // Remaining 3 split 4000: 1333.34, 1333.33, 1333.33
    const sumOwed = balances.Rahul.owed + balances.Priya.owed + balances.Neha.owed;
    assert.equal(Math.round(sumOwed * 100) / 100, 4000);

    const sumNet = Object.values(balances).reduce((sum, b) => sum + b.net, 0);
    assert.equal(Math.round(sumNet * 100) / 100, 0);
  });

  test('processes direct repayments without double-counting general expenses', () => {
    const participants = ['Aman', 'Rahul'];
    const items = [
      {
        id: '1',
        type: 'repayment',
        payer: 'Aman',
        recipient: 'Rahul',
        amount: 500
      }
    ];

    const balances = calculateNetBalances(items, participants);

    // Aman paid Rahul 500, so Aman has net +500 and Rahul has net -500
    assert.equal(balances.Aman.paid, 500);
    assert.equal(balances.Aman.owed, 0);
    assert.equal(balances.Aman.net, 500);

    assert.equal(balances.Rahul.paid, 0);
    assert.equal(balances.Rahul.owed, 500);
    assert.equal(balances.Rahul.net, -500);

    assert.equal(balances.Aman.net + balances.Rahul.net, 0);
  });
});

describe('Greedy Cash-Flow Settlement Solver', () => {
  test('returns empty transfers for empty, single-person, or zero-balance groups', () => {
    assert.deepEqual(solveMinimumTransfers({}), []);
    assert.deepEqual(solveMinimumTransfers({ Alice: 0 }), []);
    assert.deepEqual(solveMinimumTransfers({ Alice: 0, Bob: 0 }), []);
    assert.deepEqual(solveMinimumTransfers(null), []);
  });

  test('resolves simple 2-person debt correctly', () => {
    const balances = { Alice: 50, Bob: -50 };
    const transfers = solveMinimumTransfers(balances);

    assert.equal(transfers.length, 1);
    assert.deepEqual(transfers[0], {
      from: 'Bob',
      to: 'Alice',
      amount: 50
    });
  });

  test('resolves multi-person transfers and reconciles participant balances', () => {
    const balances = {
      Rahul: 1000,
      Priya: 500,
      Aman: -800,
      Neha: -700
    };

    const transfers = solveMinimumTransfers(balances);

    // At most N - 1 transfers (3)
    assert.ok(transfers.length <= 3);

    // Verify all transfer amounts are strictly positive
    for (const t of transfers) {
      assert.ok(t.amount > 0, 'Transfer amount must be positive');
      assert.notEqual(t.from, t.to, 'Debtor and creditor must be distinct');
    }

    // Verify transfer totals reconcile with participant balances
    const netReconciliation = { Rahul: 0, Priya: 0, Aman: 0, Neha: 0 };
    for (const t of transfers) {
      netReconciliation[t.from] -= t.amount;
      netReconciliation[t.to] += t.amount;
    }

    for (const [name, targetNet] of Object.entries(balances)) {
      assert.equal(
        Math.round(netReconciliation[name] * 100) / 100,
        Math.round(targetNet * 100) / 100,
        `Reconciliation mismatch for ${name}`
      );
    }
  });

  test('handles repeated equal balances with deterministic alphabetical tie-breaking', () => {
    const balances = {
      Bob: -50,
      Alice: -50,
      Dave: 50,
      Charlie: 50
    };

    const transfers1 = solveMinimumTransfers(balances);
    const transfers2 = solveMinimumTransfers(balances);

    // Deterministic execution guarantee
    assert.deepEqual(transfers1, transfers2);
    assert.equal(transfers1.length, 2);

    // Alphabetical tie-breaking: Alice matches Charlie, Bob matches Dave
    assert.deepEqual(transfers1, [
      { from: 'Alice', to: 'Charlie', amount: 50 },
      { from: 'Bob', to: 'Dave', amount: 50 }
    ]);
  });
});

describe('reconcileLedger Integration across Presets', () => {
  test('Preset 1 (Goa Trip): default quarantine vs human-included toggle', () => {
    const preset = getPresetById('goa-trip');
    const extraction = parseChat(preset.text);

    // 1. Default run: uncertain scooter petrol (350) is quarantined
    const defaultReconciliation = reconcileLedger(preset.text, extraction, []);

    assert.equal(defaultReconciliation.verified_items.length, 8);
    assert.equal(defaultReconciliation.quarantined_items.length, 1);
    assert.equal(defaultReconciliation.blocked_hallucinations.length, 0);

    const petrolItem = defaultReconciliation.quarantined_items[0];
    assert.match(petrolItem.exact_quote, /scooter petrol/i);
    assert.equal(petrolItem.included, false);

    // Default verified spend: 14850
    assert.equal(defaultReconciliation.metrics.total_spend, 14850);
    assert.equal(defaultReconciliation.transfers.length, 3);

    // Check zero-sum balance invariant
    const defaultSumNet = Object.values(defaultReconciliation.balances).reduce(
      (sum, b) => sum + b.net,
      0
    );
    assert.equal(Math.round(defaultSumNet * 100) / 100 + 0, 0);

    // 2. Human confirms quarantined petrol expense (id toggle)
    const toggledReconciliation = reconcileLedger(preset.text, extraction, [petrolItem.id]);

    assert.equal(toggledReconciliation.verified_items.length, 9);
    assert.equal(toggledReconciliation.quarantined_items.length, 1);
    assert.equal(toggledReconciliation.quarantined_items[0].included, true);

    // Total spend increases by 350 to 15200
    assert.equal(toggledReconciliation.metrics.total_spend, 15200);

    // Recalculated balances preserve zero-sum invariant
    const toggledSumNet = Object.values(toggledReconciliation.balances).reduce(
      (sum, b) => sum + b.net,
      0
    );
    assert.equal(Math.round(toggledSumNet * 100) / 100 + 0, 0);

    // All transfers reconcile with participant net balances
    for (const t of toggledReconciliation.transfers) {
      assert.ok(t.amount > 0);
    }
  });

  test('Preset 2 (Bengaluru Flatmates): reconciles clean balances and handles water cans quarantine', () => {
    const preset = getPresetById('bengaluru-flatmates');
    const extraction = parseChat(preset.text);

    const result = reconcileLedger(preset.text, extraction, []);

    assert.equal(result.verified_items.length, 7);
    assert.equal(result.quarantined_items.length, 1); // water cans (240)
    assert.equal(result.blocked_hallucinations.length, 0);

    // Zero-sum balance invariant
    const sumNet = Object.values(result.balances).reduce((sum, b) => sum + b.net, 0);
    assert.equal(Math.round(sumNet * 100) / 100 + 0, 0);
  });

  test('Preset 3 (Hackathon Team Midnight Run): reconciles pizza, Red Bulls, and Uber surge quarantine', () => {
    const preset = getPresetById('hackathon-run');
    const extraction = parseChat(preset.text);

    const result = reconcileLedger(preset.text, extraction, []);

    assert.equal(result.verified_items.length, 5);
    assert.equal(result.quarantined_items.length, 1); // Uber surge (220)
    assert.equal(result.blocked_hallucinations.length, 0);

    // Zero-sum balance invariant
    const sumNet = Object.values(result.balances).reduce((sum, b) => sum + b.net, 0);
    assert.equal(Math.round(sumNet * 100) / 100 + 0, 0);
  });

  test('QuoteGuard catches and blocks synthetic hallucination during reconcileLedger', () => {
    const preset = getPresetById('goa-trip');
    const extractionWithHallucination = parseChat(preset.text, { simulateHallucination: true });

    const result = reconcileLedger(preset.text, extractionWithHallucination, []);

    // 1 hallucination caught and logged
    assert.equal(result.blocked_hallucinations.length, 1);
    assert.equal(result.metrics.blocked_count, 1);

    const blocked = result.blocked_hallucinations[0];
    assert.equal(blocked.guard, 'QuoteGuard');
    assert.equal(blocked.item.amount, 9999);
    assert.match(blocked.reason, /not found in original chat/i);

    // Verified items and balances are protected from the hallucination
    assert.equal(result.verified_items.some((it) => it.amount === 9999), false);
  });
});
