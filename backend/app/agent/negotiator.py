"""Multi-Agent Supplier Negotiator with Oumi Iris policy decision hook (`negotiator.py`).

Runs a bounded 5-turn negotiation between Recoup Procurement Agent and Counterparty Vendor AR Agent,
enforcing the deterministic settlement floor policy (`offer_pct < floor_pct` never auto-accepts).
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sqlite3
import uuid
from typing import Any, Literal

from ..contracts import CallEndPayload, CallTurnPayload
from ..domain_config import get_domain
from . import llm as llm_mod
from .anticipate import Env
from .llm import FakeProvider, GeminiProvider, LLMProvider, OumiProvider, get_provider

DecisionAction = Literal["accept", "counter", "escalate"]

OUMI_DECISION_SYSTEM = (
    "You are the Oumi Iris Procurement Settlement Policy Classifier for Recoup. "
    "Given a vendor counterparty settlement offer percentage (`offer_pct`), our mandatory governance "
    "acceptance floor percentage (`floor_pct`), and negotiation context, classify the required action "
    "as exactly one of: `accept`, `counter`, or `escalate`. "
    "Return JSON: {\"action\": \"accept\" | \"counter\" | \"escalate\", \"reason\": \"...\"}. "
    "Policy invariant: any offer below `floor_pct` MUST NEVER be accepted."
)

NEGOTIATION_TURN_SYSTEM = (
    "You are Recoup's Procurement Negotiation Agent speaking on a recorded vendor settlement call "
    "with the counterparty Accounts Receivable desk. Ground every statement in the exact SQLite claim "
    "figures, Master Procurement Agreement Clauses 2-4, and IT receiving inspection evidence. "
    "Keep responses concise (1-2 sentences)."
)


def _parse_oumi_action(raw_text: str) -> DecisionAction | None:
    text = raw_text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    with contextlib.suppress(Exception):
        data = json.loads(text)
        if isinstance(data, dict):
            act = str(data.get("action") or data.get("decision") or "").strip().lower()
            if act in ("accept", "counter", "escalate"):
                return act  # type: ignore[return-value]

    low = text.lower()
    for token in ("escalate", "counter", "accept"):
        if re.search(rf"\b{token}\b", low):
            return token  # type: ignore[return-value]
    return None


def _clamp_settlement_decision(
    proposed: DecisionAction | None,
    offer_pct: float,
    floor_pct: float,
    context: str = "",
    round_idx: int = 1,
) -> DecisionAction:
    """Deterministic safety clamp: `offer_pct < floor_pct` MUST NEVER auto-accept."""
    ctx_low = context.lower()
    is_final_round = round_idx >= 2 or any(k in ctx_low for k in ("final", "round 2", "turn 4", "last"))

    if offer_pct < floor_pct:
        if is_final_round:
            return "escalate"
        if proposed == "escalate":
            return "escalate"
        return "counter"

    if proposed in ("accept", "counter", "escalate"):
        return proposed
    return "accept"


def decide_settlement_action(
    offer_pct: float,
    floor_pct: float = 85.0,
    context: str = "",
    round_idx: int = 1,
) -> DecisionAction:
    """Classify a counterparty settlement offer as `accept`, `counter`, or `escalate`.

    When `OUMI_API_KEY` and `OUMI_BASE_URL` / `OUMI_MODEL` are configured, queries the Oumi Iris
    decision endpoint (with `.llm_cache/` SHA-256 caching), then applies the deterministic policy
    safety clamp so `offer_pct < floor_pct` can never auto-accept.
    """
    oumi_key = os.getenv("OUMI_API_KEY", "").strip()
    oumi_url = os.getenv("OUMI_BASE_URL", "").strip()
    oumi_model = os.getenv("OUMI_MODEL", "").strip()

    proposed: DecisionAction | None = None
    if oumi_key and (oumi_url or oumi_model):
        provider = OumiProvider(
            model=oumi_model or "oumi-iris-decision",
            base_url=oumi_url or "https://api.oumi.ai/v1",
            api_key_env="OUMI_API_KEY",
        )
        user_msg = (
            f"offer_pct: {offer_pct:.2f}\n"
            f"floor_pct: {floor_pct:.2f}\n"
            f"round: {round_idx}\n"
            f"context: {context}"
        )
        with contextlib.suppress(Exception):
            resp = provider.complete(
                OUMI_DECISION_SYSTEM,
                [{"role": "user", "content": user_msg}],
            )
            proposed = _parse_oumi_action(resp.text)

    return _clamp_settlement_decision(
        proposed=proposed,
        offer_pct=offer_pct,
        floor_pct=floor_pct,
        context=context,
        round_idx=round_idx,
    )


def _lookup_claim_context(claim_id: str, env: Env | None) -> dict[str, Any]:
    dom = get_domain()
    neg_cfg = dict(dom.get("negotiation") or {})
    claim_amount = float(neg_cfg.get("claim_amount", 587.30))
    counterparty = str(neg_cfg.get("counterparty", "Kappa Office Systems AR desk"))
    opening_pct = float(neg_cfg.get("opening_counter_pct", 70.0))
    floor_pct = float(neg_cfg.get("accept_floor_pct", 85.0))
    second_pct = float(neg_cfg.get("second_counter_pct", neg_cfg.get("final_counter_pct", 90.0)))
    delivery_id = "D-1042"
    invoice_id = "INV-7781"
    reason = "overcharge 168.00, short 280.00, damaged 105.00, late 34.30"

    if env is not None and env.db_path.exists():
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            with contextlib.suppress(sqlite3.OperationalError):
                row = conn.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
                if row is None:
                    row = conn.execute("SELECT * FROM claims ORDER BY rowid DESC LIMIT 1").fetchone()
                if row is not None:
                    rdict = dict(row)
                    if rdict.get("amount") is not None:
                        claim_amount = float(rdict["amount"])
                    if rdict.get("delivery_id"):
                        delivery_id = str(rdict["delivery_id"])
                    if rdict.get("invoice_id"):
                        invoice_id = str(rdict["invoice_id"])
                    if rdict.get("reason"):
                        reason = str(rdict["reason"])

    return {
        "claim_id": claim_id,
        "counterparty": counterparty,
        "claim_amount": claim_amount,
        "opening_pct": opening_pct,
        "floor_pct": floor_pct,
        "second_pct": second_pct,
        "delivery_id": delivery_id,
        "invoice_id": invoice_id,
        "reason": reason,
    }


def _generate_dialogue_with_llm(
    llm: LLMProvider,
    ctx: dict[str, Any],
    opening_eur: float,
    target_eur: float,
    final_eur: float,
    outcome: Literal["accepted", "escalated"],
) -> list[str] | None:
    """Optionally enrich turn dialogue via live LLM provider (cached in `.llm_cache/`)."""
    if isinstance(llm, FakeProvider):
        return None
    prov_env = os.getenv("LLM_PROVIDER", "fake").strip().lower()
    if prov_env == "fake" and not isinstance(llm, GeminiProvider):
        return None

    final_directive = (
        f"accept settlement at EUR {final_eur:.2f}"
        if outcome == "accepted"
        else "decline and escalate to human manager because offer is below policy floor"
    )
    prompt = (
        f"Generate a 5-turn negotiation script as a JSON array of 5 strings for claim {ctx['claim_id']} "
        f"(total EUR {ctx['claim_amount']:.2f} on delivery {ctx['delivery_id']} / invoice "
        f"{ctx['invoice_id']}; breakdown: {ctx['reason']}) with {ctx['counterparty']}.\n"
        f"- Turn 1 (agent): present {ctx['claim_id']} (EUR {ctx['claim_amount']:.2f}) and cite "
        "Master Procurement Agreement Clauses 2-4.\n"
        f"- Turn 2 (counterparty): counter-offer {ctx['opening_pct']:.0f}% (EUR {opening_eur:.2f}).\n"
        f"- Turn 3 (agent): reject {ctx['opening_pct']:.0f}% citing IT receiving log (104/120 units) "
        f"and 6 DOA quarantined units, propose 90% (EUR {target_eur:.2f}) to release {ctx['invoice_id']}.\n"
        f"- Turn 4 (counterparty): offer {ctx['second_pct']:.0f}% (EUR {final_eur:.2f}).\n"
        f"- Turn 5 (agent): {final_directive}."
    )
    cache_raw = json.dumps({"s": NEGOTIATION_TURN_SYSTEM, "p": prompt}, sort_keys=True)
    cache_key = hashlib.sha256(cache_raw.encode("utf-8")).hexdigest()
    cache_file = llm_mod.CACHE_DIR / f"neg_{cache_key}.json"
    use_cache = os.getenv("LLM_CACHE", "1") == "1"

    if use_cache and cache_file.exists():
        with contextlib.suppress(Exception):
            cached_lines = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(cached_lines, list) and len(cached_lines) == 5:
                return [str(x) for x in cached_lines]

    with contextlib.suppress(Exception):
        resp = llm.complete(NEGOTIATION_TURN_SYSTEM, [{"role": "user", "content": prompt}])
        text = resp.text.strip()
        fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        if fence:
            text = fence.group(1).strip()
        parsed = json.loads(text)
        if isinstance(parsed, list) and len(parsed) == 5 and all(str(x).strip() for x in parsed):
            lines = [str(x).strip() for x in parsed]
            if use_cache:
                llm_mod.CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(json.dumps(lines, indent=2), encoding="utf-8")
            return lines
    return None


def run_vendor_negotiation(
    claim_id: str,
    env: Env,
    llm: LLMProvider | None = None,
    *,
    accept_floor_pct: float | None = None,
    second_offer_pct: float | None = None,
) -> tuple[list[CallTurnPayload], CallEndPayload]:
    """Run a 5-turn supplier settlement negotiation with deterministic policy floor enforcement."""
    provider = llm or get_provider()
    ctx = _lookup_claim_context(claim_id, env)
    if accept_floor_pct is not None:
        ctx["floor_pct"] = float(accept_floor_pct)
    if second_offer_pct is not None:
        ctx["second_pct"] = float(second_offer_pct)

    call_id = f"call_{claim_id.lower().replace('-', '_')}_{uuid.uuid4().hex[:6]}"
    claim_amount = float(ctx["claim_amount"])
    opening_pct = float(ctx["opening_pct"])
    floor_pct = float(ctx["floor_pct"])
    second_pct = float(ctx["second_pct"])
    counterparty = str(ctx["counterparty"])
    invoice_id = str(ctx["invoice_id"])
    delivery_id = str(ctx["delivery_id"])
    reason = str(ctx["reason"])

    opening_eur = round(claim_amount * (opening_pct / 100.0), 2)
    target_pct = 90.0
    target_eur = round(claim_amount * (target_pct / 100.0), 2)
    final_eur = round(claim_amount * (second_pct / 100.0), 2)

    # Decision Check 1: evaluate counterparty opening counter-offer (70% vs 85% floor)
    decision_1 = decide_settlement_action(
        offer_pct=opening_pct,
        floor_pct=floor_pct,
        context=(
            f"Claim {claim_id} (EUR {claim_amount:.2f}) opening counterparty offer at {opening_pct:.1f}% "
            f"(EUR {opening_eur:.2f}) vs policy floor {floor_pct:.1f}%."
        ),
        round_idx=1,
    )
    if opening_pct < floor_pct and decision_1 == "accept":
        decision_1 = "counter"

    # Decision Check 2: evaluate counterparty second offer (default 90% vs 85% floor)
    decision_2 = decide_settlement_action(
        offer_pct=second_pct,
        floor_pct=floor_pct,
        context=(
            f"Claim {claim_id} (EUR {claim_amount:.2f}) final counterparty offer at {second_pct:.1f}% "
            f"(EUR {final_eur:.2f}) vs policy floor {floor_pct:.1f}%."
        ),
        round_idx=2,
    )

    if second_pct >= floor_pct and decision_2 == "accept":
        outcome: Literal["accepted", "escalated"] = "accepted"
        agreed_amount: float | None = final_eur
    else:
        outcome = "escalated"
        agreed_amount = None

    default_lines = [
        (
            f"[Recoup Procurement Agent] Calling {counterparty} regarding credit claim {claim_id} "
            f"for EUR {claim_amount:.2f} on shipment {delivery_id} (invoice {invoice_id}: {reason}) "
            "under Master Procurement Agreement Clauses 2-4."
        ),
        (
            f"[{counterparty}] We reviewed {claim_id} on {invoice_id}, but we dispute the full SLA penalty "
            f"and can offer an immediate {opening_pct:.0f}% goodwill credit note of EUR {opening_eur:.2f}."
        ),
        (
            f"[Recoup Procurement Agent] We cannot accept {opening_pct:.0f}% (EUR {opening_eur:.2f}), "
            f"which is below our {floor_pct:.0f}% governance floor. Our Floor 4 IT receiving log and RMA "
            "quarantine photos confirm 104 of 120 HUB-USBC units delivered and 6 DOA units; we propose a "
            f"90% immediate credit note (EUR {target_eur:.2f}) to release the AP payment hold on "
            f"{invoice_id} today."
        ),
        (
            f"[{counterparty}] Understood — to close the dispute and release {invoice_id} for payment, "
            f"we can authorize a {second_pct:.0f}% credit note for EUR {final_eur:.2f} on {claim_id}."
        ),
        (
            (
                f"[Recoup Procurement Agent] Agreed. {second_pct:.0f}% (EUR {final_eur:.2f}) meets our "
                f"{floor_pct:.0f}% settlement policy floor. Recording EUR {final_eur:.2f} credit settlement "
                f"for {claim_id} and scheduling {invoice_id} hold release."
            )
            if outcome == "accepted"
            else (
                f"[Recoup Procurement Agent] Your {second_pct:.0f}% offer (EUR {final_eur:.2f}) remains "
                f"below our mandatory {floor_pct:.0f}% settlement floor. Keeping {invoice_id} on disputed "
                f"hold and escalating {claim_id} to our Finance & Workplace Operations Manager."
            )
        ),
    ]

    llm_lines = _generate_dialogue_with_llm(
        provider,
        ctx=ctx,
        opening_eur=opening_eur,
        target_eur=target_eur,
        final_eur=final_eur,
        outcome=outcome,
    )
    script = llm_lines if llm_lines and len(llm_lines) == 5 else default_lines

    turns: list[CallTurnPayload] = [
        CallTurnPayload(
            call_id=call_id,
            speaker="agent",
            text=script[0],
            offer_pct=100.0,
        ),
        CallTurnPayload(
            call_id=call_id,
            speaker="counterparty",
            text=script[1],
            offer_pct=opening_pct,
        ),
        CallTurnPayload(
            call_id=call_id,
            speaker="agent",
            text=script[2],
            offer_pct=target_pct,
        ),
        CallTurnPayload(
            call_id=call_id,
            speaker="counterparty",
            text=script[3],
            offer_pct=second_pct,
        ),
        CallTurnPayload(
            call_id=call_id,
            speaker="agent",
            text=script[4],
            offer_pct=second_pct if outcome == "accepted" else None,
        ),
    ]

    if outcome == "accepted":
        summary = (
            f"Settled {claim_id} with {counterparty} at {second_pct:.0f}% "
            f"(EUR {final_eur:.2f} of EUR {claim_amount:.2f}, >= {floor_pct:.0f}% policy floor)."
        )
    else:
        summary = (
            f"Escalated {claim_id} to human manager: counterparty offer {second_pct:.0f}% "
            f"(EUR {final_eur:.2f}) is below the {floor_pct:.0f}% policy floor."
        )

    end_payload = CallEndPayload(
        call_id=call_id,
        outcome=outcome,
        agreed_amount=agreed_amount,
        summary=summary,
    )
    return turns, end_payload
