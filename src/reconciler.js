'use strict';

/**
 * ============================================================================
 * SettleSloth - Deterministic Reconciliation Engine & Guardrails
 * ============================================================================
 *
 * Core Principle: "The Model Extracts, Deterministic Code Guarantees"
 *
 * This module enforces strict neuro-symbolic boundaries between open-weight
 * AI extraction and financial calculations:
 *
 * 1. QuoteGuard:
 *    Every extracted claim must be verbatim grounded in the source text
 *    (case-insensitive, whitespace-normalized) AND its numeric amount must
 *    match a number or shorthand (e.g. "2.4k") present in that quote.
 *
 * 2. ParticipantGuard:
 *    Ensures only established participants from the chat are assigned debts,
 *    credits, or exclusions. Invented or unknown participants are blocked.
 *
 * 3. Ambiguity Quarantine:
 *    Claims with uncertainty markers ("maybe", "?", "approx", etc.) are
 *    routed into a quarantine bucket and excluded from balances unless the
 *    human explicitly confirms them via validated input.
 *
 * 4. Deterministic Balance Solver (Paise-Precision Math):
 *    Computes paid, owed, and net balances in exact integer paise to prevent
 *    floating-point drift. Guarantees zero-sum balance invariant: sum(net) === 0.
 *
 * 5. Greedy Max-Debtor / Max-Creditor Cash-Flow Settlement:
 *    Heuristic settlement algorithm that iteratively pairs the largest debtor
 *    with the largest creditor, resolving balances in at most N - 1 transfers
 *    with deterministic alphabetical tie-breaking.
 * ============================================================================
 */

const { normalizeName } = require('./fallbackParser');

/**
 * Normalize whitespace and lower-case text for robust quote matching.
 * @param {string} str - String to normalize
 * @returns {string} Whitespace-collapsed lowercase string
 */
function normalizeWhitespace(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract all candidate numeric amounts and shorthand from a quote string.
 * @param {string} quote - Quote string to scan
 * @returns {number[]} Array of candidate numeric amounts
 */
function extractAmountsFromQuote(quote) {
  if (!quote || typeof quote !== 'string') return [];
  const amounts = [];
  let text = quote;

  // 1. Shorthand like 2.4k, 1.5k, 2k, Rs 2.4k
  const kRegex = /(?:(?:₹|rs\.?|inr)\s*)?(\d+(?:\.\d+)?)\s*k\b/gi;
  let m;
  while ((m = kRegex.exec(quote)) !== null) {
    const val = parseFloat(m[1]) * 1000;
    amounts.push(Math.round(val * 100) / 100);
  }
  text = text.replace(kRegex, ' ');

  // 2. Explicit currency prefix: ₹350, Rs. 1800, INR 3100
  const currRegex = /(?:₹|rs\.?|inr)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b/gi;
  while ((m = currRegex.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    amounts.push(Math.round(val * 100) / 100);
  }
  text = text.replace(currRegex, ' ');

  // 3. Plain numbers (excluding numbers attached to units like mins, am, pm)
  const numRegex = /\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b/g;
  while ((m = numRegex.exec(text)) !== null) {
    const endIdx = m.index + m[0].length;
    const remaining = text.slice(endIdx).trimStart();
    if (
      /^(?:mins?|minutes?|am|pm|l\b|liters?|litres?|msgs?|messages?|people|friends|st|nd|rd|th|days?|hours?|hrs?|k\b)/i.test(
        remaining
      )
    ) {
      continue;
    }
    const val = parseFloat(m[1].replace(/,/g, ''));
    amounts.push(Math.round(val * 100) / 100);
  }

  return Array.from(new Set(amounts));
}

/**
 * QuoteGuard: Verifies that an extracted item's quote exists in the source text
 * and that the extracted amount is grounded in the quote text itself.
 *
 * @param {object} item - Extracted item object
 * @param {string} rawText - Source chat transcript
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyQuote(item, rawText) {
  if (!item || typeof item !== 'object') {
    return { valid: false, reason: 'Item object is required' };
  }
  if (!rawText || typeof rawText !== 'string') {
    return { valid: false, reason: 'Raw chat transcript is required' };
  }
  if (!item.exact_quote || typeof item.exact_quote !== 'string' || !item.exact_quote.trim()) {
    return { valid: false, reason: 'Item is missing exact_quote' };
  }

  // 1. Verbatim quote presence check (case-insensitive & whitespace-normalized)
  const normalizedRaw = normalizeWhitespace(rawText);
  const normalizedQuote = normalizeWhitespace(item.exact_quote);

  if (!normalizedRaw.includes(normalizedQuote)) {
    return {
      valid: false,
      reason: `Quote "${item.exact_quote}" not found in original chat`
    };
  }

  // 2. Numeric amount validation
  const itemAmt = Math.round(Number(item.amount) * 100) / 100;
  if (isNaN(itemAmt) || itemAmt <= 0) {
    return {
      valid: false,
      reason: `Item amount (${item.amount}) is invalid or non-positive`
    };
  }

  // 3. Amount grounding check: quote MUST contain a representation of the amount
  const candidateAmounts = extractAmountsFromQuote(item.exact_quote);
  const matchesCandidate = candidateAmounts.some((cand) => Math.abs(cand - itemAmt) < 0.01);

  if (!matchesCandidate) {
    return {
      valid: false,
      reason: `Extracted amount ${item.amount} does not match any numeric value in quote ("${item.exact_quote}")`
    };
  }

  return { valid: true };
}

/**
 * ParticipantGuard: Verifies that payer, recipient, and beneficiaries are established participants.
 *
 * @param {object} item - Extracted item object
 * @param {string[]|Set<string>} establishedParticipants - Valid chat participants
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyParticipants(item, establishedParticipants) {
  if (!item || typeof item !== 'object') {
    return { valid: false, reason: 'Item object is required' };
  }

  const validParticipants = new Set(
    (Array.isArray(establishedParticipants)
      ? establishedParticipants
      : Array.from(establishedParticipants || [])
    )
      .map(normalizeName)
      .filter(Boolean)
  );

  if (validParticipants.size === 0) {
    return { valid: false, reason: 'No established participants found for verification' };
  }

  // Check payer
  const payer = normalizeName(item.payer);
  if (!payer || !validParticipants.has(payer)) {
    return {
      valid: false,
      reason: `Payer "${item.payer || ''}" is not an established participant in this chat`
    };
  }

  // Check recipient for direct repayments
  if (item.type === 'repayment') {
    const recipient = normalizeName(item.recipient);
    if (!recipient || !validParticipants.has(recipient)) {
      return {
        valid: false,
        reason: `Recipient "${item.recipient || ''}" is not an established participant in this chat`
      };
    }
    if (recipient === payer) {
      return {
        valid: false,
        reason: `Payer and recipient cannot be the same participant ("${payer}")`
      };
    }
  }

  // Check beneficiaries if split_among is explicitly specified
  if (item.type === 'expense' && Array.isArray(item.split_among) && item.split_among.length > 0) {
    const validBeneficiaries = item.split_among
      .map(normalizeName)
      .filter((p) => validParticipants.has(p));
    if (validBeneficiaries.length === 0) {
      return {
        valid: false,
        reason: 'None of the split_among beneficiaries are established participants'
      };
    }
  }

  return { valid: true };
}

/**
 * Check whether an item is ambiguous and belongs in the quarantine bucket.
 *
 * @param {object} item - Extracted item object
 * @returns {boolean} True if ambiguous
 */
function isAmbiguousItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.status === 'ambiguous') return true;
  if (Number(item.amount) <= 0) return true;

  const text = `${item.exact_quote || ''} ${item.description || ''}`;
  return /\b(?:maybe|approx(?:imately|\.)?|around|not\s+sure|not\s+certain|unconfirmed|tentative|check\s+receipt|verify)\b|\?/i.test(
    text
  );
}

/**
 * Calculate net balances across all participants in integer paise.
 * Invariant: Sum of all net balances === 0.00.
 *
 * @param {object[]} items - Active verified items (expenses & repayments)
 * @param {string[]} participants - List of participant names
 * @returns {Record<string, { paid: number, owed: number, net: number }>}
 */
function calculateNetBalances(items, participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    return {};
  }

  const normParticipants = Array.from(
    new Set(participants.map(normalizeName).filter(Boolean))
  ).sort();

  const paidCents = {};
  const owedCents = {};

  for (const p of normParticipants) {
    paidCents[p] = 0;
    owedCents[p] = 0;
  }

  for (const item of items || []) {
    const amtCents = Math.round(Number(item.amount) * 100);
    const payer = normalizeName(item.payer);

    if (!normParticipants.includes(payer)) {
      continue;
    }

    if (item.type === 'repayment') {
      const recipient = normalizeName(item.recipient);
      if (normParticipants.includes(recipient)) {
        paidCents[payer] += amtCents;
        owedCents[recipient] += amtCents;
      }
      continue;
    }

    // General Expense
    paidCents[payer] += amtCents;

    let beneficiaries = [];
    if (Array.isArray(item.split_among) && item.split_among.length > 0) {
      beneficiaries = item.split_among
        .map(normalizeName)
        .filter((p) => normParticipants.includes(p));
    } else {
      const excludedSet = new Set((item.excluded || []).map(normalizeName));
      beneficiaries = normParticipants.filter((p) => !excludedSet.has(p));
    }

    // Fallback: if everyone is excluded, payer absorbs
    if (beneficiaries.length === 0) {
      beneficiaries = [payer];
    }

    // Exact integer division with remainder allocation
    const count = beneficiaries.length;
    const baseShare = Math.floor(amtCents / count);
    const remainder = amtCents % count;

    beneficiaries.sort();
    for (let i = 0; i < count; i++) {
      const b = beneficiaries[i];
      const share = baseShare + (i < remainder ? 1 : 0);
      owedCents[b] += share;
    }
  }

  const balances = {};
  let sumNetCents = 0;

  for (const p of normParticipants) {
    const net = paidCents[p] - owedCents[p];
    sumNetCents += net;
    balances[p] = {
      paid: (paidCents[p] / 100) + 0,
      owed: (owedCents[p] / 100) + 0,
      net: (net / 100) + 0
    };
  }

  // Safety check: net balance invariant
  if (Math.abs(sumNetCents) > 1) {
    throw new Error(`Net balance invariant violated: total net drift is ${sumNetCents} paise`);
  }

  return balances;
}

/**
 * Deterministic greedy max-debtor / max-creditor cash-flow settlement solver.
 *
 * ALGORITHM DESCRIPTION:
 * - Separates participants into debtors (net < 0) and creditors (net > 0).
 * - Iteratively matches the participant with the largest outstanding debt
 *   against the participant with the largest outstanding credit.
 * - Settle min(debt, credit) and decrements remaining balances.
 * - Uses deterministic alphabetical tie-breaking for equal amounts.
 * - Guaranteed to produce transfers with positive amounts that reconcile
 *   exactly with each participant's balance.
 *
 * Note: While this greedy heuristic resolves N-person debts in at most N - 1
 * transfers and yields minimal transfers for standard group balances, finding
 * the strict global minimum number of transactions across arbitrary subsets
 * is NP-hard (subset sum / partition). This solver is an efficient O(N log N)
 * greedy approximation with guaranteed reconciliation.
 *
 * @param {Record<string, number|{ net: number }>} balances - Participant net balances
 * @returns {Array<{ from: string, to: string, amount: number }>} Recommended transfers
 */
function solveMinimumTransfers(balances) {
  if (!balances || typeof balances !== 'object') {
    return [];
  }

  const debtors = [];
  const creditors = [];

  for (const [name, val] of Object.entries(balances)) {
    const net = typeof val === 'object' && val !== null ? val.net : val;
    const cents = Math.round(Number(net) * 100);

    if (cents < 0) {
      debtors.push({ name, cents: -cents });
    } else if (cents > 0) {
      creditors.push({ name, cents });
    }
  }

  const transfers = [];

  while (debtors.length > 0 && creditors.length > 0) {
    // Sort deterministically: highest debt/credit first, then alphabetical name
    debtors.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
    creditors.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));

    const debtor = debtors[0];
    const creditor = creditors[0];
    const settleCents = Math.min(debtor.cents, creditor.cents);

    transfers.push({
      from: debtor.name,
      to: creditor.name,
      amount: Math.round(settleCents) / 100
    });

    debtor.cents -= settleCents;
    creditor.cents -= settleCents;

    if (debtor.cents === 0) {
      debtors.shift();
    }
    if (creditor.cents === 0) {
      creditors.shift();
    }
  }

  return transfers;
}

/**
 * End-to-end ledger reconciliation workflow.
 * Executes QuoteGuard, ParticipantGuard, and Ambiguity Quarantine, then computes
 * verified balances, minimum transfers, and audit metrics.
 *
 * @param {string} rawText - Source chat transcript
 * @param {object} extractionResult - Structured extraction result from parser
 * @param {string[]} [includeQuarantinedIds=[]] - IDs of quarantined items explicitly confirmed by human
 * @returns {object} Complete reconciled ledger payload
 */
function reconcileLedger(rawText, extractionResult, includeQuarantinedIds = []) {
  if (!extractionResult || typeof extractionResult !== 'object') {
    return {
      participants: [],
      verified_items: [],
      quarantined_items: [],
      blocked_hallucinations: [],
      balances: {},
      transfers: [],
      metrics: {
        total_spend: 0,
        raw_transaction_count: 0,
        verified_item_count: 0,
        quarantined_count: 0,
        blocked_count: 0,
        transfers_count: 0,
        drudgery_minutes_saved: 5
      }
    };
  }

  const establishedParticipants = Array.from(
    new Set((extractionResult.participants || []).map(normalizeName).filter(Boolean))
  ).sort();

  const verified_items = [];
  const quarantined_items = [];
  const blocked_hallucinations = [];

  const rawItems = Array.isArray(extractionResult.items) ? extractionResult.items : [];

  for (const item of rawItems) {
    // 1. QuoteGuard verification
    const qv = verifyQuote(item, rawText);
    if (!qv.valid) {
      blocked_hallucinations.push({
        item,
        guard: 'QuoteGuard',
        reason: qv.reason
      });
      continue;
    }

    // 2. ParticipantGuard verification
    const pv = verifyParticipants(item, establishedParticipants);
    if (!pv.valid) {
      blocked_hallucinations.push({
        item,
        guard: 'ParticipantGuard',
        reason: pv.reason
      });
      continue;
    }

    // 3. Ambiguity quarantine check
    if (isAmbiguousItem(item)) {
      const isIncluded = includeQuarantinedIds.includes(item.id);
      quarantined_items.push({
        ...item,
        included: isIncluded
      });

      if (isIncluded) {
        verified_items.push({
          ...item,
          included: true,
          human_confirmed: true
        });
      }
    } else {
      verified_items.push(item);
    }
  }

  // 4. Deterministic balance computation
  const balances = calculateNetBalances(verified_items, establishedParticipants);

  // 5. Minimum-cash-flow transfer settlement
  const transfers = solveMinimumTransfers(balances);

  // 6. Metrics
  const total_spend = verified_items
    .filter((it) => it.type === 'expense')
    .reduce((sum, it) => sum + Number(it.amount), 0);

  return {
    participants: establishedParticipants,
    verified_items,
    quarantined_items,
    blocked_hallucinations,
    balances,
    transfers,
    metrics: {
      total_spend: Math.round(total_spend * 100) / 100,
      raw_transaction_count: rawItems.length,
      verified_item_count: verified_items.length,
      quarantined_count: quarantined_items.length,
      blocked_count: blocked_hallucinations.length,
      transfers_count: transfers.length,
      drudgery_minutes_saved: Math.max(5, Math.min(45, rawItems.length * 3))
    }
  };
}

module.exports = {
  verifyQuote,
  verifyParticipants,
  isAmbiguousItem,
  calculateNetBalances,
  solveMinimumTransfers,
  reconcileLedger,
  extractAmountsFromQuote
};
