"""Staged rehearsal -> change report -> deterministic risk gate -> atomic replay -> undo -> anticipate."""
from __future__ import annotations

import asyncio
import contextlib
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..contracts import (
    AnticipateOfferPayload,
    AnticipatePrediction,
    ChangeReport,
    EventType,
    FileDiffItem,
    RiskDecision,
    ToolCall,
    ToolResult,
)
from .env import Env, diff_databases, fingerprint_env, is_db_file, make_rehearsal_env
from .events import BUS
from .risk import assess_risk
from .tools import REGISTRY, unified_diff
from .undo import UndoLog

PENDING: dict[str, asyncio.Future[bool]] = {}
PENDING_PAYLOADS: dict[str, dict[str, Any]] = {}


@dataclass
class PreparedOffer:
    offer_id: str
    prediction: AnticipatePrediction
    commit_plan: list[ToolCall]
    report: ChangeReport
    fp: str
    previews: dict[str, str]


PENDING_OFFERS: dict[str, PreparedOffer] = {}
FORGED_DIR = Path("forged_tools")

# Lazy agent entrypoints (populated on demand from app.agent.*, or overridden in unit tests).
run_agent_loop: Any = None
predict_next_need: Any = None


class StaleRehearsalError(RuntimeError):
    pass


def build_report(
    real: Env, staged: Env, commit_plan: list[ToolCall], previews: dict[str, str]
) -> ChangeReport:
    db_summary, db_max_deleted = diff_databases(real.db_path, staged.db_path)
    r = ChangeReport(
        external_outbox=list(staged.outbox),
        db_summary=db_summary,
        db_max_deleted=db_max_deleted,
    )
    real_files = (
        {
            p.relative_to(real.root_dir).as_posix(): p
            for p in real.root_dir.rglob("*")
            if p.is_file() and not is_db_file(p, real.db_path)
        }
        if real.root_dir.exists()
        else {}
    )
    staged_files = (
        {
            p.relative_to(staged.root_dir).as_posix(): p
            for p in staged.root_dir.rglob("*")
            if p.is_file() and not is_db_file(p, staged.db_path)
        }
        if staged.root_dir.exists()
        else {}
    )
    for rel in sorted(set(staged_files) - set(real_files)):
        r.files_created.append(rel)
        new_txt = staged_files[rel].read_text(encoding="utf-8", errors="replace")
        r.files_modified.append(FileDiffItem(path=rel, diff=unified_diff("", new_txt, rel)))
    for rel in sorted(set(real_files) - set(staged_files)):
        r.files_deleted.append(rel)
    for rel in sorted(set(real_files) & set(staged_files)):
        old_txt = real_files[rel].read_text(encoding="utf-8", errors="replace")
        new_txt = staged_files[rel].read_text(encoding="utf-8", errors="replace")
        if old_txt != new_txt:
            r.files_modified.append(FileDiffItem(path=rel, diff=unified_diff(old_txt, new_txt, rel)))
    return r


async def rehearse(goal: str, real: Env, run_id: str, emit_events: bool = True):
    loop_fn = run_agent_loop
    if loop_fn is None:
        from ..agent.loop import run_agent_loop as loop_fn  # type: ignore[import-not-found]

    if emit_events:
        BUS.emit(
            run_id,
            EventType.REHEARSE_START,
            {"goal": goal},
            thought="Cloning workspace & SQLite online backup into an isolated rehearsal copy.",
        )
    fp = fingerprint_env(real)
    staged = make_rehearsal_env(real)
    previews: dict[str, str] = {}
    step_counter = 0

    def emit_fn(
        type_: EventType, payload: dict[str, Any], thought: str | None = None, cost: float = 0.0
    ) -> None:
        if emit_events:
            BUS.emit(run_id, type_, payload, step=step_counter, thought=thought, cost_eur=cost)

    async def execute(call: ToolCall) -> ToolResult:
        nonlocal step_counter
        step_counter += 1
        t0 = time.perf_counter()
        tool = REGISTRY.get(call.name)
        if not tool:
            if emit_events:
                BUS.emit(
                    run_id,
                    EventType.TOOL_ERROR,
                    {"call": call.model_dump(), "error": "unknown tool"},
                    step=step_counter,
                    thought=f"Tool `{call.name}` not found in registry.",
                )
            return ToolResult(call_id=call.id, ok=False, error=f"unknown tool {call.name}")
        if emit_events:
            BUS.emit(
                run_id,
                EventType.TOOL_CALL,
                {"call": call.model_dump()},
                step=step_counter,
                thought=call.thought or f"Executing `{call.name}` inside isolated rehearsal environment.",
                cost_eur=call.cost_eur,
            )
        try:
            previews[call.id] = tool.preview(call.args, staged)
            out = tool.do(call.args, staged)
            ms = int((time.perf_counter() - t0) * 1000)
            if emit_events:
                BUS.emit(
                    run_id,
                    EventType.TOOL_DONE,
                    {"call": call.model_dump(), "output": out, "preview": previews[call.id]},
                    step=step_counter,
                    latency_ms=ms,
                )
            return ToolResult(call_id=call.id, ok=True, output=out)
        except Exception as e:  # noqa: BLE001 — errors are surfaced back to the agent loop
            if emit_events:
                BUS.emit(
                    run_id,
                    EventType.TOOL_ERROR,
                    {"call": call.model_dump(), "error": str(e)},
                    step=step_counter,
                )
            return ToolResult(call_id=call.id, ok=False, error=str(e))

    try:
        trace = await loop_fn(
            goal,
            execute,
            emit=emit_fn if emit_events else None,
            shadow_env=staged,
            forged_dir=FORGED_DIR,
        )
        commit_plan: list[ToolCall] = []
        seen_forged: set[str] = set()
        for c in trace:
            t = REGISTRY[c.name]
            if t.mutating:
                commit_plan.append(c)
            elif t.source == "forged" and t.uses == 0 and c.name not in seen_forged:
                seen_forged.add(c.name)
                commit_plan.append(c)
        report = build_report(real, staged, commit_plan, previews)
    finally:
        staged.cleanup()

    if emit_events:
        BUS.emit(
            run_id,
            EventType.REHEARSE_REPORT,
            {"report": report.model_dump(), "mutations": len(commit_plan)},
            thought=f"Rehearsal complete: {len(commit_plan)} staged action(s) ready for Risk Gate review.",
        )
    return commit_plan, report, fp, previews


async def ask_human(run_id: str, payload: dict[str, Any], timeout: float | None = None) -> str:
    wait_s = timeout if timeout is not None else float(os.getenv("APPROVAL_TIMEOUT_S", "300"))
    req_id = payload["req_id"]
    fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
    PENDING[req_id] = fut
    PENDING_PAYLOADS[req_id] = payload
    BUS.emit(
        run_id,
        EventType.APPROVAL_NEEDED,
        payload,
        thought=f"Risk Gate paused `{payload['tool_name']}` ({payload['risk_reason']}) — awaiting manager sign-off.",
    )
    try:
        approved = await asyncio.wait_for(fut, wait_s)
        return "approved" if approved else "rejected"
    except TimeoutError:
        return "timed_out"
    finally:
        PENDING.pop(req_id, None)
        PENDING_PAYLOADS.pop(req_id, None)


def _spoken_summary_for(payload: dict[str, Any]) -> str:
    with contextlib.suppress(Exception):
        from ..voice.elevenlabs_agent import build_briefing_script

        script = build_briefing_script(payload)
        if script:
            return script
    clean_tool = str(payload.get("tool_name", "action")).replace("_", " ")
    reason = str(payload.get("risk_reason", "policy threshold"))
    return (
        f"Recoup risk gate active: holding {clean_tool}. Reason: {reason}. "
        "Approve to commit staged changes, or reject to roll back."
    )


async def replay(
    run_id: str,
    commit_plan: list[ToolCall],
    report: ChangeReport,
    fp: str,
    previews: dict[str, str],
    real: Env,
    log: UndoLog,
) -> str:
    if fingerprint_env(real) != fp:
        raise StaleRehearsalError("workspace changed since rehearsal")
    committed_in_run = 0
    for i, call in enumerate(commit_plan):
        tool = REGISTRY[call.name]
        decision, reason = assess_risk(call, tool, report)
        if decision == RiskDecision.BLOCK:
            if committed_in_run:
                log.undo_steps(committed_in_run, REGISTRY, real)
            return "blocked"
        if decision == RiskDecision.ASK:
            gate_payload: dict[str, Any] = {
                "req_id": f"req_{uuid.uuid4().hex[:8]}",
                "tool_name": call.name,
                "args": call.args,
                "diff_preview": previews.get(call.id, ""),
                "risk_reason": reason,
                "report": report.model_dump(),
            }
            gate_payload["spoken_summary"] = _spoken_summary_for(gate_payload)
            outcome = await ask_human(run_id, gate_payload)
            BUS.emit(
                run_id,
                EventType.APPROVAL_RESULT,
                {"approved": outcome == "approved", "outcome": outcome, "tool": call.name},
                step=i,
                thought=(
                    f"Manager APPROVED `{call.name}`."
                    if outcome == "approved"
                    else f"Risk Gate timed out waiting for `{call.name}` approval."
                    if outcome == "timed_out"
                    else f"Manager REJECTED `{call.name}` — rolling back staged changes."
                ),
            )
            if outcome != "approved":
                if committed_in_run:
                    log.undo_steps(committed_in_run, REGISTRY, real)
                return "timed_out" if outcome == "timed_out" else "aborted_by_human"
        try:
            receipt = tool.do(call.args, real)
            tool.uses += 1
            if tool.mutating:
                log.record(i, tool.name, call.args, receipt)
                committed_in_run += 1
            BUS.emit(
                run_id,
                EventType.REPLAY_STEP_DONE,
                {"step": i, "tool": tool.name, "receipt": receipt},
                step=i,
                thought=f"Committed `{tool.name}` to live workspace with reversible receipt.",
            )
        except Exception as e:
            if committed_in_run:
                log.undo_steps(committed_in_run, REGISTRY, real)
            raise RuntimeError(f"mutation failed at {tool.name}; rolled back: {e}") from e
    return "committed"


async def speculate_next_offer(completed_goal: str, real: Env, run_id: str) -> PreparedOffer | None:
    """Run proactive ledger scan in idle time, rehearse in isolation, and emit a 1-click recovery offer."""
    predict_fn = predict_next_need
    if predict_fn is None:
        try:
            from ..agent.anticipate import predict_next_need as predict_fn  # type: ignore[import-not-found]
        except ImportError:
            return None

    pred = await asyncio.to_thread(predict_fn, completed_goal, real, feedback_path=Path("feedback.json"))
    if not pred:
        return None
    commit_plan, report, fp, previews = await rehearse(pred.goal_prompt, real, run_id, emit_events=False)
    commit_plan = [
        c for c in commit_plan if assess_risk(c, REGISTRY[c.name], report)[0] == RiskDecision.AUTO
    ]
    if report.external_outbox:
        report.external_outbox = []
    offer_id = f"offer_{uuid.uuid4().hex[:8]}"
    prepared = PreparedOffer(
        offer_id=offer_id,
        prediction=pred,
        commit_plan=commit_plan,
        report=report,
        fp=fp,
        previews=previews,
    )
    PENDING_OFFERS[offer_id] = prepared
    offer_payload = AnticipateOfferPayload(
        offer_id=offer_id,
        prediction=pred,
        report=report,
        mutations_count=len(commit_plan),
    )
    BUS.emit(
        run_id,
        EventType.ANTICIPATE_OFFER,
        offer_payload.model_dump(),
        thought=f"Proactive audit ready ({int(pred.confidence * 100)}% confidence): {pred.need}",
    )
    return prepared
