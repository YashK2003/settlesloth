'use strict';

/**
 * ============================================================================
 * SettleSloth - Expense Data Format & Deterministic Fallback Parser
 * ============================================================================
 *
 * SCHEMA DEFINITION:
 * ------------------
 * parseChat(rawText, options) returns an ExtractionResult:
 *
 * {
 *   "participants": string[],       // Sorted list of unique participant names
 *   "items": ExtractedItem[],       // Extracted financial claims (expenses & repayments)
 *   "unresolved": UnresolvedLine[], // Lines without determinable financial claims
 *   "source": SourceMeta            // Metadata on extraction counts and parser used
 * }
 *
 * ExtractedItem format:
 * {
 *   "id": string,                   // Unique sequential item ID (e.g. 'item-1')
 *   "type": 'expense' | 'repayment',// Type of transaction
 *   "description": string,          // Clean normalized description of expense or repayment
 *   "payer": string,                // Normalized name of participant who paid
 *   "recipient": string | null,     // Recipient name for direct repayments; null for expenses
 *   "amount": number,               // Numeric currency amount, rounded to 2 decimals
 *   "split_among": string[],        // Explicit beneficiaries (empty array = split among all)
 *   "excluded": string[],           // Participants explicitly excluded from this item
 *   "exact_quote": string,          // Verbatim substring as present in raw input
 *   "status": 'confirmed' | 'ambiguous', // Whether human review is required
 *   "confidence": number,           // 1.0 for confirmed, 0.4 for ambiguous
 *   "ambiguity_reason": string | null,   // Reason for ambiguity, or null if confirmed
 *   "raw_line_number": number | null     // 1-indexed line number in source text
 * }
 *
 * UnresolvedLine format:
 * {
 *   "line_number": number,          // 1-indexed line number
 *   "text": string,                 // Original line content
 *   "reason": string                // Why the line was not resolved as a claim
 * }
 *
 * SourceMeta format:
 * {
 *   "parser": 'fallback',
 *   "total_lines": number,
 *   "parsed_count": number,
 *   "unresolved_count": number
 * }
 * ============================================================================
 */

/**
 * Normalize a participant name (trim, strip punctuation, Title Case).
 * @param {string} name - Raw name string
 * @returns {string} Normalized name
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  const cleaned = name.trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/**
 * Parse a numeric amount or shorthand from a text snippet.
 * Supports:
 * - Shorthand: 2.4k, 1.5k, 2k, 0.5k (case-insensitive)
 * - Currency prefixes: ₹1500, Rs. 1500, Rs 1500, INR 1500
 * - Plain numbers and decimals: 500, 1450, 350.50
 * - Numbers with commas: 2,400, 10,000
 * Skips numbers followed by non-currency units (mins, am, pm, liters, etc.).
 *
 * @param {string} text - Text snippet to search
 * @returns {{ amount: number, raw: string } | null}
 */
function parseAmount(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Check for shorthand with 'k' or 'K': e.g. 2.4k, 1.5k, ₹2.4k, Rs. 2k
  const kMatch = text.match(/(?:(?:₹|rs\.?|inr)\s*)?(\d+(?:\.\d+)?)\s*k\b/i);
  if (kMatch) {
    const val = parseFloat(kMatch[1]) * 1000;
    if (val > 0) {
      return {
        amount: Math.round(val * 100) / 100,
        raw: kMatch[0].trim()
      };
    }
  }

  // 2. Check for explicit currency prefix: ₹1450, Rs. 1800, INR 3200
  const currMatch = text.match(/(?:₹|rs\.?|inr)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b/i);
  if (currMatch) {
    const val = parseFloat(currMatch[1].replace(/,/g, ''));
    if (val > 0) {
      return {
        amount: Math.round(val * 100) / 100,
        raw: currMatch[0].trim()
      };
    }
  }

  // 3. Look for plain numbers, skipping non-currency units
  const numRegex = /\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b/g;
  let match;
  while ((match = numRegex.exec(text)) !== null) {
    const numStr = match[1];
    const endIdx = match.index + match[0].length;
    const remaining = text.slice(endIdx).trimStart();

    // Skip units of time, volume, count, or date ordinals
    if (
      /^(?:mins?|minutes?|am|pm|l\b|liters?|litres?|msgs?|messages?|people|friends|st|nd|rd|th|days?|hours?|hrs?|k\b)/i.test(
        remaining
      )
    ) {
      continue;
    }

    const val = parseFloat(numStr.replace(/,/g, ''));

    // Guard against current year references unless preceded by payment context
    if (
      val >= 2024 &&
      val <= 2030 &&
      !/(?:paid|spent|cost|for|amount|total)\b/i.test(text.slice(0, match.index))
    ) {
      continue;
    }

    if (val > 0) {
      return {
        amount: Math.round(val * 100) / 100,
        raw: match[0].trim()
      };
    }
  }

  return null;
}

/**
 * Detect explicit participant exclusions in message text.
 * Patterns: 'don't count Aman', 'skip Aman', 'except Aman', 'Aman didn't do watersports'
 *
 * @param {string} text - Message text
 * @returns {string[]} Array of normalized excluded participant names
 */
function parseExclusions(text) {
  if (!text || typeof text !== 'string') return [];

  const exclusions = [];
  const stopwords = new Set(['it', 'this', 'that', 'me', 'us', 'them', 'the', 'all']);

  // Pattern 1: don't count X, skip X, except X, excluding X, without X
  const p1 = /(?:don'?t\s+count|skip|except|excluding|without)\s+([A-Za-z]+)/gi;
  let m1;
  while ((m1 = p1.exec(text)) !== null) {
    const name = normalizeName(m1[1]);
    if (name && !stopwords.has(name.toLowerCase())) {
      if (!exclusions.includes(name)) exclusions.push(name);
    }
  }

  // Pattern 2: X didn't join / do / come
  const p2 = /\b([A-Za-z]+)\s+didn'?t\s+(?:join|do|participate|come|eat|drink)\b/gi;
  let m2;
  while ((m2 = p2.exec(text)) !== null) {
    const name = normalizeName(m2[1]);
    const pronouns = new Set(['he', 'she', 'they', 'we', 'i']);
    if (name && !pronouns.has(name.toLowerCase())) {
      if (!exclusions.includes(name)) exclusions.push(name);
    }
  }

  return exclusions;
}

/**
 * Detect direct repayment wording and extract recipient.
 * Patterns:
 * - 'sent Rahul 500'
 * - 'I sent Rahul 500 on GPay'
 * - 'transferred 500 to Rahul'
 * - 'paid Rahul 500 for breakfast'
 *
 * @param {string} text - Message body
 * @param {string|null} speaker - Current message speaker
 * @returns {{ recipient: string, rawAmount: string } | null}
 */
function parseRepayment(text, speaker) {
  if (!text || typeof text !== 'string') return null;

  const nonNames = new Set([
    'for', 'cash', 'yesterday', 'today', 'gpay', 'phonepe',
    'upi', 'card', 'online', 'via', 'to', 'back', 'it', 'advance'
  ]);

  const p1 = /\b(?:sent|transferred|paid|repaid|returned)\s+([A-Za-z]+)\s+(?:(?:₹|rs\.?|inr)\s*)?(\d+(?:\.\d+)?k?|\d+)/i;
  const p2 = /\b(?:sent|transferred|paid|returned)\s+(?:(?:₹|rs\.?|inr)\s*)?(\d+(?:\.\d+)?k?|\d+)\s+(?:to|back\s+to)\s+([A-Za-z]+)/i;

  let recipient = null;
  let rawAmount = null;

  const m1 = text.match(p1);
  if (m1 && !nonNames.has(m1[1].toLowerCase())) {
    recipient = normalizeName(m1[1]);
    rawAmount = m1[2];
  } else {
    const m2 = text.match(p2);
    if (m2 && !nonNames.has(m2[2].toLowerCase())) {
      recipient = normalizeName(m2[2]);
      rawAmount = m2[1];
    }
  }

  // Ensure recipient is not the same as the speaker
  if (recipient && speaker && recipient.toLowerCase() === speaker.toLowerCase()) {
    return null;
  }

  if (recipient) {
    return { recipient, rawAmount };
  }

  return null;
}

/**
 * Check whether a message expresses ambiguity or requires human confirmation.
 * Identifies:
 * - Approximation: maybe, approx, around, probably, guess
 * - Interrogation: question mark (?)
 * - Unconfirmed status: not sure, not certain, tentative
 * - Verification needed: check receipt, verify, need to check
 *
 * @param {string} text - Text to analyze
 * @returns {{ isAmbiguous: boolean, reason: string | null }}
 */
function isAmbiguous(text) {
  if (!text || typeof text !== 'string') {
    return { isAmbiguous: false, reason: null };
  }

  const reasons = [];

  if (/\b(?:maybe|approx(?:imately|\.)?|around|probably|doubt|guess)\b/i.test(text)) {
    reasons.push('Contains approximation or uncertainty wording');
  }

  if (/\?/i.test(text)) {
    reasons.push('Contains question mark');
  }

  if (/\b(?:not\s+sure|not\s+certain|unconfirmed|tentative)\b/i.test(text)) {
    reasons.push('Marked as not sure or unconfirmed');
  }

  if (
    /\b(?:check\s+receipt|need\s+to\s+check|verify\s+receipt|verify\s+delivery|verify\s+card)\b/i.test(
      text
    )
  ) {
    reasons.push('Requires receipt or verification');
  }

  return {
    isAmbiguous: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join('; ') : null
  };
}

/**
 * Clean up message text to produce a concise description of the expense or repayment.
 * Strips out amounts, payment method tags, exclusion clauses, and leading action verbs.
 *
 * @param {string} text - Message text
 * @param {string} [rawAmount] - Raw amount substring matched earlier
 * @param {string} [type='expense'] - Transaction type ('expense' or 'repayment')
 * @param {string|null} [recipient=null] - Recipient name if repayment
 * @returns {string} Clean description string
 */
function cleanDescription(text, rawAmount, type = 'expense', recipient = null) {
  if (type === 'repayment' && recipient) {
    const reasonMatch = text.match(/\bfor\s+([^,.;]+)/i);
    if (reasonMatch) {
      return `repayment for ${reasonMatch[1].trim()}`;
    }
    return `repayment to ${recipient}`;
  }

  let desc = text;

  // Remove exclusion clauses
  desc = desc.replace(
    /,?\s*(?:don'?t\s+count|skip|except|excluding|without)\s+[A-Za-z]+.*$/gi,
    ''
  );

  // Remove uncertainty annotations
  desc = desc.replace(
    /(?:,\s*)?(?:need\s+to\s+check\s+receipt|not\s+sure.*|need\s+to\s+verify.*)$/gi,
    ''
  );
  desc = desc.replace(/^\s*(?:maybe|approx(?:imately|\.)?|around)\s+/gi, '');
  desc = desc.replace(/\s+(?:maybe|approx(?:imately|\.)?|around)\b/gi, '');

  // Remove amount and currency prefix
  if (rawAmount) {
    const escaped = rawAmount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    desc = desc.replace(new RegExp(`(?:₹|rs\\.?|inr)?\\s*${escaped}`, 'gi'), '');
  }

  // Remove payment methods and billing annotations
  desc = desc.replace(
    /,?\s*(?:paid\s+by\s+card|paid\s+via\s+upi|on\s+gpay|on\s+phonepe|paid\s+it|paid\s+cash|in\s+cash)\b/gi,
    ''
  );
  desc = desc.replace(/\b(?:on\s+Bescom\s+app|for\s+this\s+month|for\s+October)\b/gi, '');

  // Remove leading payment action verbs
  desc = desc.replace(/^\s*(?:Paid|Got|Bought|Added|Ordered|Covered|Spent)\s+/i, '');
  desc = desc.replace(/\b(?:was|came\s+to|extra)\b/gi, '');
  desc = desc.replace(/\bfor\s+(?=from\b|during\b)/gi, '');

  // Strip punctuation and normalize whitespace
  desc = desc.replace(/[?,:;()!]/g, ' ').replace(/\s+/g, ' ').trim();
  desc = desc.replace(/^(?:for|to|at)\s+/i, '').replace(/\s+(?:for|to|at)$/i, '');

  return desc || 'Shared expense';
}

/**
 * Main fallback parser function.
 * Deterministically parses raw multi-line group chat text into structured JSON.
 *
 * @param {string} rawText - Multi-line chat transcript
 * @param {object} [options={}] - Optional configuration
 * @param {string[]} [options.knownParticipants] - Pre-seeded participant names
 * @param {boolean} [options.simulateHallucination=false] - Injects a synthetic hallucination for testing QuoteGuard
 * @returns {object} Structured ExtractionResult object
 */
function parseChat(rawText, options = {}) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      participants: [],
      items: [],
      unresolved: [],
      source: {
        parser: 'fallback',
        total_lines: 0,
        parsed_count: 0,
        unresolved_count: 0
      }
    };
  }

  const rawLines = rawText.split(/\r?\n/);
  const items = [];
  const unresolved = [];
  const participantSet = new Set(
    (options.knownParticipants || []).map(normalizeName).filter(Boolean)
  );

  let itemIdCounter = 1;

  for (let i = 0; i < rawLines.length; i++) {
    const originalLine = rawLines[i];
    const line = originalLine.trim();

    if (!line) {
      continue;
    }

    let speaker = null;
    let messageBody = line;

    // Normalize timestamps and WhatsApp sender formats
    let cleanLine = line.replace(
      /^[\d\s\w/.,:-]+?\s+-\s+([A-Za-z0-9_]+)\s*:\s*/,
      '$1: '
    );
    cleanLine = cleanLine.replace(/^\[[^\]]+\]\s*([A-Za-z0-9_]+)\s*:\s*/, '$1: ');

    const nonNameWords = new Set([
      'he', 'she', 'they', 'it', 'we', 'i', 'you', 'who',
      'someone', 'anyone', 'everyone', 'nobody', 'somebody', 'anybody'
    ]);

    const prefixMatch = cleanLine.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (prefixMatch) {
      speaker = normalizeName(prefixMatch[1]);
      messageBody = prefixMatch[2].trim();
    } else {
      // Check for inline "<Name> paid/spent/sent..." format
      const inlineMatch = line.match(
        /^([A-Z][a-z0-9_]+)\s+(?:paid|spent|sent|bought|covered|transferred)\b\s*(.*)$/i
      );
      if (inlineMatch && !nonNameWords.has(inlineMatch[1].toLowerCase())) {
        speaker = normalizeName(inlineMatch[1]);
      }
    }

    if (speaker) {
      participantSet.add(speaker);
    }

    // Amount extraction
    const parsedAmt = parseAmount(messageBody);
    if (!parsedAmt) {
      unresolved.push({
        line_number: i + 1,
        text: line,
        reason: 'No financial transaction or amount detected'
      });
      continue;
    }

    // Determine payer: default to speaker, or check for third-party mention
    let payer = speaker;
    const thirdPartyPayMatch = messageBody.match(
      /\b([A-Z][a-z0-9_]+)\s+(?:paid|covered|spent)\b/i
    );
    if (thirdPartyPayMatch) {
      const potentialPayer = normalizeName(thirdPartyPayMatch[1]);
      if (!nonNameWords.has(potentialPayer.toLowerCase())) {
        payer = potentialPayer;
      }
    }

    if (!payer) {
      unresolved.push({
        line_number: i + 1,
        text: line,
        reason: 'Payer could not be determined without ambiguity'
      });
      continue;
    }
    participantSet.add(payer);

    // Direct repayment check
    const repayment = parseRepayment(messageBody, speaker);
    const type = repayment ? 'repayment' : 'expense';
    const recipient = repayment ? repayment.recipient : null;
    if (recipient) {
      participantSet.add(recipient);
    }

    // Exclusion check (for general expenses)
    const excluded = type === 'expense' ? parseExclusions(messageBody) : [];
    excluded.forEach((p) => participantSet.add(p));

    // Ambiguity / quarantine evaluation
    const ambiguity = isAmbiguous(messageBody);

    // Exact quote: preserve verbatim substring from the raw line
    const exact_quote = messageBody;

    // Clean human-readable description
    const description = cleanDescription(messageBody, parsedAmt.raw, type, recipient);

    items.push({
      id: `item-${itemIdCounter++}`,
      type,
      description,
      payer,
      recipient,
      amount: parsedAmt.amount,
      split_among: [],
      excluded,
      exact_quote,
      status: ambiguity.isAmbiguous ? 'ambiguous' : 'confirmed',
      confidence: ambiguity.isAmbiguous ? 0.4 : 1.0,
      ambiguity_reason: ambiguity.reason,
      raw_line_number: i + 1
    });
  }

  // Inject synthetic hallucination for QuoteGuard verification testing if requested
  if (options && options.simulateHallucination) {
    items.push({
      id: `item-${itemIdCounter++}`,
      type: 'expense',
      description: 'helicopter ride to beach',
      payer: 'Aman',
      recipient: null,
      amount: 9999,
      split_among: [],
      excluded: [],
      exact_quote: 'Aman paid 9999 for private helicopter ride',
      status: 'confirmed',
      confidence: 0.99,
      ambiguity_reason: null,
      raw_line_number: null,
      simulated_hallucination: true
    });
  }

  return {
    participants: Array.from(participantSet).sort(),
    items,
    unresolved,
    source: {
      parser: 'fallback',
      total_lines: rawLines.filter((l) => l.trim().length > 0).length,
      parsed_count: items.length,
      unresolved_count: unresolved.length
    }
  };
}

module.exports = {
  parseChat,
  parseAmount,
  parseExclusions,
  parseRepayment,
  isAmbiguous,
  normalizeName,
  cleanDescription
};
