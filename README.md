# SettleSloth 🦥

> **"The Open Model Extracts, Deterministic Code Guarantees."**
>
> A neuro-symbolic group expense reconciler that turns chaotic group-chat dumps into audit-verified debt settlements. Built with Google Gemma open-weight models (hosted Gemma 4 via Google AI Studio or local Ollama), a deterministic verification engine, and zero external build tooling.

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 88 passing](https://img.shields.io/badge/Tests-88%20passing-brightgreen.svg)]()
[![Zero Bundler](https://img.shields.io/badge/Dependencies-Express%20%26%20Dotenv%20Only-blue.svg)]()
[![Hacktoberfest 2026](https://img.shields.io/badge/Hacktoberfest-Week%203%20%22Slow%20and%20Steady%22-orange.svg)]()

---

## The Problem: Group Expense Procrastination & Chatbot Hallucination

Reconciling group expenses after weekend trips, hackathons, or month-end flatmate bills is notorious for causing procrastination:
- **Chaotic chat reality:** Friends don't write structured ledgers; they send conversational Hinglish/slang text dumps:
  > *"Rahul: paid 2.4k for dinner. Aman didn't drink so don't count him."*
  > *"Priya: Aman sent Rahul 500 for petrol. Petrol was maybe ₹350?"*
- **Shorthand, exclusions, and repayments:** Expenses use `k` notation (`2.4k = 2400`), complex participant exclusions (`don't count Aman`), direct repayments (`Aman sent Rahul 500`), and fuzzy, uncertain estimates.
- **Why pure LLM chatbots fail:** When general-purpose LLMs are asked to calculate debts directly from chat text, they suffer catastrophic arithmetic hallucinations:
  1. They invent non-existent numbers or drop participants.
  2. They double-count repayments as fresh group expenses.
  3. They silently incorporate uncertain guesses into binding balances.
  4. Their balance totals fail to sum to zero ($\sum \text{net} \neq 0$).

---

## The SettleSloth Solution: Neuro-Symbolic Verification

SettleSloth applies a strict separation of concerns:
**The open-weight model extracts verbatim evidence; deterministic code guarantees the math.**

```
                      ┌──────────────────────────────────────┐
                      │ Raw WhatsApp / Telegram Chat Dump    │
                      └──────────────────┬───────────────────┘
                                         │
                                         ▼
                      ┌──────────────────────────────────────┐
                      │      Open-Weight Model Extraction     │
                      │  Google AI Studio (gemma-4-26b-a4b-it)│
                      │      or Local Ollama (gemma3:4b)     │
                      │   (or Deterministic Fallback Parser)  │
                      └──────────────────┬───────────────────┘
                                         │ Structured Claims & Quotes
                                         ▼
                      ┌──────────────────────────────────────┐
                      │  Deterministic Verification Engine   │
                      │                                      │
                      │  1. QuoteGuard:                      │
                      │     - Case-insensitive & normalized  │
                      │       exact quote matching.          │
                      │     - Grounds amounts against quote. │
                      │                                      │
                      │  2. ParticipantGuard:                │
                      │     - Rejects unestablished names.   │
                      │     - Blocks self-repayments.        │
                      │                                      │
                      │  3. Ambiguity Quarantine:            │
                      │     - Isolates "maybe", "?", "approx"│
                      │     - Out of balance calculation     │
                      │       until human approval.          │
                      └─────────┬──────────────────┬─────────┘
                                │                  │
           Verified Claims ─────┘                  └───── Blocked Hallucinations
                                                          (Recorded in Audit Log)
                                │
                                ▼
                      ┌──────────────────────────────────────┐
                      │    Deterministic Settlement Solver   │
                      │  - Integer paise/cents math (no NaN) │
                      │  - Strict invariant: ∑ Net ≡ 0.00    │
                      │  - Greedy Cash-Flow Minimization     │
                      │  - 0ms Instant Toggle (POST /solve)  │
                      └──────────────────┬───────────────────┘
                                         │
                                         ▼
                      ┌──────────────────────────────────────┐
                      │  Night Canopy & Amber Ledger UI      │
                      │  - Verified Ledger Table             │
                      │  - Amber Quarantine Review Controls  │
                      │  - 1-Click WhatsApp Markdown Exporter│
                      └──────────────────────────────────────┘
```

### Core Verification Guarantees

1. **QuoteGuard (Ground-Truth Evidence):**
   Every single extracted claim must carry an `exact_quote`. QuoteGuard normalizes whitespace and casing, verifying that the quote exists verbatim in the source conversation. Furthermore, QuoteGuard independently parses the numerical tokens inside the quote (including `2.4k`, `1.5k`, `₹350`) to verify that the extracted amount is grounded in the quote. If an AI hallucinates an expense or invents a number, QuoteGuard blocks it into `blocked_hallucinations` with an explanatory reason.

2. **ParticipantGuard (Identity & Membership Integrity):**
   Names are normalized and validated against conversation participants. Untracked third parties cannot silently accumulate debt, and self-repayments (`Rahul sent Rahul 500`) are rejected.

3. **Ambiguity Quarantine (Amber Ledger):**
   Any claim containing linguistic uncertainty markers (*"maybe"*, *"around"*, *"approx"*, *"not sure"*, *"?"*, *"check"*) is routed directly to `quarantined_items`. Quarantined items are visually highlighted in amber and **never affect balances by default**.

4. **0ms Instant Solver (`POST /api/solve`):**
   When a human reviewer confirms or discards a quarantined item, SettleSloth invokes the deterministic solver directly without re-running model inference. Recalculations are mathematically instantaneous (0ms).

5. **Integer Paise Precision & Invariants:**
   All monetary calculations are performed in integer cents/paise ($₹1.00 = 100 \text{ paise}$) with remainder distribution, preventing IEEE 754 floating-point drift. The net balance zero-sum invariant holds strictly:
   $$\sum_{i=1}^{n} \text{NetBalance}_i \equiv 0.00$$

6. **Greedy Cash-Flow Minimization:**
   Settlement transfers are resolved using a greedy max-debtor to max-creditor algorithm, minimizing the total number of peer-to-peer transactions required to settle all debts.

---

## Built-In Chat Evaluation Presets

SettleSloth includes three realistic evaluation presets reflecting real-world group messaging:

1. **Goa Weekend Trip:**
   Rahul, Priya, Aman, and Neha. Features Hinglish slang, shorthand amounts (`2.4k`), alcohol exclusion (*"Aman didn't drink so don't count him"*), direct UPI repayment (*"Aman sent Rahul 500"*), and an uncertain fuel claim (*"Petrol was maybe ₹350?"*).
2. **Bengaluru Flatmates:**
   Arjun, Sneha, and Vikram. Reconciles electricity, high-speed Wi-Fi, maid salary, shared groceries, and an ambiguous water-can expense (*"water can 120 check receipt?"*).
3. **Hackathon Team Midnight Run:**
   Dev, Tara, and Kabir. Reconciles midnight pizza, Red Bulls with an exclusion (*"Dev didn't drink Red Bull"*), return cab fares, and an ambiguous late-night surge surcharge (*"surge approx 180?"*).

---

## Supported Providers & 100% Offline Fallback

SettleSloth supports three execution modes selectable via the UI or API:

| Mode | Provider | Description |
| :--- | :--- | :--- |
| **Hosted Cloud** | Google AI Studio (`gemma-4-26b-a4b-it`) | State-of-the-art open-weight Gemma 4 instruction-tuned model (also supports `gemma-4-31b-it`) accessed via Google AI Studio REST API using native `fetch`. |
| **Local Offline** | Ollama (`gemma3:4b`) | 100% private, on-device inference via local Ollama instance (`http://localhost:11434`). |
| **Deterministic Fallback** | Local Regex Heuristic Engine | Runs **instantly with zero API keys and zero network access**. Uses conservative line-by-line regex heuristics to parse payers, shorthand amounts, repayments, and uncertainty markers. Automatic failover occurs if the cloud API or Ollama is unavailable. |

---

## Tech Stack & Design Philosophy

- **Backend:** Node.js 20+ (CommonJS), Express 5.
- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES2022), styled with Tailwind CSS via CDN.
- **Dependencies:** Strictly limited to `express` and `dotenv`. No heavy AI SDKs, no compilation step, no webpack/vite, no database required.
- **Testing:** Node.js built-in test runner (`node --test`), 88 tests across 19 test suites passing in under 300ms.
- **Design Aesthetic:** *"Night Canopy & Amber Ledger"* — a calming dark workspace tailored for financial auditing, featuring emerald badges for verified expenses, amber alerts for quarantined claims, and ruby badges for blocked hallucinations.

---

## Getting Started

### Prerequisites
- Node.js 20.x or newer
- npm 10.x or newer

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/settlesloth.git
   cd settlesloth
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   *(Note: SettleSloth runs immediately out of the box using the deterministic fallback engine. Adding an API key is completely optional.)*

4. *(Optional)* Add your Google AI Studio API key to `.env`:
   ```bash
   GEMINI_API_KEY=your_google_ai_studio_api_key_here
   GEMMA_MODEL=gemma-4-26b-a4b-it
   GEMINI_TIMEOUT_MS=90000
   ```

5. *(Optional)* To run on-device with Ollama:
   ```bash
   ollama pull gemma3:4b
   ollama run gemma3:4b
   ```
   Ensure `OLLAMA_BASE_URL=http://localhost:11434` is set in `.env`.

### Running the Application

```bash
# Start production server
npm start

# Or start in development mode
npm run dev
```

Open your browser and navigate to:
```
http://localhost:3000
```

### Running the Test Suite

Execute the comprehensive automated test suite:
```bash
npm test
```

All 88 tests across 19 test suites verify QuoteGuard, ParticipantGuard, Ambiguity Quarantine, Paise Precision math, Cash-Flow Minimization, API contracts, and static file delivery.

---

## API Reference

### 1. Health & Diagnostics
`GET /api/health`

Returns service metadata, supported open-weight models, and provider readiness.

**Response:**
```json
{
  "status": "ok",
  "service": "settlesloth",
  "openWeightModels": ["gemma-4-26b-a4b-it", "gemma-4-31b-it", "gemma3:4b", "gemma3:1b"],
  "providerConfigured": {
    "google": true,
    "ollama": false
  }
}
```

---

### 2. Built-in Evaluation Presets
`GET /api/presets`

Returns the ground-truth evaluation transcripts.

---

### 3. Reconcile Chat Dump
`POST /api/reconcile`

Extracts claims using Gemma (hosted Gemma 4 or local Ollama) or the fallback engine, executes QuoteGuard and ParticipantGuard verification, isolates ambiguous claims, and calculates settlement balances.

**Request Body:**
```json
{
  "text": "Rahul: paid 2.4k for dinner. Aman didn't drink so don't count him.\nPriya: Aman sent Rahul 500 for petrol. Petrol was maybe ₹350?",
  "providerMode": "auto",
  "includeQuarantinedIds": [],
  "simulateHallucination": false
}
```

**Response:**
```json
{
  "success": true,
  "providerUsed": "fallback",
  "executionTimeMs": 1.2,
  "participants": ["Rahul", "Priya", "Aman"],
  "verified_items": [
    {
      "id": "exp-1",
      "type": "expense",
      "payer": "Rahul",
      "amount": 2400,
      "exact_quote": "Rahul: paid 2.4k for dinner.",
      "excluded_beneficiaries": ["Aman"]
    },
    {
      "id": "rep-2",
      "type": "repayment",
      "payer": "Aman",
      "recipient": "Rahul",
      "amount": 500,
      "exact_quote": "Aman sent Rahul 500 for petrol"
    }
  ],
  "quarantined_items": [
    {
      "id": "exp-3",
      "type": "expense",
      "payer": "Priya",
      "amount": 350,
      "exact_quote": "Petrol was maybe ₹350?",
      "ambiguity_reason": "Contains uncertainty marker: \"maybe\""
    }
  ],
  "blocked_hallucinations": [],
  "balances": [
    { "name": "Rahul", "paid": 2400, "owed": 1200, "net": 700 },
    { "name": "Priya", "paid": 0, "owed": 1200, "net": -1200 },
    { "name": "Aman", "paid": 500, "owed": 0, "net": 500 }
  ],
  "transfers": [
    { "from": "Priya", "to": "Rahul", "amount": 700 },
    { "from": "Priya", "to": "Aman", "amount": 500 }
  ],
  "metrics": {
    "totalVerifiedSpend": 2400,
    "netBalanceSum": 0,
    "transferCount": 2,
    "quarantinedCount": 1,
    "blockedCount": 0
  },
  "rawExtraction": { ... }
}
```

---

### 4. Deterministic Recalculation (0ms Solver)
`POST /api/solve`

Recalculates balances and settlement transfers when a user toggles quarantined items. Runs purely in memory without invoking LLMs.

**Request Body:**
```json
{
  "rawText": "Rahul: paid 2.4k for dinner...\nPriya: Petrol was maybe ₹350?",
  "extractionResult": {
    "items": [ ... ]
  },
  "includeQuarantinedIds": ["exp-3"]
}
```

**Response:**
```json
{
  "success": true,
  "participants": ["Rahul", "Priya", "Aman"],
  "verified_items": [ ... ],
  "quarantined_items": [ ... ],
  "blocked_hallucinations": [ ... ],
  "balances": [ ... ],
  "transfers": [ ... ],
  "metrics": { ... }
}
```

---

## 60-Second Video Demonstration Walkthrough

When recording a submission demo or walkthrough, follow this concise script:

| Time | Action | Narration Script |
| :--- | :--- | :--- |
| **0:00 – 0:10** | Open SettleSloth at `http://localhost:3000`. Click the **Goa Weekend Trip** preset button. | *"This is SettleSloth, an open-source neuro-symbolic expense reconciler for Hacktoberfest. Here's a messy WhatsApp group chat with Hinglish slang, shorthand like 2.4k, alcohol exclusions, and repayments."* |
| **0:10 – 0:25** | Select provider (Hosted Gemma 4 or Local Fallback) and click **"Reconcile Expenses"**. | *"Instead of letting an LLM do fuzzy math, Gemma extracts the claims, while deterministic JavaScript guarantees the ledger. In the Verified Ledger, notice how Rahul's 2.4k dinner respects Aman's exclusion, and Aman's 500 repayment to Rahul is tracked without double-counting."* |
| **0:25 – 0:38** | Scroll to the **"Needs Checking (Quarantine)"** section. Highlight the ₹350 petrol item. Click **"Approve & Include"**. | *"Notice this ₹350 petrol expense: Priya said 'maybe ₹350', so Ambiguity Quarantine kept it out of balances. When I click 'Approve & Include', the deterministic solver recalculates the transfers in zero milliseconds without calling the AI."* |
| **0:38 – 0:50** | Toggle the **"Simulate Hallucination"** checkbox and click **"Reconcile Expenses"**. | *"Now let's test QuoteGuard. We inject a simulated AI hallucination claiming Vikram spent 999. QuoteGuard inspects the source chat, finds no matching evidence, and blocks it into our audit log."* |
| **0:50 – 1:00** | Scroll to **"Settlement Transfers"** and click **"Copy WhatsApp Summary"**. | *"All net balances strictly sum to zero paise. Finally, click 'Copy WhatsApp Summary' to paste clean, ready-to-send payment requests straight back to the group chat."* |

---

## Deployment Guide (Render)

SettleSloth includes a native [render.yaml](render.yaml) Blueprint for one-click deployment to Render's free tier.

### Deploying to Render

1. Fork or push the SettleSloth repository to GitHub.
2. In the Render Dashboard, navigate to **Blueprints** and click **New Blueprint Instance**.
3. Connect your SettleSloth repository. Render will automatically detect `render.yaml`.
4. Render will create a Node Web Service configured with:
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
   - **Environment Variables:**
     - `NODE_ENV=production`
     - `GEMMA_MODEL=gemma-4-26b-a4b-it`
     - `GEMINI_TIMEOUT_MS=90000`
     - `GEMINI_API_KEY`: Enter your Google AI Studio API key (or leave empty to run on the deterministic fallback engine).
5. Click **Apply**. The service will build, pass the `/api/health` check, and go live.

### Server Interface & Port Binding
`server.js` listens dynamically on `process.env.PORT || 3000` binding across all interfaces (`0.0.0.0`), satisfying Render and container platform networking specifications.

---

## Known Boundaries & Limitations

1. **Single Currency per Session:**
   SettleSloth assumes expenses in a single session share the same primary currency unit (e.g., INR ₹ or USD $). Chats mixing EUR and INR should convert rates prior to reconciliation.
2. **Plain Text Chat Dumps:**
   The parser is optimized for plain text transcript exports from WhatsApp, Telegram, Discord, and Slack.
3. **Non-Financial Numerical Filtering:**
   Numbers associated with time, phone numbers, or road distances (e.g., *"drove 40 km"*, *"call me at 9876543210"*, *"meet at 9 pm"*) are filtered to prevent false positive expenses.

---

## License

This project is licensed under the terms of the [MIT License](LICENSE).
Copyright (c) 2026 SettleSloth contributors.
