'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { PRESETS } = require('./src/presets');
const { extractExpensesWithGemma } = require('./src/gemmaClient');
const { reconcileLedger } = require('./src/reconciler');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Serve static frontend files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Basic landing response / Single-Page Application root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health endpoint returning service metadata and configured open-weight models.
app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'settlesloth',
    openWeightModels: ['gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gemma3:4b', 'gemma3:1b'],
    providerConfigured: {
      google: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
      ollama: Boolean(process.env.OLLAMA_BASE_URL && process.env.OLLAMA_BASE_URL.trim())
    }
  });
});

// Presets endpoint returning the 3 built-in evaluation chat transcripts.
app.get('/api/presets', (_req, res) => {
  res.status(200).json(PRESETS);
});

// Reconcile endpoint: extracts claims via Gemma/fallback and runs deterministic reconciliation.
app.post('/api/reconcile', async (req, res, next) => {
  try {
    const {
      text,
      providerMode = 'auto',
      includeQuarantinedIds = [],
      simulateHallucination = false
    } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        error: 'Chat text is required and cannot be empty'
      });
    }

    const validModes = new Set(['auto', 'google', 'ollama', 'fallback']);
    const selectedMode =
      typeof providerMode === 'string' && validModes.has(providerMode.toLowerCase())
        ? providerMode.toLowerCase()
        : 'auto';

    const safeQuarantinedIds = Array.isArray(includeQuarantinedIds)
      ? includeQuarantinedIds.filter((id) => typeof id === 'string')
      : [];

    const extraction = await extractExpensesWithGemma(text, selectedMode, {
      simulateHallucination: Boolean(simulateHallucination)
    });

    const reconciliation = reconcileLedger(text, extraction.rawExtraction, safeQuarantinedIds);

    return res.status(200).json({
      success: true,
      providerUsed: extraction.providerUsed,
      modelName: extraction.modelName,
      latencyMs: extraction.latencyMs,
      fallbackReason: extraction.fallbackReason,
      participants: reconciliation.participants,
      verified_items: reconciliation.verified_items,
      quarantined_items: reconciliation.quarantined_items,
      blocked_hallucinations: reconciliation.blocked_hallucinations,
      balances: reconciliation.balances,
      transfers: reconciliation.transfers,
      metrics: reconciliation.metrics,
      rawExtraction: extraction.rawExtraction
    });
  } catch (err) {
    next(err);
  }
});

// Solve endpoint: 0ms deterministic recalculation when toggling quarantined items.
// Never invokes the AI model.
app.post('/api/solve', (req, res, next) => {
  try {
    const { rawText, text, extractionResult, includeQuarantinedIds = [] } = req.body || {};
    const sourceText = rawText || text;

    if (typeof sourceText !== 'string' || !sourceText.trim()) {
      return res.status(400).json({
        error: 'Source chat text (rawText) is required'
      });
    }

    if (
      !extractionResult ||
      typeof extractionResult !== 'object' ||
      !Array.isArray(extractionResult.items)
    ) {
      return res.status(400).json({
        error: 'Valid extractionResult containing an items array is required'
      });
    }

    const safeQuarantinedIds = Array.isArray(includeQuarantinedIds)
      ? includeQuarantinedIds.filter((id) => typeof id === 'string')
      : [];

    const reconciliation = reconcileLedger(sourceText, extractionResult, safeQuarantinedIds);

    return res.status(200).json({
      success: true,
      participants: reconciliation.participants,
      verified_items: reconciliation.verified_items,
      quarantined_items: reconciliation.quarantined_items,
      blocked_hallucinations: reconciliation.blocked_hallucinations,
      balances: reconciliation.balances,
      transfers: reconciliation.transfers,
      metrics: reconciliation.metrics
    });
  } catch (err) {
    next(err);
  }
});

// Consistent response for unknown routes.
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Handle malformed JSON and unexpected server errors.
app.use((err, _req, res, _next) => {
  if (
    err instanceof SyntaxError &&
    err.status === 400 &&
    Object.prototype.hasOwnProperty.call(err, 'body')
  ) {
    return res.status(400).json({
      error: 'Invalid JSON body'
    });
  }

  const safeMessage = typeof err?.message === 'string'
    ? err.message.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
    : 'Unknown error';
  console.error('Server error:', safeMessage);

  return res.status(500).json({
    error: 'Internal server error'
  });
});

// Start listening only when this file is run directly.
// Importing it in tests will not start another server.
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;

  const server = app.listen(port, () => {
    console.log(`SettleSloth running at http://localhost:${port}`);
  });

  server.on('error', (error) => {
    console.error('Failed to start server:', error.message);
    process.exitCode = 1;
  });
}

module.exports = app;
