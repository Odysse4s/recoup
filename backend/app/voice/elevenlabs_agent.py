"""Executive Risk Gate voice briefings, spoken command parsing, and vendor call turns."""
from __future__ import annotations

import base64
import hashlib
import os
import re
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import httpx

from ..contracts import ApprovalNeededPayload, CallEndPayload, CallTurnPayload, ChangeReport
from ..domain_config import brand

DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
DEFAULT_ELEVENLABS_MODEL = "eleven_turbo_v2_5"
DEFAULT_FAL_TTS_MODEL = "fal-ai/elevenlabs/tts/eleven-v3"
DEFAULT_WONDERFUL_TTS_URL = "https://api.wonderful.ai/v1/tts"

VOICE_CACHE_DIR = Path(__file__).resolve().parents[2] / ".voice_cache"

_CLAIM_ID_RE = re.compile(r"\b(CLM-[A-Z0-9-]+)\b", re.IGNORECASE)
_INVOICE_ID_RE = re.compile(r"\bINV-([A-Z0-9-]+)\b", re.IGNORECASE)
_EUR_AMOUNT_RE = re.compile(
    r"(?:EUR|€)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:EUR|euros?)",
    re.IGNORECASE,
)

_APPROVE_PATTERNS: tuple[str, ...] = (
    r"ship\s+it",
    r"go\s+ahead",
    r"send\s+it",
    r"looks\s+good",
    r"approv(?:e|ed)",
    r"confirm(?:ed)?",
    r"proceed",
    r"commit",
    r"authori[sz](?:e|ed)",
)

_REJECT_PATTERNS: tuple[str, ...] = (
    r"roll\s*back",
    r"hold\s+off",
    r"reject(?:ed)?",
    r"abort(?:ed)?",
    r"cancel(?:led|ed)?",
    r"undo",
    r"deny",
    r"denied",
    r"declin(?:e|ed)",
    r"stop",
)

_NEGATION_PREFIX = r"(?:do\s+not|don'?t|never|not)\s+"


def _spoken_eur(amount: float) -> str:
    """Render a EUR float into natural spoken English words."""
    total_cents = round(abs(float(amount)) * 100)
    euros, cents = divmod(total_cents, 100)
    euro_unit = "euro" if euros == 1 else "euros"
    if cents == 0:
        return f"{euros} {euro_unit}"
    cent_unit = "cent" if cents == 1 else "cents"
    return f"{euros} {euro_unit} and {cents} {cent_unit}"


def _clean_vendor_name(raw_vendor: str) -> str:
    """Shorten corporate/desk suffixes so spoken briefings stay crisp and under 35 words."""
    cleaned = raw_vendor.strip()
    cleaned = re.sub(r"\s+(?:S\.A\.|SA|Inc\.?|Ltd\.?|GmbH|LLC)\b.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+(?:AR|AP|billing)\s+(?:desk|team|department)\b.*$", "", cleaned, flags=re.IGNORECASE)
    words = cleaned.split()
    return " ".join(words[:4])


def _extract_vendor_from_text_or_outbox(texts: list[str], outbox: list[dict[str, Any]], args: dict[str, Any]) -> str:
    for explicit_key in ("vendor", "counterparty", "supplier", "supplier_name"):
        val = args.get(explicit_key)
        if isinstance(val, str) and val.strip():
            return _clean_vendor_name(val)

    for item in outbox:
        cp = item.get("counterparty") or item.get("vendor")
        if isinstance(cp, str) and cp.strip():
            return _clean_vendor_name(cp)

    corpus = "\n".join(texts)
    hello_match = re.search(r"Hello\s+([A-Z][A-Za-z0-9 &.-]{2,40}?)(?:,|\n)", corpus)
    if hello_match:
        return _clean_vendor_name(hello_match.group(1))

    for known in ("Kappa Office Systems", "Nova Workplace Cloud"):
        if known.lower() in corpus.lower():
            return known

    for item in [*outbox, args]:
        to_addr = item.get("to")
        if isinstance(to_addr, str) and "@" in to_addr:
            domain_part = to_addr.split("@", 1)[1].split(".", 1)[0]
            if domain_part:
                return domain_part.replace("-", " ").title()

    return ""


def build_briefing_script(summary: dict[str, Any]) -> str:
    """Convert a `ChangeReport` or `ApprovalNeededPayload` into a <35-word Risk Gate script."""
    if isinstance(summary, (ChangeReport, ApprovalNeededPayload)):
        data: dict[str, Any] = summary.model_dump()
    elif isinstance(summary, dict):
        data = dict(summary)
    else:
        data = {}

    brand_name = brand().get("brand_name", "Recoup")
    cta = "Say approve to commit, or reject to roll back."

    nested_report = data.get("report")
    report: dict[str, Any]
    if isinstance(nested_report, ChangeReport):
        report = nested_report.model_dump()
    elif isinstance(nested_report, dict):
        report = nested_report
    else:
        report = data

    args = data.get("args") if isinstance(data.get("args"), dict) else {}
    row = args.get("row") if isinstance(args.get("row"), dict) else {}
    outbox: list[dict[str, Any]] = [
        item for item in (report.get("external_outbox") or []) if isinstance(item, dict)
    ]
    tool_name = str(data.get("tool_name") or "")
    if tool_name in ("send_email", "place_call", "trigger_webhook") and not outbox:
        outbox = [{"tool": tool_name, **args}]

    files_created = [str(p) for p in (report.get("files_created") or [])]
    files_modified = report.get("files_modified") or []
    db_summary = report.get("db_summary") if isinstance(report.get("db_summary"), dict) else {}

    searchable_texts: list[str] = [
        *files_created,
        str(data.get("diff_preview") or ""),
        str(data.get("risk_reason") or ""),
    ]
    for mod in files_modified:
        if isinstance(mod, dict):
            searchable_texts.append(str(mod.get("path") or ""))
            searchable_texts.append(str(mod.get("diff") or ""))
    for item in outbox:
        for field in ("subject", "body", "purpose", "event"):
            if item.get(field):
                searchable_texts.append(str(item[field]))

    corpus = "\n".join(searchable_texts)

    # 1. Claim ID
    claim_id = ""
    for candidate in (
        data.get("claim_id"),
        args.get("claim_id"),
        row.get("id") if str(row.get("id", "")).upper().startswith("CLM-") else None,
        *(item.get("claim_id") for item in outbox),
    ):
        if isinstance(candidate, str) and candidate.strip():
            claim_id = candidate.strip().upper()
            break
    if not claim_id:
        m_claim = _CLAIM_ID_RE.search(corpus)
        if m_claim:
            claim_id = m_claim.group(1).upper()

    # 2. Claim / mutation amount
    amount: float | None = None
    for num_candidate in (
        data.get("claim_amount"),
        data.get("amount"),
        args.get("claim_amount"),
        row.get("amount"),
        *(item.get("claim_amount") for item in outbox),
    ):
        if isinstance(num_candidate, (int, float)) and not isinstance(num_candidate, bool):
            amount = float(num_candidate)
            break
    if amount is None:
        priority_corpus = "\n".join(
            [
                *(str(item.get("subject") or "") for item in outbox),
                *(str(item.get("body") or "") for item in outbox),
                *(
                    line
                    for line in corpus.splitlines()
                    if "total" in line.lower() or "credit" in line.lower() or "claim" in line.lower()
                ),
                corpus,
            ]
        )
        m_amt = _EUR_AMOUNT_RE.search(priority_corpus)
        if m_amt:
            raw_num = (m_amt.group(1) or m_amt.group(2) or "").replace(",", "")
            if raw_num:
                amount = float(raw_num)

    # 3. Invoice hold detection
    invoice_num = ""
    raw_inv = data.get("invoice_id") or args.get("invoice_id") or row.get("invoice_id")
    if isinstance(raw_inv, str) and raw_inv.strip():
        invoice_num = re.sub(r"^INV-", "", raw_inv.strip(), flags=re.IGNORECASE)
    elif str(row.get("id", "")).upper().startswith("INV-"):
        invoice_num = re.sub(r"^INV-", "", str(row["id"]).strip(), flags=re.IGNORECASE)
    else:
        m_inv = _INVOICE_ID_RE.search(corpus)
        if m_inv:
            invoice_num = m_inv.group(1)

    invoices_touched = bool(db_summary.get("invoices")) or (
        args.get("table") == "invoices" and row.get("status") == "disputed"
    )
    has_invoice_hold = bool(invoice_num and (invoices_touched or "hold" in corpus.lower() or outbox))

    # 4. Outbound channel + vendor
    vendor = _extract_vendor_from_text_or_outbox(
        searchable_texts,
        outbox,
        {**data, **args},
    )
    outbound_clause = ""
    if outbox:
        primary_tool = str(outbox[0].get("tool") or tool_name)
        if primary_tool == "send_email":
            outbound_clause = f"queued an email to {vendor}" if vendor else "queued a vendor email"
        elif primary_tool == "place_call":
            outbound_clause = f"staged a call to {vendor}" if vendor else "staged a vendor call"
        elif primary_tool == "trigger_webhook":
            outbound_clause = "staged an ERP webhook"

    # Assemble concise clauses
    clauses: list[str] = []
    if claim_id and amount is not None:
        clauses.append(f"rehearsed claim {claim_id} for {_spoken_eur(amount)}")
    elif claim_id:
        clauses.append(f"rehearsed claim {claim_id}")
    elif amount is not None:
        clauses.append(f"rehearsed a vendor credit for {_spoken_eur(amount)}")

    if has_invoice_hold and invoice_num:
        clauses.append(f"placed invoice {invoice_num} on hold")
    elif invoices_touched:
        clauses.append("placed the disputed invoice on hold")

    if outbound_clause:
        clauses.append(outbound_clause)

    if clauses:
        if len(clauses) == 1:
            lead = f"{brand_name} {clauses[0]}."
        elif len(clauses) == 2:
            lead = f"{brand_name} {clauses[0]} and {clauses[1]}."
        else:
            lead = f"{brand_name} {', '.join(clauses[:-1])}, and {clauses[-1]}."
    else:
        db_mutations = sum(
            sum(int(v) for v in counts.values() if isinstance(v, int))
            for counts in db_summary.values()
            if isinstance(counts, dict)
        )
        file_changes = len(files_created) + len(files_modified) + len(report.get("files_deleted") or [])
        if db_mutations or file_changes:
            parts: list[str] = []
            if db_mutations:
                unit = "change" if db_mutations == 1 else "changes"
                parts.append(f"{db_mutations} database {unit}")
            if file_changes:
                f_unit = "edit" if file_changes == 1 else "edits"
                parts.append(f"{file_changes} file {f_unit}")
            lead = f"{brand_name} rehearsed {' and '.join(parts)} in an isolated copy."
        else:
            lead = f"{brand_name} rehearsed staged workspace changes at the Risk Gate."

    # Enforce strict <35-word executive budget (`cta` is 9 words -> `lead` max 25 words)
    max_lead_words = 34 - len(cta.split())
    lead_words = lead.split()
    if len(lead_words) > max_lead_words:
        trimmed = " ".join(lead_words[:max_lead_words]).rstrip(",;:")
        while trimmed.split() and trimmed.split()[-1].lower() in ("and", "to", "for", "on", "a", "an", "the"):
            trimmed = " ".join(trimmed.split()[:-1]).rstrip(",;:")
        lead = f"{trimmed}."

    return f"{lead} {cta}"


def _get_cache_dir() -> Path:
    env_override = os.getenv("VOICE_CACHE_DIR", "").strip()
    if env_override:
        return Path(env_override)
    return VOICE_CACHE_DIR


def _resolve_fal_endpoint(raw_model: str) -> str:
    cleaned = raw_model.strip().strip("/")
    if not cleaned:
        return DEFAULT_FAL_TTS_MODEL
    if "/" in cleaned:
        return cleaned
    lowered = cleaned.lower()
    if lowered in ("eleven_turbo_v2_5", "eleven_turbo_v2", "turbo-v2.5", "turbo_v2_5"):
        return "fal-ai/elevenlabs/tts/turbo-v2.5"
    if lowered in ("eleven-v3", "eleven_v3"):
        return "fal-ai/elevenlabs/tts/eleven-v3"
    return f"fal-ai/elevenlabs/tts/{cleaned}"


def _extract_audio_bytes_from_response(resp: httpx.Response, client: httpx.Client) -> bytes | None:
    content_type = (resp.headers.get("content-type") or "").lower()
    if content_type.startswith(("audio/", "application/octet-stream")):
        return resp.content if resp.content else None

    try:
        payload = resp.json()
    except ValueError:
        return resp.content if resp.content else None

    if not isinstance(payload, dict):
        return None

    audio_field = payload.get("audio")
    audio_url: str | None = None
    if isinstance(audio_field, dict) and isinstance(audio_field.get("url"), str):
        audio_url = audio_field["url"]
    elif isinstance(audio_field, str) and audio_field.startswith(("http://", "https://")):
        audio_url = audio_field
    elif isinstance(payload.get("audio_url"), str):
        audio_url = payload["audio_url"]
    elif isinstance(payload.get("url"), str):
        audio_url = payload["url"]

    if audio_url:
        dl = client.get(audio_url)
        dl.raise_for_status()
        return dl.content if dl.content else None

    b64 = payload.get("audio_base64") or (
        audio_field.get("base64") if isinstance(audio_field, dict) else None
    )
    if isinstance(b64, str) and b64.strip():
        return base64.b64decode(b64)

    return None


def _synthesize_via_fal(text: str, voice_id: str | None, api_key: str) -> bytes | None:
    endpoint = _resolve_fal_endpoint(os.getenv("FAL_TTS_MODEL", ""))
    url = f"https://fal.run/{endpoint}"
    body: dict[str, Any] = {"text": text}
    chosen_voice = voice_id or os.getenv("FAL_VOICE_ID", "").strip()
    if chosen_voice:
        body["voice"] = chosen_voice

    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        resp = client.post(
            url,
            headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
        return _extract_audio_bytes_from_response(resp, client)


def _synthesize_via_elevenlabs(text: str, resolved_voice: str, api_key: str) -> bytes | None:
    model_id = os.getenv("ELEVENLABS_MODEL_ID", DEFAULT_ELEVENLABS_MODEL).strip() or DEFAULT_ELEVENLABS_MODEL
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{resolved_voice}"
    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        resp = client.post(
            url,
            headers={
                "xi-api-key": api_key,
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": model_id,
                "voice_settings": {"stability": 0.45, "similarity_boost": 0.8},
            },
        )
        resp.raise_for_status()
        return resp.content if resp.content else None


def _synthesize_via_wonderful(text: str, resolved_voice: str, api_key: str) -> bytes | None:
    url = os.getenv("WONDERFUL_TTS_URL", DEFAULT_WONDERFUL_TTS_URL).strip() or DEFAULT_WONDERFUL_TTS_URL
    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        resp = client.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={"text": text, "voice_id": resolved_voice},
        )
        resp.raise_for_status()
        return _extract_audio_bytes_from_response(resp, client)


def synthesize_briefing(text: str, voice_id: str | None = None) -> bytes | None:
    """Synthesize a spoken MP3 briefing with SHA-256 disk caching and multi-provider fallback."""
    cleaned = (text or "").strip()
    if not cleaned:
        return None

    explicit_voice = (voice_id or "").strip() or None
    resolved_voice = explicit_voice or os.getenv("ELEVENLABS_VOICE_ID", "").strip() or DEFAULT_VOICE_ID
    cache_key = hashlib.sha256(f"{resolved_voice}:{cleaned}".encode()).hexdigest()

    cache_dir = _get_cache_dir()
    cache_path = cache_dir / f"{cache_key}.mp3"
    if cache_path.is_file():
        cached_bytes = cache_path.read_bytes()
        if cached_bytes:
            return cached_bytes

    provider_pref = os.getenv("VOICE_PROVIDER", "").strip().lower()
    if provider_pref in ("none", "offline", "fake", "disabled"):
        return None

    fal_key = os.getenv("FAL_KEY", "").strip()
    eleven_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    wonderful_key = os.getenv("WONDERFUL_API_KEY", "").strip()

    if not (fal_key or eleven_key or wonderful_key):
        return None

    order = ["fal", "elevenlabs", "wonderful"]
    if provider_pref in order:
        order = [provider_pref, *[p for p in order if p != provider_pref]]

    for provider in order:
        try:
            audio_bytes: bytes | None = None
            if provider == "fal" and fal_key:
                audio_bytes = _synthesize_via_fal(cleaned, explicit_voice, fal_key)
            elif provider == "elevenlabs" and eleven_key:
                audio_bytes = _synthesize_via_elevenlabs(cleaned, resolved_voice, eleven_key)
            elif provider == "wonderful" and wonderful_key:
                audio_bytes = _synthesize_via_wonderful(cleaned, resolved_voice, wonderful_key)

            if audio_bytes:
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(audio_bytes)
                return audio_bytes
        except httpx.HTTPError:
            continue

    return None


def parse_voice_decision(transcript: str) -> str:
    """Classify a spoken Risk Gate response into `'approve' | 'reject' | 'unknown'`."""
    if not isinstance(transcript, str) or not transcript.strip():
        return "unknown"

    normalized = re.sub(r"[^\w\s']", " ", transcript.lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return "unknown"

    approve_hit = False
    reject_hit = False

    # Negated approve commands (e.g. "do not approve", "don't ship it") count as rejection
    for pat in _APPROVE_PATTERNS:
        neg_re = re.compile(rf"\b{_NEGATION_PREFIX}(?:{pat})\b")
        if neg_re.search(normalized):
            reject_hit = True
            normalized = neg_re.sub(" ", normalized)

    # Negated reject commands (e.g. "don't cancel") neutralize the reject keyword
    for pat in _REJECT_PATTERNS:
        neg_re = re.compile(rf"\b{_NEGATION_PREFIX}(?:{pat})\b")
        if neg_re.search(normalized):
            normalized = neg_re.sub(" ", normalized)

    for pat in _APPROVE_PATTERNS:
        if re.search(rf"\b(?:{pat})\b", normalized):
            approve_hit = True
            break

    for pat in _REJECT_PATTERNS:
        if re.search(rf"\b(?:{pat})\b", normalized):
            reject_hit = True
            break

    if approve_hit and not reject_hit:
        return "approve"
    if reject_hit and not approve_hit:
        return "reject"
    return "unknown"


def _pct_eur(total: float, pct: float) -> float:
    """Compute percentage of a EUR amount using commercial ROUND_HALF_UP cent rounding."""
    d_total = Decimal(str(max(0.0, float(total))))
    d_pct = Decimal(str(float(pct)))
    val = (d_total * d_pct / Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(val)


def simulate_vendor_negotiation_turns(
    claim_id: str,
    claim_amount: float,
    opening_pct: float = 70.0,
    floor_pct: float = 85.0,
) -> list[dict[str, Any]]:
    """Generate structured `CallTurnPayload`-compatible turns for a vendor settlement call."""
    clean_claim = (claim_id or "CLM-UNKNOWN").strip()
    call_id = f"CALL-{clean_claim}"
    total = _pct_eur(claim_amount, 100.0)
    open_p = round(float(opening_pct), 1)
    floor_p = round(float(floor_pct), 1)

    open_amt = _pct_eur(total, open_p)
    floor_amt = _pct_eur(total, floor_p)

    raw_turns: list[CallTurnPayload] = [
        CallTurnPayload(
            call_id=call_id,
            speaker="agent",
            text=(
                f"Hello, calling from Recoup procurement operations regarding credit claim {clean_claim} "
                f"for EUR {total:.2f} backed by our stockroom inspection log and master contract terms."
            ),
            offer_pct=100.0,
        ),
    ]

    if open_p >= floor_p:
        raw_turns.extend(
            [
                CallTurnPayload(
                    call_id=call_id,
                    speaker="counterparty",
                    text=(
                        f"We reviewed {clean_claim} on our AR desk and can issue an immediate "
                        f"{open_p:g}% credit note for EUR {open_amt:.2f} today."
                    ),
                    offer_pct=open_p,
                ),
                CallTurnPayload(
                    call_id=call_id,
                    speaker="agent",
                    text=(
                        f"Confirmed. {open_p:g}% (EUR {open_amt:.2f}) meets our {floor_p:g}% governance "
                        f"floor; logging the settlement against {clean_claim}."
                    ),
                    offer_pct=open_p,
                ),
            ]
        )
    elif floor_p <= 100.0:
        settled_p = floor_p
        settled_amt = floor_amt
        raw_turns.extend(
            [
                CallTurnPayload(
                    call_id=call_id,
                    speaker="counterparty",
                    text=(
                        f"We see the receiving discrepancy on {clean_claim}, and can offer an expedited "
                        f"{open_p:g}% credit note of EUR {open_amt:.2f} to close the dispute today."
                    ),
                    offer_pct=open_p,
                ),
                CallTurnPayload(
                    call_id=call_id,
                    speaker="agent",
                    text=(
                        f"Per procurement policy we cannot accept {open_p:g}%. With verified short-shipped, "
                        f"DOA, and late SLA items, we can settle immediately at {floor_p:g}% (EUR {floor_amt:.2f}) "
                        f"or maintain the full EUR {total:.2f} invoice hold."
                    ),
                    offer_pct=floor_p,
                ),
                CallTurnPayload(
                    call_id=call_id,
                    speaker="counterparty",
                    text=(
                        f"Understood. To release the invoice hold, we can authorize {settled_p:g}% — a credit "
                        f"note of EUR {settled_amt:.2f} on {clean_claim} issued today."
                    ),
                    offer_pct=settled_p,
                ),
                CallTurnPayload(
                    call_id=call_id,
                    speaker="agent",
                    text=(
                        f"Agreed at {settled_p:g}% (EUR {settled_amt:.2f}), meeting our {floor_p:g}% policy "
                        f"threshold. Recording provisional settlement for {clean_claim}."
                    ),
                    offer_pct=settled_p,
                ),
            ]
        )
    else:
        capped_p = min(100.0, round(open_p + 10.0, 1))
        capped_amt = _pct_eur(total, capped_p)
        raw_turns.extend(
            [
                CallTurnPayload(
                    call_id=call_id,
                    speaker="counterparty",
                    text=(
                        f"Our best credit authorization on {clean_claim} is {capped_p:g}% "
                        f"(EUR {capped_amt:.2f})."
                    ),
                    offer_pct=capped_p,
                ),
                CallTurnPayload(
                    call_id=call_id,
                    speaker="agent",
                    text=(
                        f"{capped_p:g}% remains below our {floor_p:g}% threshold; keeping the invoice on hold "
                        f"and escalating {clean_claim} to human procurement leadership."
                    ),
                    offer_pct=None,
                ),
            ]
        )

    return [turn.model_dump() for turn in raw_turns]


def summarize_negotiation_outcome(
    claim_id: str,
    claim_amount: float,
    turns: list[dict[str, Any]],
    floor_pct: float = 85.0,
) -> dict[str, Any]:
    """Build a `CallEndPayload` dictionary from completed negotiation turns."""
    clean_claim = (claim_id or "CLM-UNKNOWN").strip()
    call_id = turns[0].get("call_id", f"CALL-{clean_claim}") if turns else f"CALL-{clean_claim}"
    counterparty_offers = [
        float(t["offer_pct"])
        for t in turns
        if t.get("speaker") == "counterparty" and isinstance(t.get("offer_pct"), (int, float))
    ]
    best_pct = max(counterparty_offers) if counterparty_offers else 0.0
    if best_pct >= float(floor_pct):
        agreed = _pct_eur(claim_amount, best_pct)
        end = CallEndPayload(
            call_id=call_id,
            outcome="accepted",
            agreed_amount=agreed,
            summary=f"Settled {clean_claim} at {best_pct:g}% (EUR {agreed:.2f}).",
        )
    else:
        end = CallEndPayload(
            call_id=call_id,
            outcome="escalated",
            agreed_amount=None,
            summary=f"Counterparty peaked at {best_pct:g}% (< {floor_pct:g}% floor); escalated {clean_claim}.",
        )
    return end.model_dump()
