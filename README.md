# Recoup

**Safety-first enterprise agent for vendor audits, staged ERP changes, and reversible recovery.**

Enterprise finance and operations teams lose thousands every month to vendor shipments that arrive short, damaged, past SLA, or billed above contracted rates — yet enterprises refuse to let autonomous AI agents touch live ERP tables or contact external vendors without strict guardrails.

Recoup is a **safety-first office operations agent** built so enterprises can trust autonomous execution:

1. **Isolated Rehearsal Before Execution**: every SQLite ERP mutation, audit memo, and outbound vendor message runs inside a private rehearsal copy first, generating an exact row-by-row and file diff before production is touched.
2. **Sandboxed Tool Synthesis**: when a contract clause requires custom math, Recoup writes a pure Python tool, validates its AST, runs unit tests in a locked subprocess sandbox, and only registers it when every test passes.
3. **Deterministic Risk Gate + Mobile Voice Approval**: LLM output never decides safety. Policy thresholds (`>= EUR 250` or any external email/call) pause execution and push a spoken summary to the manager's phone (`/mobile`) for 1-tap or voice sign-off.
4. **Transactional Replay & Step-by-Step Undo**: approved changes verify workspace fingerprints before committing and store pre-image receipts for instant LIFO rollback.
5. **Proactive Ledger Audit**: once a claim is committed, Recoup scans historical paid invoices in idle time and stages a ready-to-approve recovery offer.

## Quickstart

```bash
cp .env.example backend/.env
cd backend && uv sync && uv run uvicorn app.server:app --reload
cd frontend && npm install && npm run dev
```

Runs 100% offline with `LLM_PROVIDER=fake`. Set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY` for live inference.

## Built with

Google Gemini, Wonderful, fal, FastAPI, SQLite, React, Vite, Tailwind CSS, Framer Motion.
