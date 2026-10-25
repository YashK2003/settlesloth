'use strict';

/**
 * ============================================================================
 * SettleSloth - Frontend Workbench Controller
 * ============================================================================
 *
 * Coordinates chat preset loading, AI extraction/reconciliation requests,
 * honest elapsed-time tracking, provider and model auditing, instantaneous (0ms)
 * quarantine re-solving via /api/solve, and WhatsApp summary formatting.
 *
 * Security & Correctness Invariants:
 * - Never performs financial arithmetic client-side with unverified model output.
 * - Escapes all user & model strings before rendering into the DOM.
 * - Prevents concurrent / duplicate form submissions while awaiting response.
 * - Honest elapsed timer: Never simulates fake progress or unverified stages.
 * - Distinguishes hosted AI from fallback; never labels fallback as hosted AI.
 * ============================================================================
 */

// Application State
let currentExtractionResult = null;
let currentRawText = '';
let activeQuarantinedIds = new Set();
let currentReconciliationData = null;
let isLoading = false;
let presetsCache = [];

// Elapsed time interval tracker
let inferenceTimerInterval = null;
let inferenceStartTimestamp = null;

// Helper to resolve DOM elements safely in browser or test environments
const byId = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

// DOM Element References (Input & Setup)
const chatInput = byId('chatInput');
const charCountLabel = byId('charCountLabel');
const providerModeSelect = byId('providerModeSelect');
const simulateHallucinationCheckbox = byId('simulateHallucinationCheckbox');
const reconcileBtn = byId('reconcileBtn');
const reconcileBtnIcon = byId('reconcileBtnIcon');
const reconcileBtnText = byId('reconcileBtnText');
const clearChatBtn = byId('clearChatBtn');

// Active Loading & Progress Card
const loadingCard = byId('loadingCard');
const loadingSpinner = byId('loadingSpinner');
const loadingTitle = byId('loadingTitle');
const loadingDescription = byId('loadingDescription');
const elapsedSeconds = byId('elapsedSeconds');

// Error Alert Container
const errorAlert = byId('errorAlert');
const errorMessage = byId('errorMessage');
const errorHint = byId('errorHint');
const retryBtn = byId('retryBtn');

// Top Navigation Badges
const engineStatusBadge = byId('engineStatusBadge');
const engineStatusDot = byId('engineStatusDot');
const engineStatusText = byId('engineStatusText');
const latencyValue = byId('latencyValue');

// Workbench Container States
const emptyState = byId('emptyState');
const resultsContainer = byId('resultsContainer');

// Provider & Model Audit Badge (in Results Container)
const providerAuditBadge = byId('providerAuditBadge');
const providerAuditIcon = byId('providerAuditIcon');
const providerAuditName = byId('providerAuditName');
const providerAuditTag = byId('providerAuditTag');
const providerAuditDetail = byId('providerAuditDetail');
const providerAuditLatencyVal = byId('providerAuditLatencyVal');

// Metrics DOM
const metricRawCount = byId('metricRawCount');
const metricTotalSpend = byId('metricTotalSpend');
const metricTransfersCount = byId('metricTransfersCount');
const metricTimeSaved = byId('metricTimeSaved');

// Results Sections DOM
const transfersList = byId('transfersList');
const balancesList = byId('balancesList');
const copySummaryBtn = byId('copySummaryBtn');
const copySummaryText = byId('copySummaryText');

const quarantineSection = byId('quarantineSection');
const quarantinedItemsList = byId('quarantinedItemsList');

const verifiedTableBody = byId('verifiedTableBody');
const verifiedItemsBadge = byId('verifiedItemsBadge');

const blockedHallucinationsContainer = byId('blockedHallucinationsContainer');

/**
 * Escape HTML to prevent XSS from untrusted chat messages or model claims.
 * @param {string} str - Raw string
 * @returns {string} HTML-escaped string
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format numeric currency amount in Indian Rupee standard format.
 * @param {number} amount - Amount in currency units
 * @returns {string} Formatted string, e.g. ₹1,450.00
 */
function formatRupees(amount) {
  const num = Number(amount) || 0;
  const isNegative = num < -0.001;
  const formatted = Math.abs(num).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return isNegative ? `-₹${formatted}` : `₹${formatted}`;
}

/**
 * Start honest elapsed-seconds timer.
 * Does NOT simulate fake percentage progress or imaginary stages.
 */
function startInferenceTimer() {
  stopInferenceTimer();
  inferenceStartTimestamp = Date.now();
  if (elapsedSeconds) {
    elapsedSeconds.textContent = '0';
  }
  inferenceTimerInterval = setInterval(() => {
    if (!inferenceStartTimestamp || !elapsedSeconds) return;
    const elapsed = Math.floor((Date.now() - inferenceStartTimestamp) / 1000);
    elapsedSeconds.textContent = String(elapsed);
  }, 1000);
}

/**
 * Stop and clean up inference timer.
 */
function stopInferenceTimer() {
  if (inferenceTimerInterval) {
    clearInterval(inferenceTimerInterval);
    inferenceTimerInterval = null;
  }
  inferenceStartTimestamp = null;
}

/**
 * Update UI loading state for AI inference.
 * Disables duplicate submissions, shows honest timer and progress card,
 * and preserves input and view stability.
 *
 * @param {boolean} loading - Loading flag
 * @param {string} [providerMode='auto'] - Provider selected
 */
function setLoadingState(loading, providerMode = 'auto') {
  isLoading = Boolean(loading);

  if (reconcileBtn) {
    reconcileBtn.disabled = isLoading;
    if (isLoading) {
      if (reconcileBtnIcon) reconcileBtnIcon.textContent = '⏳';
      if (reconcileBtnText) reconcileBtnText.textContent = 'Sloth is Verifying...';
    } else {
      if (reconcileBtnIcon) reconcileBtnIcon.textContent = '🦥';
      if (reconcileBtnText) reconcileBtnText.textContent = 'Let the Sloth Settle It';
    }
  }

  // Prevent input mutations during active inference while keeping it legible
  if (chatInput) {
    chatInput.readOnly = isLoading;
  }
  if (clearChatBtn) {
    clearChatBtn.disabled = isLoading;
  }
  if (providerModeSelect) {
    providerModeSelect.disabled = isLoading;
  }
  if (simulateHallucinationCheckbox) {
    simulateHallucinationCheckbox.disabled = isLoading;
  }

  // Disable preset buttons during active request to prevent duplicate trigger
  const presetButtons =
    typeof document !== 'undefined' ? document.querySelectorAll('.preset-btn') : [];
  presetButtons.forEach((btn) => {
    btn.disabled = isLoading;
  });

  // Display or hide the active loading card
  if (loadingCard) {
    if (isLoading) {
      loadingCard.classList.remove('hidden');

      // Honest explanation based on provider mode
      const mode = (providerMode || 'auto').toLowerCase();
      if (mode === 'google' || mode === 'auto') {
        if (loadingTitle) loadingTitle.textContent = 'Gemma Cloud Extraction in Progress...';
        if (loadingDescription) {
          loadingDescription.textContent =
            'Gemma extracts structured claims from the chat transcript via Google AI Studio. Deterministic JavaScript then verifies source quotes with QuoteGuard and performs all balance arithmetic.';
        }
      } else if (mode === 'ollama') {
        if (loadingTitle) loadingTitle.textContent = 'Local Ollama Inference Running...';
        if (loadingDescription) {
          loadingDescription.textContent =
            'Local Ollama instance is processing the chat transcript using Gemma. Latency depends on local hardware.';
        }
      } else {
        if (loadingTitle) loadingTitle.textContent = 'Deterministic Rule Engine Parsing...';
        if (loadingDescription) {
          loadingDescription.textContent =
            'Parsing messages offline using deterministic regular expressions and grammar rules.';
        }
      }

      startInferenceTimer();
    } else {
      loadingCard.classList.add('hidden');
      stopInferenceTimer();
    }
  } else if (!isLoading) {
    stopInferenceTimer();
  }
}

/**
 * Display or hide error alert box with optional action hint.
 * @param {string|null} msg - Error message or null to hide
 * @param {string|null} [hint] - Helpful user hint or suggestion
 */
function showError(msg, hint = null) {
  if (msg) {
    if (errorMessage) errorMessage.textContent = msg;
    if (errorHint) {
      if (hint) {
        errorHint.textContent = hint;
        errorHint.classList.remove('hidden');
      } else {
        errorHint.textContent = '';
        errorHint.classList.add('hidden');
      }
    }
    if (errorAlert) errorAlert.classList.remove('hidden');
  } else {
    if (errorAlert) errorAlert.classList.add('hidden');
    if (errorMessage) errorMessage.textContent = '';
    if (errorHint) {
      errorHint.textContent = '';
      errorHint.classList.add('hidden');
    }
  }
}

/**
 * Classify provider metadata with strict verification rules.
 * Never labels a fallback response as successful hosted AI inference.
 * If provider metadata is missing or inconsistent, returns unverified state.
 *
 * @param {object} data - Full reconciliation API response
 * @returns {object} Classification result
 */
function classifyProviderMetadata(data) {
  if (!data || typeof data !== 'object') {
    return {
      category: 'unknown',
      badgeClass: 'bg-slate-900/90 border-slate-700/80 text-slate-300',
      tagClass: 'bg-slate-800 text-slate-400 border-slate-700',
      tagText: 'Unverified Metadata',
      icon: '❓',
      name: 'Unverified Provider',
      detail: 'Provider metadata returned by backend is missing or invalid.',
      isHostedAI: false,
      isFallback: false
    };
  }

  const { providerUsed, modelName, fallbackReason, rawExtraction } = data;
  const sourceParser = rawExtraction?.source?.parser;

  // Inconsistent check: provider claims to be AI but extraction source parser is fallback
  if (
    (providerUsed === 'google' && sourceParser === 'fallback') ||
    (providerUsed === 'ollama' && sourceParser === 'fallback')
  ) {
    return {
      category: 'inconsistent',
      badgeClass: 'bg-amber-950/40 border-amber-500/50 text-amber-200',
      tagClass: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
      tagText: 'Inconsistent Metadata',
      icon: '⚠️',
      name: 'Inconsistent Provider State',
      detail: 'Backend reported AI provider used, but extraction source reflects local fallback parser. Ledger was reconciled via fallback.',
      isHostedAI: false,
      isFallback: true
    };
  }

  // 1. Genuine Hosted Google AI Studio Gemma
  if (providerUsed === 'google' && !fallbackReason) {
    return {
      category: 'google',
      badgeClass: 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200',
      tagClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      tagText: 'Hosted Gemma AI · Verified',
      icon: '✨',
      name: `Google AI Studio · ${modelName || 'gemma-4-26b-a4b-it'}`,
      detail: 'Claims extracted via hosted open-weight Gemma model on Google AI Studio, then verified through deterministic QuoteGuard.',
      isHostedAI: true,
      isFallback: false
    };
  }

  // 2. Local Ollama Gemma
  if (providerUsed === 'ollama' && !fallbackReason) {
    return {
      category: 'ollama',
      badgeClass: 'bg-cyan-950/40 border-cyan-500/50 text-cyan-200',
      tagClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
      tagText: 'Local Open-Weight AI',
      icon: '🦙',
      name: `Local Ollama · ${modelName || 'gemma3:4b'}`,
      detail: 'Claims extracted via local Ollama open-weight Gemma, then verified through deterministic QuoteGuard.',
      isHostedAI: true,
      isFallback: false
    };
  }

  // 3. Fallback due to Cloud Provider Failure (Never label as hosted AI!)
  if (providerUsed === 'fallback' && fallbackReason) {
    return {
      category: 'fallback-error',
      badgeClass: 'bg-amber-950/40 border-amber-500/60 text-amber-200',
      tagClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      tagText: 'Deterministic Fallback (Cloud Failed)',
      icon: '⚠️',
      name: 'Deterministic Local Engine (Cloud Fallback)',
      detail: `Hosted AI provider did not complete: ${fallbackReason}. Reconciled safely with deterministic local engine instead. Zero hallucinated claims.`,
      isHostedAI: false,
      isFallback: true
    };
  }

  // 4. Fallback by user choice or default
  if (providerUsed === 'fallback') {
    return {
      category: 'fallback-clean',
      badgeClass: 'bg-slate-900/90 border-slate-700/80 text-slate-200',
      tagClass: 'bg-slate-800 text-amber-300 border-slate-700',
      tagText: 'Deterministic Local · Offline',
      icon: '⚡',
      name: 'Deterministic Local Engine',
      detail: 'Claims extracted instantly via rule-based regex and grammar parsing with zero external network dependencies.',
      isHostedAI: false,
      isFallback: true
    };
  }

  // Fallback unknown
  return {
    category: 'unknown',
    badgeClass: 'bg-slate-900/90 border-slate-700/80 text-slate-300',
    tagClass: 'bg-slate-800 text-slate-400 border-slate-700',
    tagText: 'Unverified Provider',
    icon: '❓',
    name: `Unverified (${providerUsed || 'Unknown'})`,
    detail: 'Provider metadata was not recognized by the client.',
    isHostedAI: false,
    isFallback: false
  };
}

/**
 * Update the detailed Provider & Model Audit Badge inside the results workbench.
 * @param {object} data - Full reconciliation API response
 */
function renderProviderAuditBadge(data) {
  if (!providerAuditBadge) return;

  const info = classifyProviderMetadata(data);
  providerAuditBadge.className = `p-4 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs shadow-md transition-all ${info.badgeClass}`;

  if (providerAuditIcon) providerAuditIcon.textContent = info.icon;
  if (providerAuditName) providerAuditName.textContent = info.name;
  if (providerAuditTag) {
    providerAuditTag.className = `px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider font-semibold border ${info.tagClass}`;
    providerAuditTag.textContent = info.tagText;
  }
  if (providerAuditDetail) providerAuditDetail.textContent = info.detail;
  if (providerAuditLatencyVal) {
    providerAuditLatencyVal.textContent =
      typeof data?.latencyMs === 'number' ? data.latencyMs.toLocaleString() : '0';
  }
}

/**
 * Update the top header engine status badge.
 * @param {string} provider - 'google', 'ollama', or 'fallback'
 * @param {string} [modelName] - Name of model
 * @param {number} [latencyMs] - Latency in ms
 */
function updateEngineBadge(provider, modelName, latencyMs) {
  if (typeof latencyMs === 'number' && latencyValue) {
    latencyValue.textContent = latencyMs.toLocaleString();
  }

  if (!engineStatusDot || !engineStatusText) return;

  if (provider === 'google') {
    engineStatusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 pulse-dot';
    engineStatusText.textContent = `Google AI Studio (${modelName || 'gemma-4-26b-a4b-it'})`;
  } else if (provider === 'ollama') {
    engineStatusDot.className = 'w-2 h-2 rounded-full bg-cyan-400 pulse-dot';
    engineStatusText.textContent = `Ollama Local (${modelName || 'gemma3'})`;
  } else {
    engineStatusDot.className = 'w-2 h-2 rounded-full bg-amber-400';
    engineStatusText.textContent = 'Deterministic Local Engine (Offline)';
  }
}

/**
 * Update character count indicator below chat textarea.
 */
function updateCharCount() {
  if (!chatInput || !charCountLabel) return;
  const len = chatInput.value.length;
  charCountLabel.textContent = `${len.toLocaleString()} characters`;
}

/**
 * Fetch presets from API and set up preset buttons.
 */
async function loadPresets() {
  try {
    const res = await fetch('/api/presets');
    if (res.ok) {
      presetsCache = await res.json();
    }
  } catch (err) {
    console.warn('Could not load presets from API:', err);
  }

  // Wire up preset buttons
  const buttons = document.querySelectorAll('.preset-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isLoading) return; // Prevent clicking while loading
      const presetId = btn.getAttribute('data-preset');
      const preset = presetsCache.find((p) => p.id === presetId);
      if (preset && preset.text && chatInput) {
        chatInput.value = preset.text;
        updateCharCount();
        showError(null);
        // Highlight active preset button
        buttons.forEach((b) => b.classList.remove('border-amber-500', 'bg-slate-800'));
        btn.classList.add('border-amber-500', 'bg-slate-800');
      }
    });
  });
}

/**
 * Check backend health configuration on page startup.
 */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const data = await res.json();
      if (data.providerConfigured?.google && providerModeSelect) {
        providerModeSelect.value = 'auto';
      }
    }
  } catch {
    // Non-fatal on startup
  }
}

/**
 * Render all reconciliation results to the DOM.
 * @param {object} data - Full reconciliation payload
 */
function renderReconciliation(data) {
  currentReconciliationData = data;

  // 0. Update Provider & Model Audit Badge
  renderProviderAuditBadge(data);

  // 1. Payoff Banner Metrics
  if (metricRawCount) metricRawCount.textContent = data.metrics?.raw_transaction_count || 0;
  if (metricTotalSpend) metricTotalSpend.textContent = formatRupees(data.metrics?.total_spend || 0);
  if (metricTransfersCount) metricTransfersCount.textContent = data.transfers ? data.transfers.length : 0;
  if (metricTimeSaved) metricTimeSaved.textContent = `~${data.metrics?.drudgery_minutes_saved || 15} mins`;

  // 2. Minimum Settlement Plan (Transfers)
  if (transfersList) {
    transfersList.innerHTML = '';
    if (!data.transfers || data.transfers.length === 0) {
      transfersList.innerHTML = `
        <div class="col-span-full p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-400">
          ✨ All participant balances are already settled! No transfers needed.
        </div>
      `;
    } else {
      data.transfers.forEach((t, idx) => {
        const card = document.createElement('div');
        card.className =
          'p-3.5 rounded-xl bg-slate-900/90 border border-slate-800/90 hover:border-slate-700 flex items-center justify-between gap-3 shadow-md smooth-transition';
        card.innerHTML = `
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-5 h-5 rounded-full bg-slate-800 text-slate-400 text-[10px] flex items-center justify-center font-mono">
              ${idx + 1}
            </span>
            <div class="truncate">
              <span class="font-bold text-rose-300 text-xs">${escapeHtml(t.from)}</span>
              <span class="text-slate-500 text-[10px] mx-1">pays ➔</span>
              <span class="font-bold text-emerald-300 text-xs">${escapeHtml(t.to)}</span>
            </div>
          </div>
          <div class="font-bold text-amber-400 font-mono-numbers text-sm whitespace-nowrap">
            ${formatRupees(t.amount)}
          </div>
        `;
        transfersList.appendChild(card);
      });
    }
  }

  // 3. Final Net Balances
  if (balancesList) {
    balancesList.innerHTML = '';
    if (data.balances) {
      const entries = Object.entries(data.balances).sort((a, b) => b[1].net - a[1].net);
      entries.forEach(([name, bal]) => {
        const net = bal.net || 0;
        const isPositive = net > 0.001;
        const isNegative = net < -0.001;

        let colorClass = 'bg-slate-800 text-slate-300 border-slate-700';
        let signPrefix = '';
        if (isPositive) {
          colorClass = 'bg-emerald-950/60 text-emerald-300 border-emerald-500/30';
          signPrefix = '+';
        } else if (isNegative) {
          colorClass = 'bg-rose-950/60 text-rose-300 border-rose-500/30';
        }

        const pill = document.createElement('div');
        pill.className = `px-3 py-1.5 rounded-lg border text-xs flex items-center gap-2 ${colorClass}`;
        pill.innerHTML = `
          <span class="font-medium">${escapeHtml(name)}</span>
          <span class="font-mono-numbers font-bold text-[11px]">${signPrefix}${formatRupees(net)}</span>
        `;
        balancesList.appendChild(pill);
      });
    }
  }

  // 4. Amber "Needs Checking" Quarantine Box
  if (quarantinedItemsList && quarantineSection) {
    quarantinedItemsList.innerHTML = '';
    const quarantinedItems = data.quarantined_items || [];
    if (quarantinedItems.length > 0) {
      quarantineSection.classList.remove('hidden');
      quarantinedItems.forEach((item) => {
        const isIncluded = activeQuarantinedIds.has(item.id);
        const row = document.createElement('div');
        row.className =
          'p-3 rounded-xl bg-slate-900/80 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs';
        row.innerHTML = `
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="font-semibold text-white">${escapeHtml(item.payer)}:</span>
              <span class="font-mono-numbers text-amber-400 font-bold">${formatRupees(item.amount)}</span>
              <span class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 text-[10px] border border-amber-500/20">
                ${escapeHtml(item.description)}
              </span>
            </div>
            <p class="text-slate-400 italic text-[11px] truncate mb-1">
              &ldquo;${escapeHtml(item.exact_quote)}&rdquo;
            </p>
            <p class="text-[10px] text-amber-300/80 flex items-center gap-1">
              <span>⚠️</span> Reason: ${escapeHtml(item.ambiguity_reason || 'Unconfirmed amount or marker')}
            </p>
          </div>
          <div class="flex items-center sm:self-center">
            <label class="flex items-center gap-2 px-3 py-1.5 rounded-lg border cursor-pointer select-none transition-colors ${
              isIncluded
                ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold'
                : 'bg-slate-800 text-amber-300 border-amber-500/30 hover:bg-slate-700'
            }">
              <input type="checkbox" data-quarantine-id="${escapeHtml(item.id)}" ${
          isIncluded ? 'checked' : ''
        } class="quarantine-toggle rounded text-amber-600 focus:ring-amber-500">
              <span class="text-xs">${isIncluded ? 'Included in Math ✓' : 'Confirm &amp; Include'}</span>
            </label>
          </div>
        `;
        quarantinedItemsList.appendChild(row);
      });

      // Wire up checkbox toggles
      const toggles = quarantinedItemsList.querySelectorAll('.quarantine-toggle');
      toggles.forEach((chk) => {
        chk.addEventListener('change', async (e) => {
          const id = e.target.getAttribute('data-quarantine-id');
          if (e.target.checked) {
            activeQuarantinedIds.add(id);
          } else {
            activeQuarantinedIds.delete(id);
          }
          await handleSolveUpdate();
        });
      });
    } else {
      quarantineSection.classList.add('hidden');
    }
  }

  // 5. Verified Expense & Repayment Ledger
  if (verifiedTableBody && verifiedItemsBadge) {
    verifiedTableBody.innerHTML = '';
    const verifiedItems = data.verified_items || [];
    verifiedItemsBadge.textContent = `${verifiedItems.length} Verified`;

    if (verifiedItems.length === 0) {
      verifiedTableBody.innerHTML = `
        <tr>
          <td colspan="5" class="py-6 text-center text-slate-500">No verified expenses found.</td>
        </tr>
      `;
    } else {
      verifiedItems.forEach((item) => {
        const isRepayment = item.type === 'repayment';
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-900/50 transition-colors';

        let typeBadge = isRepayment
          ? '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-cyan-950 text-cyan-300 border border-cyan-500/30">Repayment</span>'
          : '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950 text-emerald-300 border border-emerald-500/30">Expense</span>';

        let splitText = '';
        if (isRepayment) {
          splitText = `<span class="text-cyan-300">Paid to <strong>${escapeHtml(item.recipient)}</strong></span>`;
        } else if (item.excluded && item.excluded.length > 0) {
          const excludedPills = item.excluded
            .map(
              (name) =>
                `<span class="px-1.5 py-0.2 rounded bg-rose-950/80 text-rose-300 border border-rose-500/20 text-[9px] line-through">${escapeHtml(name)}</span>`
            )
            .join(' ');
          splitText = `<span class="text-slate-400">All except:</span> ${excludedPills}`;
        } else if (item.split_among && item.split_among.length > 0) {
          splitText = escapeHtml(item.split_among.join(', '));
        } else {
          splitText = '<span class="text-slate-400">All members</span>';
        }

        tr.innerHTML = `
          <td class="py-2.5 px-3 whitespace-nowrap">${typeBadge}</td>
          <td class="py-2.5 px-3 font-semibold text-white whitespace-nowrap">${escapeHtml(item.payer)}</td>
          <td class="py-2.5 px-3">
            <div class="font-medium text-slate-200">${escapeHtml(item.description)}</div>
            <div class="text-[10px] text-slate-400 italic truncate max-w-xs sm:max-w-md">
              &ldquo;${escapeHtml(item.exact_quote)}&rdquo;
            </div>
          </td>
          <td class="py-2.5 px-3">${splitText}</td>
          <td class="py-2.5 px-3 text-right font-mono-numbers font-bold ${
            isRepayment ? 'text-cyan-400' : 'text-emerald-400'
          }">
            ${formatRupees(item.amount)}
          </td>
        `;
        verifiedTableBody.appendChild(tr);
      });
    }
  }

  // 6. Anti-Hallucination Audit Log
  if (blockedHallucinationsContainer) {
    const blocked = data.blocked_hallucinations || [];
    const verifiedCount = data.verified_items ? data.verified_items.length : 0;
    blockedHallucinationsContainer.innerHTML = '';

    if (blocked.length === 0) {
      blockedHallucinationsContainer.innerHTML = `
        <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 flex items-center gap-2">
          <span class="text-emerald-400 font-bold">✓</span>
          <span>All ${verifiedCount} active claims passed QuoteGuard and ParticipantGuard verification. Zero ungrounded hallucinations detected.</span>
        </div>
      `;
    } else {
      blocked.forEach((b) => {
        const card = document.createElement('div');
        card.className =
          'p-3.5 rounded-xl bg-rose-950/40 border border-rose-500/50 text-xs flex flex-col gap-1.5 mb-2';
        card.innerHTML = `
          <div class="flex items-center justify-between text-rose-300 font-bold">
            <span class="flex items-center gap-1.5">
              <span>🛡️</span> Blocked by ${escapeHtml(b.guard || 'QuoteGuard')}
            </span>
            <span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-200 text-[10px] uppercase font-mono">
              Hallucination Intercepted
            </span>
          </div>
          <div class="text-slate-300 font-mono text-[11px] bg-slate-950/60 p-2 rounded border border-rose-900/40">
            Claim: ${escapeHtml(b.item?.exact_quote || b.item?.description || 'Unsupported claim')}
            (${formatRupees(b.item?.amount || 0)})
          </div>
          <p class="text-[11px] text-rose-300/90 font-medium">
            <strong>Reason:</strong> ${escapeHtml(b.reason || 'Not grounded in chat text')}
          </p>
        `;
        blockedHallucinationsContainer.appendChild(card);
      });
    }
  }

  // Reveal results container and hide empty state
  if (emptyState) emptyState.classList.add('hidden');
  if (resultsContainer) resultsContainer.classList.remove('hidden');
}

/**
 * Handle user clicking the primary "Let the Sloth Settle It" reconcile button.
 */
async function handleReconcile() {
  if (isLoading) return;
  const text = chatInput ? chatInput.value.trim() : '';
  if (!text) {
    showError('Please paste group chat messages or select a preset to reconcile.');
    if (chatInput) chatInput.focus();
    return;
  }

  showError(null);
  const providerMode = providerModeSelect ? providerModeSelect.value : 'auto';
  const simulateHallucination = simulateHallucinationCheckbox ? simulateHallucinationCheckbox.checked : false;

  setLoadingState(true, providerMode);

  try {
    const res = await fetch('/api/reconcile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        providerMode,
        includeQuarantinedIds: Array.from(activeQuarantinedIds),
        simulateHallucination
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      const serverErr = data?.error || `Server returned HTTP ${res.status}`;
      throw new Error(serverErr);
    }

    currentRawText = text;
    currentExtractionResult = data.rawExtraction;

    updateEngineBadge(data.providerUsed, data.modelName, data.latencyMs);
    renderReconciliation(data);
  } catch (err) {
    const isTimeout = /timeout|aborted|network/i.test(err.message || '');
    const hint = isTimeout
      ? 'Tip: Hosted Gemma may be busy or experiencing high latency. You can select "Deterministic Local Engine" for instant offline reconciliation, or click Retry.'
      : 'Tip: Verify your inputs and service status at /api/health, then click Retry.';
    showError(err.message || 'Error occurred while reconciling expenses.', hint);
  } finally {
    setLoadingState(false, providerMode);
  }
}

/**
 * Handle immediate 0ms solve recalculation when a quarantined item is toggled.
 * Does NOT call the AI model.
 */
async function handleSolveUpdate() {
  if (!currentExtractionResult || !currentRawText) return;

  try {
    const res = await fetch('/api/solve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        rawText: currentRawText,
        extractionResult: currentExtractionResult,
        includeQuarantinedIds: Array.from(activeQuarantinedIds)
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      // Re-render with existing extraction result
      renderReconciliation({
        ...data,
        rawExtraction: currentExtractionResult
      });
    }
  } catch (err) {
    showError('Could not update settlement math: ' + err.message);
  }
}

/**
 * Generate a clean, readable WhatsApp markdown card for copy-paste sharing.
 */
function generateWhatsAppSummary(data) {
  if (!data) return '';

  const lines = [];
  lines.push('🦥 *SettleSloth Settlement Plan*');
  lines.push('═════════════════════════════════');
  lines.push(`📊 *Total Verified Spend:* ${formatRupees(data.metrics?.total_spend || 0)}`);
  if (data.participants && data.participants.length > 0) {
    lines.push(`👥 *Participants:* ${data.participants.join(', ')}`);
  }
  lines.push('');

  lines.push('💰 *Final Net Balances:*');
  if (data.balances) {
    const sorted = Object.entries(data.balances).sort((a, b) => b[1].net - a[1].net);
    for (const [name, b] of sorted) {
      const net = b.net || 0;
      const prefix = net > 0 ? '+' : '';
      lines.push(`• ${name}: ${prefix}${formatRupees(net)}`);
    }
  }
  lines.push('');

  lines.push('🤝 *Recommended Transfers:*');
  if (!data.transfers || data.transfers.length === 0) {
    lines.push('✨ All balances settled! No transfers needed.');
  } else {
    data.transfers.forEach((t, i) => {
      lines.push(`${i + 1}. *${t.from}* ➔ *${t.to}*: ${formatRupees(t.amount)}`);
    });
  }

  lines.push('═════════════════════════════════');
  lines.push('🛡️ Verified with SettleSloth deterministic QuoteGuard.');

  return lines.join('\n');
}

/**
 * Copy formatted settlement summary to system clipboard with user feedback.
 */
async function handleCopySummary() {
  if (!currentReconciliationData) return;

  const summaryText = generateWhatsAppSummary(currentReconciliationData);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(summaryText);
    } else {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = summaryText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    if (copySummaryText) copySummaryText.textContent = 'Copied to Clipboard! ✓';
    if (copySummaryBtn) copySummaryBtn.classList.replace('bg-emerald-600', 'bg-emerald-500');

    setTimeout(() => {
      if (copySummaryText) copySummaryText.textContent = 'Copy WhatsApp Summary';
      if (copySummaryBtn) copySummaryBtn.classList.replace('bg-emerald-500', 'bg-emerald-600');
    }, 2000);
  } catch {
    showError('Could not copy to clipboard automatically. Please copy manually.');
  }
}

// Initialization on DOM Content Loaded (Browser context)
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    loadPresets();
    checkHealth();

    if (chatInput) chatInput.addEventListener('input', updateCharCount);
    if (clearChatBtn) {
      clearChatBtn.addEventListener('click', () => {
        if (chatInput) chatInput.value = '';
        updateCharCount();
        showError(null);
      });
    }

    if (reconcileBtn) reconcileBtn.addEventListener('click', handleReconcile);
    if (copySummaryBtn) copySummaryBtn.addEventListener('click', handleCopySummary);
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        showError(null);
        handleReconcile();
      });
    }
  });
}

// Export functions for unit testing in Node environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml,
    formatRupees,
    classifyProviderMetadata,
    generateWhatsAppSummary,
    startInferenceTimer,
    stopInferenceTimer,
    setLoadingState,
    showError,
    getIsLoading: () => isLoading
  };
}
