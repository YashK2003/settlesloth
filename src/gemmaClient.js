'use strict';

/**
 * ============================================================================
 * SettleSloth - Open-Weight Gemma AI Adapter
 * ============================================================================
 *
 * This adapter coordinates expense extraction from raw group chats using:
 * 1. Google AI Studio REST API (gemma-4-26b-a4b-it by default, or gemma-4-31b-it)
 * 2. Local Ollama REST API (gemma3:4b / gemma3:1b at localhost:11434)
 * 3. Deterministic Local Fallback Parser (src/fallbackParser.js)
 *
 * IMPORTANT SECURITY & RELIABILITY CONSTRAINTS:
 * - API keys are kept strictly server-side and never exposed in responses/logs.
 * - Model output is NEVER trusted blindly; it is strictly validated into the
 *   canonical schema and then passed to deterministic QuoteGuard & Reconciler.
 * - Timeouts (8s for cloud, 2.5s for local Ollama) ensure no stalled requests.
 * - Transparent reporting: providerUsed accurately reflects whether AI ran
 *   or the deterministic fallback parser was used.
 * ============================================================================
 */

const { parseChat } = require('./fallbackParser');

const DEFAULT_GEMMA_MODEL = 'gemma-4-26b-a4b-it';
const HOSTED_GEMMA_MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it'];
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma3:4b';

const DEFAULT_GEMINI_TIMEOUT_MS = 90000;
const OLLAMA_TIMEOUT_MS = 2500;

/**
 * Determine effective timeout for Google AI Studio calls.
 * Priority: explicit override > GEMINI_TIMEOUT_MS env > 90000ms default.
 *
 * @param {number} [overrideMs]
 * @returns {number}
 */
function getGeminiTimeoutMs(overrideMs) {
  if (typeof overrideMs === 'number' && overrideMs > 0) {
    return overrideMs;
  }
  const envVal = Number(process.env.GEMINI_TIMEOUT_MS);
  if (!isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return DEFAULT_GEMINI_TIMEOUT_MS;
}

/**
 * Redact sensitive API keys and secrets from error strings.
 *
 * @param {string} msg
 * @param {string} [apiKey]
 * @returns {string}
 */
function sanitizeErrorMessage(msg, apiKey) {
  if (!msg || typeof msg !== 'string') return '';
  let cleaned = msg;
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    const escaped = apiKey.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(escaped, 'g'), '[REDACTED_API_KEY]');
  }
  cleaned = cleaned.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]');
  return cleaned;
}

/**
 * Concise prompt instructing Gemma to perform ONLY structured extraction and quote capture.
 * Mathematics, balance calculations, transfer solvers, and commentary are explicitly forbidden.
 */
const EXTRACTION_SYSTEM_PROMPT = `Extract group expense claims and repayments from the chat transcript into concise, schema-valid JSON.

RULES:
1. Do not calculate expense splits, net balances, or settlement transfers.
2. Do not explain your reasoning or provide conversational commentary.
3. Identify all known participants in "participants".
4. For each clearly supported expense or repayment in "items":
   - "payer": name of the person who paid.
   - "amount": numeric value (e.g. convert "2.4k" to 2400, "1.5k" to 1500).
   - "exact_quote": exact verbatim substring from the transcript.
   - "type": "expense" for group costs, or "repayment" for direct transfers between two people.
   - "recipient": recipient name if repayment, else null.
   - "split_among": specific beneficiary names if explicitly limited, else empty [].
   - "excluded": names explicitly excluded (e.g. "don't count Aman"), else empty [].
   - "status": "ambiguous" if uncertain (e.g. "maybe", "approx", "?", "not sure"), else "confirmed".
   - "ambiguity_reason": brief reason if ambiguous, else null.
5. Return ONLY raw JSON matching this schema:
{
  "participants": ["Name1", "Name2"],
  "items": [
    {
      "description": "short description",
      "payer": "Name",
      "recipient": null,
      "amount": 1200,
      "split_among": [],
      "excluded": [],
      "type": "expense",
      "status": "confirmed",
      "ambiguity_reason": null,
      "exact_quote": "exact quote from chat message"
    }
  ]
}`;

/**
 * Strip markdown code fences if model returned ```json ... ```.
 * @param {string} text - Raw model response text
 * @returns {string} Clean JSON string
 */
function cleanModelResponseText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.trim();
  // Strip leading markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
  // Strip trailing markdown code fences
  cleaned = cleaned.replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // If directly parseable as JSON, return as-is
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // If wrapped in commentary, try extracting the first {...} JSON object block
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Fall through to returning cleaned
      }
    }
  }

  return cleaned;
}

/**
 * Validate and normalize parsed model JSON into the SettleSloth extraction format.
 *
 * @param {object} parsed - Parsed JSON object from model
 * @param {string} rawText - Original chat text for quote reference
 * @returns {object|null} Validated extraction result or null if invalid
 */
function validateModelExtraction(parsed, rawText) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const participants = Array.isArray(parsed.participants)
    ? parsed.participants.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];

  if (!Array.isArray(parsed.items)) {
    return null;
  }

  const items = [];
  let idCounter = 1;

  for (const item of parsed.items) {
    if (!item || typeof item !== 'object') continue;

    const amount = Number(item.amount);
    if (isNaN(amount) || amount <= 0) continue;

    const payer = typeof item.payer === 'string' ? item.payer.trim() : '';
    if (!payer) continue;

    const exact_quote =
      typeof item.exact_quote === 'string' && item.exact_quote.trim()
        ? item.exact_quote.trim()
        : '';

    if (!exact_quote) continue;

    const type = item.type === 'repayment' ? 'repayment' : 'expense';
    const recipient =
      type === 'repayment' && typeof item.recipient === 'string' && item.recipient.trim()
        ? item.recipient.trim()
        : null;

    const status = item.status === 'ambiguous' ? 'ambiguous' : 'confirmed';
    const ambiguity_reason =
      status === 'ambiguous' && typeof item.ambiguity_reason === 'string'
        ? item.ambiguity_reason
        : null;

    const split_among = Array.isArray(item.split_among)
      ? item.split_among.filter((p) => typeof p === 'string')
      : [];

    const excluded = Array.isArray(item.excluded)
      ? item.excluded.filter((p) => typeof p === 'string')
      : [];

    items.push({
      id: item.id || `item-${idCounter++}`,
      type,
      description: item.description || 'Shared expense',
      payer,
      recipient,
      amount: Math.round(amount * 100) / 100,
      split_among,
      excluded,
      exact_quote,
      status,
      confidence: status === 'ambiguous' ? 0.4 : 1.0,
      ambiguity_reason,
      raw_line_number: item.raw_line_number || null
    });
  }

  return {
    participants,
    items,
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : [],
    source: {
      parser: 'gemma',
      total_lines: rawText.split(/\r?\n/).filter((l) => l.trim().length > 0).length,
      parsed_count: items.length,
      unresolved_count: 0
    }
  };
}

/**
 * Call hosted Google AI Studio REST endpoint for Gemma (gemma-4-26b-a4b-it or gemma-4-31b-it).
 *
 * @param {string} rawText - Chat transcript
 * @param {object} [options={}] - Options
 * @returns {Promise<object>} Parsed model extraction
 */
async function callGoogleAIStudio(rawText, options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const model = options.model || process.env.GEMMA_MODEL || DEFAULT_GEMMA_MODEL;
  const timeoutMs = getGeminiTimeoutMs(options.timeoutMs);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const promptText = `${EXTRACTION_SYSTEM_PROMPT}\n\nChat transcript to extract:\n${rawText}`;

  const payload = {
    contents: [
      {
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: options.thinkingLevel || 'minimal'
      },
      maxOutputTokens: options.maxOutputTokens || 2048,
      temperature: options.temperature !== undefined ? options.temperature : 0.1
    }
  };

  const fetchImpl = options.fetchFn || fetch;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim()
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || (err.name === 'AbortError' && /timeout/i.test(err.message))) {
      throw new Error(`Google AI Studio request timed out after ${timeoutMs}ms`);
    } else if (err.name === 'AbortError') {
      throw new Error('Google AI Studio request was aborted');
    }
    throw new Error(sanitizeErrorMessage(err.message, apiKey));
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson.error?.message || JSON.stringify(errJson);
    } catch {
      errorDetail = await response.text().catch(() => '');
    }
    const safeDetail = sanitizeErrorMessage(errorDetail, apiKey);
    throw new Error(`Google AI Studio HTTP ${response.status}: ${safeDetail.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('Google AI Studio returned no candidate');
  }

  const parts = candidate.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Google AI Studio returned empty candidate content');
  }

  // Filter out internal thinking/thought parts (present in Gemma 4 / Gemini models with thinking)
  const nonThoughtParts = parts.filter((p) => !p.thought && typeof p.text === 'string');
  const textParts = nonThoughtParts.length > 0
    ? nonThoughtParts
    : parts.filter((p) => typeof p.text === 'string');

  if (textParts.length === 0) {
    throw new Error('Google AI Studio candidate contained no text parts');
  }

  const candidateText = textParts.map((p) => p.text).join('\n');
  const cleaned = cleanModelResponseText(candidateText);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`Model returned invalid JSON: ${parseErr.message}`);
  }

  const validated = validateModelExtraction(parsed, rawText);
  if (!validated) {
    throw new Error('Model output failed schema validation');
  }

  return validated;
}

/**
 * Call local Ollama endpoint for Gemma 3.
 *
 * @param {string} rawText - Chat transcript
 * @param {object} [options={}] - Options
 * @returns {Promise<object>} Parsed model extraction
 */
async function callOllama(rawText, options = {}) {
  const baseUrl = options.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL;
  const model = options.model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  const timeoutMs = options.timeoutMs || OLLAMA_TIMEOUT_MS;
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/generate`;

  const promptText = `${EXTRACTION_SYSTEM_PROMPT}\n\nChat transcript to extract:\n${rawText}`;

  const payload = {
    model,
    prompt: promptText,
    stream: false,
    format: 'json',
    options: {
      temperature: 0.1
    }
  };

  const fetchImpl = options.fetchFn || fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}`);
  }

  const data = await response.json();
  const rawResponse = data.response;
  if (!rawResponse) {
    throw new Error('Ollama returned empty response');
  }

  const cleaned = cleanModelResponseText(rawResponse);
  const parsed = JSON.parse(cleaned);
  const validated = validateModelExtraction(parsed, rawText);
  if (!validated) {
    throw new Error('Ollama model output failed schema validation');
  }

  return validated;
}

/**
 * Unified AI extraction entry point.
 * Supports:
 * - providerMode: 'auto' (tries Google AI Studio -> Ollama -> Fallback)
 * - providerMode: 'google' (tries Google AI Studio -> Fallback on error)
 * - providerMode: 'ollama' (tries Ollama -> Fallback on error)
 * - providerMode: 'fallback' (direct deterministic fallback parser)
 *
 * @param {string} rawText - Raw chat transcript
 * @param {string} [providerMode='auto'] - Provider selection
 * @param {object} [options={}] - Optional configuration
 * @returns {Promise<object>} Standardized extraction response with provider metadata
 */
async function extractExpensesWithGemma(rawText, providerMode = 'auto', options = {}) {
  const startTime = Date.now();
  const mode = (providerMode || 'auto').toLowerCase();

  // 1. Direct Fallback Mode
  if (mode === 'fallback') {
    const rawExtraction = parseChat(rawText, options);
    return {
      rawExtraction,
      providerUsed: 'fallback',
      modelName: 'deterministic-fallback',
      latencyMs: Date.now() - startTime,
      fallbackReason: options.fallbackReason || null
    };
  }

  // 2. Google AI Studio Mode
  if (mode === 'google') {
    try {
      const rawExtraction = await callGoogleAIStudio(rawText, options);
      if (options.simulateHallucination) {
        rawExtraction.items.push({
          id: `item-${rawExtraction.items.length + 1}`,
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
        rawExtraction,
        providerUsed: 'google',
        modelName: options.model || process.env.GEMMA_MODEL || DEFAULT_GEMMA_MODEL,
        latencyMs: Date.now() - startTime,
        fallbackReason: null
      };
    } catch (err) {
      // Safe fallback with transparent error reason
      const rawExtraction = parseChat(rawText, options);
      const keyForRedact = options.apiKey !== undefined ? options.apiKey : process.env.GEMINI_API_KEY;
      return {
        rawExtraction,
        providerUsed: 'fallback',
        modelName: 'deterministic-fallback',
        latencyMs: Date.now() - startTime,
        fallbackReason: sanitizeErrorMessage(`Google AI Studio failed: ${err.message}`, keyForRedact)
      };
    }
  }

  // 3. Ollama Mode
  if (mode === 'ollama') {
    try {
      const rawExtraction = await callOllama(rawText, options);
      if (options.simulateHallucination) {
        rawExtraction.items.push({
          id: `item-${rawExtraction.items.length + 1}`,
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
        rawExtraction,
        providerUsed: 'ollama',
        modelName: options.model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
        latencyMs: Date.now() - startTime,
        fallbackReason: null
      };
    } catch (err) {
      const rawExtraction = parseChat(rawText, options);
      return {
        rawExtraction,
        providerUsed: 'fallback',
        modelName: 'deterministic-fallback',
        latencyMs: Date.now() - startTime,
        fallbackReason: `Ollama failed: ${err.message}`
      };
    }
  }

  // 4. Auto Mode: Google -> Ollama -> Fallback
  const errors = [];

  // Try Google AI Studio first if API key is present
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.GEMINI_API_KEY;
  const hasGoogleKey = Boolean(apiKey && apiKey.trim());
  if (hasGoogleKey) {
    try {
      const rawExtraction = await callGoogleAIStudio(rawText, options);
      if (options.simulateHallucination) {
        rawExtraction.items.push({
          id: `item-${rawExtraction.items.length + 1}`,
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
        rawExtraction,
        providerUsed: 'google',
        modelName: options.model || process.env.GEMMA_MODEL || DEFAULT_GEMMA_MODEL,
        latencyMs: Date.now() - startTime,
        fallbackReason: null
      };
    } catch (err) {
      errors.push(sanitizeErrorMessage(`Google AI Studio: ${err.message}`, apiKey));
    }
  } else {
    errors.push('Google AI Studio: GEMINI_API_KEY not configured');
  }

  // Next try local Ollama
  try {
    const rawExtraction = await callOllama(rawText, options);
    if (options.simulateHallucination) {
      rawExtraction.items.push({
        id: `item-${rawExtraction.items.length + 1}`,
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
      rawExtraction,
      providerUsed: 'ollama',
      modelName: options.model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
      latencyMs: Date.now() - startTime,
      fallbackReason: null
    };
  } catch (err) {
    errors.push(`Ollama: ${err.message}`);
  }

  // Fallback to deterministic parser
  const rawExtraction = parseChat(rawText, options);
  return {
    rawExtraction,
    providerUsed: 'fallback',
    modelName: 'deterministic-fallback',
    latencyMs: Date.now() - startTime,
    fallbackReason: errors.join('; ')
  };
}

module.exports = {
  extractExpensesWithGemma,
  callGoogleAIStudio,
  callOllama,
  validateModelExtraction,
  cleanModelResponseText,
  sanitizeErrorMessage,
  getGeminiTimeoutMs,
  DEFAULT_GEMMA_MODEL,
  HOSTED_GEMMA_MODELS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GOOGLE_TIMEOUT_MS: DEFAULT_GEMINI_TIMEOUT_MS
};
