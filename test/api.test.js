'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');
const { PRESETS } = require('../src/presets');
const {
  extractExpensesWithGemma,
  callGoogleAIStudio,
  callOllama,
  validateModelExtraction,
  cleanModelResponseText,
  sanitizeErrorMessage,
  getGeminiTimeoutMs,
  DEFAULT_GEMMA_MODEL,
  HOSTED_GEMMA_MODELS,
  DEFAULT_GEMINI_TIMEOUT_MS
} = require('../src/gemmaClient');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('GET /api/presets', () => {
  test('returns 200 and all 3 configured presets', async () => {
    const response = await fetch(`${baseUrl}/api/presets`);
    assert.equal(response.status, 200);

    const presets = await response.json();
    assert.ok(Array.isArray(presets));
    assert.equal(presets.length, 3);
    assert.deepEqual(
      presets.map((p) => p.id),
      ['goa-trip', 'bengaluru-flatmates', 'hackathon-run']
    );

    for (const preset of presets) {
      assert.ok(preset.id);
      assert.ok(preset.title);
      assert.ok(preset.text);
      assert.ok(Array.isArray(preset.participants));
    }
  });
});

describe('POST /api/reconcile', () => {
  const goaPreset = PRESETS.find((p) => p.id === 'goa-trip');

  test('reconciles chat successfully with fallback provider', async () => {
    const response = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: goaPreset.text,
        providerMode: 'fallback'
      })
    });

    assert.equal(response.status, 200);
    const data = await response.json();

    assert.equal(data.success, true);
    assert.equal(data.providerUsed, 'fallback');
    assert.equal(data.modelName, 'deterministic-fallback');
    assert.ok(typeof data.latencyMs === 'number');

    assert.deepEqual(data.participants, ['Aman', 'Neha', 'Priya', 'Rahul']);
    assert.equal(data.verified_items.length, 8);
    assert.equal(data.quarantined_items.length, 1);
    assert.equal(data.blocked_hallucinations.length, 0);

    // Verify zero-sum balance invariant
    const sumNet = Object.values(data.balances).reduce((sum, b) => sum + b.net, 0);
    assert.equal(Math.round(sumNet * 100) / 100 + 0, 0);

    // Verify transfers exist and are positive
    assert.ok(data.transfers.length > 0);
    for (const t of data.transfers) {
      assert.ok(t.amount > 0);
    }
  });

  test('auto mode gracefully falls back when no GEMINI_API_KEY is configured', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const response = await fetch(`${baseUrl}/api/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Rahul: Paid 500 for coffee\nPriya: Got snacks for 300',
          providerMode: 'auto'
        })
      });

      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.success, true);
      assert.equal(data.providerUsed, 'fallback');
      assert.ok(data.fallbackReason);
      assert.equal(data.verified_items.length, 2);
    } finally {
      if (savedKey) process.env.GEMINI_API_KEY = savedKey;
    }
  });

  test('catches simulated hallucination in POST /api/reconcile', async () => {
    const response = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: goaPreset.text,
        providerMode: 'fallback',
        simulateHallucination: true
      })
    });

    assert.equal(response.status, 200);
    const data = await response.json();

    assert.equal(data.blocked_hallucinations.length, 1);
    assert.equal(data.metrics.blocked_count, 1);
    assert.equal(data.blocked_hallucinations[0].guard, 'QuoteGuard');
  });

  test('promotes quarantined item when ID is included in includeQuarantinedIds', async () => {
    // First run without quarantine
    const res1 = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: goaPreset.text,
        providerMode: 'fallback'
      })
    });
    const data1 = await res1.json();
    const quarantinedId = data1.quarantined_items[0].id;
    const initialSpend = data1.metrics.total_spend;

    // Second run with quarantine included
    const res2 = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: goaPreset.text,
        providerMode: 'fallback',
        includeQuarantinedIds: [quarantinedId]
      })
    });
    const data2 = await res2.json();

    assert.equal(data2.verified_items.length, data1.verified_items.length + 1);
    assert.equal(data2.metrics.total_spend, initialSpend + 350);
  });

  test('validates required text input and rejects empty text', async () => {
    const res1 = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res1.status, 400);
    const body1 = await res1.json();
    assert.match(body1.error, /Chat text is required/i);

    const res2 = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '    ' })
    });
    assert.equal(res2.status, 400);

    const res3 = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 12345 })
    });
    assert.equal(res3.status, 400);
  });
});

describe('POST /api/solve', () => {
  const goaPreset = PRESETS.find((p) => p.id === 'goa-trip');

  test('recalculates ledger deterministically without model requests', async () => {
    // 1. Get extraction result from reconcile
    const reconcileRes = await fetch(`${baseUrl}/api/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: goaPreset.text,
        providerMode: 'fallback'
      })
    });
    const reconcileData = await reconcileRes.json();
    const extractionResult = reconcileData.rawExtraction;
    const quarantinedId = reconcileData.quarantined_items[0].id;

    // 2. Call POST /api/solve with quarantined item included
    const startTime = Date.now();
    const solveRes = await fetch(`${baseUrl}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: goaPreset.text,
        extractionResult,
        includeQuarantinedIds: [quarantinedId]
      })
    });
    const solveDuration = Date.now() - startTime;

    assert.equal(solveRes.status, 200);
    const solveData = await solveRes.json();

    assert.equal(solveData.success, true);
    assert.equal(solveData.verified_items.length, 9);
    assert.equal(solveData.metrics.total_spend, 15200);
    assert.ok(solveDuration < 50, 'Solve should execute almost instantly without model call');

    // Balance zero-sum invariant
    const sumNet = Object.values(solveData.balances).reduce((sum, b) => sum + b.net, 0);
    assert.equal(Math.round(sumNet * 100) / 100 + 0, 0);
  });

  test('validates input for POST /api/solve', async () => {
    const res1 = await fetch(`${baseUrl}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res1.status, 400);

    const res2 = await fetch(`${baseUrl}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: 'Rahul: Paid 500 for lunch'
      })
    });
    assert.equal(res2.status, 400);
  });
});

describe('AI Adapter Mocking & Edge Case Resilience', () => {
  const sampleChat = 'Rahul: Paid 1500 for cab\nPriya: Lunch was 800';

  test('cleanModelResponseText strips markdown code fences', () => {
    const raw = '```json\n{"participants": ["Rahul"]}\n```';
    assert.equal(cleanModelResponseText(raw), '{"participants": ["Rahul"]}');

    const rawNoLang = '```\n{"participants": ["Rahul"]}\n```';
    assert.equal(cleanModelResponseText(rawNoLang), '{"participants": ["Rahul"]}');
  });

  test('validateModelExtraction validates schema and ignores invalid items', () => {
    const modelOutput = {
      participants: ['Rahul', 'Priya'],
      items: [
        {
          description: 'cab',
          payer: 'Rahul',
          amount: 1500,
          exact_quote: 'Paid 1500 for cab',
          type: 'expense',
          status: 'confirmed'
        },
        {
          description: 'invalid amount item',
          payer: 'Priya',
          amount: -50,
          exact_quote: 'bad'
        },
        {
          description: 'missing quote item',
          payer: 'Priya',
          amount: 500,
          exact_quote: ''
        }
      ]
    };

    const validated = validateModelExtraction(modelOutput, sampleChat);
    assert.ok(validated);
    assert.equal(validated.items.length, 1);
    assert.equal(validated.items[0].amount, 1500);
  });

  test('callGoogleAIStudio succeeds with mocked fetch response', async () => {
    const mockGemmaJson = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  participants: ['Rahul', 'Priya'],
                  items: [
                    {
                      description: 'airport cab',
                      payer: 'Rahul',
                      amount: 1500,
                      exact_quote: 'Paid 1500 for cab',
                      type: 'expense',
                      status: 'confirmed'
                    }
                  ]
                })
              }
            ]
          }
        }
      ]
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockGemmaJson
    });

    const result = await callGoogleAIStudio(sampleChat, {
      apiKey: 'test-fake-key-for-mock',
      fetchFn: mockFetch
    });

    assert.ok(result);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].payer, 'Rahul');
    assert.equal(result.items[0].amount, 1500);
  });

  test('extractExpensesWithGemma falls back when mocked Google API returns HTTP 500', async () => {
    const mockErrorFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    const result = await extractExpensesWithGemma(sampleChat, 'google', {
      apiKey: 'test-fake-key-for-mock',
      fetchFn: mockErrorFetch
    });

    assert.equal(result.providerUsed, 'fallback');
    assert.match(result.fallbackReason, /Google AI Studio failed: Google AI Studio HTTP 500/);
    assert.equal(result.rawExtraction.items.length, 2);
  });

  test('extractExpensesWithGemma falls back when mocked model returns malformed JSON', async () => {
    const mockMalformedFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'Here is your json: {not valid json...' }]
            }
          }
        ]
      })
    });

    const result = await extractExpensesWithGemma(sampleChat, 'google', {
      apiKey: 'test-fake-key-for-mock',
      fetchFn: mockMalformedFetch
    });

    assert.equal(result.providerUsed, 'fallback');
    assert.match(result.fallbackReason, /Google AI Studio failed/);
    assert.equal(result.rawExtraction.items.length, 2);
  });

  test('callOllama succeeds with mocked Ollama response', async () => {
    const mockOllamaResponse = {
      response: JSON.stringify({
        participants: ['Rahul', 'Priya'],
        items: [
          {
            description: 'cab',
            payer: 'Rahul',
            amount: 1500,
            exact_quote: 'Paid 1500 for cab',
            type: 'expense',
            status: 'confirmed'
          }
        ]
      })
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockOllamaResponse
    });

    const result = await callOllama(sampleChat, {
      baseUrl: 'http://localhost:11434',
      fetchFn: mockFetch
    });

    assert.ok(result);
    assert.equal(result.items.length, 1);
  });

  test('DEFAULT_GEMMA_MODEL is gemma-4-26b-a4b-it and HOSTED_GEMMA_MODELS contains supported variants', () => {
    assert.equal(DEFAULT_GEMMA_MODEL, 'gemma-4-26b-a4b-it');
    assert.deepEqual(HOSTED_GEMMA_MODELS, ['gemma-4-26b-a4b-it', 'gemma-4-31b-it']);
  });

  test('callGoogleAIStudio rejects when GEMINI_API_KEY is missing or empty', async () => {
    await assert.rejects(
      async () => {
        await callGoogleAIStudio(sampleChat, { apiKey: '' });
      },
      {
        name: 'Error',
        message: 'GEMINI_API_KEY is not configured'
      }
    );
  });

  test('callGoogleAIStudio sends x-goog-api-key header and targets gemma-4-26b-a4b-it by default', async () => {
    let capturedUrl = '';
    let capturedHeaders = {};

    const mockFetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      participants: ['Rahul'],
                      items: [
                        {
                          description: 'cab',
                          payer: 'Rahul',
                          amount: 1500,
                          exact_quote: 'Paid 1500 for cab',
                          type: 'expense',
                          status: 'confirmed'
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        })
      };
    };

    const result = await callGoogleAIStudio(sampleChat, {
      apiKey: 'test-fake-key-for-header-check',
      fetchFn: mockFetch
    });

    assert.ok(result);
    assert.match(capturedUrl, /models\/gemma-4-26b-a4b-it:generateContent/);
    assert.equal(capturedHeaders['x-goog-api-key'], 'test-fake-key-for-header-check');
  });

  test('callGoogleAIStudio handles model reasoning and filters out internal thinking parts', async () => {
    const mockThinkingJson = {
      candidates: [
        {
          content: {
            parts: [
              {
                thought: true,
                text: 'Analyzing expenses: Rahul paid 1500 for cab. Extracting verbatim quote...'
              },
              {
                text: JSON.stringify({
                  participants: ['Rahul'],
                  items: [
                    {
                      description: 'cab',
                      payer: 'Rahul',
                      amount: 1500,
                      exact_quote: 'Paid 1500 for cab',
                      type: 'expense',
                      status: 'confirmed'
                    }
                  ]
                })
              }
            ]
          }
        }
      ]
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockThinkingJson
    });

    const result = await callGoogleAIStudio(sampleChat, {
      apiKey: 'test-fake-key-for-thinking-check',
      fetchFn: mockFetch
    });

    assert.ok(result);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].payer, 'Rahul');
    assert.equal(result.items[0].amount, 1500);
  });

  test('cleanModelResponseText extracts JSON surrounded by conversational commentary', () => {
    const withPreamble = `Sure, here is the extraction in JSON format:\n\`\`\`json\n{"participants":["Rahul"],"items":[]}\n\`\`\`\nHope this helps!`;
    const cleaned = cleanModelResponseText(withPreamble);
    assert.deepEqual(JSON.parse(cleaned), { participants: ['Rahul'], items: [] });
  });

  test('callGoogleAIStudio parses structured Google JSON errors if available', async () => {
    const mockGoogleApiError = {
      error: {
        code: 404,
        message: 'models/gemma-4-26b-a4b-it is not found for API version v1beta',
        status: 'NOT_FOUND'
      }
    };

    const mockFetch = async () => ({
      ok: false,
      status: 404,
      json: async () => mockGoogleApiError,
      text: async () => JSON.stringify(mockGoogleApiError)
    });

    await assert.rejects(
      async () => {
        await callGoogleAIStudio(sampleChat, {
          apiKey: 'test-key',
          fetchFn: mockFetch
        });
      },
      /Google AI Studio HTTP 404: models\/gemma-4-26b-a4b-it is not found/
    );
  });

  test('callGoogleAIStudio sends payload with minimal thinkingLevel and maxOutputTokens cap', async () => {
    let capturedBody = null;

    const mockFetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      participants: ['Rahul'],
                      items: [
                        {
                          description: 'cab',
                          payer: 'Rahul',
                          amount: 1500,
                          exact_quote: 'Paid 1500 for cab',
                          type: 'expense',
                          status: 'confirmed'
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        })
      };
    };

    await callGoogleAIStudio(sampleChat, {
      apiKey: 'test-key',
      fetchFn: mockFetch
    });

    assert.ok(capturedBody);
    assert.ok(capturedBody.generationConfig);
    assert.deepEqual(capturedBody.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
    assert.equal(capturedBody.generationConfig.maxOutputTokens, 2048);
    assert.equal(capturedBody.generationConfig.temperature, 0.1);
  });

  test('getGeminiTimeoutMs returns 90000 by default, respects GEMINI_TIMEOUT_MS env, and handles options override', () => {
    const savedEnv = process.env.GEMINI_TIMEOUT_MS;
    try {
      delete process.env.GEMINI_TIMEOUT_MS;
      assert.equal(getGeminiTimeoutMs(), DEFAULT_GEMINI_TIMEOUT_MS);
      assert.equal(getGeminiTimeoutMs(), 90000);

      process.env.GEMINI_TIMEOUT_MS = '45000';
      assert.equal(getGeminiTimeoutMs(), 45000);

      // Explicit override takes precedence
      assert.equal(getGeminiTimeoutMs(15000), 15000);
    } finally {
      if (savedEnv !== undefined) {
        process.env.GEMINI_TIMEOUT_MS = savedEnv;
      } else {
        delete process.env.GEMINI_TIMEOUT_MS;
      }
    }
  });

  test('callGoogleAIStudio cleanly handles timeout and abort errors', async () => {
    // 1. Timeout error
    const mockTimeoutFetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };

    await assert.rejects(
      async () => {
        await callGoogleAIStudio(sampleChat, {
          apiKey: 'test-key',
          timeoutMs: 5000,
          fetchFn: mockTimeoutFetch
        });
      },
      /Google AI Studio request timed out after 5000ms/
    );

    // 2. Abort error
    const mockAbortFetch = async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      async () => {
        await callGoogleAIStudio(sampleChat, {
          apiKey: 'test-key',
          fetchFn: mockAbortFetch
        });
      },
      /Google AI Studio request was aborted/
    );
  });

  test('extractExpensesWithGemma in google mode safely falls back on timeout with redacted diagnostic metadata', async () => {
    const mockTimeoutFetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };

    const result = await extractExpensesWithGemma(sampleChat, 'google', {
      apiKey: 'test-fake-key-for-timeout',
      timeoutMs: 3000,
      fetchFn: mockTimeoutFetch
    });

    assert.equal(result.providerUsed, 'fallback');
    assert.equal(result.modelName, 'deterministic-fallback');
    assert.match(result.fallbackReason, /Google AI Studio failed: Google AI Studio request timed out after 3000ms/);
    assert.equal(result.rawExtraction.items.length, 2);
  });

  test('extractExpensesWithGemma in auto mode safely falls back after cloud timeout', async () => {
    const mockTimeoutFetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };

    const result = await extractExpensesWithGemma(sampleChat, 'auto', {
      apiKey: 'test-fake-key-for-auto-timeout',
      timeoutMs: 4000,
      fetchFn: mockTimeoutFetch
    });

    assert.equal(result.providerUsed, 'fallback');
    assert.equal(result.modelName, 'deterministic-fallback');
    assert.match(result.fallbackReason, /Google AI Studio: Google AI Studio request timed out after 4000ms/);
    assert.match(result.fallbackReason, /Ollama:/);
    assert.equal(result.rawExtraction.items.length, 2);
  });

  test('sanitizeErrorMessage safely redacts actual API keys and standard Google key patterns', () => {
    const realKey = 'AIzaSyExampleKey1234567890abcdefgh';
    const rawError = `Request failed with key ${realKey} and header x-goog-api-key: ${realKey}`;
    const cleaned = sanitizeErrorMessage(rawError, realKey);

    assert.doesNotMatch(cleaned, new RegExp(realKey));
    assert.match(cleaned, /\[REDACTED_API_KEY\]/);
  });
});
