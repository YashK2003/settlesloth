# SettleSloth

SettleSloth turns messy group-chat expense messages into verified expenses
and a clear settlement plan.

## Core principle

Gemma extracts expense information. Deterministic JavaScript verifies the
evidence and calculates balances.

Uncertain expenses remain pending until a person reviews them.

## Tech stack

- Node.js and Express
- Vanilla HTML, CSS, and JavaScript
- Google Gemma through an API, with optional local Ollama support
- Deterministic verification and settlement calculations
- Node.js built-in test runner

## Local development

Requirements: Node.js 20 or newer.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Add your API key to `.env` when AI integration is implemented.
4. Run the application with `npm start`.
5. Run tests with `npm test`.

Never commit `.env` or expose your API key in frontend code.
