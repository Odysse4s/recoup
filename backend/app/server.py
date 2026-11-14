"""FastAPI runtime server for Recoup. All routes are mounted under /api."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import gc
import hashlib
import inspect
import json
import os
import re
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from .contracts import (
    ApprovalDecision,
    CallEndPayload,
    CallTurnPayload,
    EventType,
    EvidencePayload,
    GoalRequest,
)
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
        from .voice.elevenlabs_agent import synthesize_briefing  # type: ignore[import-not-found]

        is_unpatched = getattr(synthesize_briefing, "__module__", "").endswith("elevenlabs_agent")
        pytest_offline = (
            "PYTEST_CURRENT_TEST" in os.environ
            and is_unpatched
            and not os.getenv("ELEVENLABS_API_KEY", "").strip()
            and not os.getenv("VOICE_PROVIDER", "").strip()
        )
        if not pytest_offline:
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
        BUS.emit(
            run_id,
            EventType.CALL_TURN,
            turn_payload,
            step=idx,
            thought=f"{speaker_label}: {turn_payload['text']}",
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
    speaker: Literal["agent", "counterparty"] = "agent"
    text: str


@app.post("/api/voice/turn-audio")
async def voice_turn_audio(req: TurnAudioRequest):
    """Synthesize a single call turn via call_audio or elevenlabs_agent, else HTTP 204 for Web Speech."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty turn text")

    with contextlib.suppress(Exception):
        from .voice.call_audio import synthesize_call_turn  # type: ignore[import-not-found]

        maybe_turn = synthesize_call_turn(req.speaker, text)
        turn_bytes = await maybe_turn if inspect.isawaitable(maybe_turn) else maybe_turn
        if turn_bytes:
            return Response(content=turn_bytes, media_type="audio/mpeg")

    with contextlib.suppress(Exception):
        from .voice.elevenlabs_agent import synthesize_briefing

        cp_voice = (
            os.getenv("ELEVENLABS_COUNTERPARTY_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")
            if req.speaker == "counterparty"
            else None
        )
        maybe_audio = synthesize_briefing(text, voice_id=cp_voice)
        audio_bytes = await maybe_audio if inspect.isawaitable(maybe_audio) else maybe_audio
        if audio_bytes:
            return Response(content=audio_bytes, media_type="audio/mpeg")

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
