"""TDD synthesis and self-repair engine for sandboxed enterprise audit tools."""
from __future__ import annotations

import ast
import contextlib
import json
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from ..contracts import EventType, ForgeSpecPayload, ForgeTestPayload

_FALLBACK_ALLOWED_IMPORTS: tuple[str, ...] = (
    "collections",
    "csv",
    "datetime",
    "decimal",
    "functools",
    "itertools",
    "json",
    "math",
    "operator",
    "re",
    "statistics",
    "typing",
    "unicodedata",
)

try:
    from ..engine.sandbox import ALLOWED_IMPORTS as _SANDBOX_ALLOWED_IMPORTS

    ALLOWED_IMPORTS: tuple[str, ...] = tuple(sorted(_SANDBOX_ALLOWED_IMPORTS))
except ImportError:
    ALLOWED_IMPORTS = _FALLBACK_ALLOWED_IMPORTS

try:
    from ..engine.sandbox import verify_and_register_forged_tool
except ImportError:

    def verify_and_register_forged_tool(
        name: str,
        description: str,
        params_schema: dict[str, Any],
        code: str,
        examples: list[dict[str, Any]],
        save_dir: Path | None = None,
    ) -> dict[str, Any]:
        raise RuntimeError(
            "Sandbox verifier `app.engine.sandbox.verify_and_register_forged_tool` is unavailable."
        )


if TYPE_CHECKING:
    from .llm import LLMProvider
else:
    try:
        from .llm import LLMProvider
    except ImportError:
        LLMProvider = Any

_PROMPT_ALLOWED_IMPORTS = ", ".join(
    mod for mod in ALLOWED_IMPORTS if not mod.startswith(("__", "urllib"))
)

SPEC_SYSTEM = (
    "You are Recoup's TDD tool architect for enterprise vendor audits, procurement contracts, "
    "tiered rebates, multi-currency FX reconciliation, and SLA credit governance. Given a missing "
    "tool name and goal context, return STRICT MINIFIED single-line JSON (no markdown fences, no "
    "commentary, no verbose schema descriptions) matching ForgeSpecPayload:\n"
    '{"name":"<snake_case_name>","purpose":"<1 short sentence>",'
    '"input_schema":{"type":"object","properties":{...},"required":[...]},'
    '"output_schema":{"type":"object"},'
    '"examples":[{"in":{...},"out":{...}}]}\n'
    "Rules:\n"
    "1. Reason concisely without lengthy internal prose so total thought + output stays compact.\n"
    "2. Strip any `MISSING:` prefix from `name`.\n"
    "3. Provide 3 compact deterministic TDD `examples`: (a) standard discrepancy/breach, "
    "(b) zero-discrepancy baseline, and (c) cap or boundary.\n"
    "4. Round monetary outputs in `out` to 2 decimal places (`float`).\n"
    "5. For `compute_supplier_claim`, use exact inputs "
    "`qty_billed`, `qty_received`, `qty_damaged`, `billed_unit_price`, `contract_unit_price`, "
    "`days_late`, `late_penalty_pct_per_day`, `max_penalty_pct` and exact outputs "
    "`overcharge`, `shortage`, `damaged`, `late_penalty`, `total` (rounded to 2 decimals): "
    "`overcharge = max(0.0, billed_unit_price - contract_unit_price) * qty_billed`, "
    "`shortage = max(0, qty_billed - qty_received) * contract_unit_price`, "
    "`damaged = max(0, qty_damaged) * contract_unit_price`, "
    "`accepted_value = max(0, qty_received - qty_damaged) * contract_unit_price`, "
    "`late_penalty = accepted_value * min(max(0, days_late) * late_penalty_pct_per_day, max_penalty_pct) / 100`, "
    "`total = overcharge + shortage + damaged + late_penalty`."
)

CODE_SYSTEM = (
    "You are Recoup's deterministic Python tool synthesizer for enterprise SLA, tiered rebate, "
    "multi-currency FX, and accounts payable calculators. Write ONLY pure Python source code "
    "(no markdown fences, no prose, no comments) defining `def <name>(args: dict) -> dict:`.\n"
    f"Allowed standard-library imports ONLY: {_PROMPT_ALLOWED_IMPORTS}.\n"
    "Strict sandbox rules:\n"
    "- Reason concisely without lengthy scratchpad derivations and keep code under 35 lines.\n"
    "- Never import os, sys, subprocess, pathlib, socket, httpx, requests, or third-party modules.\n"
    "- Never call open, exec, eval, compile, __import__, getattr, setattr, delattr, globals, locals, "
    "vars, input, or breakpoint, and never define or access dunder (`__...__`) names or attributes.\n"
    "- Read inputs defensively via `args.get(...)` with safe coercion (`int`/`float`/`str`) and "
    "non-negative clamping (`max(0, ...)` / `max(0.0, ...)`).\n"
    "- For multi-clause formulas, use `decimal.Decimal` with `ROUND_HALF_UP` or `round(val, 2)`, "
    "enforce caps via `min(..., max_cap)`, and return plain JSON-serializable values.\n"
    "- When synthesizing `compute_supplier_claim`, compute exact keys `overcharge`, `shortage`, "
    "`damaged`, `late_penalty`, `total` (each rounded to 2 decimals) using `accepted_value = "
    "max(0, qty_received - qty_damaged) * contract_unit_price` and `late_penalty = "
    "accepted_value * min(max(0, days_late) * late_penalty_pct_per_day, max_penalty_pct) / 100`."
)

_TOP_LEVEL_CODE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*(?::\s*[^=]+)?=")


def _extract_json_payload(raw: str) -> dict[str, Any]:
    """Extract a single strict JSON object from an LLM response."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Empty JSON payload from LLM.")

    fence_matches = list(re.finditer(r"```(?P<lang>[A-Za-z0-9_-]*)\s*(?P<body>.*?)```", text, re.DOTALL))
    if fence_matches:
        candidates: list[str] = []
        for match in fence_matches:
            lang = (match.group("lang") or "").lower()
            body = match.group("body").strip()
            if lang in ("", "json", "jsonc"):
                candidates.append(body)
        if not candidates:
            raise ValueError("No valid JSON object found in fenced LLM response.")
        if len(candidates) > 1:
            raise ValueError("Ambiguous JSON payload: multiple JSON blocks found.")
        text = candidates[0]

    start = text.find("{")
    if start == -1:
        raise ValueError("No valid JSON object found in LLM response.")

    try:
        value, end = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed JSON payload: {exc.msg}") from exc

    if not isinstance(value, dict):
        raise TypeError("JSON payload is not a dictionary object.")

    trailing = text[start + end :].strip()
    if trailing:
        raise ValueError("Trailing content after JSON payload is not allowed.")

    return value


def _normalize_spec_dict(data: dict[str, Any], fallback_name: str = "") -> dict[str, Any]:
    """Normalize common LLM field aliases into a canonical ForgeSpecPayload dictionary."""
    if not isinstance(data, dict):
        raise TypeError("Spec payload must be a dictionary.")

    normalized: dict[str, Any] = dict(data)

    raw_name = (
        normalized.get("name")
        or normalized.get("tool_name")
        or normalized.get("function_name")
        or fallback_name
    )
    if isinstance(raw_name, str) and raw_name.strip():
        clean_name = raw_name.strip().removeprefix("MISSING:").strip()
        if clean_name:
            normalized["name"] = clean_name

    if not normalized.get("purpose"):
        for alias in ("description", "summary", "intent"):
            val = normalized.get(alias)
            if isinstance(val, str) and val.strip():
                normalized["purpose"] = val.strip()
                break

    if not isinstance(normalized.get("input_schema"), dict):
        for alias in ("params_schema", "parameters", "args_schema"):
            val = normalized.get(alias)
            if isinstance(val, dict):
                normalized["input_schema"] = val
                break
        else:
            if "input_schema" not in normalized or normalized["input_schema"] is None:
                normalized["input_schema"] = {"type": "object", "properties": {}}

    if not isinstance(normalized.get("output_schema"), dict):
        for alias in ("return_schema", "returns"):
            val = normalized.get(alias)
            if isinstance(val, dict):
                normalized["output_schema"] = val
                break
        else:
            if "output_schema" not in normalized or normalized["output_schema"] is None:
                normalized["output_schema"] = {"type": "object"}

    raw_examples = normalized.get("examples")
    if raw_examples is None and isinstance(normalized.get("test_cases"), list):
        raw_examples = normalized["test_cases"]

    if isinstance(raw_examples, list):
        norm_examples: list[Any] = []
        for item in raw_examples:
            if isinstance(item, dict):
                ex = dict(item)
                if "in" not in ex and "input_args" not in ex:
                    for in_key in ("input", "inputs", "args"):
                        if in_key in ex:
                            ex["in"] = ex.pop(in_key)
                            break
                if "out" not in ex and "expected_output" not in ex:
                    for out_key in ("expected", "output", "result"):
                        if out_key in ex:
                            ex["out"] = ex.pop(out_key)
                            break
                norm_examples.append(ex)
            else:
                norm_examples.append(item)
        normalized["examples"] = norm_examples

    return normalized


def _has_python_defs(tree: ast.Module) -> bool:
    return any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for node in tree.body)


def _extract_python_code(raw: str) -> str:
    """Extract pure Python code from a fenced or unfenced LLM completion."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Empty Python code payload from LLM.")

    fence_matches = list(re.finditer(r"```(?P<lang>[A-Za-z0-9_-]*)\s*(?P<body>.*?)```", text, re.DOTALL))
    if fence_matches:
        candidates: list[str] = []
        for match in fence_matches:
            lang = (match.group("lang") or "").lower()
            body = match.group("body").strip()
            if lang in ("", "python", "py"):
                candidates.append(body)
        if not candidates:
            raise ValueError("No identifiable Python code found in fenced LLM response.")
        if len(candidates) > 1:
            raise ValueError("Ambiguous Python code payload: multiple Python blocks found.")
        if not candidates[0]:
            raise ValueError("Empty Python code payload inside markdown fence.")
        return candidates[0]

    # Fast path: unfenced valid Python module with top-level constants/imports + function definition
    try:
        parsed_whole = ast.parse(text)
        if _has_python_defs(parsed_whole):
            return text
    except SyntaxError:
        pass

    lines = text.splitlines()
    start_idx: int | None = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(("import ", "from ", "def ", "class ")) or _TOP_LEVEL_CODE_RE.match(stripped):
            start_idx = i
            break

    if start_idx is None:
        raise ValueError("No identifiable Python code found in LLM response.")

    candidate_lines = lines[start_idx:]
    candidate = "\n".join(candidate_lines).strip()
    if not candidate:
        raise ValueError("Python code payload is empty after identifying the starting code block.")

    # Trim trailing conversational prose lines if doing so recovers a valid Python AST
    try:
        ast.parse(candidate)
    except SyntaxError:
        for end_idx in range(len(candidate_lines) - 1, 0, -1):
            sub = "\n".join(candidate_lines[:end_idx]).strip()
            if not sub:
                break
            try:
                tree = ast.parse(sub)
                if _has_python_defs(tree):
                    return sub
            except SyntaxError:
                continue

    return candidate


def _format_retry_feedback(res: dict[str, Any], examples: list[dict[str, Any]]) -> str:
    """Format AST errors or per-case TDD mismatches into an actionable repair prompt."""
    lines: list[str] = ["Previous attempt failed:"]

    ast_errors = res.get("ast_errors") or []
    if ast_errors:
        lines.append("AST validation errors:")
        for err in ast_errors:
            lines.append(f"  - {err}")
        lines.append("Tests were skipped because AST validation failed.")

    test_results = res.get("test_results") or []
    failed_tests = [r for r in test_results if not r.get("passed", False)]

    if not ast_errors and not failed_tests:
        lines.append("No failed tests were reported.")
    elif failed_tests:
        lines.append("Failed tests:")
        for result in failed_tests:
            idx = result.get("index", "unknown")
            example = examples[idx] if isinstance(idx, int) and 0 <= idx < len(examples) else None
            input_args = example.get("in") if example else "n/a"
            expected_output = example.get("out") if example else "n/a"
            actual_output = result.get("actual", "n/a")

            detail = (
                "  - "
                f"Test {idx}: "
                f"input={json.dumps(input_args, sort_keys=True, default=str)}; "
                f"expected={json.dumps(expected_output, sort_keys=True, default=str)}; "
                f"actual={json.dumps(actual_output, sort_keys=True, default=str)}"
            )
            if result.get("error"):
                detail += f"; error={result['error']}"
            lines.append(detail)

    lines.append("Fix the code and return ONLY valid pure Python defining the required function.")
    return "\n".join(lines)


def forge_missing_tool(
    llm: LLMProvider,
    missing_name: str,
    goal: str,
    emit: Callable[[EventType, dict[str, Any], str | None, float], None] | None = None,
    save_dir: Path | None = None,
    max_attempts: int = 3,
) -> bool:
    """Synthesize a missing Python tool via TDD, verify in sandbox with up to `max_attempts` repairs."""
    if max_attempts < 1:
        return False

    clean_name = missing_name.strip().removeprefix("MISSING:").strip() or missing_name.strip()
    spec_prompt = f"Missing tool: {clean_name}\nGoal: {goal}"
    spec_resp = llm.complete(SPEC_SYSTEM, [{"role": "user", "content": spec_prompt}])
    spec_cost = float(getattr(spec_resp, "cost_eur", 0.0))
    spec: ForgeSpecPayload | None = None
    try:
        spec_data = _normalize_spec_dict(
            _extract_json_payload(spec_resp.text),
            fallback_name=clean_name,
        )
        spec = ForgeSpecPayload.model_validate(spec_data)
    except (ValueError, TypeError, ValidationError) as exc:
        retry_resp = llm.complete(
            SPEC_SYSTEM,
            [
                {"role": "user", "content": spec_prompt},
                {"role": "assistant", "content": spec_resp.text or ""},
                {
                    "role": "user",
                    "content": (
                        f"Previous JSON was truncated or invalid ({exc}). "
                        "Skip verbose explanations and output STRICT single-line minified JSON "
                        "under 250 tokens with minimal `input_schema` and 3 compact `examples`."
                    ),
                },
            ],
        )
        spec_cost += float(getattr(retry_resp, "cost_eur", 0.0))
        with contextlib.suppress(ValueError, TypeError, ValidationError):
            spec_data = _normalize_spec_dict(
                _extract_json_payload(retry_resp.text),
                fallback_name=clean_name,
            )
            spec = ForgeSpecPayload.model_validate(spec_data)

    if spec is None and os.getenv("LLM_FALLBACK_FAKE", "1") == "1":
        from .llm import FakeProvider

        fallback_resp = FakeProvider().complete(SPEC_SYSTEM, [{"role": "user", "content": spec_prompt}])
        spec_data = _normalize_spec_dict(
            _extract_json_payload(fallback_resp.text),
            fallback_name=clean_name,
        )
        spec = ForgeSpecPayload.model_validate(spec_data)

    if spec is None:
        return False

    if spec.name == "compute_supplier_claim":
        req_in = {
            "qty_billed",
            "qty_received",
            "qty_damaged",
            "billed_unit_price",
            "contract_unit_price",
            "days_late",
            "late_penalty_pct_per_day",
            "max_penalty_pct",
        }
        req_out = {"overcharge", "shortage", "damaged", "late_penalty", "total"}
        for ex in spec.examples:
            if isinstance(ex.input_args, dict) and req_in.issubset(ex.input_args.keys()) and isinstance(
                ex.expected_output, dict
            ) and req_out.issubset(ex.expected_output.keys()):
                qb = max(0, int(ex.input_args.get("qty_billed", 0)))
                qr = max(0, int(ex.input_args.get("qty_received", 0)))
                qd = max(0, int(ex.input_args.get("qty_damaged", 0)))
                bp = max(0.0, float(ex.input_args.get("billed_unit_price", 0.0)))
                cp = max(0.0, float(ex.input_args.get("contract_unit_price", 0.0)))
                dl = max(0, int(ex.input_args.get("days_late", 0)))
                pct = max(0.0, float(ex.input_args.get("late_penalty_pct_per_day", 0.0)))
                cap = max(0.0, float(ex.input_args.get("max_penalty_pct", 0.0)))
                ov = round(max(0.0, bp - cp) * qb, 2)
                sh = round(max(0, qb - qr) * cp, 2)
                dm = round(qd * cp, 2)
                acc = max(0, qr - qd) * cp
                lp = round(acc * min(dl * pct, cap) / 100.0, 2)
                ex.expected_output = {
                    "overcharge": ov,
                    "shortage": sh,
                    "damaged": dm,
                    "late_penalty": lp,
                    "total": round(ov + sh + dm + lp, 2),
                }

    if emit:
        emit(
            EventType.FORGE_SPEC,
            spec.model_dump(by_alias=True),
            f"Synthesizing TDD spec for missing tool `{spec.name}` ({len(spec.examples)} test cases).",
            spec_cost,
        )

    examples_raw = [{"in": ex.input_args, "out": ex.expected_output} for ex in spec.examples]
    feedback = ""

    for attempt in range(1, max_attempts + 1):
        prompt = (
            f"Function name: {spec.name}\n"
            f"Purpose: {spec.purpose}\n"
            f"Input schema: {json.dumps(spec.input_schema)}\n"
            f"TDD examples: {json.dumps(examples_raw)}\n"
            f"{feedback}"
        )
        code_resp = llm.complete(CODE_SYSTEM, [{"role": "user", "content": prompt}])
        try:
            code = _extract_python_code(code_resp.text)
        except ValueError as exc:
            feedback = (
                "Previous attempt failed:\n"
                f"Python extraction error: {exc}\n"
                "Return only valid Python code for the required function.\n"
            )
            if attempt == max_attempts:
                return False
            continue

        res = verify_and_register_forged_tool(
            name=spec.name,
            description=spec.purpose,
            params_schema=spec.input_schema,
            code=code,
            examples=examples_raw,
            save_dir=save_dir,
        )
        test_payload = ForgeTestPayload(
            name=spec.name,
            attempt=attempt,
            code=code,
            ast_passed=res["ast_passed"],
            ast_errors=res.get("ast_errors", []),
            test_results=res.get("test_results", []),
            registered=res["registered"],
        )
        if emit:
            emit(
                EventType.FORGE_TEST_RESULT,
                test_payload.model_dump(),
                f"Forge sandbox attempt {attempt}/{max_attempts} for `{spec.name}`.",
                float(getattr(code_resp, "cost_eur", 0.0)),
            )

        if res["registered"]:
            if emit:
                emit(
                    EventType.FORGE_REGISTERED,
                    {"name": spec.name, "description": spec.purpose, "attempt": attempt},
                    f"Tool `{spec.name}` passed all TDD checks and is registered.",
                    0.0,
                )
            return True

        feedback = _format_retry_feedback(res, examples_raw)

    return False
