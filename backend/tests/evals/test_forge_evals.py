"""Standalone offline evaluations for Recoup's TDD tool synthesis engine (`forge.py`)."""
from __future__ import annotations

import ast
import importlib.util
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from app.agent import forge as forge_module
from app.agent.forge import (
    ALLOWED_IMPORTS,
    _extract_json_payload,
    _extract_python_code,
    _format_retry_feedback,
    _normalize_spec_dict,
    forge_missing_tool,
)
from app.contracts import EventType, ForgeSpecPayload
from app.domain_config import DOMAIN
from app.engine.env import Env
from app.engine.tools import REGISTRY, Tool

_HAS_REAL_SANDBOX = importlib.util.find_spec("app.engine.sandbox") is not None

_FORBIDDEN_CALLS = {
    "open",
    "exec",
    "eval",
    "compile",
    "__import__",
    "getattr",
    "setattr",
    "delattr",
    "globals",
    "locals",
    "vars",
    "input",
    "breakpoint",
}


@dataclass
class StubLLMResponse:
    text: str
    cost_eur: float = 0.001


class SequenceLLM:
    """Deterministic FIFO LLM double for offline TDD synthesis tests."""

    def __init__(self, responses: list[StubLLMResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def complete(
        self,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> StubLLMResponse:
        self.calls.append({"system": system, "messages": messages, "tools": tools})
        if not self._responses:
            raise AssertionError("SequenceLLM exhausted: unexpected extra LLM call.")
        return self._responses.pop(0)


def _local_ast_and_tdd_verifier(
    name: str,
    description: str,
    params_schema: dict[str, Any],
    code: str,
    examples: list[dict[str, Any]],
    save_dir: Path | None = None,
) -> dict[str, Any]:
    """In-process AST + TDD verifier fallback when `app.engine.sandbox` is not yet merged."""
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {
            "ast_passed": False,
            "ast_errors": [f"SyntaxError: {exc.msg} (line {exc.lineno})"],
            "test_results": [],
            "registered": False,
        }

    ast_errors: list[str] = []
    has_target_fn = False
    allowed = set(ALLOWED_IMPORTS)

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            has_target_fn = True
        elif isinstance(node, ast.Import):
            for alias in node.names:
                root_mod = alias.name.split(".")[0]
                if root_mod not in allowed:
                    ast_errors.append(f"Disallowed import: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            root_mod = (node.module or "").split(".")[0]
            if root_mod not in allowed:
                ast_errors.append(f"Disallowed import from: {node.module}")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in _FORBIDDEN_CALLS:
                ast_errors.append(f"Forbidden builtin call: {node.func.id}")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr.endswith("__"):
            ast_errors.append(f"Forbidden dunder attribute access: {node.attr}")

    if not has_target_fn:
        ast_errors.append(f"Missing required function definition `def {name}(args: dict) -> dict:`")

    if ast_errors:
        return {
            "ast_passed": False,
            "ast_errors": ast_errors,
            "test_results": [],
            "registered": False,
        }

    namespace: dict[str, Any] = {}
    exec(compile(tree, filename=f"<forged:{name}>", mode="exec"), namespace)  # noqa: S102
    fn = namespace[name]

    test_results: list[dict[str, Any]] = []
    all_passed = True
    for idx, ex in enumerate(examples):
        try:
            actual = fn(dict(ex["in"]))
            passed = actual == ex["out"]
            test_results.append({"index": idx, "passed": passed, "actual": actual})
            if not passed:
                all_passed = False
        except Exception as exc:  # noqa: BLE001
            all_passed = False
            test_results.append({"index": idx, "passed": False, "actual": None, "error": repr(exc)})

    if not all_passed:
        return {
            "ast_passed": True,
            "ast_errors": [],
            "test_results": test_results,
            "registered": False,
        }

    if save_dir is not None:
        save_dir.mkdir(parents=True, exist_ok=True)
        (save_dir / f"{name}.py").write_text(code, encoding="utf-8")

    class _ForgedTool(Tool):
        mutating = False
        reversible = True
        risk = "low"
        source = "forged"

        def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
            return {"result": fn(dict(args))}

        def undo(self, receipt: dict[str, Any], env: Env) -> None:
            return None

    _ForgedTool.name = name
    _ForgedTool.description = description
    _ForgedTool.params_schema = params_schema
    REGISTRY[name] = _ForgedTool()

    return {
        "ast_passed": True,
        "ast_errors": [],
        "test_results": test_results,
        "registered": True,
    }


@pytest.fixture(autouse=True)
def _sandbox_and_registry_guard(monkeypatch: pytest.MonkeyPatch):
    """Ensure standalone execution without `app.engine.sandbox` and keep `REGISTRY` clean."""
    tracked_names = ("compute_supplier_claim", "calc_sla_credit", "parse_receiving_note")
    for tool_name in tracked_names:
        REGISTRY.pop(tool_name, None)
    if not _HAS_REAL_SANDBOX:
        monkeypatch.setattr(forge_module, "verify_and_register_forged_tool", _local_ast_and_tdd_verifier)
    yield
    for tool_name in tracked_names:
        REGISTRY.pop(tool_name, None)


def _capture_events() -> tuple[list[tuple[EventType, dict[str, Any]]], Callable[..., None]]:
    events: list[tuple[EventType, dict[str, Any]]] = []

    def emit(event_type: EventType, payload: dict[str, Any], thought: str | None, cost: float) -> None:
        events.append((event_type, payload))

    return events, emit


def _supplier_claim_spec(name: str = "compute_supplier_claim") -> dict[str, Any]:
    forge_cfg = DOMAIN["demo"]["forge"]
    return {
        "name": name,
        "purpose": forge_cfg["purpose"],
        "input_schema": {
            "type": "object",
            "properties": {
                "qty_billed": {"type": "integer"},
                "qty_received": {"type": "integer"},
                "qty_damaged": {"type": "integer"},
                "billed_unit_price": {"type": "number"},
                "contract_unit_price": {"type": "number"},
                "days_late": {"type": "integer"},
                "late_penalty_pct_per_day": {"type": "number"},
                "max_penalty_pct": {"type": "number"},
            },
            "required": [
                "qty_billed",
                "qty_received",
                "qty_damaged",
                "billed_unit_price",
                "contract_unit_price",
                "days_late",
                "late_penalty_pct_per_day",
                "max_penalty_pct",
            ],
        },
        "output_schema": {
            "type": "object",
            "properties": {
                "overcharge": {"type": "number"},
                "shortage": {"type": "number"},
                "damaged": {"type": "number"},
                "late_penalty": {"type": "number"},
                "total": {"type": "number"},
            },
        },
        "examples": forge_cfg["examples"],
    }


# ---------------------------------------------------------------------------
# 1. Signature Tool Synthesis: compute_supplier_claim (Shipment D-1042)
# ---------------------------------------------------------------------------


class TestComputeSupplierClaimSynthesis:
    def test_synthesizes_and_registers_supplier_claim_calculator(self, tmp_path: Path) -> None:
        forge_cfg = DOMAIN["demo"]["forge"]
        spec_payload = _supplier_claim_spec()
        llm = SequenceLLM(
            [
                StubLLMResponse(text=json.dumps(spec_payload)),
                StubLLMResponse(text=forge_cfg["code"]),
            ]
        )
        emitted, emit = _capture_events()

        ok = forge_missing_tool(
            llm,
            "MISSING:compute_supplier_claim",
            DOMAIN["default_goal"],
            emit=emit,
            save_dir=tmp_path / "forged_tools",
            max_attempts=3,
        )

        assert ok is True
        assert "compute_supplier_claim" in REGISTRY
        assert (tmp_path / "forged_tools" / "compute_supplier_claim.py").exists()

        emitted_types = [ev[0] for ev in emitted]
        assert emitted_types == [
            EventType.FORGE_SPEC,
            EventType.FORGE_TEST_RESULT,
            EventType.FORGE_REGISTERED,
        ]

        spec_ev = emitted[0][1]
        assert spec_ev["name"] == "compute_supplier_claim"
        assert len(spec_ev["examples"]) == 3
        assert "in" in spec_ev["examples"][0]
        assert "out" in spec_ev["examples"][0]

    def test_computes_exact_eur_587_30_for_shipment_d1042_and_edge_cases(self, tmp_path: Path) -> None:
        forge_cfg = DOMAIN["demo"]["forge"]
        llm = SequenceLLM(
            [
                StubLLMResponse(text=json.dumps(_supplier_claim_spec())),
                StubLLMResponse(text=f"```python\n{forge_cfg['code']}\n```"),
            ]
        )
        assert forge_missing_tool(llm, "compute_supplier_claim", DOMAIN["default_goal"]) is True

        tool = REGISTRY["compute_supplier_claim"]
        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")

        # Hero shipment D-1042 against Kappa Office Systems master contract -> EUR 587.30
        d1042_out = tool.do(forge_cfg["call_args"], env)
        claim = d1042_out.get("result", d1042_out)
        assert claim == {
            "overcharge": 168.0,
            "shortage": 280.0,
            "damaged": 105.0,
            "late_penalty": 34.3,
            "total": 587.3,
        }

        # Clean shipment D-1050 (Nova Workplace Cloud) -> EUR 0.00
        clean_out = tool.do(
            {
                "qty_billed": 40,
                "qty_received": 40,
                "qty_damaged": 0,
                "billed_unit_price": 14.20,
                "contract_unit_price": 14.20,
                "days_late": 0,
                "late_penalty_pct_per_day": 0.5,
                "max_penalty_pct": 5.0,
            },
            env,
        )
        clean_claim = clean_out.get("result", clean_out)
        assert clean_claim["total"] == 0.0

        # Capped SLA penalty + defensive clamping when billed below contract or early delivery
        edge_out = tool.do(
            {
                "qty_billed": 10,
                "qty_received": 12,
                "qty_damaged": 0,
                "billed_unit_price": 9.50,
                "contract_unit_price": 10.00,
                "days_late": -2,
                "late_penalty_pct_per_day": 1.0,
                "max_penalty_pct": 10.0,
            },
            env,
        )
        edge_claim = edge_out.get("result", edge_out)
        assert edge_claim == {
            "overcharge": 0.0,
            "shortage": 0.0,
            "damaged": 0.0,
            "late_penalty": 0.0,
            "total": 0.0,
        }


# ---------------------------------------------------------------------------
# 2. Spec Dict Normalization (`_normalize_spec_dict`)
# ---------------------------------------------------------------------------


def test_normalize_spec_dict_maps_common_llm_aliases() -> None:
    raw_llm_spec = {
        "tool_name": "MISSING:compute_supplier_claim",
        "description": "Calculate vendor claim line items and capped SLA credit",
        "parameters": {"type": "object", "properties": {"qty_billed": {"type": "integer"}}},
        "examples": [
            {
                "input": {"qty_billed": 10},
                "expected": {"total": 0.0},
            }
        ],
    }
    normalized = _normalize_spec_dict(raw_llm_spec, fallback_name="compute_supplier_claim")
    parsed = ForgeSpecPayload.model_validate(normalized)

    assert parsed.name == "compute_supplier_claim"
    assert parsed.purpose == "Calculate vendor claim line items and capped SLA credit"
    assert parsed.input_schema["properties"]["qty_billed"] == {"type": "integer"}
    assert parsed.examples[0].input_args == {"qty_billed": 10}
    assert parsed.examples[0].expected_output == {"total": 0.0}


# ---------------------------------------------------------------------------
# 3. JSON & Python Extraction Edge Cases
# ---------------------------------------------------------------------------


def test_extract_json_payload_handles_fenced_and_commentary_inputs() -> None:
    fenced = (
        "Here is the vendor SLA calculator specification:\n"
        "```json\n"
        '{"name": "calc_sla_credit", "purpose": "Compute SLA credit", "examples": []}\n'
        "```\n"
        "Ready for sandbox verification."
    )
    assert _extract_json_payload(fenced)["name"] == "calc_sla_credit"

    prefixed = 'Specification JSON: {"name": "calc_sla_credit", "purpose": "Compute SLA credit"}'
    assert _extract_json_payload(prefixed)["purpose"] == "Compute SLA credit"

    mixed_fences = (
        '```json\n{"name": "calc_sla_credit", "purpose": "ok", "examples": []}\n```\n'
        "```python\ndef calc_sla_credit(args: dict) -> dict:\n    return {}\n```"
    )
    assert _extract_json_payload(mixed_fences)["name"] == "calc_sla_credit"


@pytest.mark.parametrize(
    ("bad_raw", "err_pattern"),
    [
        ("", "Empty JSON payload"),
        ("   \n\t ", "Empty JSON payload"),
        ("Plain explanation without braces.", "No valid JSON object"),
        ('{"name": "broken"', "Malformed JSON payload"),
        ('{"name": "first"} {"name": "second"}', "Trailing content"),
        ('{"name": "valid"} trailing commentary', "Trailing content"),
        ('```json\n{"a": 1}\n```\n```json\n{"b": 2}\n```', "Ambiguous JSON payload"),
    ],
)
def test_extract_json_payload_rejects_invalid_or_ambiguous_inputs(bad_raw: str, err_pattern: str) -> None:
    with pytest.raises(ValueError, match=err_pattern):
        _extract_json_payload(bad_raw)


def test_extract_python_code_handles_fenced_and_unfenced_code() -> None:
    fenced_py = (
        "Implementation:\n"
        "```py\n"
        "import math\n\n"
        "def calc_sla_credit(args: dict) -> dict:\n"
        "    return {'credit': round(float(args.get('amount', 0)), 2)}\n"
        "```\n"
    )
    extracted = _extract_python_code(fenced_py)
    assert extracted.startswith("import math")
    assert "def calc_sla_credit" in extracted

    unfenced_with_prose = (
        "Below is the pure Python implementation:\n"
        "def calc_sla_credit(args: dict) -> dict:\n"
        "    return {'credit': 0.0}\n"
    )
    unfenced = _extract_python_code(unfenced_with_prose)
    assert unfenced.startswith("def calc_sla_credit")
    assert "Below is the pure Python" not in unfenced


@pytest.mark.parametrize(
    ("bad_code", "err_pattern"),
    [
        ("", "Empty Python code payload"),
        ("   \n\t ", "Empty Python code payload"),
        ("Only prose commentary with zero code blocks.", "No identifiable Python code"),
        (
            "```python\ndef a(args): return {}\n```\n```python\ndef b(args): return {}\n```",
            "Ambiguous Python code payload",
        ),
    ],
)
def test_extract_python_code_rejects_invalid_or_ambiguous_inputs(bad_code: str, err_pattern: str) -> None:
    with pytest.raises(ValueError, match=err_pattern):
        _extract_python_code(bad_code)


# ---------------------------------------------------------------------------
# 4. Multi-Attempt Self-Repair & Retry Feedback
# ---------------------------------------------------------------------------


def test_self_repairs_uncapped_sla_penalty_on_attempt_2() -> None:
    """Attempt 1 forgets `max_penalty_pct` cap (Test 2 fails: 15.0 vs 10.0); Attempt 2 repairs it."""
    buggy_uncapped_code = """\
def compute_supplier_claim(args: dict) -> dict:
    billed = int(args.get("qty_billed", 0))
    received = int(args.get("qty_received", 0))
    damaged = int(args.get("qty_damaged", 0))
    billed_price = float(args.get("billed_unit_price", 0))
    contract_price = float(args.get("contract_unit_price", 0))
    days_late = max(0, int(args.get("days_late", 0)))
    pct_per_day = float(args.get("late_penalty_pct_per_day", 0))

    overcharge = max(0.0, billed_price - contract_price) * billed
    shortage = max(0, billed - received) * contract_price
    damaged_credit = max(0, damaged) * contract_price
    accepted_value = max(0, received - damaged) * contract_price
    late_penalty = accepted_value * (days_late * pct_per_day) / 100
    total = overcharge + shortage + damaged_credit + late_penalty
    return {
        "overcharge": round(overcharge, 2),
        "shortage": round(shortage, 2),
        "damaged": round(damaged_credit, 2),
        "late_penalty": round(late_penalty, 2),
        "total": round(total, 2),
    }
"""
    repaired_code = DOMAIN["demo"]["forge"]["code"]
    llm = SequenceLLM(
        [
            StubLLMResponse(text=json.dumps(_supplier_claim_spec())),
            StubLLMResponse(text=buggy_uncapped_code),
            StubLLMResponse(text=repaired_code),
        ]
    )
    emitted, emit = _capture_events()

    assert forge_missing_tool(llm, "compute_supplier_claim", DOMAIN["default_goal"], emit=emit) is True

    # Retry prompt sent on Attempt 2 must include Test 2 mismatch (15.0 vs 10.0) and omit passing Test 0 & 1
    retry_prompt = llm.calls[2]["messages"][-1]["content"]
    assert "Previous attempt failed:" in retry_prompt
    assert "Test 2" in retry_prompt
    assert "Test 0" not in retry_prompt
    assert "Test 1" not in retry_prompt
    assert '"late_penalty": 10.0' in retry_prompt
    assert '"late_penalty": 15.0' in retry_prompt

    registered_ev = next(p for t, p in emitted if t == EventType.FORGE_REGISTERED)
    assert registered_ev["attempt"] == 2


def test_self_repairs_after_ast_security_rejection_and_extraction_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Covers prose extraction failure (no FORGE_TEST_RESULT), AST rejection, and clean repair."""
    monkeypatch.setattr(forge_module, "verify_and_register_forged_tool", _local_ast_and_tdd_verifier)

    disallowed_import_code = (
        "import os\n\n"
        "def compute_supplier_claim(args: dict) -> dict:\n"
        "    return {'total': 0.0}\n"
    )
    repaired_code = DOMAIN["demo"]["forge"]["code"]

    llm = SequenceLLM(
        [
            StubLLMResponse(text=json.dumps(_supplier_claim_spec())),
            StubLLMResponse(text="Let me think through the contract clauses first."),
            StubLLMResponse(text=disallowed_import_code),
            StubLLMResponse(text=repaired_code),
        ]
    )
    emitted, emit = _capture_events()

    ok = forge_missing_tool(
        llm,
        "compute_supplier_claim",
        DOMAIN["default_goal"],
        emit=emit,
        max_attempts=3,
    )
    assert ok is True

    # Attempt 2 prompt has extraction error feedback; Attempt 3 prompt has AST error feedback
    assert "Python extraction error" in llm.calls[2]["messages"][-1]["content"]
    ast_retry_prompt = llm.calls[3]["messages"][-1]["content"]
    assert "AST validation errors:" in ast_retry_prompt
    assert "Tests were skipped because AST validation failed." in ast_retry_prompt

    # Attempt 1 failed before sandbox, so FORGE_TEST_RESULT was emitted only for Attempts 2 and 3
    test_events = [p for t, p in emitted if t == EventType.FORGE_TEST_RESULT]
    assert [ev["attempt"] for ev in test_events] == [2, 3]
    assert test_events[0]["ast_passed"] is False
    assert test_events[1]["registered"] is True


def test_format_retry_feedback_and_max_attempts_exhaustion(monkeypatch: pytest.MonkeyPatch) -> None:
    examples = [{"in": {"days_late": 15}, "out": {"late_penalty": 10.0}}]
    feedback = _format_retry_feedback(
        {
            "ast_passed": True,
            "ast_errors": [],
            "test_results": [
                {
                    "index": 0,
                    "passed": False,
                    "actual": None,
                    "error": "KeyError('days_late')",
                }
            ],
        },
        examples,
    )
    assert "Test 0" in feedback
    assert "KeyError('days_late')" in feedback

    def always_fail_verifier(**kwargs: Any) -> dict[str, Any]:
        return {
            "ast_passed": True,
            "ast_errors": [],
            "test_results": [{"index": 0, "passed": False, "actual": {"total": -1.0}}],
            "registered": False,
        }

    monkeypatch.setattr(forge_module, "verify_and_register_forged_tool", always_fail_verifier)

    bad_code = "def compute_supplier_claim(args: dict) -> dict:\n    return {'total': -1.0}\n"
    llm = SequenceLLM(
        [
            StubLLMResponse(text=json.dumps(_supplier_claim_spec())),
            StubLLMResponse(text=bad_code),
            StubLLMResponse(text=bad_code),
            StubLLMResponse(text=bad_code),
        ]
    )
    assert forge_missing_tool(llm, "compute_supplier_claim", DOMAIN["default_goal"], max_attempts=3) is False
    assert len(llm.calls) == 4
