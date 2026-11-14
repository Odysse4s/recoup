# Recoup

**Makes the supplier call you avoid. Rehearsed, approved, reversible.**

Restaurant groups lose money every week to deliveries that arrive short, damaged, late or billed above
contract. Recovering it means reading the receiving note, checking the contract, doing the math,
chasing the supplier and booking the credit. Nobody has time, so the money is never claimed.

Recoup is an agent that does the whole job for an operations manager:

1. **Reads the evidence**: receiving notes, invoices and delivery photos.
2. **Builds the tools it lacks**: when no calculator exists for a contract clause, it writes one,
   tests it against worked examples in a sandbox, and only then uses it.
3. **Rehearses every change**: database updates, claim letters and supplier emails are applied to a
   private copy first, producing an exact diff before anything real is touched.
4. **Asks before it acts**: claims above the policy threshold and any supplier contact wait for a
   one-tap or spoken approval on the manager's phone.
5. **Makes it reversible**: every committed change can be undone step by step.
6. **Finds the next one**: after a claim lands, it looks for similar unclaimed credits and offers them.

## Quickstart

```bash
cp .env.example backend/.env
cd backend && uv sync && uv run uvicorn app.server:app --reload
cd frontend && npm install && npm run dev
```

Runs fully offline with `LLM_PROVIDER=fake`. Set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY` for live runs.

## Built with

Google Gemini, fal, Wonderful, FastAPI, SQLite, React, Vite, Tailwind CSS, Framer Motion.
