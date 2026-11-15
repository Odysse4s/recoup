# Recoup

**Safety-first enterprise agent runtime for vendor audits, isolated ERP rehearsal, live voice governance, and reversible recovery.**

📄 **[Pitch Deck (PDF)](docs/Recoup_GenAISummit_PitchDeck.pdf)**

Enterprise finance and procurement teams lose thousands every month to vendor shipments that arrive short, damaged, past SLA, or billed above contracted rates — yet enterprises cannot let autonomous AI agents mutate production ERP ledgers, file tax credits, or contact external suppliers without deterministic guardrails.

Recoup is a **rehearsal-first enterprise agent runtime** engineered so finance operations can trust autonomous execution:

1. **Copy-on-Write Workspace & SQLite Rehearsal (`Safe Clone`)** — Every SQLite ERP mutation, audit memo, Greek **AADE myDATA 5.1** tax credit XML, and outbound supplier MIME message executes inside an isolated disposable clone first, producing an exact row-level and file diff with SHA-256 drift verification before production is touched.
2. **Self-Healing 7-Layer AST Tool Synthesis** — When a supplier contract requires custom multi-factor math (tiered rebates, SLA penalties, damaged/short units), Recoup writes pure Python, validates its AST against a 7-layer static security gate, runs unit tests in a locked subprocess sandbox, self-repairs on test failure, and registers the verified tool live.
3. **Zero-Output-Token System-1 Gate (`Oumi Iris`) + Deterministic Policy Guard** — LLM prose never decides safety. Deterministic policy thresholds (`>= EUR 250` or any external dispatch) pause execution, evaluate logprob routing via **Oumi Iris** (`0` output tokens), hold dual scenario emails in the outbox, and open a live **xAI Grok Voice** consult on desktop or `/mobile` iPhone handoff.
4. **Transactional Replay & Cryptographic Pre-Image Undo** — Approved settlements verify workspace SHA-256 fingerprints before atomic replay and capture pre-image receipts for instant 1-click LIFO database and filesystem rollback.
5. **Multimodal Dock Evidence & Proactive AP Sweep** — Ingests dock inspection photos and receipts via **fal.ai** vision/STT (`Wizper`), verifies clean control shipments with zero false positives, and scans historical paid invoices in idle time to pre-rehearse unclaimed SLA recoveries.

## Architecture

```text
official-hackathon/
├── backend/
│   ├── app/
│   │   ├── agent/          # ReAct planner/verifier, 3-way critic, AST tool forge, vision & proactive sweep
│   │   ├── engine/         # Copy-on-write Env clone, 7-layer sandbox, deterministic risk gate, LIFO undo log
│   │   ├── voice/          # xAI Grok Voice TTS/Realtime, Wizper STT, and <18-word Risk Gate briefings
│   │   ├── oumi_iris.py    # Oumi Iris System-1 logprob classifier (0 output tokens)
│   │   └── server.py       # FastAPI SSE runtime, dual-scenario outbox, AADE myDATA XML & consult endpoints
│   └── tests/              # 280+ offline unit, security sandbox, Oumi Iris, voice, and E2E scenario tests
├── frontend/
│   └── src/
│       ├── components/     # 3-pane operator console, Thought Graph, SQLite Studio, Live Windows & Mobile Gate
│       ├── hooks/          # Real-time SSE state machine, pacer choreography & cross-device voice sync
│       └── lib/            # WebAudio Grok Voice pipeline, table diffing, syntax highlighting & sound cues
└── docker-compose.yml      # Single-command backend (:8000) + frontend (:5173) stack with persistent caches
```

## Quickstart

### Docker Compose (Recommended)

```bash
cp .env.example .env   # add FAL_KEY / GEMINI_API_KEY / OUMI_API_KEY (or run offline with LLM_PROVIDER=fake)
docker compose up -d
```

- **Operator Console:** `http://localhost:5173`
- **Mobile iPhone Gate:** `http://localhost:5173/mobile`
- **FastAPI Runtime:** `http://localhost:8000`

### Local Development & Verification

```bash
# Backend tests & linter
cd backend && uv sync && uv run ruff check . && uv run pytest -q

# Frontend typecheck & dev server
cd frontend && npm install && npm run typecheck && npm run dev
```

## Built With

Google Gemini 2.5 Flash · fal.ai (xAI Grok Voice, Wizper STT, Vision & LLM Gateway) · Oumi Iris (System-1 Logprob Gate) · FastAPI · SQLite · React 19 · TypeScript · Vite · Tailwind CSS · Framer Motion.

## Team & License

Built in 36 hours at the **GenAI Summit SEE Hackathon** (Athens, Nov 2026) by **Odysseas Avdikos**, **Orestis Spyrou**, and **Efthymios Grizanitis**.

Copyright © 2026 Odysseas Avdikos, Orestis Spyrou, and Efthymios Grizanitis. **All Rights Reserved** — see [LICENSE](LICENSE). Source code is published strictly for technical evaluation and recruitment review.
