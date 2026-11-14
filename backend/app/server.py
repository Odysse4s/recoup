"""FastAPI runtime server for Recoup. All routes are mounted under /api."""
from __future__ import annotations

import asyncio
import contextlib
import gc
import hashlib
import json
import os
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from .contracts import ApprovalDecision, EventType, GoalRequest
from .domain_config import brand, get_domain
from .engine.env import Env, fingerprint_env, is_db_file
from .engine.events import BUS
from .engine.orchestrator import (
    PENDING,
    PENDING_OFFERS,
    PENDING_PAYLOADS,
    StaleRehearsalError,
    rehearse,
    replay,
    speculate_next_offer,
)
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
SHUTDOWN_EVENT: asyncio.Event | None = None


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


@app.get("/api/state")
def state():
    """Complete live workspace and safety runtime state for HUD initialization and live inspection."""
    forged = [
        {"name": t.name, "description": t.description, "uses": t.uses}
        for t in REGISTRY.values()
        if t.source == "forged"
    ]
    total_cost = round(sum(e.cost_eur for e in BUS.history), 5)
    total_steps = sum(1 for e in BUS.history if e.type == EventType.TOOL_CALL)
    domain = get_domain()
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
        "pending_approvals": list(PENDING_PAYLOADS.values()),
        "pending_offers": [
            {
                "offer_id": o.offer_id,
                "prediction": o.prediction.model_dump(),
                "report": o.report.model_dump(),
                "mutations_count": len(o.commit_plan),
            }
            for o in PENDING_OFFERS.values()
        ],
        "metrics": {
            "steps": total_steps,
            "cost_eur": total_cost,
            "forged_count": len(forged),
            "unapproved_high_risk": len(PENDING_PAYLOADS),
        },
    }


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
    if ANTICIPATE_TASK and not ANTICIPATE_TASK.done():
        ANTICIPATE_TASK.cancel()
    run_id = uuid.uuid4().hex[:8]
    asyncio.create_task(_run(req.goal, run_id, req.anticipate_after))
    return {"run_id": run_id}


@app.post("/api/approve/{req_id}")
async def approve(req_id: str, d: ApprovalDecision):
    fut = PENDING.get(req_id)
    if not fut or fut.done():
        raise HTTPException(404, "no pending approval")
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
        "steps_undone": steps,
        "remaining": len(LOG.entries),
        "irreversible_skipped": skipped,
        "fingerprint": fingerprint_env(REAL)[:12],
    }


@app.post("/api/reset")
async def reset():
    """Restore workspace to deterministic Recoup baseline seed."""
    if ANTICIPATE_TASK and not ANTICIPATE_TASK.done():
        ANTICIPATE_TASK.cancel()
    for fut in list(PENDING.values()):
        if not fut.done():
            fut.cancel()
    PENDING.clear()
    PENDING_PAYLOADS.clear()
    PENDING_OFFERS.clear()
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
    """Synthesize spoken executive briefing via voice module or ElevenLabs, with 204 Web Speech fallback."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty briefing text")

    with contextlib.suppress(Exception):
        import inspect

        from .voice.elevenlabs_agent import synthesize_briefing  # type: ignore[import-not-found]

        maybe_audio = synthesize_briefing(text)
        audio_bytes = await maybe_audio if inspect.isawaitable(maybe_audio) else maybe_audio
        if audio_bytes:
            return Response(content=audio_bytes, media_type="audio/mpeg")

    voice_id = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5")
    cache_key = hashlib.sha256(f"{voice_id}:{model_id}:{text}".encode()).hexdigest()
    VOICE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = VOICE_CACHE_DIR / f"{cache_key}.mp3"

    if cache_file.exists():
        return Response(content=cache_file.read_bytes(), media_type="audio/mpeg")

    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        return Response(status_code=204)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"}
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {"stability": 0.48, "similarity_boost": 0.78},
    }
    with contextlib.suppress(Exception):
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 200 and resp.content:
                cache_file.write_bytes(resp.content)
                return Response(content=resp.content, media_type="audio/mpeg")
    return Response(status_code=204)
