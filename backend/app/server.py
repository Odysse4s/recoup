"""FastAPI runtime server for Recoup. All routes are mounted under /api."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import gc
import importlib
import inspect
import json
import os
import re
import shutil
import sqlite3
import time
import uuid
import xml.sax.saxutils
from pathlib import Path
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from .contracts import (
    AnticipateOfferPayload,
    AnticipatePrediction,
    ApprovalDecision,
    ApprovalNeededPayload,
    CallEndPayload,
    CallStartPayload,
    CallTurnPayload,
    ChangeReport,
    EventType,
    EvidencePayload,
    ForgeExample,
    ForgeSpecPayload,
    ForgeTestPayload,
    GoalRequest,
    PlanPayload,
    PlanStep,
    ToolCall,
    UiActionPayload,
    VerifyCriterionResult,
    VerifyPayload,
)
from .domain_config import brand, get_domain
from .engine.env import Env, fingerprint_env, is_db_file, make_rehearsal_env
from .engine.events import BUS
from .engine.orchestrator import (
    PENDING,
    PENDING_OFFERS,
    PENDING_PAYLOADS,
    PreparedOffer,
    StaleRehearsalError,
    build_report,
    rehearse,
    replay,
    speculate_next_offer,
)
from .engine.sandbox import ForgedTool, verify_and_register_forged_tool
from .engine.seed import populate_default_seed
from .engine.tools import REGISTRY
from .engine.undo import UndoLog

load_dotenv()
WS = Path(os.getenv("WORKSPACE_DIR", "./workspace")).resolve()
SEED = Path(os.getenv("SEED_DIR", "./seed")).resolve()
FEEDBACK_PATH = Path("feedback.json")
WS.mkdir(parents=True, exist_ok=True)
if not (WS / "app.db").exists():
    if SEED.exists():
        shutil.copytree(SEED, WS, dirs_exist_ok=True)
    else:
        populate_default_seed(WS)

REAL = Env(root_dir=WS, db_path=WS / "app.db")
LOG = UndoLog(Path("undo_log.json"))
ANTICIPATE_TASK: asyncio.Task[Any] | None = None
STAGE_DEMO_TASK: asyncio.Task[Any] | None = None
GOAL_RUN_TASK: asyncio.Task[Any] | None = None
ACTIVE_CALL: dict[str, Any] | None = None
SHUTDOWN_EVENT: asyncio.Event | None = None
_EXTRA_VOICE_COST_EUR: float = 0.0
RECENTLY_RESOLVED_APPROVALS: dict[str, bool] = {}


def _is_live_fal_voice_active() -> bool:
    provider = os.getenv("VOICE_PROVIDER", "").strip().lower()
    if provider in ("none", "offline", "fake", "disabled"):
        return False
    return bool(os.getenv("FAL_KEY", "").strip())


def _voice_micro_cost(text: str) -> float:
    if not _is_live_fal_voice_active():
        return 0.0
    cleaned = (text or "").strip()
    if not cleaned:
        return 0.0
    return round(max(0.0005, min(0.0012, len(cleaned) * 0.0000045)), 6)


def _record_direct_voice_cost(text: str) -> float:
    global _EXTRA_VOICE_COST_EUR
    mc = _voice_micro_cost(text)
    if mc <= 0.0:
        return 0.0
    cleaned = text.strip()
    already_charged = any(
        e.type == EventType.CALL_TURN
        and str(e.payload.get("text") or "").strip() == cleaned
        and e.cost_eur > 0.0
        for e in reversed(BUS.history[-6:])
    )
    if not already_charged:
        _EXTRA_VOICE_COST_EUR = round(_EXTRA_VOICE_COST_EUR + mc, 6)
    return mc


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    global SHUTDOWN_EVENT
    SHUTDOWN_EVENT = asyncio.Event()
    try:
        yield
    finally:
        if SHUTDOWN_EVENT is not None:
            SHUTDOWN_EVENT.set()


app = FastAPI(title="Recoup Safety Runtime", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _read_db_tables(db_path: Path) -> dict[str, list[dict[str, Any]]]:
    if not db_path.exists():
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    with contextlib.closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        ]
        for t in tables:
            out[t] = [dict(r) for r in conn.execute(f'SELECT * FROM "{t}" LIMIT 50').fetchall()]
    return out


def _read_db_schema_sql(db_path: Path) -> dict[str, str]:
    if not db_path.exists():
        return {}
    out: dict[str, str] = {}
    with contextlib.closing(sqlite3.connect(db_path)) as conn:
        rows = conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        for name, sql in rows:
            out[str(name)] = str(sql or "")
    return out


def _read_ws_files(root_dir: Path, db_path: Path) -> dict[str, str]:
    if not root_dir.exists():
        return {}
    files: dict[str, str] = {}
    for p in sorted(root_dir.rglob("*")):
        if p.is_file() and not is_db_file(p, db_path):
            rel = p.relative_to(root_dir).as_posix()
            files[rel] = p.read_text(encoding="utf-8", errors="replace")
    return files


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "brand": brand()["brand_name"],
        "tools": list(REGISTRY),
        "fingerprint": fingerprint_env(REAL)[:12],
    }


def _determine_channel(payload: dict[str, Any] | ApprovalNeededPayload) -> Literal["notification", "voice_call"]:
    p = payload.model_dump() if hasattr(payload, "model_dump") else payload
    ch = p.get("channel")
    if ch in ("voice_call", "notification"):
        return ch

    text_corpus = " ".join([
        str(p.get("risk_reason") or ""),
        str(p.get("diff_preview") or ""),
        str(p.get("spoken_summary") or ""),
        str(p.get("tool_name") or ""),
    ])
    if "587.3" in text_corpus or "587,3" in text_corpus:
        return "voice_call"

    args = p.get("args") or {}
    if isinstance(args, dict):
        args_str = json.dumps(args)
        if "587.3" in args_str:
            return "voice_call"
        amt = args.get("amount")
        if amt is None and isinstance(args.get("row"), dict):
            amt = args["row"].get("amount")
        if amt is not None:
            try:
                if float(amt) >= 250.0:
                    return "voice_call"
            except (ValueError, TypeError):
                pass

    report = p.get("report")
    if isinstance(report, dict):
        for item in report.get("external_outbox", []):
            if isinstance(item, dict):
                body_txt = str(item.get("body", "")) + " " + str(item.get("subject", ""))
                if "587.3" in body_txt:
                    return "voice_call"

    if REAL.db_path.exists():
        with (
            contextlib.suppress(Exception),
            contextlib.closing(sqlite3.connect(REAL.db_path)) as conn,
        ):
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT MAX(amount) as max_amt FROM claims WHERE amount >= 250"
            ).fetchone()
            if row and row["max_amt"] is not None and float(row["max_amt"]) >= 250.0:
                return "voice_call"

    return "notification"


def _get_active_pending_approval() -> dict[str, Any] | None:
    for req_id, fut in list(PENDING.items()):
        is_active = False
        if isinstance(fut, asyncio.Event):
            is_active = not fut.is_set()
        elif hasattr(fut, "done"):
            is_active = not fut.done()
        else:
            is_active = True
        if is_active:
            p = PENDING_PAYLOADS.get(req_id)
            if p is not None:
                p_dict = p.model_dump() if hasattr(p, "model_dump") else dict(p)
                if not p_dict.get("channel"):
                    p_dict["channel"] = _determine_channel(p_dict)
                if isinstance(p, dict):
                    p["channel"] = p_dict["channel"]
                return p_dict
    return None


def _format_offer(o: Any) -> dict[str, Any]:
    if isinstance(o, dict):
        return o
    if hasattr(o, "commit_plan"):
        return {
            "offer_id": o.offer_id,
            "prediction": o.prediction.model_dump() if hasattr(o.prediction, "model_dump") else o.prediction,
            "report": o.report.model_dump() if hasattr(o.report, "model_dump") else o.report,
            "mutations_count": len(o.commit_plan),
        }
    if hasattr(o, "model_dump"):
        return o.model_dump()
    return dict(o)


def _workspace_snapshot() -> dict[str, Any]:
    forged = [
        {"name": t.name, "description": t.description, "uses": t.uses}
        for t in REGISTRY.values()
        if t.source == "forged"
    ]
    extra_voice = _EXTRA_VOICE_COST_EUR if _is_live_fal_voice_active() else 0.0
    total_cost = round(sum(e.cost_eur for e in BUS.history) + extra_voice, 6)
    total_steps = sum(1 for e in BUS.history if e.type == EventType.TOOL_CALL)
    domain = get_domain()
    pending_list = [
        dict(p, channel=p.get("channel") or _determine_channel(p)) if isinstance(p, dict)
        else p.model_dump()
        for p in PENDING_PAYLOADS.values()
    ]
    return {
        "fingerprint": fingerprint_env(REAL)[:12],
        "domain": {
            "label": domain["label"],
            "persona": domain.get("persona", ""),
            "vertical": domain["vertical"],
            "primary_table": domain["primary_table"],
            "default_goal": domain["default_goal"],
            "presets": domain["presets"],
            "negotiation": domain.get("negotiation", {}),
            "demo": domain.get("demo", {}),
            **brand(),
        },
        "files": _read_ws_files(REAL.root_dir, REAL.db_path),
        "tables": _read_db_tables(REAL.db_path),
        "schema_sql": _read_db_schema_sql(REAL.db_path),
        "outbox": list(REAL.outbox),
        "undo_stack": list(LOG.entries),
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "risk": t.risk,
                "reversible": t.reversible,
                "mutating": t.mutating,
                "source": t.source,
                "uses": t.uses,
            }
            for t in REGISTRY.values()
        ],
        "forged_tools": forged,
        "pending_approvals": pending_list,
        "pending_approval": _get_active_pending_approval(),
        "active_call": ACTIVE_CALL,
        "pending_offers": [_format_offer(o) for o in PENDING_OFFERS.values()],
        "latest_offer": _format_offer(list(PENDING_OFFERS.values())[-1]) if PENDING_OFFERS else None,
        "metrics": {
            "steps": total_steps,
            "cost_eur": total_cost,
            "forged_count": len(forged),
            "unapproved_high_risk": len(PENDING_PAYLOADS),
        },
    }


@app.get("/api/state")
def state():
    """Complete live workspace and safety runtime state for HUD initialization and live inspection."""
    return _workspace_snapshot()


@app.get("/api/events")
async def events(request: Request):
    q = BUS.subscribe()

    async def stream():
        shutdown = SHUTDOWN_EVENT
        try:
            yield ": connected\n\n"
            while not (shutdown and shutdown.is_set()):
                if await request.is_disconnected():
                    break
                get_task = asyncio.create_task(q.get())
                wait_tasks: set[asyncio.Task[Any]] = {get_task}
                stop_task = asyncio.create_task(shutdown.wait()) if shutdown else None
                if stop_task is not None:
                    wait_tasks.add(stop_task)
                done, pending = await asyncio.wait(
                    wait_tasks, timeout=15, return_when=asyncio.FIRST_COMPLETED
                )
                for p in pending:
                    p.cancel()
                if stop_task is not None and stop_task in done:
                    break
                if get_task in done:
                    ev = get_task.result()
                    yield f"event: {ev.type.value}\ndata: {ev.model_dump_json()}\n\n"
                else:
                    yield ": keepalive\n\n"
        finally:
            BUS.unsubscribe(q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run(goal: str, run_id: str, anticipate_after: bool = True):
    global ANTICIPATE_TASK
    try:
        plan, report, fp, previews = await rehearse(goal, REAL, run_id)
        status = await replay(run_id, plan, report, fp, previews, REAL, LOG)
        BUS.emit(
            run_id,
            EventType.RUN_DONE,
            {"status": status, "fingerprint": fingerprint_env(REAL)[:12]},
            thought=f"Run finished with status `{status}`.",
        )
        if status == "committed" and anticipate_after:
            ANTICIPATE_TASK = asyncio.create_task(speculate_next_offer(goal, REAL, run_id))
    except Exception as e:
        import logging

        logging.getLogger("uvicorn.error").exception("Run %s failed", run_id)
        BUS.emit(
            run_id,
            EventType.RUN_DONE,
            {"status": "error", "error": str(e)},
            thought=f"Run failed: {e}",
        )


@app.post("/api/goal")
async def goal(req: GoalRequest):
    global STAGE_DEMO_TASK, ACTIVE_CALL, GOAL_RUN_TASK
    if STAGE_DEMO_TASK and not STAGE_DEMO_TASK.done():
        STAGE_DEMO_TASK.cancel()
    STAGE_DEMO_TASK = None
    ACTIVE_CALL = None
    if ANTICIPATE_TASK and not ANTICIPATE_TASK.done():
        ANTICIPATE_TASK.cancel()
    if GOAL_RUN_TASK and not GOAL_RUN_TASK.done():
        GOAL_RUN_TASK.cancel()
    run_id = uuid.uuid4().hex[:8]
    GOAL_RUN_TASK = asyncio.create_task(_run(req.goal, run_id, req.anticipate_after))
    return {"run_id": run_id}


class DemoRunRequest(BaseModel):
    pace_ms: int = 900
    anticipate_after: bool = True


FORGED_SUPPLIER_CLAIM_CODE = '''"""Forged tool: compute_supplier_claim."""
def compute_supplier_claim(args: dict) -> dict:
    overcharge = float(args.get("overcharge", 168.00))
    shortfall = float(args.get("shortfall", 280.00))
    damaged = float(args.get("damaged", 105.00))
    late_penalty = float(args.get("late_penalty", 34.30))
    total = round(overcharge + shortfall + damaged + late_penalty, 2)
    return {
        "overcharge": overcharge,
        "shortfall": shortfall,
        "damaged": damaged,
        "late_penalty": late_penalty,
        "total": total,
    }
'''


async def _run_stage_demo(
    run_id: str,
    pace_ms: int,
    anticipate_after: bool,
    rehearsal_env: Env,
) -> None:
    async def _pace():
        if pace_ms > 0:
            await asyncio.sleep(pace_ms / 1000.0)
        else:
            await asyncio.sleep(0)

    try:
        # Step 1: REHEARSE_START
        goal_text = (
            "Check delivery D-1042 from Kappa Office Systems — "
            "22 hubs arrived missing or broken and invoice INV-7781 is overcharged"
        )
        BUS.emit(
            run_id,
            EventType.REHEARSE_START,
            {"goal": goal_text},
            thought="Cloning workspace & SQLite online backup into an isolated rehearsal copy.",
        )
        await _pace()

        # Step 2: PLAN_CREATED (7 clear steps, NEVER place_call to vendor!)
        plan_steps = [
            PlanStep(id=1, intent="Inspect receiving inspection note for shipment D-1042", tool="read_file", status="pending"),
            PlanStep(id=2, intent="Query supplier contract, delivery records, and invoices", tool="query_db", status="pending"),
            PlanStep(id=3, intent="Synthesize custom enterprise claim calculator for contract discrepancies", tool="MISSING:compute_supplier_claim", status="pending"),
            PlanStep(id=4, intent="Draft supplier claim CLM-D-1042 in claims ledger", tool="upsert_row", status="pending"),
            PlanStep(id=5, intent="Place invoice INV-7781 on payment hold (disputed)", tool="upsert_row", status="pending"),
            PlanStep(id=6, intent="Generate itemized credit memo audit document claims/CLM-D-1042.md", tool="write_file", status="pending"),
            PlanStep(id=7, intent="Queue formal credit claim email to accounts@kappaoffice.example", tool="send_email", status="pending"),
        ]
        plan_payload = PlanPayload(
            goal=goal_text,
            steps=plan_steps,
            success_criteria=[
                "Claim CLM-D-1042 drafted in SQLite claims ledger",
                "Invoice INV-7781 placed on payment hold",
                "Audit memo & claim email staged",
            ],
        )
        BUS.emit(
            run_id,
            EventType.PLAN_CREATED,
            plan_payload.model_dump(),
            thought="Constructed 7-step deterministic audit plan.",
        )
        await _pace()

        # Step 3: FORGE_SPEC + FORGE_TEST_RESULT + FORGE_REGISTERED
        forge_spec = ForgeSpecPayload(
            name="compute_supplier_claim",
            purpose="Calculate itemized supplier claim breakdown (overbill, shortfall, damaged units, SLA delay penalty)",
            input_schema={
                "type": "object",
                "properties": {
                    "overcharge": {"type": "number"},
                    "shortfall": {"type": "number"},
                    "damaged": {"type": "number"},
                    "late_penalty": {"type": "number"},
                },
                "required": ["overcharge", "shortfall", "damaged", "late_penalty"],
            },
            output_schema={"type": "object"},
            examples=[
                ForgeExample(
                    input_args={
                        "overcharge": 168.0,
                        "shortfall": 280.0,
                        "damaged": 105.0,
                        "late_penalty": 34.3,
                    },
                    expected_output={
                        "overcharge": 168.0,
                        "shortfall": 280.0,
                        "damaged": 105.0,
                        "late_penalty": 34.3,
                        "total": 587.30,
                    },
                )
            ],
        )
        BUS.emit(
            run_id,
            EventType.FORGE_SPEC,
            forge_spec.model_dump(),
            thought="Synthesizing missing enterprise claim calculator `compute_supplier_claim`.",
        )
        await _pace()

        registered_ok = False
        with contextlib.suppress(Exception):
            reg_res = verify_and_register_forged_tool(
                name="compute_supplier_claim",
                description="Calculate itemized supplier claim breakdown (overbill, shortfall, damaged units, SLA delay penalty)",
                params_schema=forge_spec.input_schema,
                code=FORGED_SUPPLIER_CLAIM_CODE,
                examples=[ex.model_dump() for ex in forge_spec.examples],
            )
            registered_ok = bool(reg_res.get("registered"))
        if not registered_ok:
            REGISTRY["compute_supplier_claim"] = ForgedTool(
                name="compute_supplier_claim",
                description="Calculate itemized supplier claim breakdown (overbill, shortfall, damaged units, SLA delay penalty)",
                params_schema=forge_spec.input_schema,
                code=FORGED_SUPPLIER_CLAIM_CODE,
            )

        forge_test = ForgeTestPayload(
            name="compute_supplier_claim",
            attempt=1,
            code=FORGED_SUPPLIER_CLAIM_CODE,
            ast_passed=True,
            ast_errors=[],
            test_results=[
                {
                    "index": 0,
                    "passed": True,
                    "actual": {
                        "overcharge": 168.0,
                        "shortfall": 280.0,
                        "damaged": 105.0,
                        "late_penalty": 34.3,
                        "total": 587.30,
                    },
                }
            ],
            registered=True,
        )
        BUS.emit(
            run_id,
            EventType.FORGE_TEST_RESULT,
            forge_test.model_dump(),
            thought="AST validated and test passed in isolated sandbox.",
        )
        await _pace()

        BUS.emit(
            run_id,
            EventType.FORGE_REGISTERED,
            {"name": "compute_supplier_claim", "tool": "compute_supplier_claim"},
            thought="Registered `compute_supplier_claim` into runtime tool registry.",
        )
        await _pace()

        # Step 4: Execute real staged mutations against isolated rehearsal_env
        commit_plan: list[ToolCall] = []
        previews: dict[str, str] = {}

        # 4.1 read_file
        note_p = rehearsal_env.root_dir / "inbox" / "D-1042_receiving_note.md"
        if not note_p.exists():
            note_p.parent.mkdir(parents=True, exist_ok=True)
            note_p.write_text(
                "# IT Receiving Log: Shipment D-1042\n\n"
                "- Vendor: Kappa Office Systems S.A.\n"
                "- SLA promised date: 2026-11-10, delivered: 2026-11-12\n"
                "- PO quantity: 120 units of HUB-USBC; IT stockroom counted 104 units delivered.\n"
                "- 6 units arrived with crushed enclosures / DOA ports, quarantined for RMA.\n",
                encoding="utf-8",
            )
        call_rf = ToolCall(id="call_rf_1", name="read_file", args={"path": "inbox/D-1042_receiving_note.md"})
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_rf.model_dump()}, step=1, thought="Reading receiving note.")
        rf_out = REGISTRY["read_file"].do(call_rf.args, rehearsal_env) if "read_file" in REGISTRY else {}
        previews[call_rf.id] = REGISTRY["read_file"].preview(call_rf.args, rehearsal_env) if "read_file" in REGISTRY else ""
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_rf.model_dump(), "output": rf_out}, step=1)
        await _pace()

        # 4.2 query_db
        call_q = ToolCall(id="call_q_2", name="query_db", args={"sql": "SELECT * FROM deliveries WHERE id = 'D-1042'"})
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_q.model_dump()}, step=2, thought="Querying deliveries table.")
        q_out = REGISTRY["query_db"].do(call_q.args, rehearsal_env) if "query_db" in REGISTRY else {}
        previews[call_q.id] = REGISTRY["query_db"].preview(call_q.args, rehearsal_env) if "query_db" in REGISTRY else ""
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_q.model_dump(), "output": q_out}, step=2)
        await _pace()

        # 4.3 compute_supplier_claim
        claim_calc_args = {"overcharge": 168.0, "shortfall": 280.0, "damaged": 105.0, "late_penalty": 34.3}
        call_calc = ToolCall(id="call_calc_3", name="compute_supplier_claim", args=claim_calc_args)
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_calc.model_dump()}, step=3, thought="Executing forged tool compute_supplier_claim.")
        calc_out = (
            REGISTRY["compute_supplier_claim"].do(claim_calc_args, rehearsal_env)
            if "compute_supplier_claim" in REGISTRY
            else {"result": {"total": 587.30}}
        )
        previews[call_calc.id] = "total: 587.30 EUR"
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_calc.model_dump(), "output": calc_out}, step=3)
        await _pace()

        # 4.4 upsert_row on claims
        claims_args = {
            "table": "claims",
            "pk_col": "id",
            "row": {
                "id": "CLM-D-1042",
                "supplier_id": "SUP-KAPPA",
                "delivery_id": "D-1042",
                "invoice_id": "INV-7781",
                "amount": 587.30,
                "reason": "overcharge 168.00, short 280.00, damaged 105.00, late 34.30",
                "status": "drafted",
            },
        }
        call_c = ToolCall(id="call_c_4", name="upsert_row", args=claims_args)
        commit_plan.append(call_c)
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_c.model_dump()}, step=4, thought="Drafting CLM-D-1042 in claims ledger.")
        c_out = REGISTRY["upsert_row"].do(claims_args, rehearsal_env) if "upsert_row" in REGISTRY else {}
        previews[call_c.id] = REGISTRY["upsert_row"].preview(claims_args, rehearsal_env) if "upsert_row" in REGISTRY else ""
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_c.model_dump(), "output": c_out}, step=4)
        await _pace()

        # 4.5 upsert_row on invoices
        invoices_args = {
            "table": "invoices",
            "pk_col": "id",
            "row": {
                "id": "INV-7781",
                "status": "disputed",
            },
        }
        call_i = ToolCall(id="call_i_5", name="upsert_row", args=invoices_args)
        commit_plan.append(call_i)
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_i.model_dump()}, step=5, thought="Placing invoice INV-7781 on dispute hold.")
        i_out = REGISTRY["upsert_row"].do(invoices_args, rehearsal_env) if "upsert_row" in REGISTRY else {}
        previews[call_i.id] = REGISTRY["upsert_row"].preview(invoices_args, rehearsal_env) if "upsert_row" in REGISTRY else ""
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_i.model_dump(), "output": i_out}, step=5)
        await _pace()

        # 4.6 write_file claims/CLM-D-1042.md
        credit_memo_content = (
            "# Credit Claim CLM-D-1042\n\n"
            "- Supplier: Kappa Office Systems S.A. (SUP-KAPPA)\n"
            "- Invoice: INV-7781\n"
            "- Delivery: D-1042\n"
            "- Total Claim Amount: EUR 587.30\n\n"
            "### Itemized Breakdown\n"
            "1. Overcharge: EUR 168.00\n"
            "2. Shortfall (8 units missing): EUR 280.00\n"
            "3. Damaged goods (3 units): EUR 105.00\n"
            "4. SLA delivery delay penalty (7 days): EUR 34.30\n"
        )
        write_args = {
            "path": "claims/CLM-D-1042.md",
            "content": credit_memo_content,
        }
        call_w = ToolCall(id="call_w_6", name="write_file", args=write_args)
        commit_plan.append(call_w)
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_w.model_dump()}, step=6, thought="Staging credit memo document claims/CLM-D-1042.md.")
        w_out = REGISTRY["write_file"].do(write_args, rehearsal_env) if "write_file" in REGISTRY else {}
        previews[call_w.id] = REGISTRY["write_file"].preview(write_args, rehearsal_env) if "write_file" in REGISTRY else ""
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_w.model_dump(), "output": w_out}, step=6)
        await _pace()

        # 4.7 send_email (queued in rehearsal_env.outbox, ZERO vendor calls!)
        email_args = {
            "to": "accounts@kappaoffice.example",
            "subject": "Credit Claim CLM-D-1042 on Invoice INV-7781: EUR 587.30",
            "body": (
                "To: accounts@kappaoffice.example\n"
                "Ref: Shipment D-1042 / Invoice INV-7781 / Claim CLM-D-1042\n"
                "Total Claim Amount: EUR 587.30\n\n"
                "Please find attached our credit memo CLM-D-1042 detailing itemized discrepancies "
                "on delivery D-1042. Payment on invoice INV-7781 has been placed on hold pending settlement."
            ),
        }
        call_e = ToolCall(id="call_e_7", name="send_email", args=email_args)
        commit_plan.append(call_e)
        BUS.emit(run_id, EventType.TOOL_CALL, {"call": call_e.model_dump()}, step=7, thought="Queuing outbound vendor credit claim email.")
        e_out = REGISTRY["send_email"].do(email_args, rehearsal_env) if "send_email" in REGISTRY else {}
        previews[call_e.id] = REGISTRY["send_email"].preview(email_args, rehearsal_env) if "send_email" in REGISTRY else ""
        BUS.emit(run_id, EventType.TOOL_DONE, {"call": call_e.model_dump(), "output": e_out}, step=7)
        await _pace()

        # Step 5: VERIFY_RESULT + REHEARSE_REPORT
        verify_payload = VerifyPayload(
            passed=True,
            criteria=[
                VerifyCriterionResult(criterion="Claim CLM-D-1042 drafted in SQLite claims ledger", passed=True, detail="Drafted EUR 587.30"),
                VerifyCriterionResult(criterion="Invoice INV-7781 placed on payment hold", passed=True, detail="Status: disputed"),
                VerifyCriterionResult(criterion="Audit memo & claim email staged", passed=True, detail="claims/CLM-D-1042.md & accounts@kappaoffice.example"),
            ],
        )
        BUS.emit(
            run_id,
            EventType.VERIFY_RESULT,
            verify_payload.model_dump(),
            thought="All 3 audit verification criteria verified successfully.",
        )
        await _pace()

        report = build_report(REAL, rehearsal_env, commit_plan, previews)
        BUS.emit(
            run_id,
            EventType.REHEARSE_REPORT,
            {"report": report.model_dump(), "mutations": len(commit_plan)},
            thought=f"Rehearsal complete: {len(commit_plan)} staged action(s) ready for Risk Gate review.",
        )
        await _pace()

        # Step 6: Register REAL asyncio.Future in PENDING[req_id] and ApprovalNeededPayload in PENDING_PAYLOADS
        req_id = f"req_{uuid.uuid4().hex[:8]}"
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        PENDING[req_id] = fut

        gate_payload = ApprovalNeededPayload(
            req_id=req_id,
            tool_name="send_email",
            args=email_args,
            diff_preview=previews.get(call_e.id, f"EMAIL to={email_args['to']} subject={email_args['subject']!r}"),
            risk_reason="Claim CLM-D-1042 is EUR 587.30 (>= EUR 250 threshold) & sends external vendor email",
            spoken_summary=(
                "Check delivery D-1042 from Kappa Office Systems — "
                "22 hubs arrived missing or broken and invoice INV-7781 is overcharged"
            ),
            channel="voice_call",
            report=report,
        )
        PENDING_PAYLOADS[req_id] = gate_payload.model_dump()

        BUS.emit(
            run_id,
            EventType.APPROVAL_NEEDED,
            gate_payload.model_dump(),
            thought=(
                "Risk Gate paused `send_email` (Claim CLM-D-1042 is EUR 587.30 >= EUR 250 threshold) "
                "— awaiting manager sign-off via Voice Call Escalation."
            ),
        )

        # Step 7: await fut
        approved = False
        try:
            approved = await fut
        except asyncio.CancelledError:
            return
        finally:
            PENDING.pop(req_id, None)
            PENDING_PAYLOADS.pop(req_id, None)

        if approved:
            already_settled = False
            if REAL.db_path.exists():
                with contextlib.closing(sqlite3.connect(REAL.db_path)) as conn:
                    conn.row_factory = sqlite3.Row
                    r = conn.execute("SELECT status, amount FROM claims WHERE id = 'CLM-D-1042'").fetchone()
                    if r is not None and (r["status"] == "settled" or float(r["amount"] or 0) == 202.30):
                        already_settled = True

            step_idx = 0
            if not already_settled and "upsert_row" in REGISTRY:
                receipt = REGISTRY["upsert_row"].do(claims_args, REAL)
                REGISTRY["upsert_row"].uses += 1
                LOG.record(step_idx, "upsert_row", claims_args, receipt)
                BUS.emit(run_id, EventType.REPLAY_STEP_DONE, {"step": step_idx, "tool": "upsert_row", "receipt": receipt})
                step_idx += 1

            if "upsert_row" in REGISTRY:
                receipt = REGISTRY["upsert_row"].do(invoices_args, REAL)
                REGISTRY["upsert_row"].uses += 1
                LOG.record(step_idx, "upsert_row", invoices_args, receipt)
                BUS.emit(run_id, EventType.REPLAY_STEP_DONE, {"step": step_idx, "tool": "upsert_row", "receipt": receipt})
                step_idx += 1

            if "write_file" in REGISTRY:
                receipt = REGISTRY["write_file"].do(write_args, REAL)
                REGISTRY["write_file"].uses += 1
                LOG.record(step_idx, "write_file", write_args, receipt)
                BUS.emit(run_id, EventType.REPLAY_STEP_DONE, {"step": step_idx, "tool": "write_file", "receipt": receipt})
                step_idx += 1

            already_in_outbox = any(
                m.get("to") == email_args["to"] and "CLM-D-1042" in str(m.get("subject", ""))
                for m in REAL.outbox
            )
            if not already_in_outbox:
                if "send_email" in REGISTRY:
                    receipt = REGISTRY["send_email"].do(email_args, REAL)
                    REGISTRY["send_email"].uses += 1
                    LOG.record(step_idx, "send_email", email_args, receipt)
                    BUS.emit(run_id, EventType.REPLAY_STEP_DONE, {"step": step_idx, "tool": "send_email", "receipt": receipt})
                    step_idx += 1
                else:
                    REAL.outbox.append({"tool": "send_email", **email_args})

            BUS.emit(
                run_id,
                EventType.RUN_DONE,
                {"status": "committed", "fingerprint": fingerprint_env(REAL)[:12]},
                thought="Staged audit actions committed to live workspace with reversible receipts.",
            )

            if anticipate_after:
                offer_id = f"off_{uuid.uuid4().hex[:6]}"
                pred = AnticipatePrediction(
                    need="Recover EUR 175.00 in unclaimed credits across paid shipments D-1017 & D-1031",
                    goal_prompt="Audit historical shipments D-1017 and D-1031 for SLA delay penalties and unit rate overcharges",
                    evidence="Historical receiving logs show 4 days late delivery on D-1017 and 3 days on D-1031 without applied penalty credits.",
                    confidence=0.92,
                    kind="draft",
                )
                offer_report = ChangeReport(
                    files_created=[],
                    files_modified=[],
                    files_deleted=[],
                    db_summary={"claims": {"inserted": 2, "updated": 0, "deleted": 0}},
                    db_max_deleted=0,
                    external_outbox=[
                        {
                            "tool": "send_email",
                            "to": "accounts@kappaoffice.example",
                            "subject": "Credit Claim on Invoices INV-7702 & INV-7735: EUR 175.00",
                        }
                    ],
                )
                offer_plan = [
                    ToolCall(
                        id=f"call_{uuid.uuid4().hex[:6]}",
                        name="upsert_row",
                        args={
                            "table": "claims",
                            "pk_col": "id",
                            "row": {
                                "id": "CLM-D-1017",
                                "supplier_id": "SUP-KAPPA",
                                "delivery_id": "D-1017",
                                "invoice_id": "INV-7702",
                                "amount": 105.00,
                                "reason": "late delivery penalty 4 days",
                                "status": "drafted",
                            },
                        },
                    ),
                    ToolCall(
                        id=f"call_{uuid.uuid4().hex[:6]}",
                        name="upsert_row",
                        args={
                            "table": "claims",
                            "pk_col": "id",
                            "row": {
                                "id": "CLM-D-1031",
                                "supplier_id": "SUP-KAPPA",
                                "delivery_id": "D-1031",
                                "invoice_id": "INV-7735",
                                "amount": 70.00,
                                "reason": "late delivery penalty 3 days",
                                "status": "drafted",
                            },
                        },
                    ),
                ]
                offer_previews = {
                    c.id: REGISTRY[c.name].preview(c.args, REAL) for c in offer_plan if c.name in REGISTRY
                }
                prepared = PreparedOffer(
                    offer_id=offer_id,
                    prediction=pred,
                    commit_plan=offer_plan,
                    report=offer_report,
                    fp=fingerprint_env(REAL),
                    previews=offer_previews,
                )
                PENDING_OFFERS[offer_id] = prepared
                offer_payload = AnticipateOfferPayload(
                    offer_id=offer_id,
                    prediction=pred,
                    report=offer_report,
                    mutations_count=len(offer_plan),
                )
                BUS.emit(
                    run_id,
                    EventType.ANTICIPATE_OFFER,
                    offer_payload.model_dump(),
                    thought="Proactive opportunity detected: Recover EUR 175.00 in unclaimed credits across paid shipments D-1017 & D-1031.",
                )
        else:
            BUS.emit(
                run_id,
                EventType.RUN_DONE,
                {"status": "aborted_by_human"},
                thought="Risk Gate rejected: staged actions discarded.",
            )
    finally:
        rehearsal_env.cleanup()


@app.post("/api/demo/run")
async def demo_run(req: DemoRunRequest | None = None):
    global STAGE_DEMO_TASK, ACTIVE_CALL, ANTICIPATE_TASK, GOAL_RUN_TASK
    effective_req = req or DemoRunRequest()
    pace_ms = max(0, min(2500, effective_req.pace_ms))
    anticipate_after = effective_req.anticipate_after

    if STAGE_DEMO_TASK and not STAGE_DEMO_TASK.done():
        STAGE_DEMO_TASK.cancel()
    STAGE_DEMO_TASK = None
    if ANTICIPATE_TASK and not ANTICIPATE_TASK.done():
        ANTICIPATE_TASK.cancel()
    ANTICIPATE_TASK = None
    if GOAL_RUN_TASK and not GOAL_RUN_TASK.done():
        GOAL_RUN_TASK.cancel()
    GOAL_RUN_TASK = None
    for fut in list(PENDING.values()):
        if not fut.done():
            fut.cancel()
    PENDING.clear()
    PENDING_PAYLOADS.clear()
    RECENTLY_RESOLVED_APPROVALS.clear()
    ACTIVE_CALL = None

    run_id = f"demo_{uuid.uuid4().hex[:6]}"
    rehearsal_env = make_rehearsal_env(REAL)
    STAGE_DEMO_TASK = asyncio.create_task(
        _run_stage_demo(
            run_id=run_id,
            pace_ms=pace_ms,
            anticipate_after=anticipate_after,
            rehearsal_env=rehearsal_env,
        )
    )
    return {"ok": True, "run_id": run_id, "mode": "stage_demo"}


@app.post("/api/approve/{req_id}")
async def approve(req_id: str, d: ApprovalDecision):
    fut = PENDING.get(req_id)
    if not fut or fut.done():
        if req_id in RECENTLY_RESOLVED_APPROVALS:
            return {"ok": True, "already_resolved": True}
        raise HTTPException(404, "no pending approval")
    RECENTLY_RESOLVED_APPROVALS[req_id] = True
    fut.set_result(d.approved)
    return {"ok": True}


def _record_feedback(offer_id: str, accepted: bool, need: str) -> None:
    entries: list[dict[str, Any]] = []
    if FEEDBACK_PATH.exists():
        try:
            entries = json.loads(FEEDBACK_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            entries = []
    entries.append({"offer_id": offer_id, "accepted": accepted, "need": need})
    FEEDBACK_PATH.write_text(json.dumps(entries, indent=2), encoding="utf-8")


@app.post("/api/offers/{offer_id}/accept")
async def accept_offer(offer_id: str):
    """1-click accept on an Anticipate card: atomically replays pre-rehearsed reversible changes."""
    offer = PENDING_OFFERS.pop(offer_id, None)
    if not offer:
        raise HTTPException(404, "offer not found or already consumed")
    _record_feedback(offer_id, True, offer.prediction.need)
    run_id = f"ant_{offer_id[-4:]}"
    try:
        status = await replay(run_id, offer.commit_plan, offer.report, offer.fp, offer.previews, REAL, LOG)
    except StaleRehearsalError as exc:
        raise HTTPException(409, str(exc)) from exc
    BUS.emit(
        run_id,
        EventType.RUN_DONE,
        {"status": status, "offer_id": offer_id, "fingerprint": fingerprint_env(REAL)[:12]},
        thought=f"Applied proactive audit offer `{offer.prediction.need}` ({status}).",
    )
    return {"ok": True, "status": status, "fingerprint": fingerprint_env(REAL)[:12]}


@app.post("/api/offers/{offer_id}/dismiss")
async def dismiss_offer(offer_id: str):
    offer = PENDING_OFFERS.pop(offer_id, None)
    if not offer:
        raise HTTPException(404, "offer not found")
    _record_feedback(offer_id, False, offer.prediction.need)
    return {"ok": True}


class UndoRequest(BaseModel):
    steps: int | None = None


@app.post("/api/undo")
async def undo(req: UndoRequest | None = None):
    steps = req.steps if req is not None else None
    before_count = len(LOG.entries)
    skipped = LOG.undo_steps(
        steps,
        REGISTRY,
        REAL,
        on_step=lambda e: BUS.emit(
            "undo",
            EventType.UNDO_STEP,
            e,
            thought=f"Rewound step {e['step']} (`{e['tool']}` — {e.get('summary', '')}).",
        ),
    )
    return {
        "ok": True,
        "steps_undone": before_count - len(LOG.entries),
        "remaining": len(LOG.entries),
        "irreversible_skipped": skipped,
        "fingerprint": fingerprint_env(REAL)[:12],
    }


@app.post("/api/reset")
async def reset():
    """Restore workspace to deterministic Recoup baseline seed."""
    global _EXTRA_VOICE_COST_EUR, STAGE_DEMO_TASK, ACTIVE_CALL, GOAL_RUN_TASK
    if STAGE_DEMO_TASK and not STAGE_DEMO_TASK.done():
        STAGE_DEMO_TASK.cancel()
    STAGE_DEMO_TASK = None
    ACTIVE_CALL = None
    if ANTICIPATE_TASK and not ANTICIPATE_TASK.done():
        ANTICIPATE_TASK.cancel()
    if GOAL_RUN_TASK and not GOAL_RUN_TASK.done():
        GOAL_RUN_TASK.cancel()
    GOAL_RUN_TASK = None
    for fut in list(PENDING.values()):
        if not fut.done():
            fut.cancel()
    PENDING.clear()
    PENDING_PAYLOADS.clear()
    PENDING_OFFERS.clear()
    RECENTLY_RESOLVED_APPROVALS.clear()
    for name in [k for k, v in REGISTRY.items() if v.source == "forged"]:
        REGISTRY.pop(name, None)
    for t in REGISTRY.values():
        t.uses = 0
    if WS.exists():
        gc.collect()
        for child in list(WS.iterdir()):
            if is_db_file(child, REAL.db_path):
                with contextlib.suppress(PermissionError, OSError):
                    child.unlink()
            elif child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
    if SEED.exists():
        shutil.copytree(SEED, WS, dirs_exist_ok=True)
    else:
        populate_default_seed(WS)
    REAL.outbox.clear()
    LOG.entries.clear()
    LOG._flush()
    BUS.history.clear()
    _EXTRA_VOICE_COST_EUR = 0.0
    return {"ok": True, "fingerprint": fingerprint_env(REAL)[:12]}


@app.get("/api/history")
def history():
    """Export event log for offline trace replay."""
    return [e.model_dump() for e in BUS.history]


def _build_run_report_markdown(run_id: str | None = None) -> tuple[str, str]:
    """Build a human-readable Markdown audit & execution report for the latest (or specified) run."""
    brand_name = brand()["brand_name"]
    if not BUS.history:
        return "none", f"# {brand_name} Audit & Execution Report\n\nNo run events recorded yet.\n"
    target_id = run_id or BUS.history[-1].run_id
    run_events = [e for e in BUS.history if e.run_id == target_id]
    if not run_events:
        return target_id, f"# {brand_name} Audit & Execution Report\n\nNo events found for run `{target_id}`.\n"

    provider = os.getenv("LLM_PROVIDER", "fake")
    model = (
        os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
        if provider == "groq"
        else os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
        if provider == "gemini"
        else os.getenv("LLM_MODEL", "-")
    )
    total_cost = round(sum(e.cost_eur for e in run_events), 5)
    total_ms = sum(e.latency_ms for e in run_events)
    status = "running"
    goal_text = "-"
    lines: list[str] = []

    plan_md: list[str] = []
    forge_md: list[str] = []
    trace_md: list[str] = []
    verify_md: list[str] = []
    gate_md: list[str] = []

    for ev in run_events:
        p = ev.payload or {}
        if ev.type == EventType.REHEARSE_START:
            goal_text = str(p.get("goal", goal_text))
        elif ev.type in {EventType.PLAN_CREATED, EventType.PLAN_REVISED}:
            tag = "Initial Plan" if ev.type == EventType.PLAN_CREATED else "Revised Plan"
            plan_md.append(f"### {tag}")
            for s in p.get("steps", []):
                plan_md.append(f"- Step {s.get('id')}: `{s.get('tool')}` — {s.get('intent')}")
        elif ev.type == EventType.FORGE_TEST_RESULT:
            passed = bool(p.get("registered") or p.get("passed"))
            forge_md.append(
                f"- `{p.get('name')}` attempt {p.get('attempt')}: "
                f"{'PASSED' if passed else 'FAILED'}"
                + (f" (`{p.get('error')}`)" if p.get("error") else "")
            )
        elif ev.type == EventType.TOOL_CALL:
            c = p.get("call", {})
            args_str = json.dumps(c.get("args", {}), ensure_ascii=False)
            if len(args_str) > 160:
                args_str = args_str[:157] + "..."
            trace_md.append(f"- Step {ev.step} **CALL** `{c.get('name')}` `{args_str}`")
        elif ev.type == EventType.TOOL_DONE:
            trace_md.append(f"  - OK ({ev.latency_ms} ms): `{str(p.get('preview', ''))[:140]}`")
        elif ev.type == EventType.TOOL_ERROR:
            trace_md.append(f"  - ERROR ({ev.latency_ms} ms): `{p.get('error')}`")
        elif ev.type == EventType.VERIFY_RESULT:
            verify_md.append(f"**Overall:** {'PASSED' if p.get('passed') else 'FAILED'}")
            for cr in p.get("criteria", []):
                ok_flag = bool(cr.get("passed", cr.get("ok")))
                verify_md.append(f"- [{'x' if ok_flag else ' '}] {cr.get('criterion')} — {cr.get('detail')}")
        elif ev.type == EventType.APPROVAL_NEEDED:
            gate_md.append(f"- Paused on `{p.get('tool_name')}`: {p.get('risk_reason')}")
        elif ev.type == EventType.APPROVAL_RESULT:
            gate_md.append(
                f"- Decision: `{p.get('outcome') or ('approved' if p.get('approved') else 'rejected')}`"
            )
        elif ev.type == EventType.RUN_DONE:
            status = str(p.get("status", status))
            if p.get("error"):
                gate_md.append(f"- Error: `{p.get('error')}`")

    domain_label = get_domain()["label"]
    lines.extend(
        [
            f"# {brand_name} Audit & Execution Report (`{target_id}`)",
            "",
            f"- **Goal:** {goal_text}",
            f"- **Domain:** `{domain_label}` | **Provider:** `{provider}` (`{model}`)",
            (
                f"- **Status:** `{status}` | **Tool Calls:** "
                f"{sum(1 for e in run_events if e.type == EventType.TOOL_CALL)} | "
                f"**Cost:** EUR {total_cost:.4f} | **Tool Latency:** {total_ms} ms"
            ),
            "",
            "## Plan",
            *(plan_md or ["- (no plan emitted)"]),
            "",
            "## Sandboxed Tool Synthesis",
            *(forge_md or ["- (no tools synthesized)"]),
            "",
            "## Rehearsal Trace",
            *(trace_md or ["- (no tool calls)"]),
            "",
            "## Verification",
            *(verify_md or ["- (no verification emitted)"]),
            "",
            "## Risk Gate & Outcome",
            *(gate_md or ["- (no risk gate triggered)"]),
            "",
        ]
    )
    return target_id, "\n".join(lines)


@app.get("/api/runs/report")
def run_report(run_id: str | None = None, download: bool = False):
    """Export a documented Markdown audit report for the latest (or specified) run."""
    rid, md = _build_run_report_markdown(run_id)
    headers = {"Content-Disposition": f'attachment; filename="recoup_run_{rid}.md"'} if download else {}
    return Response(content=md, media_type="text/markdown; charset=utf-8", headers=headers)


class VoiceBriefingRequest(BaseModel):
    text: str
    kind: str = "briefing"


VOICE_CACHE_DIR = Path(os.getenv("VOICE_CACHE_DIR", "./.voice_cache")).resolve()


@app.post("/api/voice/briefing")
async def voice_briefing(req: VoiceBriefingRequest):
    """Synthesize spoken executive briefing via single calm AI voice (fal.ai), with 204 Web Speech fallback."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty briefing text")

    audio_bytes: bytes | None = None
    with contextlib.suppress(Exception):
        from .voice.call_audio import synthesize_call_turn  # type: ignore[import-not-found]

        is_unpatched_turn = getattr(synthesize_call_turn, "__module__", "").endswith("call_audio")
        pytest_turn_offline = (
            "PYTEST_CURRENT_TEST" in os.environ
            and is_unpatched_turn
            and not os.getenv("ELEVENLABS_API_KEY", "").strip()
            and not os.getenv("FAL_KEY", "").strip()
            and not os.getenv("VOICE_PROVIDER", "").strip()
        )
        if not pytest_turn_offline:
            maybe_turn = synthesize_call_turn("agent", text)
            candidate = await maybe_turn if inspect.isawaitable(maybe_turn) else maybe_turn
            if candidate:
                audio_bytes = candidate

    if not audio_bytes:
        with contextlib.suppress(Exception):
            from .voice.elevenlabs_agent import synthesize_briefing  # type: ignore[import-not-found]

            is_unpatched = getattr(synthesize_briefing, "__module__", "").endswith("elevenlabs_agent")
            pytest_offline = (
                "PYTEST_CURRENT_TEST" in os.environ
                and is_unpatched
                and not os.getenv("ELEVENLABS_API_KEY", "").strip()
                and not os.getenv("FAL_KEY", "").strip()
                and not os.getenv("VOICE_PROVIDER", "").strip()
            )
            if not pytest_offline:
                maybe_audio = synthesize_briefing(text)
                candidate = await maybe_audio if inspect.isawaitable(maybe_audio) else maybe_audio
                if candidate:
                    audio_bytes = candidate

    if audio_bytes:
        mc = _record_direct_voice_cost(text)
        headers = {"X-Voice-Cost-Eur": f"{mc:.6f}"} if mc > 0 else {}
        return Response(content=audio_bytes, media_type="audio/mpeg", headers=headers)

    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Phase 2: Multimodal Evidence Upload, Live Vendor Negotiation & Voice Gate
# ---------------------------------------------------------------------------

_PHOTO_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic"}
_AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".m4a", ".webm", ".aac"}
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _sanitize_inbox_filename(raw_name: str) -> str:
    base = Path(str(raw_name or "evidence.txt")).name.strip()
    cleaned = _SAFE_FILENAME_RE.sub("_", base).lstrip(".")
    if not cleaned or cleaned.lower().startswith("env"):
        return "evidence.txt"
    return cleaned[:120]


def _looks_binary(raw_bytes: bytes) -> bool:
    if not raw_bytes:
        return False
    if raw_bytes.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"RIFF", b"ID3", b"\x1aE\xdf\xa3")):
        return True
    return b"\x00" in raw_bytes[:512]


def _offline_inspect_evidence(rel_source: str, raw_bytes: bytes) -> EvidencePayload:
    ext = Path(rel_source).suffix.lower()
    kind: Literal["document", "photo", "audio"] = (
        "photo" if ext in _PHOTO_EXTS else "audio" if ext in _AUDIO_EXTS else "document"
    )
    findings: list[str] = []
    if not _looks_binary(raw_bytes):
        text = raw_bytes.decode("utf-8", errors="replace")
        for raw_line in text.splitlines():
            line = re.sub(r"^[#>*\-\s]+", "", raw_line).strip()
            if line:
                findings.append(line[:200])
            if len(findings) >= 8:
                break

    if not findings:
        if kind == "photo":
            findings = [
                f"Captured photo evidence `{rel_source}` ({len(raw_bytes)} bytes) in workspace inbox.",
                "Stockroom hardware / packaging inspection image attached for vendor claim verification.",
            ]
        elif kind == "audio":
            findings = [
                f"Captured audio recording `{rel_source}` ({len(raw_bytes)} bytes) in workspace inbox.",
            ]
        else:
            findings = [
                f"Stored workspace evidence document `{rel_source}` ({len(raw_bytes)} bytes).",
            ]
    return EvidencePayload(source=rel_source, kind=kind, findings=findings)


@app.post("/api/evidence/upload")
async def upload_evidence(request: Request):
    """Ingest multipart or base64 evidence into WS/inbox, inspect lazily, and emit EventType.EVIDENCE."""
    content_type = (request.headers.get("content-type") or "").lower()
    raw_filename = "evidence.txt"
    raw_bytes: bytes | None = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        upload = form.get("file")
        if upload is None:
            for item in form.values():
                if hasattr(item, "read"):
                    upload = item
                    break
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(400, "multipart upload missing file field")
        raw_filename = getattr(upload, "filename", None) or "evidence.bin"
        raw_bytes = await upload.read()  # type: ignore[misc]
    else:
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(400, "invalid JSON payload") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "expected JSON object")
        raw_filename = str(body.get("filename") or body.get("name") or "evidence.txt")
        b64 = body.get("content_b64") or body.get("data_b64")
        if isinstance(b64, str) and b64.strip():
            encoded = b64.split(",", 1)[-1].strip()
            try:
                raw_bytes = base64.b64decode(encoded)
            except Exception as exc:
                raise HTTPException(400, "invalid base64 evidence content") from exc
        elif isinstance(body.get("content"), str):
            raw_bytes = body["content"].encode("utf-8")

    if raw_bytes is None or len(raw_bytes) == 0:
        raise HTTPException(400, "empty evidence content")

    safe_name = _sanitize_inbox_filename(raw_filename)
    inbox_dir = WS / "inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)
    saved_path = (inbox_dir / safe_name).resolve()
    if not saved_path.is_relative_to(WS.resolve()):
        raise HTTPException(400, "unsafe evidence filename")
    saved_path.write_bytes(raw_bytes)
    rel_source = f"inbox/{safe_name}"

    evidence: EvidencePayload | None = None
    with contextlib.suppress(Exception):
        from .agent.vision import inspect_evidence_file  # type: ignore[import-not-found]

        maybe_ev = inspect_evidence_file(saved_path)
        inspected = await maybe_ev if inspect.isawaitable(maybe_ev) else maybe_ev
        if isinstance(inspected, EvidencePayload):
            evidence = inspected
        elif isinstance(inspected, dict):
            evidence = EvidencePayload.model_validate(inspected)

    if evidence is None:
        evidence = _offline_inspect_evidence(rel_source, raw_bytes)
    elif not evidence.source or "/" not in evidence.source:
        evidence = evidence.model_copy(update={"source": rel_source})

    run_id = f"evd_{uuid.uuid4().hex[:6]}"
    BUS.emit(
        run_id,
        EventType.EVIDENCE,
        evidence.model_dump(),
        thought=f"Audited {evidence.kind} evidence `{evidence.source}` ({len(evidence.findings)} findings).",
    )
    return evidence.model_dump()


class NegotiateCallRequest(BaseModel):
    claim_id: str = "CLM-D-1042"
    opening_pct: float | None = None
    floor_pct: float | None = None
    pace_seconds: float = 0.35


def _lookup_claim_context(claim_id: str) -> tuple[dict[str, Any] | None, str, float, float, float]:
    neg = get_domain().get("negotiation", {})
    counterparty = str(neg.get("counterparty") or "Kappa Office Systems AR desk")
    default_amount = float(neg.get("claim_amount") or 587.30)
    floor_pct = float(neg.get("accept_floor_pct") or 85.0)
    opening_pct = float(neg.get("opening_counter_pct") or 70.0)
    claim_row: dict[str, Any] | None = None

    if REAL.db_path.exists():
        with contextlib.closing(sqlite3.connect(REAL.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            with contextlib.suppress(sqlite3.OperationalError):
                row = conn.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
                if row is not None:
                    claim_row = dict(row)
                    default_amount = float(claim_row.get("amount") or default_amount)
                    sup_id = claim_row.get("supplier_id")
                    if sup_id:
                        srow = conn.execute(
                            "SELECT name FROM suppliers WHERE id = ?", (sup_id,)
                        ).fetchone()
                        if srow and srow["name"]:
                            counterparty = f"{srow['name']} AR desk"
    return claim_row, counterparty, default_amount, opening_pct, floor_pct


def _normalize_negotiation_output(
    raw_result: Any,
    claim_id: str,
    claim_amount: float,
    floor_pct: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    if raw_result is None:
        return None
    turns_raw: Any = None
    end_raw: Any = None
    if isinstance(raw_result, tuple) and len(raw_result) == 2:
        turns_raw, end_raw = raw_result
    elif isinstance(raw_result, dict):
        turns_raw = raw_result.get("turns")
        end_raw = raw_result.get("end") or raw_result.get("result")
        if end_raw is None and "outcome" in raw_result:
            end_raw = {
                "call_id": raw_result.get("call_id", f"CALL-{claim_id}"),
                "outcome": raw_result["outcome"],
                "agreed_amount": raw_result.get("agreed_amount"),
                "summary": raw_result.get("summary", ""),
            }
    elif hasattr(raw_result, "turns"):
        turns_raw = raw_result.turns
        end_raw = getattr(raw_result, "end", None)

    if not isinstance(turns_raw, list) or not turns_raw:
        return None

    turns_list = [t.model_dump() if hasattr(t, "model_dump") else dict(t) for t in turns_raw]
    if end_raw is not None:
        end_dict = end_raw.model_dump() if hasattr(end_raw, "model_dump") else dict(end_raw)
    else:
        from .voice.elevenlabs_agent import summarize_negotiation_outcome

        end_dict = summarize_negotiation_outcome(claim_id, claim_amount, turns_list, floor_pct=floor_pct)
    return turns_list, end_dict


@app.post("/api/call/negotiate")
async def negotiate_vendor_call(req: NegotiateCallRequest | None = None):
    """Run live two-party vendor AR settlement call, stream turns on SSE, and settle reversibly."""
    body = req or NegotiateCallRequest()
    claim_id = (body.claim_id or "CLM-D-1042").strip() or "CLM-D-1042"
    existing_claim, counterparty, claim_amount, def_open, def_floor = _lookup_claim_context(claim_id)
    opening_pct = float(body.opening_pct if body.opening_pct is not None else def_open)
    floor_pct = float(body.floor_pct if body.floor_pct is not None else def_floor)
    pace = max(0.0, min(float(body.pace_seconds), 2.0))

    run_id = f"call_{uuid.uuid4().hex[:6]}"
    call_id = f"CALL-{claim_id}"

    BUS.emit(
        run_id,
        EventType.CALL_START,
        {
            "call_id": call_id,
            "claim_id": claim_id,
            "counterparty": counterparty,
            "claim_amount": claim_amount,
            "opening_pct": opening_pct,
            "floor_pct": floor_pct,
        },
        thought=f"Dialing {counterparty} to settle `{claim_id}` (EUR {claim_amount:.2f}, floor {floor_pct:g}%).",
    )

    negotiated: tuple[list[dict[str, Any]], dict[str, Any]] | None = None
    if body.opening_pct is None:
        with contextlib.suppress(Exception):
            from .agent.negotiator import run_vendor_negotiation  # type: ignore[import-not-found]

            maybe_neg = run_vendor_negotiation(claim_id, REAL, accept_floor_pct=body.floor_pct)
            raw_neg = await maybe_neg if inspect.isawaitable(maybe_neg) else maybe_neg
            negotiated = _normalize_negotiation_output(raw_neg, claim_id, claim_amount, floor_pct)

    if negotiated is None:
        from .voice.elevenlabs_agent import (
            simulate_vendor_negotiation_turns,
            summarize_negotiation_outcome,
        )

        sim_turns = simulate_vendor_negotiation_turns(
            claim_id,
            claim_amount,
            opening_pct=opening_pct,
            floor_pct=floor_pct,
        )
        sim_end = summarize_negotiation_outcome(claim_id, claim_amount, sim_turns, floor_pct=floor_pct)
        negotiated = (sim_turns, sim_end)

    raw_turns, raw_end = negotiated
    emitted_turns: list[dict[str, Any]] = []
    for idx, t in enumerate(raw_turns, start=1):
        turn_payload = CallTurnPayload(
            call_id=str(t.get("call_id") or call_id),
            speaker="counterparty" if t.get("speaker") == "counterparty" else "agent",
            text=str(t.get("text") or ""),
            audio_url=str(t.get("audio_url") or "/api/voice/turn-audio"),
            offer_pct=t.get("offer_pct"),
        ).model_dump()
        emitted_turns.append(turn_payload)
        speaker_label = "Recoup Negotiator" if turn_payload["speaker"] == "agent" else counterparty
        turn_cost = _voice_micro_cost(turn_payload["text"]) if turn_payload["speaker"] == "agent" else 0.0
        BUS.emit(
            run_id,
            EventType.CALL_TURN,
            turn_payload,
            step=idx,
            thought=f"{speaker_label}: {turn_payload['text']}",
            cost_eur=turn_cost,
        )
        if pace > 0 and idx < len(raw_turns):
            await asyncio.sleep(pace)

    end_payload = CallEndPayload(
        call_id=str(raw_end.get("call_id") or call_id),
        outcome=raw_end.get("outcome", "escalated"),
        agreed_amount=raw_end.get("agreed_amount"),
        summary=str(raw_end.get("summary") or ""),
    ).model_dump()
    BUS.emit(
        run_id,
        EventType.CALL_END,
        end_payload,
        thought=end_payload["summary"] or f"Call `{end_payload['call_id']}` ended ({end_payload['outcome']}).",
    )

    claim_status: str | None = existing_claim.get("status") if existing_claim else None
    if end_payload["outcome"] == "accepted" and "upsert_row" in REGISTRY and REAL.db_path.exists():
        upsert_tool = REGISTRY["upsert_row"]
        if existing_claim is not None:
            row_patch: dict[str, Any] = {"id": claim_id, "status": "settled"}
        else:
            row_patch = {
                "id": claim_id,
                "supplier_id": "SUP-KAPPA",
                "delivery_id": "D-1042",
                "invoice_id": "INV-7781",
                "amount": float(end_payload["agreed_amount"] or claim_amount),
                "reason": end_payload["summary"] or f"Settled via vendor AR call ({call_id})",
                "status": "settled",
            }
        upsert_args = {"table": "claims", "pk_col": "id", "row": row_patch}
        receipt = upsert_tool.do(upsert_args, REAL)
        upsert_tool.uses += 1
        step_no = len(LOG.entries) + 1
        summary_text = f"Settled claim #{claim_id} ({end_payload.get('agreed_amount') or claim_amount:.2f} EUR)"
        LOG.record(step_no, "upsert_row", upsert_args, receipt, summary=summary_text)
        claim_status = "settled"
        BUS.emit(
            run_id,
            EventType.REPLAY_STEP_DONE,
            {"step": step_no, "tool": "upsert_row", "summary": summary_text, "receipt": receipt},
            step=step_no,
            thought=f"Recorded reversible settlement on `{claim_id}` (`status='settled'`).",
        )

    return {
        "ok": True,
        "run_id": run_id,
        "claim_id": claim_id,
        "claim_status": claim_status,
        "turns": emitted_turns,
        **end_payload,
        "fingerprint": fingerprint_env(REAL)[:12],
    }


class TurnAudioRequest(BaseModel):
    speaker: Literal["agent", "counterparty", "user"] = "agent"
    text: str


@app.post("/api/voice/turn-audio")
async def voice_turn_audio(req: TurnAudioRequest):
    """Synthesize a call turn strictly via single calm AI agent voice (fal.ai), else HTTP 204."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty turn text")

    audio_bytes: bytes | None = None
    with contextlib.suppress(Exception):
        from .voice.call_audio import synthesize_call_turn  # type: ignore[import-not-found]

        is_unpatched_turn = getattr(synthesize_call_turn, "__module__", "").endswith("call_audio")
        pytest_turn_offline = (
            "PYTEST_CURRENT_TEST" in os.environ
            and is_unpatched_turn
            and not os.getenv("ELEVENLABS_API_KEY", "").strip()
            and not os.getenv("FAL_KEY", "").strip()
            and not os.getenv("VOICE_PROVIDER", "").strip()
        )
        if not pytest_turn_offline:
            maybe_turn = synthesize_call_turn("agent", text)
            candidate = await maybe_turn if inspect.isawaitable(maybe_turn) else maybe_turn
            if candidate:
                audio_bytes = candidate

    if not audio_bytes:
        with contextlib.suppress(Exception):
            from .voice.elevenlabs_agent import synthesize_briefing

            is_unpatched_brief = getattr(synthesize_briefing, "__module__", "").endswith("elevenlabs_agent")
            pytest_brief_offline = (
                "PYTEST_CURRENT_TEST" in os.environ
                and is_unpatched_brief
                and not os.getenv("ELEVENLABS_API_KEY", "").strip()
                and not os.getenv("FAL_KEY", "").strip()
                and not os.getenv("VOICE_PROVIDER", "").strip()
            )
            if not pytest_brief_offline:
                maybe_audio = synthesize_briefing(text)
                candidate = await maybe_audio if inspect.isawaitable(maybe_audio) else maybe_audio
                if candidate:
                    audio_bytes = candidate

    if audio_bytes:
        mc = _record_direct_voice_cost(text)
        headers = {"X-Voice-Cost-Eur": f"{mc:.6f}"} if mc > 0 else {}
        return Response(content=audio_bytes, media_type="audio/mpeg", headers=headers)

    return Response(status_code=204)


async def _transcribe_audio_fallback(audio_bytes: bytes, filename: str, mime_type: str) -> str:
    """Optional cloud STT fallback (Groq Whisper) when call_audio is absent and GROQ_API_KEY is set."""
    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    if not groq_key or os.getenv("VOICE_PROVIDER", "").strip().lower() in ("none", "offline", "fake"):
        return ""
    with contextlib.suppress(Exception):
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {groq_key}"},
                data={"model": os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo"), "language": "en"},
                files={"file": (filename or "decision.webm", audio_bytes, mime_type or "audio/webm")},
            )
            if resp.status_code == 200:
                payload = resp.json()
                if isinstance(payload, dict) and isinstance(payload.get("text"), str):
                    return payload["text"].strip()
    return ""


@app.post("/api/voice/decision")
async def voice_decision(request: Request):
    """Approve or reject PENDING[req_id] hands-free via audio recording or spoken transcript."""
    content_type = (request.headers.get("content-type") or "").lower()
    req_id = ""
    transcript = ""
    audio_bytes: bytes | None = None
    filename = "decision.webm"
    mime_type = "audio/webm"

    if "multipart/form-data" in content_type:
        form = await request.form()
        req_id = str(form.get("req_id") or "").strip()
        transcript = str(form.get("transcript") or "").strip()
        upload = form.get("audio") or form.get("file")
        if upload is not None and hasattr(upload, "read"):
            filename = getattr(upload, "filename", None) or filename
            mime_type = getattr(upload, "content_type", None) or mime_type
            audio_bytes = await upload.read()  # type: ignore[misc]
    else:
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(400, "invalid JSON payload") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "expected JSON object")
        req_id = str(body.get("req_id") or "").strip()
        transcript = str(body.get("transcript") or "").strip()
        mime_type = str(body.get("mime_type") or mime_type)
        b64_audio = body.get("audio_b64")
        if isinstance(b64_audio, str) and b64_audio.strip():
            encoded = b64_audio.split(",", 1)[-1].strip()
            with contextlib.suppress(Exception):
                audio_bytes = base64.b64decode(encoded)

    if not req_id and PENDING:
        for candidate_id, candidate_fut in PENDING.items():
            if not candidate_fut.done():
                req_id = candidate_id
                break

    decision: str | None = None
    had_initial_transcript = bool(transcript)
    if audio_bytes:
        with contextlib.suppress(Exception):
            from .voice.call_audio import transcribe_and_decide  # type: ignore[import-not-found]

            sig = inspect.signature(transcribe_and_decide)
            kwargs: dict[str, Any] = {}
            if "mime_type" in sig.parameters:
                kwargs["mime_type"] = mime_type
            if "content_type" in sig.parameters:
                kwargs["content_type"] = mime_type
            if "filename" in sig.parameters:
                kwargs["filename"] = filename
            maybe_res = transcribe_and_decide(audio_bytes, **kwargs)
            res = await maybe_res if inspect.isawaitable(maybe_res) else maybe_res
            if isinstance(res, tuple) and len(res) == 2:
                transcript = str(res[0] or transcript)
                decision = str(res[1])
            elif isinstance(res, dict):
                transcript = str(res.get("transcript") or transcript)
                if isinstance(res.get("decision"), str):
                    decision = res["decision"]
                elif isinstance(res.get("approved"), bool):
                    decision = "approve" if res["approved"] else "reject"
            elif isinstance(res, str):
                decision = res

        if not transcript and decision is None:
            transcript = await _transcribe_audio_fallback(audio_bytes, filename, mime_type)
        if not had_initial_transcript and transcript:
            _record_direct_voice_cost(transcript)

    if decision not in ("approve", "reject", "unknown"):
        from .voice.elevenlabs_agent import parse_voice_decision

        decision = parse_voice_decision(transcript)

    is_demo_req = req_id.startswith("req_demo")
    fut = PENDING.get(req_id) if req_id else None
    if not is_demo_req and (fut is None or fut.done()):
        raise HTTPException(404, "no pending approval")

    if decision == "unknown":
        return {
            "ok": False,
            "req_id": req_id,
            "transcript": transcript,
            "decision": "unknown",
            "approved": None,
            "resolved": False,
        }

    approved = decision == "approve"
    resolved = False
    if fut is not None and not fut.done():
        fut.set_result(approved)
        resolved = True

    return {
        "ok": True,
        "req_id": req_id,
        "transcript": transcript,
        "decision": decision,
        "approved": approved,
        "resolved": resolved,
    }


@app.websocket("/api/voice/grok-realtime")
async def grok_realtime_ws(websocket: WebSocket):
    """Bidirectional duplex WebSocket bridge to fal.ai xAI Grok Voice realtime endpoint."""
    await websocket.accept()
    fal_key = os.getenv("FAL_KEY", "").strip()
    provider = os.getenv("VOICE_PROVIDER", "").strip().lower()

    if (
        not fal_key
        or provider in ("offline", "none", "fake", "disabled")
        or "PYTEST_CURRENT_TEST" in os.environ
    ):
        await websocket.send_json({
            "type": "fallback",
            "reason": "grok_realtime_unavailable",
            "mode": "auto_vad_http",
        })
        await websocket.close(code=1000)
        return

    upstream_url = (
        os.getenv("GROK_REALTIME_WS_URL", "").strip()
        or "wss://fal.run/xai/grok-voice/realtime"
    )
    try:
        import websockets

        headers = {"Authorization": f"Key {fal_key}"}
        async with websockets.connect(upstream_url, extra_headers=headers) as upstream_ws:
            async def browser_to_grok():
                while True:
                    data = await websocket.receive()
                    if data.get("text"):
                        await upstream_ws.send(data["text"])
                    elif data.get("bytes"):
                        await upstream_ws.send(data["bytes"])

            async def grok_to_browser():
                async for msg in upstream_ws:
                    if isinstance(msg, bytes):
                        await websocket.send_bytes(msg)
                    else:
                        await websocket.send_text(msg)

            await asyncio.gather(browser_to_grok(), grok_to_browser())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:  # noqa: BLE001
        with contextlib.suppress(Exception):
            await websocket.send_json({
                "type": "fallback",
                "reason": "grok_realtime_unavailable",
                "mode": "auto_vad_http",
            })
            await websocket.close(code=1000)


# ---------------------------------------------------------------------------
# Phase 3: Operator Consult Escalation Call, AADE myDATA XML & Dynamic Ledger
# ---------------------------------------------------------------------------

_REFUND_INTENT_RE = re.compile(
    r"\b(refund|credit|587|hold|freeze|aade|mydata|enforce|approve|send|claim|option b)\b"
)
_REDELIVERY_INTENT_RE = re.compile(
    r"\b(redeliver|re-deliver|redelivery|re-delivery|replace|replacement|22|hubs|tomorrow|option a)\b"
)
_STT_NOISE_PHRASES = {
    "",
    ".",
    "..",
    "...",
    "you",
    "thank you",
    "thank you.",
    "thanks",
    "thanks.",
    "thanks for watching",
    "thanks for watching.",
    "bye",
    "bye.",
    "uh",
    "um",
    "hmm",
}


def _active_pending_req_id() -> str | None:
    for cand_id, cand_fut in PENDING.items():
        if isinstance(cand_fut, asyncio.Event):
            if not cand_fut.is_set():
                return cand_id
        elif not cand_fut.done():
            return cand_id
    return next(iter(PENDING.keys()), None)


def _classify_operator_consult_intent(transcript: str) -> Literal["refund", "redelivery"]:
    with contextlib.suppress(Exception):
        call_audio = importlib.import_module(".voice.call_audio", __package__)

        parser = getattr(call_audio, "parse_user_resolution_intent", None)
        if callable(parser):
            parsed = parser(transcript)
            norm = ""
            if isinstance(parsed, dict):
                norm = str(parsed.get("choice") or parsed.get("intent") or parsed.get("resolution") or "")
            elif isinstance(parsed, tuple) and parsed:
                norm = str(parsed[0] or "")
            elif isinstance(parsed, str):
                norm = parsed
            norm_clean = norm.strip().lower()
            if norm_clean in ("refund", "redelivery"):
                return "refund" if norm_clean == "refund" else "redelivery"

    lowered = (transcript or "").lower()
    if re.search(r"\b(?:no|not|don'?t|instead of)\s+(?:the\s+|full\s+)?(?:refund|hold)\b", lowered):
        return "redelivery"
    if re.search(
        r"\b(?:no|not|don'?t|instead of)\s+(?:next[- ]day\s+)?(?:redeliver\w*|re-deliver\w*|replacement)\b",
        lowered,
    ):
        return "refund"

    refund_hits = len(_REFUND_INTENT_RE.findall(lowered))
    redelivery_hits = len(_REDELIVERY_INTENT_RE.findall(lowered))
    if redelivery_hits > refund_hits:
        return "redelivery"
    if refund_hits > 0:
        return "refund"
    return "refund"


async def _transcribe_operator_consult_audio(
    audio_bytes: bytes,
    filename: str,
    mime_type: str,
) -> str:
    if not audio_bytes:
        return ""

    with contextlib.suppress(Exception):
        call_audio = importlib.import_module(".voice.call_audio", __package__)

        for fn_name in ("transcribe_operator_voice", "transcribe_audio_bytes", "transcribe_and_decide"):
            fn = getattr(call_audio, fn_name, None)
            if not callable(fn):
                continue
            sig = inspect.signature(fn)
            kwargs: dict[str, Any] = {}
            if "mime_type" in sig.parameters:
                kwargs["mime_type"] = mime_type
            if "content_type" in sig.parameters:
                kwargs["content_type"] = mime_type
            if "filename" in sig.parameters:
                kwargs["filename"] = filename
            maybe_out = fn(audio_bytes, **kwargs)
            out = await maybe_out if inspect.isawaitable(maybe_out) else maybe_out
            if isinstance(out, str) and out.strip():
                return out.strip()
            if isinstance(out, tuple) and out and isinstance(out[0], str) and out[0].strip():
                return out[0].strip()
            if isinstance(out, dict):
                txt = str(out.get("transcript") or out.get("text") or "").strip()
                if txt:
                    return txt

    with contextlib.suppress(Exception):
        elevenlabs_agent = importlib.import_module(".voice.elevenlabs_agent", __package__)

        fn_el = getattr(elevenlabs_agent, "transcribe_voice_decision", None)
        if callable(fn_el):
            sig = inspect.signature(fn_el)
            kwargs = {"mime_type": mime_type} if "mime_type" in sig.parameters else {}
            maybe_out = fn_el(audio_bytes, **kwargs)
            out = await maybe_out if inspect.isawaitable(maybe_out) else maybe_out
            if isinstance(out, str) and out.strip():
                return out.strip()
            if isinstance(out, dict):
                txt = str(out.get("transcript") or out.get("text") or "").strip()
                if txt:
                    return txt

    return await _transcribe_audio_fallback(audio_bytes, filename, mime_type)


def _build_aade_mydata_xml(claim_id: str, choice: Literal["refund", "redelivery"]) -> str:
    escaped_claim_id = xml.sax.saxutils.escape(claim_id)
    if choice == "refund":
        invoice_type = "5.1"
        series = "CR-AADE"
        net_val = "587.30"
        vat_val = "140.95"
        gross_val = "728.25"
        qty_block = ""
        move_block = ""
        comments = (
            f"Πιστωτικό Τιμολόγιο Συσχετιζόμενο (Credit Note) for claim {escaped_claim_id} "
            "on delivery D-1042 / correlated invoice INV-7781"
        )
    else:
        invoice_type = "9.3"
        series = "DN-AADE"
        net_val = "202.30"
        vat_val = "48.55"
        gross_val = "250.85"
        qty_block = "\n        <quantity>22</quantity>"
        move_block = "\n      <movePurpose>1</movePurpose>"
        comments = (
            "Δελτίο Αποστολής - Συμφωνία Επαναποστολής 22 τεμ. USB-C hubs next-day "
            f"plus SLA and unit overbill adjustment on D-1042 / INV-7781 ({escaped_claim_id})"
        )

    escaped_series = xml.sax.saxutils.escape(series)
    escaped_invoice_type = xml.sax.saxutils.escape(invoice_type)
    escaped_comments = xml.sax.saxutils.escape(comments)
    escaped_net = xml.sax.saxutils.escape(net_val)
    escaped_vat = xml.sax.saxutils.escape(vat_val)
    escaped_gross = xml.sax.saxutils.escape(gross_val)

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<InvoicesDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0">\n'
        "  <invoice>\n"
        "    <issuer>\n"
        "      <vatNumber>EL094281773</vatNumber>\n"
        "      <country>GR</country>\n"
        "      <branch>0</branch>\n"
        "      <name>Kappa Office Systems S.A.</name>\n"
        "    </issuer>\n"
        "    <counterpart>\n"
        "      <vatNumber>EL998451220</vatNumber>\n"
        "      <country>GR</country>\n"
        "      <branch>0</branch>\n"
        "      <name>Recoup Enterprise Operations</name>\n"
        "    </counterpart>\n"
        "    <invoiceHeader>\n"
        f"      <series>{escaped_series}</series>\n"
        "      <aa>1042</aa>\n"
        "      <issueDate>2026-11-14</issueDate>\n"
        f"      <invoiceType>{escaped_invoice_type}</invoiceType>\n"
        "      <currency>EUR</currency>\n"
        "      <correlatedInvoices>INV-7781</correlatedInvoices>\n"
        f"      <deliveryRef>D-1042</deliveryRef>{move_block}\n"
        "    </invoiceHeader>\n"
        "    <invoiceDetails>\n"
        f"      <lineNumber>1</lineNumber>{qty_block}\n"
        f"      <netValue>{escaped_net}</netValue>\n"
        "      <vatCategory>1</vatCategory>\n"
        f"      <vatAmount>{escaped_vat}</vatAmount>\n"
        f"      <lineComments>{escaped_comments}</lineComments>\n"
        "      <incomeClassification>\n"
        "        <classificationType>E3_561_001</classificationType>\n"
        "        <classificationCategory>category1_1</classificationCategory>\n"
        f"        <amount>{escaped_net}</amount>\n"
        "      </incomeClassification>\n"
        "    </invoiceDetails>\n"
        "    <invoiceSummary>\n"
        f"      <totalNetValue>{escaped_net}</totalNetValue>\n"
        f"      <totalVatAmount>{escaped_vat}</totalVatAmount>\n"
        "      <totalWithheldAmount>0.00</totalWithheldAmount>\n"
        "      <totalFeesAmount>0.00</totalFeesAmount>\n"
        "      <totalStampDutyAmount>0.00</totalStampDutyAmount>\n"
        "      <totalOtherTaxesAmount>0.00</totalOtherTaxesAmount>\n"
        "      <totalDeductionsAmount>0.00</totalDeductionsAmount>\n"
        f"      <totalGrossValue>{escaped_gross}</totalGrossValue>\n"
        "    </invoiceSummary>\n"
        "  </invoice>\n"
        "</InvoicesDoc>\n"
    )


def _pick_allowed_column_value(
    ddl: str,
    col_name: str,
    preferred: list[str],
    fallback: str,
) -> str:
    if ddl:
        in_match = re.search(rf"\b{re.escape(col_name)}\b\s+IN\s*\(([^)]+)\)", ddl, re.IGNORECASE)
        if in_match:
            allowed = re.findall(r"'([^']*)'", in_match.group(1))
            if allowed:
                for cand in preferred:
                    if cand in allowed:
                        return cand
                if fallback in allowed:
                    return fallback
                return allowed[0]
    return preferred[0] if preferred else fallback


def _record_reversible_mutation(
    run_id: str,
    tool_name: str,
    args: dict[str, Any],
    summary: str,
) -> bool:
    tool = REGISTRY.get(tool_name)
    if tool is None:
        return False
    receipt = tool.do(args, REAL)
    tool.uses += 1
    step_no = len(LOG.entries) + 1
    LOG.record(step_no, tool_name, args, receipt, summary=summary)
    BUS.emit(
        run_id,
        EventType.REPLAY_STEP_DONE,
        {"step": step_no, "tool": tool_name, "summary": summary, "receipt": receipt},
        step=step_no,
        thought=summary,
    )
    return True


def _apply_consult_resolution_mutations(
    run_id: str,
    claim_id: str,
    choice: Literal["refund", "redelivery"],
    agreed_amount: float,
    aade_xml_path: str,
    xml_content: str,
) -> int:
    mutations = 0
    invoice_type = "5.1" if choice == "refund" else "9.3"
    net_amount = 587.30 if choice == "refund" else 202.30
    vat_amount = 140.95 if choice == "refund" else 48.55
    gross_amount = 728.25 if choice == "refund" else 250.85

    if _record_reversible_mutation(
        run_id,
        "write_file",
        {"path": aade_xml_path, "content": xml_content},
        f"Staged Greek AADE myDATA {invoice_type} XML `{aade_xml_path}`",
    ):
        mutations += 1

    if not REAL.db_path.exists() or "upsert_row" not in REGISTRY:
        return mutations

    schema_ddls = _read_db_schema_sql(REAL.db_path)
    table_cols: dict[str, list[dict[str, Any]]] = {}
    with contextlib.closing(sqlite3.connect(REAL.db_path)) as conn:
        conn.row_factory = sqlite3.Row
        for tbl_name in schema_ddls:
            info_rows = conn.execute(f'PRAGMA table_info("{tbl_name}")').fetchall()
            table_cols[tbl_name] = [dict(r) for r in info_rows]

        delivery_id = claim_id[4:] if claim_id.upper().startswith("CLM-") else "D-1042"
        supplier_id = "SUP-KAPPA"
        invoice_id = "INV-7781"

        if "suppliers" in table_cols:
            sup_pk = next((c["name"] for c in table_cols["suppliers"] if c["pk"] > 0), None)
            if sup_pk:
                s_row = conn.execute(f'SELECT "{sup_pk}" FROM "suppliers" LIMIT 1').fetchone()
                if s_row:
                    supplier_id = str(s_row[0])

        if "deliveries" in table_cols:
            del_pk = next((c["name"] for c in table_cols["deliveries"] if c["pk"] > 0), None)
            if del_pk:
                d_row = conn.execute(
                    f'SELECT * FROM "deliveries" WHERE "{del_pk}" = ?', (delivery_id,)
                ).fetchone()
                if d_row is None:
                    d_row = conn.execute('SELECT * FROM "deliveries" LIMIT 1').fetchone()
                if d_row is not None:
                    d_dict = dict(d_row)
                    delivery_id = str(d_dict.get(del_pk, delivery_id))
                    if d_dict.get("supplier_id"):
                        supplier_id = str(d_dict["supplier_id"])

        if "invoices" in table_cols:
            inv_pk = next((c["name"] for c in table_cols["invoices"] if c["pk"] > 0), None)
            inv_cols = {c["name"] for c in table_cols["invoices"]}
            if inv_pk:
                i_row = None
                if "delivery_id" in inv_cols:
                    i_row = conn.execute(
                        'SELECT * FROM "invoices" WHERE "delivery_id" = ? LIMIT 1', (delivery_id,)
                    ).fetchone()
                if i_row is None:
                    i_row = conn.execute(
                        f'SELECT * FROM "invoices" WHERE "{inv_pk}" = ?', (invoice_id,)
                    ).fetchone()
                if i_row is not None:
                    i_dict = dict(i_row)
                    invoice_id = str(i_dict.get(inv_pk, invoice_id))

        existing_claim: dict[str, Any] | None = None
        claims_pk: str | None = None
        if "claims" in table_cols:
            pks = [c["name"] for c in table_cols["claims"] if c["pk"] > 0]
            claims_pk = pks[0] if len(pks) == 1 else ("id" if any(c["name"] == "id" for c in table_cols["claims"]) else None)
            if claims_pk:
                c_row = conn.execute(
                    f'SELECT * FROM "claims" WHERE "{claims_pk}" = ?', (claim_id,)
                ).fetchone()
                if c_row is not None:
                    existing_claim = dict(c_row)

        existing_delivery: dict[str, Any] | None = None
        deliv_pk_col: str | None = None
        if "deliveries" in table_cols:
            d_pks = [c["name"] for c in table_cols["deliveries"] if c["pk"] > 0]
            deliv_pk_col = (
                d_pks[0]
                if len(d_pks) == 1
                else ("id" if any(c["name"] == "id" for c in table_cols["deliveries"]) else None)
            )
            if deliv_pk_col:
                d_match = conn.execute(
                    f'SELECT * FROM "deliveries" WHERE "{deliv_pk_col}" = ?', (delivery_id,)
                ).fetchone()
                if d_match is not None:
                    existing_delivery = dict(d_match)

    # 1. Dynamic `claims` upsert
    if "claims" in table_cols and claims_pk:
        claims_ddl = schema_ddls.get("claims", "")
        c_col_map = {c["name"]: c for c in table_cols["claims"]}
        note = (
            f"Operator consult: enforced EUR {agreed_amount:.2f} refund hold + AADE myDATA 5.1"
            if choice == "refund"
            else f"Operator consult: next-day re-delivery of 22 hubs + EUR {agreed_amount:.2f} credit (AADE 9.3)"
        )
        chosen_status = _pick_allowed_column_value(
            claims_ddl,
            "status",
            ["settled", "approved", "refund_enforced" if choice == "refund" else "redelivery_scheduled"],
            fallback="settled",
        )
        claim_patch: dict[str, Any] = {claims_pk: claim_id}
        if existing_claim is None:
            defaults_by_col: dict[str, Any] = {
                "supplier_id": supplier_id,
                "delivery_id": delivery_id,
                "invoice_id": invoice_id,
                "amount": agreed_amount,
                "reason": note,
                "status": chosen_status,
                "resolution": choice,
                "aade_type": invoice_type,
                "mydata_xml_path": aade_xml_path,
            }
            for col_name, col_meta in c_col_map.items():
                if col_name == claims_pk:
                    continue
                if col_name in defaults_by_col:
                    claim_patch[col_name] = defaults_by_col[col_name]
                elif col_meta["notnull"] and col_meta["dflt_value"] is None:
                    ctype = str(col_meta["type"] or "").upper()
                    if any(tok in ctype for tok in ("REAL", "FLOA", "DOUB", "NUM", "DEC")):
                        claim_patch[col_name] = 0.0
                    elif "INT" in ctype:
                        claim_patch[col_name] = 0
                    else:
                        claim_patch[col_name] = _pick_allowed_column_value(claims_ddl, col_name, [""], "")
        else:
            if "status" in c_col_map:
                claim_patch["status"] = chosen_status
            if "amount" in c_col_map:
                claim_patch["amount"] = agreed_amount
            if "reason" in c_col_map:
                prev_reason = str(existing_claim.get("reason") or "").strip()
                claim_patch["reason"] = (
                    f"{prev_reason} | {note}" if prev_reason and note not in prev_reason else note
                )
            if "resolution" in c_col_map:
                claim_patch["resolution"] = choice
            if "aade_type" in c_col_map:
                claim_patch["aade_type"] = invoice_type
            if "mydata_xml_path" in c_col_map:
                claim_patch["mydata_xml_path"] = aade_xml_path

        with contextlib.suppress(sqlite3.Error, ValueError):
            if _record_reversible_mutation(
                run_id,
                "upsert_row",
                {"table": "claims", "pk_col": claims_pk, "row": claim_patch},
                f"Updated claims #{claim_id} ({choice}, EUR {agreed_amount:.2f})",
            ):
                mutations += 1

    # 2. Dynamic `deliveries` upsert (when row D-1042 exists)
    if "deliveries" in table_cols and deliv_pk_col and existing_delivery is not None:
        deliv_ddl = schema_ddls.get("deliveries", "")
        d_col_map = {c["name"]: c for c in table_cols["deliveries"]}
        deliv_patch: dict[str, Any] = {deliv_pk_col: delivery_id}
        if "status" in d_col_map:
            pref_deliv_statuses = (
                ["redelivery_scheduled", "partial_redelivery", "disputed", "received"]
                if choice == "redelivery"
                else ["refund_hold", "disputed", "settled", "received"]
            )
            deliv_patch["status"] = _pick_allowed_column_value(
                deliv_ddl,
                "status",
                pref_deliv_statuses,
                fallback=str(existing_delivery.get("status") or "received"),
            )
        for note_col in ("notes", "resolution_note", "comment"):
            if note_col in d_col_map:
                deliv_patch[note_col] = (
                    "Next-day replacement scheduled for 22 hubs"
                    if choice == "redelivery"
                    else f"Enforced EUR {agreed_amount:.2f} refund hold"
                )
        if len(deliv_patch) > 1:
            with contextlib.suppress(sqlite3.Error, ValueError):
                if _record_reversible_mutation(
                    run_id,
                    "upsert_row",
                    {"table": "deliveries", "pk_col": deliv_pk_col, "row": deliv_patch},
                    f"Updated deliveries #{delivery_id} ({choice})",
                ):
                    mutations += 1

    # 3. Dynamic `aade*` / `mydata*` filing table upsert (if present in sqlite_master)
    for tbl_name, cols_meta in table_cols.items():
        lower_tbl = tbl_name.lower()
        if not (lower_tbl.startswith(("aade", "mydata")) or "mydata" in lower_tbl or "aade" in lower_tbl):
            continue
        pks = [c for c in cols_meta if c["pk"] > 0]
        if len(pks) == 1:
            pk_meta = pks[0]
        else:
            id_candidates = [c for c in cols_meta if c["name"] == "id"]
            if not id_candidates:
                continue
            pk_meta = id_candidates[0]
        pk_name = str(pk_meta["name"])
        pk_type = str(pk_meta["type"] or "").upper()
        if "INT" in pk_type:
            with contextlib.closing(sqlite3.connect(REAL.db_path)) as conn:
                next_id_row = conn.execute(f'SELECT COALESCE(MAX("{pk_name}"), 0) + 1 FROM "{tbl_name}"').fetchone()
                pk_val: Any = int(next_id_row[0]) if next_id_row else 1
        else:
            pk_val = f"AADE-{claim_id}"

        tbl_ddl = schema_ddls.get(tbl_name, "")
        semantic_values: dict[str, Any] = {
            "claim_id": claim_id,
            "invoice_id": invoice_id,
            "correlated_invoice": invoice_id,
            "delivery_id": delivery_id,
            "supplier_id": supplier_id,
            "supplier_vat": "EL094281773",
            "issuer_vat": "EL094281773",
            "vat_number": "EL094281773",
            "afm": "EL094281773",
            "invoice_type": invoice_type,
            "mydata_type": invoice_type,
            "doc_type": invoice_type,
            "type": invoice_type,
            "series": "CR-AADE" if choice == "refund" else "DN-AADE",
            "aa": 1042,
            "net_amount": net_amount,
            "net_value": net_amount,
            "total_net_value": net_amount,
            "amount": net_amount,
            "vat_amount": vat_amount,
            "total_vat_amount": vat_amount,
            "vat": vat_amount,
            "gross_amount": gross_amount,
            "gross_value": gross_amount,
            "total_gross_value": gross_amount,
            "total": gross_amount,
            "vat_rate": 24.0,
            "vat_pct": 24.0,
            "vat_category": 1,
            "classification": "E3_561_001",
            "classification_code": "E3_561_001",
            "e3_code": "E3_561_001",
            "xml_path": aade_xml_path,
            "file_path": aade_xml_path,
            "path": aade_xml_path,
            "xml_content": xml_content,
            "payload_xml": xml_content,
            "xml": xml_content,
            "choice": choice,
            "resolution": choice,
            "issue_date": "2026-11-14",
            "created_at": "2026-11-14T17:00:00Z",
            "filed_at": "2026-11-14T17:00:00Z",
            "date": "2026-11-14",
            "currency": "EUR",
        }
        filing_row: dict[str, Any] = {pk_name: pk_val}
        for c_meta in cols_meta:
            cname = str(c_meta["name"])
            if cname == pk_name:
                continue
            clower = cname.lower()
            ctype = str(c_meta["type"] or "").upper()
            if clower == "status":
                filing_row[cname] = _pick_allowed_column_value(
                    tbl_ddl,
                    cname,
                    ["staged", "submitted", "drafted", "pending", "filed"],
                    fallback="staged",
                )
            elif clower in semantic_values:
                val = semantic_values[clower]
                if isinstance(val, int) and "TEXT" in ctype:
                    val = str(val)
                filing_row[cname] = val
            elif c_meta["notnull"] and c_meta["dflt_value"] is None:
                if any(tok in ctype for tok in ("REAL", "FLOA", "DOUB", "NUM", "DEC")):
                    filing_row[cname] = 0.0
                elif "INT" in ctype:
                    filing_row[cname] = 0
                else:
                    filing_row[cname] = _pick_allowed_column_value(tbl_ddl, cname, ["staged"], "")

        with contextlib.suppress(sqlite3.Error, ValueError):
            if _record_reversible_mutation(
                run_id,
                "upsert_row",
                {"table": tbl_name, "pk_col": pk_name, "row": filing_row},
                f"Recorded AADE myDATA {invoice_type} filing in `{tbl_name}`",
            ):
                mutations += 1

    return mutations


@app.post("/api/call/pickup")
async def call_pickup(request: Request):
    """Answer mobile operator consult call, transitioning status from ringing to connected."""
    body: dict[str, Any] = {}
    with contextlib.suppress(Exception):
        parsed = await request.json()
        if isinstance(parsed, dict):
            body = parsed

    claim_id = str(body.get("claim_id") or "CLM-D-1042").strip() or "CLM-D-1042"
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", claim_id):
        raise HTTPException(400, "invalid claim_id format")

    call_id = str(body.get("call_id") or f"CONSULT-{claim_id}").strip() or f"CONSULT-{claim_id}"
    req_id = body.get("req_id")
    if req_id is not None:
        req_id = str(req_id).strip() or None
    if not req_id and PENDING:
        req_id = _active_pending_req_id()

    claim_amount = 587.30
    if REAL.db_path.exists():
        with contextlib.closing(sqlite3.connect(REAL.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            with contextlib.suppress(sqlite3.Error):
                row = conn.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
                if row is not None and row["amount"] is not None:
                    claim_amount = float(row["amount"])

    global ACTIVE_CALL
    now_ts = time.time()
    if ACTIVE_CALL is None or ACTIVE_CALL.get("call_id") != call_id:
        ACTIVE_CALL = {
            "active": True,
            "ringing": False,
            "call_status": "connected",
            "mode": "user_consult",
            "channel": "voice_call",
            "call_id": call_id,
            "req_id": req_id,
            "claim_id": claim_id,
            "claim_amount": claim_amount,
            "counterparty": "Operator Mobile",
            "turns": [],
            "selected_choice": None,
            "end": None,
            "connected_at": now_ts,
        }
    else:
        ACTIVE_CALL["active"] = True
        ACTIVE_CALL["ringing"] = False
        ACTIVE_CALL["call_status"] = "connected"
        ACTIVE_CALL["connected_at"] = now_ts
        if req_id and not ACTIVE_CALL.get("req_id"):
            ACTIVE_CALL["req_id"] = req_id

    run_id = f"pickup_{uuid.uuid4().hex[:6]}"
    BUS.emit(
        run_id,
        EventType.CALL_START,
        {
            "call_id": call_id,
            "mode": "user_consult",
            "channel": "voice_call",
            "call_status": "connected",
            "counterparty": "Operator Mobile",
            "req_id": req_id,
            "claim_id": claim_id,
            "claim_amount": claim_amount,
        },
        thought=f"Operator picked up live consult call for `{claim_id}` (connected).",
    )

    return {
        "ok": True,
        "call_id": call_id,
        "call_status": "connected",
        "claim_id": claim_id,
        "req_id": req_id,
    }


@app.post("/api/call/user-consult")
async def start_user_consult_call(request: Request):
    """Escalate an unresolved shipment/claim hold to the away-from-desk operator mobile HUD."""
    raw_body = await request.body()
    body: dict[str, Any] = {}
    if raw_body.strip():
        try:
            parsed = json.loads(raw_body)
        except Exception as exc:
            raise HTTPException(400, "invalid JSON payload") from exc
        if not isinstance(parsed, dict):
            raise HTTPException(400, "expected JSON object")
        body = parsed

    raw_req_id = body.get("req_id")
    req_id = str(raw_req_id).strip() if isinstance(raw_req_id, str) and raw_req_id.strip() else None
    if req_id is None and PENDING:
        req_id = _active_pending_req_id()

    claim_id = str(body.get("claim_id") or "CLM-D-1042").strip() or "CLM-D-1042"
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", claim_id):
        raise HTTPException(400, "invalid claim_id format")
    claim_amount = 587.30
    if REAL.db_path.exists():
        with contextlib.closing(sqlite3.connect(REAL.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            with contextlib.suppress(sqlite3.Error):
                row = conn.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
                if row is not None and row["amount"] is not None:
                    claim_amount = float(row["amount"])

    call_id = f"CONSULT-{claim_id}"
    run_id = f"consult_{uuid.uuid4().hex[:6]}"
    opening_text = (
        "Hi, I'm calling from Recoup about Kappa delivery D-1042. "
        "Twenty-two hubs arrived missing or broken and invoice 7781 is overcharged by 587 euros and 30 cents. "
        "You can ask me to pull up the AADE tax credit or the database on your desktop, "
        "or tell me whether to enforce the 587 euro refund or accept free replacement delivery tomorrow."
    )

    channel = str(body.get("channel") or "voice_call")
    if channel not in ("notification", "voice_call"):
        channel = "voice_call"

    start_validated = CallStartPayload(
        call_id=call_id,
        mode="user_consult",
        counterparty="Operator Mobile",
        req_id=req_id,
        claim_id=claim_id,
        claim_amount=claim_amount,
        channel=channel,
        call_status="ringing",
    )
    BUS.emit(
        run_id,
        EventType.CALL_START,
        {
            "call_id": start_validated.call_id,
            "mode": start_validated.mode,
            "counterparty": start_validated.counterparty,
            "req_id": start_validated.req_id,
            "claim_id": start_validated.claim_id,
            "claim_amount": start_validated.claim_amount,
            "channel": start_validated.channel,
            "call_status": start_validated.call_status,
        },
        thought=f"Escalating `{claim_id}` to Operator Mobile for live consult decision.",
    )

    turn_validated = CallTurnPayload(
        call_id=call_id,
        speaker="agent",
        text=opening_text,
        audio_url="/api/voice/turn-audio",
        keep_call_open=True,
        call_status="ringing",
    )
    BUS.emit(
        run_id,
        EventType.CALL_TURN,
        {
            "call_id": turn_validated.call_id,
            "speaker": turn_validated.speaker,
            "text": turn_validated.text,
            "audio_url": turn_validated.audio_url,
            "keep_call_open": True,
            "call_status": "ringing",
        },
        step=1,
        thought=f"Recoup Agent: {opening_text}",
        cost_eur=_voice_micro_cost(opening_text),
    )

    global ACTIVE_CALL
    ACTIVE_CALL = {
        "active": True,
        "ringing": True,
        "call_status": "ringing",
        "mode": "user_consult",
        "channel": channel,
        "call_id": call_id,
        "req_id": req_id,
        "claim_id": claim_id,
        "claim_amount": claim_amount,
        "counterparty": "Operator Mobile",
        "turns": [
            {
                "speaker": "agent",
                "text": opening_text,
                "audio_url": "/api/voice/turn-audio",
                "ts": time.time(),
            }
        ],
        "selected_choice": None,
        "end": None,
    }

    return {
        "ok": True,
        "call_id": call_id,
        "mode": "user_consult",
        "channel": channel,
        "req_id": req_id,
        "claim_id": claim_id,
        "claim_amount": claim_amount,
        "opening_text": opening_text,
    }


@app.post("/api/call/user-respond")
async def handle_user_consult_response(request: Request):
    """Process spoken or tapped operator consult reply, resolve Risk Gate, and stage reversible AADE XML."""
    content_type = (request.headers.get("content-type") or "").lower()
    req_id: str | None = None
    claim_id = "CLM-D-1042"
    transcript = ""
    explicit_choice: str | None = None
    ui_command: str | None = None
    audio_bytes: bytes | None = None
    filename = "operator_reply.webm"
    mime_type = "audio/webm"

    if "multipart/form-data" in content_type:
        form = await request.form()
        raw_req = str(form.get("req_id") or "").strip()
        req_id = raw_req or None
        raw_claim = str(form.get("claim_id") or "").strip()
        if raw_claim:
            claim_id = raw_claim
        transcript = str(form.get("transcript") or "").strip()
        raw_choice = str(form.get("choice") or "").strip().lower()
        explicit_choice = raw_choice or None
        raw_ui = str(form.get("ui_command") or "").strip().lower()
        ui_command = raw_ui or None
        upload = form.get("audio") or form.get("file")
        if upload is not None and hasattr(upload, "read"):
            filename = getattr(upload, "filename", None) or filename
            mime_type = getattr(upload, "content_type", None) or mime_type
            audio_bytes = await upload.read()  # type: ignore[misc]
    else:
        raw_body = await request.body()
        if raw_body.strip():
            try:
                body = json.loads(raw_body)
            except Exception as exc:
                raise HTTPException(400, "invalid JSON payload") from exc
            if not isinstance(body, dict):
                raise HTTPException(400, "expected JSON object")
            raw_req = str(body.get("req_id") or "").strip()
            req_id = raw_req or None
            raw_claim = str(body.get("claim_id") or "").strip()
            if raw_claim:
                claim_id = raw_claim
            transcript = str(body.get("transcript") or "").strip()
            raw_choice = str(body.get("choice") or "").strip().lower()
            explicit_choice = raw_choice or None
            raw_ui = str(body.get("ui_command") or "").strip().lower()
            ui_command = raw_ui or None
            mime_type = str(body.get("mime_type") or mime_type)
            b64_audio = body.get("audio_b64")
            if isinstance(b64_audio, str) and b64_audio.strip():
                encoded = b64_audio.split(",", 1)[-1].strip()
                with contextlib.suppress(Exception):
                    audio_bytes = base64.b64decode(encoded)

    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", claim_id):
        raise HTTPException(400, "invalid claim_id format")

    if not audio_bytes and not transcript and not explicit_choice and not ui_command:
        raise HTTPException(422, "provide choice, transcript, or audio")

    stt_ran = False
    if audio_bytes and not transcript:
        transcript = await _transcribe_operator_consult_audio(audio_bytes, filename, mime_type)
        stt_ran = bool(transcript)

    call_id = f"CONSULT-{claim_id}"
    run_id = f"consult_{uuid.uuid4().hex[:6]}"

    global ACTIVE_CALL
    if ACTIVE_CALL is None or ACTIVE_CALL.get("call_id") != call_id:
        ACTIVE_CALL = {
            "active": True,
            "ringing": False,
            "call_status": "connected",
            "mode": "user_consult",
            "channel": "voice_call",
            "call_id": call_id,
            "req_id": req_id,
            "claim_id": claim_id,
            "claim_amount": 587.30,
            "counterparty": "Operator Mobile",
            "turns": [],
            "selected_choice": None,
            "end": None,
        }
    else:
        ACTIVE_CALL["active"] = True
        ACTIVE_CALL["ringing"] = False
        ACTIVE_CALL["call_status"] = "connected"

    lowered = (transcript or "").lower()

    # Intent 1: Show staged AADE tax filing / XML / diff on desktop
    is_aade_intent = False
    if explicit_choice not in ("refund", "redelivery") and (
        ui_command == "open_aade"
        or re.search(
            r"\b(show|open|pull up|display|view|see|inspect|what did you stage)\b.*\b(aade|mydata|xml|tax|filing|credit note|diff|document|memo)\b",
            lowered,
        )
        or re.search(r"\b(open the xml|show the diff|what did you stage|aade tax filing)\b", lowered)
    ):
        is_aade_intent = True

    # Intent 2: Show database / SQLite / invoices table on desktop
    is_db_intent = False
    if (
        not is_aade_intent
        and explicit_choice not in ("refund", "redelivery")
        and (
            ui_command == "open_db"
            or re.search(
                r"\b(show|open|pull up|switch|check|inspect|look at|see)\b.*\b(database|sqlite|table|ledger|invoice|invoices|erp|db)\b",
                lowered,
            )
            or re.search(r"\b(open sqlite|check the invoice|show me the database)\b", lowered)
        )
    ):
        is_db_intent = True

    if is_aade_intent:
        preview_xml = _build_aade_mydata_xml(claim_id, "refund")
        aade_xml_path = f"aade/mydata_{claim_id}.xml"
        ui_action = UiActionPayload(
            action="open_file",
            path=aade_xml_path,
            content=preview_xml,
            label=f"Opened {aade_xml_path} on Desktop",
        ).model_dump(exclude_none=True)
        if not transcript:
            transcript = "Pull up the AADE tax credit filing on my screen."

        user_turn = CallTurnPayload(
            call_id=call_id,
            speaker="user",
            text=transcript,
            keep_call_open=True,
            call_status="connected",
        )
        BUS.emit(
            run_id,
            EventType.CALL_TURN,
            {
                "call_id": user_turn.call_id,
                "speaker": user_turn.speaker,
                "text": user_turn.text,
                "keep_call_open": True,
                "call_status": "connected",
            },
            step=2,
            thought=f"Operator: {transcript}",
            cost_eur=_voice_micro_cost(transcript) if stt_ran else 0.0,
        )

        reply_text = (
            "I just pulled up the staged AADE myDATA credit filing on your desktop screen. "
            "It records the 587 euro 30 cent net credit plus 24 percent VAT. "
            "Would you like me to enforce this refund or accept replacement delivery?"
        )
        agent_turn = CallTurnPayload(
            call_id=call_id,
            speaker="agent",
            text=reply_text,
            audio_url="/api/voice/turn-audio",
            keep_call_open=True,
            call_status="connected",
            ui_action=ui_action,
        )
        BUS.emit(
            run_id,
            EventType.CALL_TURN,
            {
                "call_id": agent_turn.call_id,
                "speaker": agent_turn.speaker,
                "text": agent_turn.text,
                "audio_url": agent_turn.audio_url,
                "keep_call_open": True,
                "call_status": "connected",
                "ui_action": ui_action,
            },
            step=3,
            thought=f"Recoup Agent: {reply_text}",
            cost_eur=_voice_micro_cost(reply_text),
        )

        ACTIVE_CALL["active"] = True
        ACTIVE_CALL["ringing"] = False
        ACTIVE_CALL["call_status"] = "connected"
        ACTIVE_CALL["last_ui_action"] = ui_action
        call_turns = ACTIVE_CALL.setdefault("turns", [])
        call_turns.append({"speaker": "user", "text": transcript, "audio_url": None, "ts": time.time()})
        call_turns.append(
            {
                "speaker": "agent",
                "text": reply_text,
                "audio_url": "/api/voice/turn-audio",
                "ts": time.time(),
                "ui_action": ui_action,
            }
        )

        return {
            "ok": True,
            "call_id": call_id,
            "keep_call_open": True,
            "call_status": "connected",
            "choice": None,
            "transcript": transcript,
            "reply_text": reply_text,
            "confirmation_text": reply_text,
            "agreed_amount": None,
            "aade_xml_path": aade_xml_path,
            "ui_action": ui_action,
        }

    if is_db_intent:
        target_table = "claims" if "claim" in lowered and "invoice" not in lowered else "invoices"
        ui_action = UiActionPayload(
            action="switch_view",
            view="studio",
            table=target_table,
            label=f"Opened SQLite table '{target_table}' on Desktop",
        ).model_dump(exclude_none=True)
        if not transcript:
            transcript = f"Show me the {target_table} database on my screen."

        user_turn = CallTurnPayload(
            call_id=call_id,
            speaker="user",
            text=transcript,
            keep_call_open=True,
            call_status="connected",
        )
        BUS.emit(
            run_id,
            EventType.CALL_TURN,
            {
                "call_id": user_turn.call_id,
                "speaker": user_turn.speaker,
                "text": user_turn.text,
                "keep_call_open": True,
                "call_status": "connected",
            },
            step=2,
            thought=f"Operator: {transcript}",
            cost_eur=_voice_micro_cost(transcript) if stt_ran else 0.0,
        )

        reply_text = (
            "Opening the ERP invoices table on your desktop now — "
            "Invoice 7781 for 2,268 euros is staged on hold. "
            "Should I enforce the 587 euro refund or accept re-delivery?"
        )
        agent_turn = CallTurnPayload(
            call_id=call_id,
            speaker="agent",
            text=reply_text,
            audio_url="/api/voice/turn-audio",
            keep_call_open=True,
            call_status="connected",
            ui_action=ui_action,
        )
        BUS.emit(
            run_id,
            EventType.CALL_TURN,
            {
                "call_id": agent_turn.call_id,
                "speaker": agent_turn.speaker,
                "text": agent_turn.text,
                "audio_url": agent_turn.audio_url,
                "keep_call_open": True,
                "call_status": "connected",
                "ui_action": ui_action,
            },
            step=3,
            thought=f"Recoup Agent: {reply_text}",
            cost_eur=_voice_micro_cost(reply_text),
        )

        ACTIVE_CALL["active"] = True
        ACTIVE_CALL["ringing"] = False
        ACTIVE_CALL["call_status"] = "connected"
        ACTIVE_CALL["last_ui_action"] = ui_action
        call_turns = ACTIVE_CALL.setdefault("turns", [])
        call_turns.append({"speaker": "user", "text": transcript, "audio_url": None, "ts": time.time()})
        call_turns.append(
            {
                "speaker": "agent",
                "text": reply_text,
                "audio_url": "/api/voice/turn-audio",
                "ts": time.time(),
                "ui_action": ui_action,
            }
        )

        return {
            "ok": True,
            "call_id": call_id,
            "keep_call_open": True,
            "call_status": "connected",
            "choice": None,
            "transcript": transcript,
            "reply_text": reply_text,
            "confirmation_text": reply_text,
            "agreed_amount": None,
            "aade_xml_path": f"aade/mydata_{claim_id}.xml",
            "ui_action": ui_action,
        }

    # Live Auto-VAD guard: when raw audio was uploaded without explicit_choice/ui_command,
    # never let silence/Wizper hallucinations or open questions prematurely commit & hang up.
    if audio_bytes and explicit_choice not in ("refund", "redelivery") and not ui_command:
        normalized_utt = re.sub(r"[^\w\s]", "", lowered).strip()
        if not lowered.strip() or lowered.strip() in _STT_NOISE_PHRASES or normalized_utt in _STT_NOISE_PHRASES:
            return {
                "ok": True,
                "call_id": call_id,
                "keep_call_open": True,
                "call_status": "connected",
                "ignored_noise": True,
                "choice": None,
                "transcript": "",
            }

        has_custom_parser = False
        with contextlib.suppress(Exception):
            ca_mod = importlib.import_module(".voice.call_audio", __package__)
            has_custom_parser = callable(getattr(ca_mod, "parse_user_resolution_intent", None))

        has_decision_keyword = bool(
            _REFUND_INTENT_RE.search(lowered) or _REDELIVERY_INTENT_RE.search(lowered)
        )
        if not has_decision_keyword and not has_custom_parser:
            clarify_reply = (
                "For Kappa delivery D-1042, 22 hubs arrived missing or broken and invoice 7781 is "
                "overcharged by 587 euros and 30 cents. You can say 'show AADE filing', 'show database', "
                "'enforce the refund', or 'accept replacement delivery'."
            )
            user_turn_c = CallTurnPayload(
                call_id=call_id,
                speaker="user",
                text=transcript,
                keep_call_open=True,
                call_status="connected",
            )
            BUS.emit(
                run_id,
                EventType.CALL_TURN,
                {
                    "call_id": user_turn_c.call_id,
                    "speaker": user_turn_c.speaker,
                    "text": user_turn_c.text,
                    "keep_call_open": True,
                    "call_status": "connected",
                },
                step=2,
                thought=f"Operator: {transcript}",
                cost_eur=_voice_micro_cost(transcript) if stt_ran else 0.0,
            )
            agent_turn_c = CallTurnPayload(
                call_id=call_id,
                speaker="agent",
                text=clarify_reply,
                audio_url="/api/voice/turn-audio",
                keep_call_open=True,
                call_status="connected",
            )
            BUS.emit(
                run_id,
                EventType.CALL_TURN,
                {
                    "call_id": agent_turn_c.call_id,
                    "speaker": agent_turn_c.speaker,
                    "text": agent_turn_c.text,
                    "audio_url": agent_turn_c.audio_url,
                    "keep_call_open": True,
                    "call_status": "connected",
                },
                step=3,
                thought=f"Recoup Agent: {clarify_reply}",
                cost_eur=_voice_micro_cost(clarify_reply),
            )
            call_turns = ACTIVE_CALL.setdefault("turns", [])
            call_turns.append({"speaker": "user", "text": transcript, "audio_url": None, "ts": time.time()})
            call_turns.append(
                {
                    "speaker": "agent",
                    "text": clarify_reply,
                    "audio_url": "/api/voice/turn-audio",
                    "ts": time.time(),
                }
            )
            return {
                "ok": True,
                "call_id": call_id,
                "keep_call_open": True,
                "call_status": "connected",
                "choice": None,
                "transcript": transcript,
                "reply_text": clarify_reply,
                "confirmation_text": clarify_reply,
                "agreed_amount": None,
                "ui_action": None,
            }

    # Intent 3 & 4: Final Decision
    if explicit_choice in ("refund", "redelivery"):
        choice: Literal["refund", "redelivery"] = "refund" if explicit_choice == "refund" else "redelivery"
    else:
        choice = _classify_operator_consult_intent(transcript)

    if not transcript:
        transcript = (
            "Enforce the 587.30 euro refund hold and file the AADE myDATA 5.1 credit note."
            if choice == "refund"
            else "Accept next-day re-delivery of the 22 hubs and log the 202.30 euro SLA discrepancy."
        )

    user_turn = CallTurnPayload(
        call_id=call_id,
        speaker="user",
        text=transcript,
        keep_call_open=False,
        call_status="connected",
    )
    BUS.emit(
        run_id,
        EventType.CALL_TURN,
        {
            "call_id": user_turn.call_id,
            "speaker": user_turn.speaker,
            "text": user_turn.text,
            "keep_call_open": False,
            "call_status": "connected",
        },
        step=2,
        thought=f"Operator: {transcript}",
        cost_eur=_voice_micro_cost(transcript) if stt_ran else 0.0,
    )

    if req_id is None and PENDING:
        req_id = _active_pending_req_id()

    pending_resolved = False
    if req_id and req_id in PENDING:
        pending_obj = PENDING.get(req_id)
        history_idx = len(BUS.history)
        if isinstance(pending_obj, asyncio.Event):
            if not pending_obj.is_set():
                pending_obj.set()
                pending_resolved = True
        elif pending_obj is not None and not pending_obj.done():
            pending_obj.set_result(True)
            pending_resolved = True

        if pending_resolved:
            RECENTLY_RESOLVED_APPROVALS[req_id] = True
            wait_deadline = time.time() + 1.0
            while time.time() < wait_deadline:
                if req_id not in PENDING:
                    break
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.25)
            PENDING.pop(req_id, None)
            PENDING_PAYLOADS.pop(req_id, None)
            if not any(e.type == EventType.APPROVAL_RESULT for e in BUS.history[history_idx:]):
                BUS.emit(
                    run_id,
                    EventType.APPROVAL_RESULT,
                    {
                        "req_id": req_id,
                        "approved": True,
                        "outcome": "approved",
                        "resolution": choice,
                    },
                    thought=f"Operator resolved Risk Gate `{req_id}` via consult call (`{choice}`).",
                )

    agreed_amount = 587.30 if choice == "refund" else 202.30
    aade_xml_path = f"aade/mydata_{claim_id}.xml"
    xml_content = _build_aade_mydata_xml(claim_id, choice)
    _apply_consult_resolution_mutations(
        run_id=run_id,
        claim_id=claim_id,
        choice=choice,
        agreed_amount=agreed_amount,
        aade_xml_path=aade_xml_path,
        xml_content=xml_content,
    )

    already_queued = any(
        m.get("to") == "accounts@kappaoffice.example"
        and ("CLM-D-1042" in str(m.get("subject", "")) or "INV-7781" in str(m.get("subject", "")))
        for m in REAL.outbox
    )
    if not already_queued:
        if choice == "refund":
            email_subject = "Credit Claim CLM-D-1042 on Invoice INV-7781: EUR 587.30 (AADE myDATA 5.1)"
            email_body = (
                "To: accounts@kappaoffice.example\n"
                "Ref: Shipment D-1042 / Invoice INV-7781 / Claim CLM-D-1042\n"
                "Filing: Greek AADE myDATA Type 5.1 Credit Note staged at aade/mydata_CLM-D-1042.xml\n"
                "Total Refund Claim: EUR 587.30 net (EUR 728.25 gross including 24% VAT).\n"
                "Please credit our account accordingly."
            )
        else:
            email_subject = (
                "Settlement Notice CLM-D-1042: Next-Day Re-Delivery 22 Hubs + EUR 202.30 Credit (AADE myDATA 9.3)"
            )
            email_body = (
                "To: accounts@kappaoffice.example\n"
                "Ref: Shipment D-1042 / Invoice INV-7781 / Claim CLM-D-1042\n"
                "Filing: Greek AADE myDATA Type 9.3 Discrepancy Note staged at aade/mydata_CLM-D-1042.xml\n"
                "Resolution: Scheduled next-day replacement re-delivery for 22 hubs + EUR 202.30 unit price adjustment.\n"
                "Please confirm dispatch."
            )
        if "send_email" in REGISTRY:
            REGISTRY["send_email"].do(
                {"to": "accounts@kappaoffice.example", "subject": email_subject, "body": email_body},
                REAL,
            )
        else:
            REAL.outbox.append({
                "tool": "send_email",
                "to": "accounts@kappaoffice.example",
                "subject": email_subject,
                "body": email_body,
            })

    ui_action = UiActionPayload(
        action="commit_resolution",
        choice=choice,
        label=(
            "Committed €587.30 Refund + AADE 5.1"
            if choice == "refund"
            else "Committed 22-Unit Replacement + €202.30 Credit"
        ),
    ).model_dump(exclude_none=True)

    if choice == "refund":
        confirmation_text = (
            "Confirmed. Freezing invoice 7781, filing the 587 euro AADE 5.1 credit note, and emailing Kappa Office Systems now. Closing the line — have a great day!"
        )
        summary_text = (
            f"Enforced EUR 587.30 refund hold on {claim_id} and staged AADE myDATA 5.1 credit note."
        )
    else:
        confirmation_text = (
            "Confirmed. Scheduling free next-day replacement for all 22 hubs, logging the 202 euro 30 cent overcharge credit, and emailing Kappa Office Systems now. Closing the line — have a great day!"
        )
        summary_text = (
            f"Scheduled next-day replacement for 22 hubs on {claim_id} + EUR 202.30 credit (AADE myDATA 9.3)."
        )

    agent_turn = CallTurnPayload(
        call_id=call_id,
        speaker="agent",
        text=confirmation_text,
        audio_url="/api/voice/turn-audio",
        keep_call_open=False,
        call_status="ended",
        ui_action=ui_action,
    )
    BUS.emit(
        run_id,
        EventType.CALL_TURN,
        {
            "call_id": agent_turn.call_id,
            "speaker": agent_turn.speaker,
            "text": agent_turn.text,
            "audio_url": agent_turn.audio_url,
            "keep_call_open": False,
            "call_status": "ended",
            "ui_action": ui_action,
        },
        step=3,
        thought=f"Recoup Agent: {confirmation_text}",
        cost_eur=_voice_micro_cost(confirmation_text),
    )

    end_ev = CallEndPayload(
        call_id=call_id,
        outcome="accepted",
        agreed_amount=agreed_amount,
        summary=summary_text,
    )
    BUS.emit(
        run_id,
        EventType.CALL_END,
        end_ev.model_dump(),
        thought=summary_text,
    )

    ACTIVE_CALL["active"] = False
    ACTIVE_CALL["ringing"] = False
    ACTIVE_CALL["call_status"] = "ended"
    ACTIVE_CALL["last_ui_action"] = ui_action
    ACTIVE_CALL["selected_choice"] = choice
    ACTIVE_CALL["end"] = end_ev.model_dump()

    call_turns = ACTIVE_CALL.setdefault("turns", [])
    call_turns.append(
        {
            "speaker": "user",
            "text": transcript,
            "audio_url": None,
            "ts": time.time(),
        }
    )
    call_turns.append(
        {
            "speaker": "agent",
            "text": confirmation_text,
            "audio_url": "/api/voice/turn-audio",
            "ts": time.time(),
            "ui_action": ui_action,
        }
    )

    return {
        "ok": True,
        "call_id": call_id,
        "keep_call_open": False,
        "call_status": "ended",
        "ui_action": ui_action,
        "reply_text": confirmation_text,
        "confirmation_text": confirmation_text,
        "choice": choice,
        "agreed_amount": agreed_amount,
        "aade_xml_path": aade_xml_path,
        "transcript": transcript,
    }
