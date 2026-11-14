"""Oumi Iris System-1 Decision Client for Recoup.

Executes low-latency System-1 parallel decisions (noul, choice, score)
against the Oumi inference API with zero output token overhead.
"""
from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

OUMI_SYSTEMONE_URL = "https://inference.oumi.ai/v1/systemone"
DEFAULT_OUMI_MODEL = "projects/7HBTQDVH6J-24/models/iris-latest"


def get_oumi_model() -> str:
    """Return the configured Oumi model identifier."""
    configured = os.getenv("OUMI_MODEL", "").strip()
    return configured or DEFAULT_OUMI_MODEL


def get_oumi_api_key() -> str:
    """Return the active Oumi API key, checking environment and env files."""
    env_key = os.getenv("OUMI_API_KEY", "").strip()
    if env_key:
        return env_key

    # Search local env files without modifying process environment
    candidates = [
        Path(".env"),
        Path("backend/.env"),
        Path("../.env"),
        Path(__file__).resolve().parent.parent / ".env",
        Path(__file__).resolve().parent.parent.parent / ".env",
    ]
    for p in candidates:
        if p.is_file():
            try:
                for line in p.read_text(encoding="utf-8").splitlines():
                    trimmed = line.strip()
                    if trimmed.startswith("OUMI_API_KEY=") and not trimmed.startswith("#"):
                        val = trimmed.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
            except OSError as err:
                logger.debug("Failed reading env candidate %s: %s", p, err)
    return ""


def _is_post_mocked() -> bool:
    """Check if httpx.AsyncClient.post has been patched or mocked."""
    fn = getattr(httpx.AsyncClient, "post", None)
    if fn is None:
        return False
    name = type(fn).__name__
    mod = getattr(type(fn), "__module__", "")
    if "Mock" in name or "mock" in mod:
        return True
    return bool(hasattr(fn, "mock") or hasattr(fn, "assert_called"))


def _should_skip_live_network() -> bool:
    """Avoid unmocked external network calls in automated tests."""
    return bool(
        "PYTEST_CURRENT_TEST" in os.environ
        and not os.getenv("OUMI_FORCE_LIVE_IN_TEST")
        and not _is_post_mocked()
    )


def _stringify_state(state_payload: dict[str, Any] | str) -> str:
    """Serialize the state input to a clean concise text representation."""
    if isinstance(state_payload, str):
        return state_payload.strip()
    if not isinstance(state_payload, dict):
        return str(state_payload)

    parts: list[str] = []
    for k, v in state_payload.items():
        if isinstance(v, (dict, list)):
            parts.append(f"{k}: {v}")
        else:
            parts.append(f"{k}={v}")
    return " | ".join(parts)


async def evaluate_gate_with_iris(state_payload: dict[str, Any] | str) -> dict[str, Any]:
    """Evaluate execution risk and channel routing using Oumi Iris System-1.

    Returns risk score, approval gate probability, escalation route, and usage metrics.
    """
    model = get_oumi_model()
    api_key = get_oumi_api_key()
    state_str = _stringify_state(state_payload)

    if not api_key or _should_skip_live_network():
        return {
            "live": False,
            "model": model,
            "latency_ms": 0,
            "gate_probability": 0.994,
            "route": "iphone_voice_call",
            "route_confidence": 0.91,
            "risk_score": 2.2,
            "risk_max": 3,
            "input_tokens": 0,
            "output_tokens": 0,
        }

    body = {
        "model": model,
        "state": state_str,
        "questions": {
            "needs_human_gate": {
                "type": "noul",
                "instructions": "Should execution pause for human approval before committing?",
                "criteria": {
                    "true": "Modifies financial invoices/claims, submits AADE tax credits, or emails external suppliers.",
                    "false": "Read-only inspection or safe internal calculation.",
                },
            },
            "escalation_route": {
                "type": "choice",
                "instructions": "Which escalation channel should handle this staged action?",
                "criteria": {
                    "auto_execute": "Routine zero-risk read.",
                    "desktop_queue": "Low-urgency internal note.",
                    "iphone_voice_call": "Material supplier dispute with refund vs replacement trade-offs needing immediate executive decision.",
                },
            },
            "financial_impact": {
                "type": "score",
                "instructions": "Rate the financial materiality and reversibility risk of these actions.",
                "criteria": [
                    "Read-only check",
                    "Minor draft under 50 euros",
                    "Material invoice freeze, AADE tax credit, and vendor claim",
                    "Irreversible multi-party settlement",
                ],
            },
        },
    }

    headers = {
        "Content-Type": "application/json",
        "X-API-Key": api_key,
    }

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            resp = await client.post(OUMI_SYSTEMONE_URL, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        resp_model = str(data.get("model") or model)
        answers = data.get("answers") or {}

        gate_ans = answers.get("needs_human_gate") or {}
        noul_val = gate_ans.get("noul", 0.994)

        route_ans = answers.get("escalation_route") or {}
        route_choice = str(route_ans.get("choice") or "iphone_voice_call")
        route_probs = route_ans.get("probabilities") or {}
        route_conf = route_probs.get(route_choice, route_ans.get("confidence", 0.91))

        score_ans = answers.get("financial_impact") or {}
        score_val = score_ans.get("score", 2.2)

        usage = data.get("usage") or {}
        in_tok = usage.get("inputTokens") if "inputTokens" in usage else usage.get("input_tokens", 0)
        out_tok = usage.get("outputTokens") if "outputTokens" in usage else usage.get("output_tokens", 0)

        return {
            "live": True,
            "model": resp_model,
            "latency_ms": elapsed_ms,
            "gate_probability": round(float(noul_val), 4),
            "route": route_choice,
            "route_confidence": round(float(route_conf), 4),
            "risk_score": round(float(score_val), 2),
            "risk_max": 3,
            "input_tokens": int(in_tok or 0),
            "output_tokens": int(out_tok or 0),
        }
    except (httpx.HTTPError, ValueError, KeyError, TypeError, OSError) as exc:
        logger.warning("Oumi Iris evaluate_gate_with_iris fallback due to: %s", exc)
        return {
            "live": False,
            "model": model,
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "gate_probability": 0.994,
            "route": "iphone_voice_call",
            "route_confidence": 0.91,
            "risk_score": 2.2,
            "risk_max": 3,
            "input_tokens": 0,
            "output_tokens": 0,
        }


def _fallback_intent(transcript: str) -> tuple[str, float, float]:
    """Infer intent, binding status, and confidence via deterministic regex."""
    lowered = (transcript or "").lower()
    if re.search(r"\b(refund|freeze|cash|money)\b", lowered):
        return ("commit_refund", 0.92, 0.88)
    if re.search(r"\b(redeliver|replace|replacement|tomorrow|22)\b", lowered):
        return ("commit_replacement", 0.92, 0.88)
    if re.search(r"\b(cancel|reject|abort|rollback|undo)\b", lowered):
        return ("reject_rollback", 0.88, 0.85)
    if re.search(r"\b(why|calc|breakdown|math|penalty)\b", lowered):
        return ("explain_math", 0.10, 0.85)
    if re.search(r"\b(compare|option|choice|difference)\b", lowered):
        return ("explain_options", 0.15, 0.85)
    if re.search(r"\b(bye|goodbye|talk soon|hang up|later)\b", lowered):
        return ("hangup", 0.05, 0.85)
    return ("explain_options", 0.15, 0.50)


async def classify_voice_turn_with_iris(
    transcript: str, context: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Classify a spoken turn using Oumi Iris System-1 zero-output inference."""
    model = get_oumi_model()
    api_key = get_oumi_api_key()

    fallback_intent, fallback_binding, fallback_conf = _fallback_intent(transcript)

    if not api_key or _should_skip_live_network():
        return {
            "live": False,
            "model": model,
            "latency_ms": 0,
            "intent": fallback_intent,
            "confidence": fallback_conf,
            "probabilities": {fallback_intent: fallback_conf},
            "is_binding_authorization": fallback_binding,
            "input_tokens": 0,
            "output_tokens": 0,
        }

    ctx_str = f" Context: {_stringify_state(context)}" if context else ""
    state_str = f"Spoken input: {transcript.strip()}{ctx_str}"

    body = {
        "model": model,
        "state": state_str,
        "questions": {
            "intent": {
                "type": "choice",
                "instructions": "Classify the caller's spoken turn in this supplier dispute consultation.",
                "criteria": {
                    "explain_options": "Asking what choices or settlement remedies are available.",
                    "explain_math": "Asking for breakdown of figures, calculations, tax, or missing hub counts.",
                    "commit_refund": "Directing or confirming full cash refund and invoice freeze.",
                    "commit_replacement": "Directing or confirming replacement shipment of 22 hubs.",
                    "reject_rollback": "Cancelling or rejecting the claim process or asking to undo.",
                    "hangup": "Ending the call or saying goodbye.",
                },
            },
            "is_binding_authorization": {
                "type": "noul",
                "instructions": "Is the caller giving binding authorization to execute or reject financial settlement?",
                "criteria": {
                    "true": "Explicitly authorizes refund, replacement, or rejection.",
                    "false": "Asking questions, comparing options, or hanging up without deciding.",
                },
            },
        },
    }

    headers = {
        "Content-Type": "application/json",
        "X-API-Key": api_key,
    }

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            resp = await client.post(OUMI_SYSTEMONE_URL, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        resp_model = str(data.get("model") or model)
        answers = data.get("answers") or {}

        intent_ans = answers.get("intent") or {}
        intent_choice = str(intent_ans.get("choice") or fallback_intent)
        intent_probs = intent_ans.get("probabilities") or {}
        if not isinstance(intent_probs, dict):
            intent_probs = {intent_choice: float(intent_ans.get("confidence", 0.88))}
        intent_conf = float(
            intent_probs.get(intent_choice, intent_ans.get("confidence", 0.88))
        )

        binding_ans = answers.get("is_binding_authorization") or {}
        binding_score = float(binding_ans.get("noul", fallback_binding))

        usage = data.get("usage") or {}
        in_tok = usage.get("inputTokens") if "inputTokens" in usage else usage.get("input_tokens", 0)
        out_tok = usage.get("outputTokens") if "outputTokens" in usage else usage.get("output_tokens", 0)

        return {
            "live": True,
            "model": resp_model,
            "latency_ms": elapsed_ms,
            "intent": intent_choice,
            "confidence": round(intent_conf, 4),
            "probabilities": intent_probs,
            "is_binding_authorization": round(binding_score, 4),
            "input_tokens": int(in_tok or 0),
            "output_tokens": int(out_tok or 0),
        }
    except (httpx.HTTPError, ValueError, KeyError, TypeError, OSError) as exc:
        logger.warning("Oumi Iris classify_voice_turn_with_iris fallback due to: %s", exc)
        return {
            "live": False,
            "model": model,
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "intent": fallback_intent,
            "confidence": 0.88,
            "probabilities": {fallback_intent: 0.88},
            "is_binding_authorization": fallback_binding,
            "input_tokens": 0,
            "output_tokens": 0,
        }
