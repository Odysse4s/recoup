"""Shared data shapes between the agent, the engine and the HUD.

Mirrored one-to-one in frontend/src/contracts.ts; keep EventType values identical in both files.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class EventType(str, Enum):
    PLAN_CREATED = "plan"
    PLAN_REVISED = "replan"
    REHEARSE_START = "rehearse_start"
    EVIDENCE = "evidence"
    TOOL_CALL = "tool_call"
    TOOL_DONE = "tool_done"
    TOOL_ERROR = "tool_error"
    FORGE_SPEC = "forge_spec"
    FORGE_TEST_RESULT = "forge_test"
    FORGE_REGISTERED = "forge_registered"
    REHEARSE_REPORT = "rehearse_report"
    APPROVAL_NEEDED = "approval_needed"
    APPROVAL_RESULT = "approval_result"
    REPLAY_STEP_DONE = "replay_step_done"
    UNDO_STEP = "undo_step"
    VERIFY_RESULT = "verify"
    CALL_START = "call_start"
    CALL_TURN = "call_turn"
    CALL_END = "call_end"
    ANTICIPATE_OFFER = "offer"
    RUN_DONE = "run_done"


class RiskDecision(str, Enum):
    AUTO = "auto"
    ASK = "ask"
    BLOCK = "block"


# ---------- agent <-> engine ----------
class ToolCall(BaseModel):
    id: str
    name: str
    args: dict[str, Any] = {}
    thought: str | None = None
    thought_signature: str | None = None


class ToolResult(BaseModel):
    call_id: str
    ok: bool
    output: Any = None
    error: str | None = None


class PlanStep(BaseModel):
    id: int
    intent: str
    tool: str  # registered tool name, or "MISSING:<name>" to synthesize a new one
    status: Literal["pending", "running", "done", "failed"] = "pending"


class PlanPayload(BaseModel):
    goal: str
    steps: list[PlanStep]
    success_criteria: list[str]


# ---------- evidence (documents, photos) ----------
class EvidencePayload(BaseModel):
    source: str
    kind: Literal["document", "photo", "audio"] = "document"
    findings: list[str] = []


# ---------- tool synthesis ----------
class ForgeExample(BaseModel):
    model_config = {"populate_by_name": True}
    input_args: dict[str, Any] = Field(alias="in")
    expected_output: Any = Field(alias="out")


class ForgeSpecPayload(BaseModel):
    name: str
    purpose: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] = {"type": "object"}
    examples: list[ForgeExample]


class ForgeTestPayload(BaseModel):
    name: str
    attempt: int
    code: str
    ast_passed: bool
    ast_errors: list[str] = []
    test_results: list[dict[str, Any]] = []
    registered: bool = False


# ---------- engine -> UI ----------
class FileDiffItem(BaseModel):
    path: str
    diff: str


class ChangeReport(BaseModel):
    files_created: list[str] = []
    files_modified: list[FileDiffItem] = []
    files_deleted: list[str] = []
    db_summary: dict[str, dict[str, int]] = {}
    db_max_deleted: int = 0
    external_outbox: list[dict[str, Any]] = []


class ApprovalNeededPayload(BaseModel):
    req_id: str
    tool_name: str
    args: dict[str, Any]
    diff_preview: str
    risk_reason: str
    spoken_summary: str = ""
    report: ChangeReport | None = None


class ApprovalDecision(BaseModel):
    approved: bool


class VerifyCriterionResult(BaseModel):
    criterion: str
    passed: bool
    detail: str = ""


class VerifyPayload(BaseModel):
    passed: bool
    criteria: list[VerifyCriterionResult]


# ---------- supplier call ----------
class CallTurnPayload(BaseModel):
    call_id: str
    speaker: Literal["agent", "counterparty"]
    text: str
    audio_url: str | None = None
    offer_pct: float | None = None


class CallEndPayload(BaseModel):
    call_id: str
    outcome: Literal["accepted", "escalated", "rejected", "no_answer"]
    agreed_amount: float | None = None
    summary: str = ""


# ---------- anticipate ----------
class AnticipatePrediction(BaseModel):
    need: str
    goal_prompt: str
    evidence: str
    confidence: float = Field(ge=0, le=1)
    kind: Literal["info", "draft", "report", "precompute"] = "draft"


class AnticipateOfferPayload(BaseModel):
    offer_id: str
    prediction: AnticipatePrediction
    report: ChangeReport
    mutations_count: int


# ---------- SSE envelope ----------
class ServerEvent(BaseModel):
    id: int
    run_id: str
    ts: float
    type: EventType
    step: int | None = None
    thought: str | None = None
    cost_eur: float = 0.0
    latency_ms: int = 0
    payload: dict[str, Any] = {}


class GoalRequest(BaseModel):
    goal: str
    anticipate_after: bool = True
