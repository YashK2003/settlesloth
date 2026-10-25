'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');
const {
  escapeHtml,
  formatRupees,
  classifyProviderMetadata,
  generateWhatsAppSummary
} = require('../public/app');

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

describe('Frontend Static Asset Serving & Accessibility', () => {
  test('GET / serves index.html with Single-Page Application UI & Long-Running UX Elements', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);

    const contentType = response.headers.get('content-type');
    assert.match(contentType, /text\/html/);

    const html = await response.text();
    assert.match(html, /<title>SettleSloth/i);
    assert.match(html, /id="chatInput"/);
    assert.match(html, /id="reconcileBtn"/);
    assert.match(html, /id="providerModeSelect"/);
    assert.match(html, /id="simulateHallucinationCheckbox"/);
    assert.match(html, /id="transfersList"/);
    assert.match(html, /id="quarantineSection"/);
    assert.match(html, /id="verifiedTableBody"/);
    assert.match(html, /id="auditLogSection"/);

    // Long-running AI UX Elements
    assert.match(html, /id="loadingCard"/);
    assert.match(html, /id="loadingSpinner"/);
    assert.match(html, /id="loadingTitle"/);
    assert.match(html, /id="loadingDescription"/);
    assert.match(html, /id="elapsedTimeBadge"/);
    assert.match(html, /id="elapsedSeconds"/);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);

    // Error handling with retry
    assert.match(html, /id="errorAlert"/);
    assert.match(html, /id="errorMessage"/);
    assert.match(html, /id="errorHint"/);
    assert.match(html, /id="retryBtn"/);
    assert.match(html, /role="alert"/);

    // Provider & Model Audit Badge
    assert.match(html, /id="providerAuditBadge"/);
    assert.match(html, /id="providerAuditIcon"/);
    assert.match(html, /id="providerAuditName"/);
    assert.match(html, /id="providerAuditTag"/);
    assert.match(html, /id="providerAuditDetail"/);
    assert.match(html, /id="providerAuditLatencyVal"/);

    assert.match(html, /src="app\.js"/);
    assert.match(html, /href="styles\.css"/);
  });

  test('GET /styles.css serves valid CSS stylesheet with animations and focus visibility', async () => {
    const response = await fetch(`${baseUrl}/styles.css`);
    assert.equal(response.status, 200);

    const contentType = response.headers.get('content-type');
    assert.match(contentType, /text\/css/);

    const css = await response.text();
    assert.match(css, /--bg-canopy/);
    assert.match(css, /amber-glow-card/);
    assert.match(css, /animate-spin-slow/);
    assert.match(css, /@keyframes spin-slow/);
    assert.match(css, /:focus-visible/);
  });

  test('GET /app.js serves frontend controller script with AI UX functions', async () => {
    const response = await fetch(`${baseUrl}/app.js`);
    assert.equal(response.status, 200);

    const contentType = response.headers.get('content-type');
    assert.match(contentType, /application\/javascript|text\/javascript/);

    const js = await response.text();
    assert.match(js, /function escapeHtml/);
    assert.match(js, /function formatRupees/);
    assert.match(js, /function startInferenceTimer/);
    assert.match(js, /function stopInferenceTimer/);
    assert.match(js, /function setLoadingState/);
    assert.match(js, /function classifyProviderMetadata/);
    assert.match(js, /function renderProviderAuditBadge/);
    assert.match(js, /function handleReconcile/);
    assert.match(js, /function handleSolveUpdate/);
    assert.match(js, /function generateWhatsAppSummary/);
  });
});

describe('Frontend Provider & Model Audit Badge Classification', () => {
  test('classifies genuine hosted Google AI Studio Gemma inference', () => {
    const payload = {
      providerUsed: 'google',
      modelName: 'gemma-4-26b-a4b-it',
      latencyMs: 63196,
      fallbackReason: null,
      rawExtraction: { source: { parser: 'gemma' } }
    };

    const result = classifyProviderMetadata(payload);
    assert.equal(result.category, 'google');
    assert.equal(result.isHostedAI, true);
    assert.equal(result.isFallback, false);
    assert.match(result.name, /Google AI Studio/);
    assert.match(result.name, /gemma-4-26b-a4b-it/);
    assert.match(result.tagText, /Hosted Gemma AI/);
    assert.match(result.detail, /QuoteGuard/);
  });

  test('classifies local Ollama Gemma inference', () => {
    const payload = {
      providerUsed: 'ollama',
      modelName: 'gemma3:4b',
      latencyMs: 1200,
      fallbackReason: null,
      rawExtraction: { source: { parser: 'gemma' } }
    };

    const result = classifyProviderMetadata(payload);
    assert.equal(result.category, 'ollama');
    assert.equal(result.isHostedAI, true);
    assert.equal(result.isFallback, false);
    assert.match(result.name, /Local Ollama/);
    assert.match(result.tagText, /Local Open-Weight AI/);
  });

  test('never labels fallback response as successful hosted AI inference when cloud fails', () => {
    const payload = {
      providerUsed: 'fallback',
      modelName: 'deterministic-fallback',
      latencyMs: 90050,
      fallbackReason: 'Google AI Studio failed: The operation was aborted due to timeout',
      rawExtraction: { source: { parser: 'fallback' } }
    };

    const result = classifyProviderMetadata(payload);
    assert.equal(result.category, 'fallback-error');
    assert.equal(result.isHostedAI, false, 'Fallback must NEVER be labeled as hosted AI');
    assert.equal(result.isFallback, true);
    assert.match(result.name, /Deterministic Local Engine/);
    assert.match(result.tagText, /Fallback/);
    assert.match(result.detail, /Hosted AI provider did not complete/);
    assert.match(result.detail, /timeout/);
  });

  test('classifies clean user-selected offline deterministic fallback', () => {
    const payload = {
      providerUsed: 'fallback',
      modelName: 'deterministic-fallback',
      latencyMs: 25,
      fallbackReason: null,
      rawExtraction: { source: { parser: 'fallback' } }
    };

    const result = classifyProviderMetadata(payload);
    assert.equal(result.category, 'fallback-clean');
    assert.equal(result.isHostedAI, false);
    assert.equal(result.isFallback, true);
    assert.match(result.name, /Deterministic Local Engine/);
    assert.match(result.tagText, /Deterministic Local · Offline/);
  });

  test('detects inconsistent metadata when provider claims AI but source parser was fallback', () => {
    const payload = {
      providerUsed: 'google',
      modelName: 'gemma-4-26b-a4b-it',
      latencyMs: 500,
      fallbackReason: null,
      rawExtraction: { source: { parser: 'fallback' } }
    };

    const result = classifyProviderMetadata(payload);
    assert.equal(result.category, 'inconsistent');
    assert.equal(result.isHostedAI, false);
    assert.equal(result.isFallback, true);
    assert.match(result.tagText, /Inconsistent Metadata/);
  });

  test('handles null, undefined, or missing provider metadata gracefully as unknown', () => {
    const r1 = classifyProviderMetadata(null);
    assert.equal(r1.category, 'unknown');
    assert.equal(r1.isHostedAI, false);

    const r2 = classifyProviderMetadata({});
    assert.equal(r2.category, 'unknown');
    assert.equal(r2.isHostedAI, false);

    const r3 = classifyProviderMetadata({ providerUsed: 'unexpected-provider' });
    assert.equal(r3.category, 'unknown');
    assert.equal(r3.isHostedAI, false);
  });
});

describe('Frontend Helpers & WhatsApp Summary Formatting', () => {
  test('escapeHtml prevents XSS injection strings', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(escapeHtml('Aman & Priya'), 'Aman &amp; Priya');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('formatRupees formats Indian currency amounts with 2 decimal places and handles negative values', () => {
    assert.equal(formatRupees(1200), '₹1,200.00');
    assert.equal(formatRupees(0), '₹0.00');
    assert.equal(formatRupees(1500.5), '₹1,500.50');
    assert.equal(formatRupees(-600), '-₹600.00');
    assert.equal(formatRupees('invalid'), '₹0.00');
  });

  test('generateWhatsAppSummary formats structured settlement card', () => {
    const sampleData = {
      metrics: { total_spend: 1800, drudgery_minutes_saved: 12 },
      participants: ['Aman', 'Priya', 'Rahul'],
      balances: {
        Aman: { paid: 0, owed: 600, net: -600 },
        Priya: { paid: 600, owed: 600, net: 0 },
        Rahul: { paid: 1200, owed: 600, net: 600 }
      },
      transfers: [{ from: 'Aman', to: 'Rahul', amount: 600 }]
    };

    const summary = generateWhatsAppSummary(sampleData);
    assert.match(summary, /SettleSloth Settlement Plan/);
    assert.match(summary, /Total Verified Spend.*₹1,800\.00/);
    assert.match(summary, /Aman.*Rahul.*₹600\.00/);
    assert.match(summary, /• Aman: -₹600\.00/);
    assert.match(summary, /QuoteGuard/);
  });
});

describe('Frontend Loading & Inference State Management', () => {
  const { setLoadingState, getIsLoading, startInferenceTimer, stopInferenceTimer } = require('../public/app');

  test('setLoadingState toggles loading state and prevents duplicate submissions', () => {
    assert.equal(getIsLoading(), false);

    setLoadingState(true, 'google');
    assert.equal(getIsLoading(), true, 'Loading flag should be true while request is running');

    // Simulate duplicate submission attempt
    setLoadingState(true, 'google');
    assert.equal(getIsLoading(), true);

    setLoadingState(false, 'google');
    assert.equal(getIsLoading(), false, 'Loading flag must reset when request completes');
  });

  test('startInferenceTimer and stopInferenceTimer clean up timer resources', async () => {
    startInferenceTimer();
    // Allow brief interval tick
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopInferenceTimer();

    // Verify calling stopInferenceTimer multiple times is safe and idempotent
    stopInferenceTimer();
    assert.equal(getIsLoading(), false);
  });
});
