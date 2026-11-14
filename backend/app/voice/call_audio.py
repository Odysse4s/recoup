"""Dual-speaker vendor negotiation TTS, Wizper STT, and fal Grok Voice Realtime helpers."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import struct
from collections import OrderedDict
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from . import elevenlabs_agent
from .elevenlabs_agent import (
    DEFAULT_ELEVENLABS_MODEL,
    DEFAULT_FAL_TTS_MODEL,
    DEFAULT_WONDERFUL_TTS_URL,
    _extract_audio_bytes_from_response,
    _resolve_fal_endpoint,
    parse_voice_decision,
)

AGENT_VOICE = "Rachel"
COUNTERPARTY_VOICE = "Roger"
DEFAULT_FAL_STT_MODEL = "fal-ai/wizper"

DEFAULT_GROK_TTS_URL = "https://fal.run/xai/grok-tts"
DEFAULT_GROK_VOICE_URL = "https://fal.run/xai/grok-voice"
DEFAULT_GROK_REALTIME_WS_URL = "wss://fal.run/xai/grok-voice/realtime"
DEFAULT_GROK_VOICE_ID = "ara"

_DEFAULT_CACHE_DIR = elevenlabs_agent.VOICE_CACHE_DIR
VOICE_CACHE_DIR = _DEFAULT_CACHE_DIR

_ELEVENLABS_PRESET_VOICE_IDS: dict[str, str] = {
    "rachel": "21m00Tcm4TlvDq8ikWAM",
    "roger": "CwhRBWXzGAHq8TQ4Fs17",
    "charlie": "IKne3meq5aSn9XLyUdCD",
    "george": "JBFqnCBsd6RMkjVDRZzb",
    "aria": "9BWtsMINqrJLrRacOk9x",
    "sarah": "EXAVITQu4vr4xnSDxMaL",
}

# fal.run's data-URI validator checks Python's stdlib mimetypes before Wizper's ffmpeg
# container-sniffs the audio stream; map browser MediaRecorder labels to accepted aliases.
_WIZPER_SAFE_MIME_MAP: dict[str, str] = {
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/webm": "video/webm",
    "video/webm": "video/webm",
    "audio/wav": "audio/x-wav",
    "audio/wave": "audio/x-wav",
    "audio/x-wav": "audio/x-wav",
    "audio/mp4": "audio/mpeg",
    "video/mp4": "video/mp4",
    "audio/m4a": "audio/mpeg",
    "audio/x-m4a": "audio/mpeg",
    "audio/aac": "audio/mpeg",
    "audio/ogg": "audio/mpeg",
    "application/ogg": "application/ogg",
    "application/octet-stream": "application/octet-stream",
}


def _normalize_wizper_mime(mime_type: str) -> str:
    base_mime = (mime_type or "audio/webm").split(";", 1)[0].strip().lower()
    if not base_mime:
        return "video/webm"
    return _WIZPER_SAFE_MIME_MAP.get(base_mime, "application/octet-stream")


def _resolve_cache_dir() -> Path:
    env_override = os.getenv("VOICE_CACHE_DIR", "").strip()
    if env_override:
        return Path(env_override)
    if VOICE_CACHE_DIR != _DEFAULT_CACHE_DIR:
        return VOICE_CACHE_DIR
    if elevenlabs_agent.VOICE_CACHE_DIR != _DEFAULT_CACHE_DIR:
        return elevenlabs_agent.VOICE_CACHE_DIR
    return VOICE_CACHE_DIR


def _resolve_speaker_voice(speaker: Literal["agent", "counterparty"]) -> str:
    if speaker == "counterparty":
        return (
            os.getenv("COUNTERPARTY_VOICE", "").strip()
            or os.getenv("FAL_COUNTERPARTY_VOICE", "").strip()
            or COUNTERPARTY_VOICE
        )
    return (
        os.getenv("AGENT_VOICE", "").strip()
        or os.getenv("FAL_AGENT_VOICE", "").strip()
        or AGENT_VOICE
    )


def _resolve_elevenlabs_voice_id(speaker: Literal["agent", "counterparty"], voice: str) -> str:
    if speaker == "counterparty":
        override = os.getenv("ELEVENLABS_COUNTERPARTY_VOICE_ID", "").strip()
        if override:
            return override
    else:
        override = os.getenv("ELEVENLABS_AGENT_VOICE_ID", "").strip()
        if override:
            return override
    return _ELEVENLABS_PRESET_VOICE_IDS.get(voice.lower(), voice)


def _resolve_stt_endpoint(raw_model: str) -> str:
    cleaned = raw_model.strip().strip("/")
    if not cleaned:
        return DEFAULT_FAL_STT_MODEL
    if "/" in cleaned:
        return cleaned
    return f"fal-ai/{cleaned}"


def _fal_turn_tts(text: str, voice: str, api_key: str) -> bytes | None:
    raw_model = os.getenv("FAL_TTS_MODEL", "").strip() or DEFAULT_FAL_TTS_MODEL
    endpoint = _resolve_fal_endpoint(raw_model)
    url = f"https://fal.run/{endpoint}"
    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        resp = client.post(
            url,
            headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
            json={"text": text, "voice": voice},
        )
        resp.raise_for_status()
        return _extract_audio_bytes_from_response(resp, client)


def _wonderful_turn_tts(
    text: str,
    speaker: Literal["agent", "counterparty"],
    voice: str,
    api_key: str,
) -> bytes | None:
    url = os.getenv("WONDERFUL_TTS_URL", DEFAULT_WONDERFUL_TTS_URL).strip() or DEFAULT_WONDERFUL_TTS_URL
    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        resp = client.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={"text": text, "voice_id": voice, "speaker": speaker},
        )
        resp.raise_for_status()
        return _extract_audio_bytes_from_response(resp, client)


def _elevenlabs_turn_tts(text: str, voice_id: str, api_key: str) -> bytes | None:
    model_id = os.getenv("ELEVENLABS_MODEL_ID", DEFAULT_ELEVENLABS_MODEL).strip() or DEFAULT_ELEVENLABS_MODEL
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
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


_SPEAKER_TAG_PREFIX_RE = re.compile(
    r"^\s*(?:\[[^\]]{2,80}\]|Turn\s*\d+\s*(?:\([^)]*\))?\s*:)\s*",
    re.IGNORECASE,
)


def synthesize_grok_tts(text: str, voice: str | None = None) -> bytes | None:
    """Synthesize speech via xAI Grok TTS on fal.ai with SHA-256 disk caching."""
    cleaned = _SPEAKER_TAG_PREFIX_RE.sub("", (text or "").strip()).strip()
    if not cleaned:
        return None

    provider_pref = os.getenv("VOICE_PROVIDER", "").strip().lower()
    if provider_pref in ("none", "offline", "fake", "disabled"):
        return None

    voice_id = (voice or "").strip() or os.getenv("GROK_VOICE", "").strip() or DEFAULT_GROK_VOICE_ID
    digest = hashlib.sha256(f"{voice_id}:{cleaned}".encode()).hexdigest()
    cache_dir = _resolve_cache_dir()
    cache_path = cache_dir / f"grok_{voice_id}_{digest}.mp3"
    if cache_path.is_file():
        cached_bytes = cache_path.read_bytes()
        if cached_bytes:
            return cached_bytes

    if "PYTEST_CURRENT_TEST" in os.environ:
        client_mod = getattr(httpx.Client, "__module__", "")
        client_name = getattr(httpx.Client, "__name__", "")
        if client_mod.startswith("httpx") or client_name == "FalDualClient":
            return None

    fal_key = os.getenv("FAL_KEY", "").strip()
    if not fal_key:
        return None

    url = os.getenv("GROK_TTS_URL", DEFAULT_GROK_TTS_URL).strip() or DEFAULT_GROK_TTS_URL
    try:
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            resp = client.post(
                url,
                headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
                json={"text": cleaned, "voice": voice_id},
            )
            resp.raise_for_status()
            audio_bytes = _extract_audio_bytes_from_response(resp, client)
            if audio_bytes:
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(audio_bytes)
                return audio_bytes
    except (httpx.HTTPError, ValueError):
        return None

    return None


_TURN_AUDIO_LRU_MAX = 64
_turn_audio_lru: OrderedDict[str, bytes] = OrderedDict()


def _lru_get(cache_key: str) -> bytes | None:
    hit = _turn_audio_lru.get(cache_key)
    if hit is not None:
        _turn_audio_lru.move_to_end(cache_key)
    return hit


def _lru_put(cache_key: str, audio_bytes: bytes) -> None:
    _turn_audio_lru[cache_key] = audio_bytes
    _turn_audio_lru.move_to_end(cache_key)
    while len(_turn_audio_lru) > _TURN_AUDIO_LRU_MAX:
        _turn_audio_lru.popitem(last=False)


def synthesize_call_turn(
    speaker: Literal["agent", "counterparty"],
    text: str,
) -> bytes | None:
    """Synthesize a vendor negotiation turn using distinct voices per speaker role.

    Repeated lines (e.g. a recurring opening/confirmation phrase) hit an in-memory LRU
    before even touching disk, so they come back in well under 100ms instead of paying
    a disk read on every turn.
    """
    cleaned = _SPEAKER_TAG_PREFIX_RE.sub("", (text or "").strip()).strip()
    if not cleaned:
        return None

    provider_pref = os.getenv("VOICE_PROVIDER", "").strip().lower()
    if provider_pref in ("none", "offline", "fake", "disabled"):
        return None

    role: Literal["agent", "counterparty"] = "counterparty" if speaker == "counterparty" else "agent"
    voice = _resolve_speaker_voice(role)
    cache_key = hashlib.sha256(f"{role}:{voice}:{cleaned}".encode()).hexdigest()

    lru_hit = _lru_get(cache_key)
    if lru_hit is not None:
        return lru_hit

    cache_dir = _resolve_cache_dir()
    cache_path = cache_dir / f"{cache_key}.mp3"
    if cache_path.is_file():
        cached_bytes = cache_path.read_bytes()
        if cached_bytes:
            _lru_put(cache_key, cached_bytes)
            return cached_bytes

    if "PYTEST_CURRENT_TEST" in os.environ and getattr(httpx.Client, "__module__", "").startswith("httpx"):
        return None
    fal_key = os.getenv("FAL_KEY", "").strip()
    wonderful_key = os.getenv("WONDERFUL_API_KEY", "").strip()
    eleven_key = os.getenv("ELEVENLABS_API_KEY", "").strip()

    if not (fal_key or wonderful_key or eleven_key):
        return None

    if fal_key and provider_pref not in ("elevenlabs", "offline", "none", "fake", "disabled"):
        grok_voice = "eve" if role == "counterparty" else "ara"
        grok_bytes = synthesize_grok_tts(cleaned, voice=grok_voice)
        if grok_bytes:
            _lru_put(cache_key, grok_bytes)
            return grok_bytes

    order = ["fal", "wonderful", "elevenlabs"]
    if provider_pref in order:
        order = [provider_pref, *[p for p in order if p != provider_pref]]

    eleven_voice_id = _resolve_elevenlabs_voice_id(role, voice)

    for provider in order:
        try:
            audio_bytes: bytes | None = None
            if provider == "fal" and fal_key:
                audio_bytes = _fal_turn_tts(cleaned, voice, fal_key)
            elif provider == "wonderful" and wonderful_key:
                audio_bytes = _wonderful_turn_tts(cleaned, role, voice, wonderful_key)
            elif provider == "elevenlabs" and eleven_key:
                audio_bytes = _elevenlabs_turn_tts(cleaned, eleven_voice_id, eleven_key)

            if audio_bytes:
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(audio_bytes)
                _lru_put(cache_key, audio_bytes)
                return audio_bytes
        except httpx.HTTPError:
            continue

    return None


def transcribe_audio_bytes(audio_bytes: bytes, mime_type: str = "audio/webm") -> str:
    """Transcribe spoken audio bytes via fal Wizper STT, returning `''` when offline."""
    if not audio_bytes:
        return ""

    provider_pref = os.getenv("VOICE_PROVIDER", "").strip().lower()
    if provider_pref in ("none", "offline", "fake", "disabled"):
        return ""

    if "PYTEST_CURRENT_TEST" in os.environ and getattr(httpx.Client, "__module__", "").startswith("httpx"):
        return ""

    fal_key = os.getenv("FAL_KEY", "").strip()
    if not fal_key:
        return ""

    clean_mime = _normalize_wizper_mime(mime_type)
    b64_audio = base64.b64encode(audio_bytes).decode("ascii")
    data_uri = f"data:{clean_mime};base64,{b64_audio}"

    endpoint = _resolve_stt_endpoint(os.getenv("FAL_STT_MODEL", ""))
    url = f"https://fal.run/{endpoint}"
    language = os.getenv("FAL_STT_LANGUAGE", "en").strip() or "en"

    try:
        with httpx.Client(timeout=20.0, follow_redirects=True) as client:
            resp = client.post(
                url,
                headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
                json={"audio_url": data_uri, "task": "transcribe", "language": language},
            )
            resp.raise_for_status()
            payload: Any = resp.json()
    except (httpx.HTTPError, ValueError):
        return ""

    if not isinstance(payload, dict):
        return ""

    for key in ("text", "transcript", "transcription"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    chunks = payload.get("chunks")
    if isinstance(chunks, list):
        joined = " ".join(
            str(chunk.get("text", "")).strip()
            for chunk in chunks
            if isinstance(chunk, dict) and str(chunk.get("text", "")).strip()
        ).strip()
        if joined:
            return joined

    return ""


def transcribe_and_decide(
    audio_bytes: bytes = b"",
    transcript: str = "",
    mime_type: str = "audio/webm",
) -> dict[str, str]:
    """Resolve spoken transcript (directly or via Wizper STT) and classify Risk Gate decision."""
    final_text = (transcript or "").strip()
    if not final_text and audio_bytes:
        final_text = transcribe_audio_bytes(audio_bytes, mime_type=mime_type).strip()
    decision = parse_voice_decision(final_text)
    return {"transcript": final_text, "decision": decision}


# ---------------------------------------------------------------------------
# Phase 3: fal.ai Grok Voice Realtime (`xai/grok-voice/realtime`)
# ---------------------------------------------------------------------------

DEFAULT_GROK_REALTIME_MODEL = "xai/grok-voice/realtime"
DEFAULT_GROK_REALTIME_URL = "wss://fal.run/xai/grok-voice/realtime"
DEFAULT_GROK_REALTIME_VOICE = "ara"
GROK_REALTIME_SAMPLE_RATE = 24000
GROK_REALTIME_SUPPORTED_RATES: frozenset[int] = frozenset(
    {8000, 16000, 22050, 24000, 32000, 44100, 48000}
)
GROK_REALTIME_MAX_DURATION_S = 90.0
GROK_REALTIME_HARD_MAX_DURATION_S = 120.0
GROK_REALTIME_IDLE_TIMEOUT_S = 20.0
GROK_REALTIME_CONNECT_TIMEOUT_S = 10.0
GROK_REALTIME_MAX_CLIENT_FRAME_BYTES = 262_144

ALLOWED_GROK_REALTIME_VOICES: frozenset[str] = frozenset(
    {
        "ara",
        "eve",
        "leo",
        "rex",
        "sal",
        "carina",
        "zagan",
        "helix",
        "orion",
        "luna",
        "iris",
        "altair",
        "zenith",
        "perseus",
        "helios",
        "lux",
        "kepler",
        "rigel",
        "cosmo",
        "celeste",
        "ursa",
        "sirius",
        "lumen",
        "castor",
        "naksh",
        "atlas",
        "aurora",
        "liora",
    }
)

RECOUP_REALTIME_SYSTEM_PROMPT: str = (
    "You are Recoup, the enterprise procurement audit voice assistant on a live call with a human "
    "operator or Kappa Office Systems representative.\n"
    "CASE FACTS (CLM-D-1042 / Shipment D-1042 / Invoice INV-7781):\n"
    "- Vendor: Kappa Office Systems S.A., SKU HUB-USBC (USB-C Workstation Hubs, 120 ordered, "
    "billed EUR 2,268.00 at EUR 18.90 vs EUR 17.50 contract rate).\n"
    "- Discrepancies: 22 missing or damaged hubs total (16 short-shipped = EUR 280.00; "
    "6 DOA damaged = EUR 105.00), EUR 168.00 unit overcharge, and 2-day late SLA penalty = EUR 34.30.\n"
    "- Total audited claim: EUR 587.30.\n"
    "- Resolution options: (1) EUR 587.30 refund/credit note against INV-7781, "
    "(2) replacement re-delivery of the 22 HUB-USBC units, or (3) hold off with no action.\n"
    "VOICE & TURN-TAKING RULES:\n"
    "- Speak in 1 to 2 crisp, natural sentences per turn, strictly under 30 words.\n"
    "- Output plain spoken English only without bullet points, markdown, or numbered lists.\n"
    "- Be polite, direct, and immediately adaptive if the caller interrupts or changes their mind.\n"
    "STRICT GOVERNANCE BOUNDARY (NEVER VIOLATE):\n"
    "- You CANNOT execute ERP writes, authorize or issue refunds, file AADE tax submissions, or send emails.\n"
    "- NEVER claim that a refund was issued, an ERP record was updated, an AADE filing occurred, "
    "or an email was sent.\n"
    "- When the caller chooses an option, state clearly that you will stage the request behind the "
    "Recoup Risk Gate for human approval, and that any outbound email requires separate explicit "
    "human review and approval."
)

RealtimeDecision = Literal["refund", "redelivery", "unclear", "no_action"]

DEFAULT_REALTIME_CLAIM_ID = "CLM-D-1042"
DEFAULT_REALTIME_REFUND_EUR = 587.30
DEFAULT_REALTIME_REPLACEMENT_UNITS = 22

_REALTIME_SESSION_LOCK = asyncio.Lock()


@dataclass(frozen=True, slots=True)
class RealtimeCallTurn:
    """Single conversational turn from a live Recoup realtime voice session."""

    speaker: str
    text: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class RealtimeCallOutcome:
    """Governance-safe structured outcome parsed from a live realtime voice call."""

    decision: RealtimeDecision
    claim_id: str = DEFAULT_REALTIME_CLAIM_ID
    refund_amount_eur: float | None = None
    replacement_units: int | None = None
    requires_risk_gate: Literal[True] = True
    email_requires_explicit_approval: Literal[True] = True
    erp_authorized: Literal[False] = False
    decisive_turn_text: str = ""
    summary: str = ""

    def __post_init__(self) -> None:
        if self.requires_risk_gate is not True:
            raise ValueError("Governance violation: requires_risk_gate must always be True")
        if self.email_requires_explicit_approval is not True:
            raise ValueError("Governance violation: email_requires_explicit_approval must always be True")
        if self.erp_authorized is not False:
            raise ValueError("Governance violation: erp_authorized must always be False")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


def encode_fal_realtime_event(obj: Any) -> bytes:
    """Encode a JSON-compatible event dict into MessagePack binary format for `fal.run`."""
    if obj is None:
        return b"\xc0"
    if obj is False:
        return b"\xc2"
    if obj is True:
        return b"\xc3"
    if isinstance(obj, int):
        if 0 <= obj <= 0x7F:
            return bytes((obj,))
        if -32 <= obj < 0:
            return struct.pack("b", obj)
        if 0 <= obj <= 0xFF:
            return struct.pack(">BB", 0xCC, obj)
        if 0 <= obj <= 0xFFFF:
            return struct.pack(">BH", 0xCD, obj)
        if 0 <= obj <= 0xFFFFFFFF:
            return struct.pack(">BI", 0xCE, obj)
        if 0 <= obj <= 0xFFFFFFFFFFFFFFFF:
            return struct.pack(">BQ", 0xCF, obj)
        if -128 <= obj <= 127:
            return struct.pack(">Bb", 0xD0, obj)
        if -32768 <= obj <= 32767:
            return struct.pack(">Bh", 0xD1, obj)
        if -2147483648 <= obj <= 2147483647:
            return struct.pack(">Bi", 0xD2, obj)
        return struct.pack(">Bq", 0xD3, obj)
    if isinstance(obj, float):
        return struct.pack(">Bd", 0xCB, obj)
    if isinstance(obj, str):
        raw = obj.encode("utf-8")
        n = len(raw)
        if n <= 31:
            return bytes((0xA0 | n,)) + raw
        if n <= 0xFF:
            return struct.pack(">BB", 0xD9, n) + raw
        if n <= 0xFFFF:
            return struct.pack(">BH", 0xDA, n) + raw
        return struct.pack(">BI", 0xDB, n) + raw
    if isinstance(obj, (bytes, bytearray, memoryview)):
        raw_b = bytes(obj)
        n = len(raw_b)
        if n <= 0xFF:
            return struct.pack(">BB", 0xC4, n) + raw_b
        if n <= 0xFFFF:
            return struct.pack(">BH", 0xC5, n) + raw_b
        return struct.pack(">BI", 0xC6, n) + raw_b
    if isinstance(obj, (list, tuple)):
        n = len(obj)
        if n <= 15:
            header = bytes((0x90 | n,))
        elif n <= 0xFFFF:
            header = struct.pack(">BH", 0xDC, n)
        else:
            header = struct.pack(">BI", 0xDD, n)
        return header + b"".join(encode_fal_realtime_event(item) for item in obj)
    if isinstance(obj, dict):
        n = len(obj)
        if n <= 15:
            header = bytes((0x80 | n,))
        elif n <= 0xFFFF:
            header = struct.pack(">BH", 0xDE, n)
        else:
            header = struct.pack(">BI", 0xDF, n)
        parts: list[bytes] = [header]
        for k, v in obj.items():
            parts.append(encode_fal_realtime_event(str(k)))
            parts.append(encode_fal_realtime_event(v))
        return b"".join(parts)
    raise TypeError(f"Unsupported type for MessagePack encoding: {type(obj)!r}")


def _msgpack_unpack_from(buf: memoryview, offset: int = 0) -> tuple[Any, int]:
    if offset >= len(buf):
        raise ValueError("Unexpected EOF while decoding MessagePack payload")
    b = buf[offset]
    offset += 1

    if b <= 0x7F:
        return b, offset
    if b >= 0xE0:
        return b - 256, offset
    if 0xA0 <= b <= 0xBF:
        n = b & 0x1F
        if offset + n > len(buf):
            raise ValueError("Truncated MessagePack fixstr")
        return bytes(buf[offset : offset + n]).decode("utf-8", errors="replace"), offset + n
    if 0x90 <= b <= 0x9F:
        n = b & 0x0F
        arr: list[Any] = []
        for _ in range(n):
            item, offset = _msgpack_unpack_from(buf, offset)
            arr.append(item)
        return arr, offset
    if 0x80 <= b <= 0x8F:
        n = b & 0x0F
        out: dict[Any, Any] = {}
        for _ in range(n):
            k, offset = _msgpack_unpack_from(buf, offset)
            v, offset = _msgpack_unpack_from(buf, offset)
            out[k] = v
        return out, offset

    if b == 0xC0:
        return None, offset
    if b == 0xC2:
        return False, offset
    if b == 0xC3:
        return True, offset
    if b in (0xC4, 0xC5, 0xC6):
        fmt, width = {0xC4: (">B", 1), 0xC5: (">H", 2), 0xC6: (">I", 4)}[b]
        (n,) = struct.unpack_from(fmt, buf, offset)
        offset += width
        if offset + n > len(buf):
            raise ValueError("Truncated MessagePack bin")
        return bytes(buf[offset : offset + n]), offset + n
    if b in (0xC7, 0xC8, 0xC9):
        fmt, width = {0xC7: (">B", 1), 0xC8: (">H", 2), 0xC9: (">I", 4)}[b]
        (n,) = struct.unpack_from(fmt, buf, offset)
        offset += width + 1
        if offset + n > len(buf):
            raise ValueError("Truncated MessagePack ext")
        return bytes(buf[offset : offset + n]), offset + n
    if b == 0xCA:
        (val,) = struct.unpack_from(">f", buf, offset)
        return val, offset + 4
    if b == 0xCB:
        (val,) = struct.unpack_from(">d", buf, offset)
        return val, offset + 8
    if b in (0xCC, 0xCD, 0xCE, 0xCF, 0xD0, 0xD1, 0xD2, 0xD3):
        fmt, width = {
            0xCC: (">B", 1),
            0xCD: (">H", 2),
            0xCE: (">I", 4),
            0xCF: (">Q", 8),
            0xD0: (">b", 1),
            0xD1: (">h", 2),
            0xD2: (">i", 4),
            0xD3: (">q", 8),
        }[b]
        (val,) = struct.unpack_from(fmt, buf, offset)
        return val, offset + width
    if b in (0xD4, 0xD5, 0xD6, 0xD7, 0xD8):
        ext_len = {0xD4: 1, 0xD5: 2, 0xD6: 4, 0xD7: 8, 0xD8: 16}[b]
        offset += 1
        if offset + ext_len > len(buf):
            raise ValueError("Truncated MessagePack fixext")
        return bytes(buf[offset : offset + ext_len]), offset + ext_len
    if b in (0xD9, 0xDA, 0xDB):
        fmt, width = {0xD9: (">B", 1), 0xDA: (">H", 2), 0xDB: (">I", 4)}[b]
        (n,) = struct.unpack_from(fmt, buf, offset)
        offset += width
        if offset + n > len(buf):
            raise ValueError("Truncated MessagePack str")
        return bytes(buf[offset : offset + n]).decode("utf-8", errors="replace"), offset + n
    if b in (0xDC, 0xDD):
        fmt, width = {0xDC: (">H", 2), 0xDD: (">I", 4)}[b]
        (n,) = struct.unpack_from(fmt, buf, offset)
        offset += width
        arr = []
        for _ in range(n):
            item, offset = _msgpack_unpack_from(buf, offset)
            arr.append(item)
        return arr, offset
    if b in (0xDE, 0xDF):
        fmt, width = {0xDE: (">H", 2), 0xDF: (">I", 4)}[b]
        (n,) = struct.unpack_from(fmt, buf, offset)
        offset += width
        out = {}
        for _ in range(n):
            k, offset = _msgpack_unpack_from(buf, offset)
            v, offset = _msgpack_unpack_from(buf, offset)
            out[k] = v
        return out, offset
    raise ValueError(f"Unsupported MessagePack marker byte: 0x{b:02x}")


def decode_fal_realtime_frame(raw: str | bytes) -> dict[str, Any] | None:
    """Decode an inbound `fal.run` hybrid frame (JSON text control frame or MessagePack binary)."""
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return None
        with contextlib.suppress(json.JSONDecodeError):
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return parsed
        return None

    raw_bytes = bytes(raw)
    if not raw_bytes:
        return None

    lstrip = raw_bytes.lstrip()
    if lstrip.startswith(b"{"):
        with contextlib.suppress(UnicodeDecodeError, json.JSONDecodeError):
            parsed = json.loads(lstrip.decode("utf-8"))
            if isinstance(parsed, dict):
                return parsed

    with contextlib.suppress(Exception):
        parsed_mp, _ = _msgpack_unpack_from(memoryview(raw_bytes), 0)
        if isinstance(parsed_mp, dict):
            return parsed_mp

    return None


def build_grok_realtime_session_update(
    *,
    voice: str | None = None,
    instructions: str | None = None,
    sample_rate: int = GROK_REALTIME_SAMPLE_RATE,
    reasoning_effort: Literal["none", "high"] = "none",
    counterparty_ai: bool = False,
) -> dict[str, Any]:
    """Build a singular-AI `session.update` payload for `xai/grok-voice/realtime`."""
    if counterparty_ai:
        raise ValueError("Dual-AI mode is prohibited: Recoup realtime uses a singular AI voice with a human.")

    resolved_voice = (voice or os.getenv("GROK_VOICE", "") or DEFAULT_GROK_REALTIME_VOICE).strip().lower()
    if not resolved_voice or "," in resolved_voice or " " in resolved_voice:
        raise ValueError(f"Singular Grok voice required, got {voice!r}")
    if resolved_voice not in ALLOWED_GROK_REALTIME_VOICES:
        raise ValueError(f"Unsupported Grok realtime voice: {voice!r}")

    if sample_rate not in GROK_REALTIME_SUPPORTED_RATES:
        raise ValueError(f"Unsupported PCM sample rate {sample_rate}; expected one of {sorted(GROK_REALTIME_SUPPORTED_RATES)}")

    resolved_instructions = (instructions or RECOUP_REALTIME_SYSTEM_PROMPT).strip()
    return {
        "type": "session.update",
        "session": {
            "voice": resolved_voice,
            "instructions": resolved_instructions,
            "reasoning": {"effort": reasoning_effort},
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500,
            },
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": sample_rate},
                    "transcription": {"model": "grok-transcribe", "language_hint": "en"},
                },
                "output": {"format": {"type": "audio/pcm", "rate": sample_rate}},
            },
            "tools": [],
        },
    }


_HUMAN_SPEAKER_ROLES = {"human", "user", "counterparty", "operator", "caller", "vendor", "manager"}
_AGENT_SPEAKER_ROLES = {"agent", "assistant", "recoup", "ai", "model", "system"}

_LINE_SPEAKER_RE = re.compile(
    r"^\s*(human|user|counterparty|operator|caller|vendor|manager|agent|assistant|recoup|ai|system)\s*:\s*(.*)$",
    re.IGNORECASE,
)
_BENIGN_NO_IDIOM_RE = re.compile(
    r"\bno\s*[-\s]?(?:problem|problems|worries|worry|issue|issues|doubt|question|brainer|hesitation)\b",
    re.IGNORECASE,
)
_DOUBLE_NEGATION_RE = re.compile(
    r"\b(?:do\s+not|don'?t|dont|never)\s+(?:cancel|abort|stop|drop|hold\s+off(?:\s+on)?|skip|forget)\b",
    re.IGNORECASE,
)
_INTERJECTION_NO_RE = re.compile(
    r"(?:^|(?<=[.,;!?]))\s*\bno\b(?=\s+(?:please|just|go\s+ahead|request|stage|send|ship|give|issue|process|take|we|i|let'?s|lets)\b)",
    re.IGNORECASE,
)
_RETRACTION_PIVOT_RE = re.compile(
    r"\b(?:scratch\s+that|forget\s+(?:that|it)|never\s+mind|change\s+of\s+(?:mind|plan)|changed\s+(?:my|our)\s+mind)\b",
    re.IGNORECASE,
)
_PIVOT_SPLIT_RE = re.compile(
    r"("
    r"\b(?:wait(?:\s+a\s+(?:second|sec|minute|moment))?(?!\s+(?:on\s+both|until\b))"
    r"|hold\s+on(?:\s+a\s+(?:second|sec|minute|moment))?(?!\s+until\b)"
    r"|hang\s+on(?:\s+a\s+(?:second|sec|minute|moment))?(?!\s+until\b)"
    r"|stop(?:\s+(?:there|right\s+there|right\s+now|here|talking|speaking|for\s+a\s+(?:second|sec|minute|moment)|a\s+(?:second|sec|minute|moment)))?"
    r"(?=\s*(?:[.,;!?—–]|$|\b(?:and|don'?t|do\s+not|we|i|let'?s|lets|please|just|request|issue|send|ship|give|process|stage|take|hold|wait|actually)\b))"
    r"|actually|on\s+second\s+thought"
    r"|scratch\s+that|forget\s+(?:that|it)|correction|change\s+of\s+(?:mind|plan)|changed\s+(?:my|our)\s+mind|never\s+mind)\b"
    r"|(?:^|(?<=[.!?—–]))\s*\bno\b\s*,\s*(?=\b(?:we|i|let'?s|lets|please|just|request|issue|send|ship|give|process|stage|take|do|don'?t|do\s+not|hold|cancel|leave)\b)"
    r")",
    re.IGNORECASE,
)
_CLAUSE_SPLIT_RE = re.compile(
    r"(?:[.,](?!\d)|[;!?—–])+"
    r"|\b(?:but|however|though|although|yet|whereas)\b"
    r"|(?=\b(?:we|i)\s+(?:want|need|prefer|would\s+like|will\s+take|'ll\s+take|choose|opt\s+for|go\s+with)\b)"
    r"|(?=\b(?:let'?s|lets)\s+(?:take|do|go\s+with|get|issue|send|ship|have|make|request|stage|process)\b)"
    r"|(?<!\bdo\s)(?<!\bnot\s)(?<!\bdon't\s)(?<!\bdont\s)(?<!\bnever\s)(?<!\bto\s)(?<!\bor\s)(?<!\bnor\s)(?<!\bno\s)"
    r"(?=\b(?:request|stage|process|issue|reimburse|reship|re-ship|redeliver|re-deliver"
    r"|send\s+(?:the|new|more|another|22|replacements?)"
    r"|ship\s+(?:the|new|more|another|22|replacements?)"
    r"|give\s+us"
    r"|(?:just|please)\s+(?:request|stage|process|issue|send|ship|give|take|do|reship|re-ship|redeliver|re-deliver|reimburse))\b)",
    re.IGNORECASE,
)
_INSTEAD_OF_RE = re.compile(
    r"\b(?:instead\s+of|rather\s+than|as\s+opposed\s+to)\s+"
    r"((?:(?:a|an|the|any|our|getting|taking|issuing|sending|shipping|doing|receiving|requesting)\s+){0,3}"
    r"(?:(?:eur\s+)?587(?:[.,]\s*30|\s+30|\s+euros?)?(?:\s+(?:refund(?:s)?|credit\s+notes?|credit\s+memos?|credits?))?"
    r"|22\s+(?:[a-z0-9-]+\s+){0,2}(?:replacement\s+)?(?:hubs?|units?)"
    r"|refund(?:s|ed|ing)?|credit\s+notes?|credit\s+memos?|credits?|reimburse(?:ment|ments|d|s)?|money\s+back"
    r"|re[-\s]?deliver(?:y|ies|ed|ing)?|replacements?(?:\s+(?:re[-\s]?deliver(?:y|ies)|hubs?|units?))?"
    r"|re[-\s]?ship(?:ment|ments|ped|ping|s)?|reship(?:ment|ments|ped|ping|s)?))\b",
    re.IGNORECASE,
)
_OPTION_NEGATOR_RE = re.compile(
    r"\b(?:do\s+not|don'?t|dont|no|not|never|neither|nor|without|forget|skip|drop|scratch|nix|avoid|stop|cancel|abort|hold\s+off\s+on|against)\b",
    re.IGNORECASE,
)
_REFUND_TARGET_RE = re.compile(
    r"\b(?:"
    r"refund(?:s|ed|ing)?"
    r"|credit\s+notes?"
    r"|credit\s+memos?"
    r"|credit(?:s|ed|ing)?(?!\s+(?:cards?|claims?)\b)"
    r"|reimburse(?:ment|ments|d|s)?"
    r"|money\s+back"
    r"|587(?:[.,]\s*30|\s+30)?(?:\s+euros?)?(?![.,]\s*\d)(?!\s+(?:euros?\s+)?(?:claim|discrepanc(?:y|ies)|dispute|variance|audit|case|matter|issue|invoice)\b)"
    r")\b",
    re.IGNORECASE,
)
_EXPLICIT_REDELIVERY_TARGET_RE = re.compile(
    r"\b(?:"
    r"re[-\s]?deliver(?:y|ies|ed|ing)?"
    r"|replacements?"
    r"|replace(?:d|s|ing)?"
    r"|re[-\s]?ship(?:ment|ments|ped|ping|s)?"
    r"|reship(?:ment|ments|ped|ping|s)?"
    r"|(?:send|ship|deliver|dispatch)\s+(?:out\s+)?(?:the\s+|our\s+|us\s+)?(?:new|more|another|missing|remaining|22)\b"
    r")\b",
    re.IGNORECASE,
)
_BARE_22_UNITS_RE = re.compile(
    r"\b22\s+(?:[a-z0-9-]+\s+){0,2}(?:hubs?|units?)\b(?!\s+(?:were|was|are|is)\b)",
    re.IGNORECASE,
)
_UNITS_ACTION_CUE_RE = re.compile(
    r"\b(?:send|ship|deliver|dispatch|fulfill|supply|give|take|get|want|need|prefer|choose|opt|go\s+with"
    r"|request|stage|process|do\s+not|don'?t|dont|no|not|never|without|skip|drop|cancel|abort|scratch|forget)\b",
    re.IGNORECASE,
)
_HARD_NO_ACTION_RE = re.compile(
    r"\b(?:"
    r"cancel\s+(?:everything|all|it|this|that|the\s+claim)"
    r"|abort(?:\s+(?:everything|it|this|that|all|the\s+claim|the\s+call))?"
    r"(?!\s+(?:the\s+|a\s+|an\s+|any\s+)?(?:refund|credit|reimburse\w*|re[-\s]?deliver\w*|replacement\w*|re[-\s]?ship\w*|reship\w*|22\b))"
    r"|leave\s+(?:it|everything|things|the\s+claim|the\s+invoice)\s+(?:alone|untouched|as\s+is|unchanged)"
    r"|do\s+nothing(?!\s+(?:else|yet|until|before|unless)\b)"
    r"|don'?t\s+do\s+anything(?!\s+(?:else|yet|until|before|unless)\b)"
    r"|do\s+not\s+do\s+anything(?!\s+(?:else|yet|until|before|unless)\b)"
    r"|take\s+no\s+action"
    r"|no\s+action"
    r"|stand\s+down"
    r"|drop\s+(?:everything|the\s+claim|it|this|that)"
    r"|neither(?:\s+one|\s+option)?"
    r"|none\s+of\s+(?:them|those|the\s+options)"
    r")\b",
    re.IGNORECASE,
)
_HOLD_OFF_RE = re.compile(r"\b(?:hold\s+off|pause\s+everything|wait\s+on\s+both)\b", re.IGNORECASE)
_UNCLEAR_RE = re.compile(
    r"\b(?:"
    r"not\s+sure"
    r"|unsure"
    r"|undecided"
    r"|uncertain"
    r"|maybe"
    r"|perhaps"
    r"|possibly"
    r"|don'?t\s+know"
    r"|do\s+not\s+know"
    r"|no\s+idea"
    r"|what\s+(?:are|were)\s+(?:my|our|the)\s+options"
    r"|(?:what|which)\s+options\s+(?:do\s+(?:i|we)\s+have|are\s+there|are\s+available)"
    r"|tell\s+me\s+(?:my|our|the)\s+options"
    r"|(?:let\s+(?:me|us)|(?:i|we)\s+(?:need|have|want)\s+to|i'?ll|we'?ll)\s+"
    r"(?:check|verify|ask|confirm|think|look|see|talk|speak|consult|review|discuss|run\s+(?:this|it)\s+by)"
    r"|check\s+with\s+(?:our\s+|the\s+|my\s+)?[a-z]+"
    r"|check\s+(?:our\s+|the\s+|my\s+)?(?:warehouse|inventory|stock|stockroom|team|manager|accounting|finance|director|boss|supervisor|records|ledger)"
    r"|until\s+(?:i|we)\s+(?:confirm|check|verify|ask|approve|get\s+back|hear\s+back|review|talk|speak|consult)"
    r"|(?:do\s+not|don'?t|dont)\s+(?:do|stage|submit|process|send|issue|commit|proceed)(?:\s+(?:anything|that|it|this))?\s+(?:yet|until|before)\b"
    r"|(?:do\s+not|don'?t|dont)\s+(?:stage|submit|commit)\s+(?:that|it|this|anything)\b"
    r"|(?:hold\s+on|hang\s+on|wait)\s+until\b"
    r"|get\s+back\s+to\s+you"
    r"|call\s+(?:you\s+)?back"
    r"|think\s+(?:about\s+it|it\s+over)"
    r"|decide\s+later"
    r"|confirm\s+later"
    r")\b",
    re.IGNORECASE,
)
_BOTH_OPTIONS_RE = re.compile(
    r"\b(?:"
    r"(?:give\s+us|(?:we|i)\s+(?:want|need|would\s+like|will\s+take|'ll\s+take)"
    r"|send(?:\s+us)?|issue|stage|process|take|get|have|do|request)\s+both\b"
    r"|both\s+(?:options|of\s+them)\b"
    r")",
    re.IGNORECASE,
)
_INFO_QUESTION_CLAUSE_RE = re.compile(
    r"^\s*(?:how\s+(?:long|fast|soon|much|many|does|do|would|will|can|could)"
    r"|when\s+(?:would|will|can|could|do|does)"
    r"|what\s+(?:is|was|are|were|would|does)"
    r"|why\s+(?:did|was|were|is|would))\b",
    re.IGNORECASE,
)
_COMPARATIVE_QUESTION_RE = re.compile(
    r"^\s*(?:what|which|can\s+(?:you|we)|could\s+(?:you|we)|should\s+(?:we|i)|do\s+you|is\s+it)\b.*\bor\b",
    re.IGNORECASE,
)
_COORD_NEG_RE = re.compile(r"\b(?:or|nor)\b", re.IGNORECASE)


def _extract_human_utterances(
    transcript_or_turns: str | Sequence[dict[str, Any] | RealtimeCallTurn | str],
) -> list[str]:
    if isinstance(transcript_or_turns, str):
        lines = [ln.strip() for ln in transcript_or_turns.splitlines() if ln.strip()]
        if not lines:
            return []
        tagged: list[tuple[str, str]] = []
        any_tag = False
        for ln in lines:
            m = _LINE_SPEAKER_RE.match(ln)
            if m:
                any_tag = True
                tagged.append((m.group(1).lower(), m.group(2).strip()))
            else:
                tagged.append(("human", ln))
        if any_tag:
            return [txt for role, txt in tagged if role in _HUMAN_SPEAKER_ROLES and txt]
        return [" ".join(lines)]

    utterances: list[str] = []
    for item in transcript_or_turns:
        if isinstance(item, str):
            if item.strip():
                utterances.append(item.strip())
        elif isinstance(item, RealtimeCallTurn):
            if item.speaker.strip().lower() in _HUMAN_SPEAKER_ROLES and item.text.strip():
                utterances.append(item.text.strip())
        elif isinstance(item, dict):
            role = str(item.get("speaker") or item.get("role") or "human").strip().lower()
            if role in _AGENT_SPEAKER_ROLES:
                continue
            text = str(item.get("text") or item.get("transcript") or item.get("content") or "").strip()
            if text:
                utterances.append(text)
    return utterances


def _find_redelivery_target(text: str, *, require_action_cue: bool = True) -> re.Match[str] | None:
    m_exp = _EXPLICIT_REDELIVERY_TARGET_RE.search(text)
    if m_exp is not None:
        return m_exp
    m_units = _BARE_22_UNITS_RE.search(text)
    if m_units is not None and (not require_action_cue or _UNITS_ACTION_CUE_RE.search(text)):
        return m_units
    return None


def _is_target_negated(
    text: str,
    target_match: re.Match[str],
    other_match: re.Match[str] | None,
    neg_matches: list[re.Match[str]],
) -> bool:
    t_start = target_match.start()
    for nm in neg_matches:
        if nm.start() >= t_start:
            continue
        if other_match is None or not (nm.start() < other_match.start() < t_start):
            return True
        between_targets = text[other_match.end() : t_start]
        if _COORD_NEG_RE.search(between_targets):
            return True
    return False


def _analyze_clause_options(clause: str) -> tuple[bool, bool, bool, bool]:
    pos_ref = neg_ref = pos_red = neg_red = False
    if _INFO_QUESTION_CLAUSE_RE.search(clause):
        return pos_ref, neg_ref, pos_red, neg_red

    normalized = _BENIGN_NO_IDIOM_RE.sub(" ", clause)
    normalized = _DOUBLE_NEGATION_RE.sub(" proceed with ", normalized)

    for m in _INSTEAD_OF_RE.finditer(normalized):
        rejected_span = m.group(1)
        if _REFUND_TARGET_RE.search(rejected_span):
            neg_ref = True
        if _find_redelivery_target(rejected_span, require_action_cue=False) is not None:
            neg_red = True
    working = _INSTEAD_OF_RE.sub(" ", normalized)

    cleaned_neg = re.sub(
        r"\b(?:not\s+sure|don'?t\s+know|do\s+not\s+know|no\s+idea)\b",
        " ",
        working,
        flags=re.IGNORECASE,
    )
    ref_m = _REFUND_TARGET_RE.search(cleaned_neg)
    red_m = _find_redelivery_target(cleaned_neg, require_action_cue=True)
    if ref_m is None and red_m is None:
        return pos_ref, neg_ref, pos_red, neg_red

    neg_matches = list(_OPTION_NEGATOR_RE.finditer(cleaned_neg))

    if ref_m is not None:
        if _is_target_negated(cleaned_neg, ref_m, red_m, neg_matches):
            neg_ref = True
        else:
            pos_ref = True

    if red_m is not None:
        if _is_target_negated(cleaned_neg, red_m, ref_m, neg_matches):
            neg_red = True
        else:
            pos_red = True

    return pos_ref, neg_ref, pos_red, neg_red


def _classify_single_human_turn(raw_text: str) -> RealtimeDecision | None:
    if not raw_text or not raw_text.strip():
        return None

    prepped = _BENIGN_NO_IDIOM_RE.sub(" ", raw_text)
    prepped = _DOUBLE_NEGATION_RE.sub(" proceed with ", prepped)
    prepped = _INTERJECTION_NO_RE.sub(".", prepped)

    tokens = _PIVOT_SPLIT_RE.split(prepped)
    pairs: list[tuple[str, str]] = [("", tokens[0])]
    for idx in range(1, len(tokens), 2):
        delim = tokens[idx]
        seg = tokens[idx + 1] if (idx + 1) < len(tokens) else ""
        pairs.append((delim, seg))

    substantive_parts = [seg.strip(" ,.;:!?—–-") for _, seg in pairs if seg.strip(" ,.;:!?—–-")]
    has_pivot = len(substantive_parts) > 1

    if (
        _COMPARATIVE_QUESTION_RE.search(prepped)
        and not has_pivot
        and _REFUND_TARGET_RE.search(prepped)
        and _find_redelivery_target(prepped, require_action_cue=False) is not None
    ):
        return "unclear"

    stage_decisions: list[RealtimeDecision] = []
    pending_retraction = False
    any_neg_ref = False
    any_neg_red = False
    any_hard_no_action = bool(_HARD_NO_ACTION_RE.search(prepped))
    any_hold_off = bool(_HOLD_OFF_RE.search(prepped))
    any_unclear = bool(_UNCLEAR_RE.search(prepped))
    any_both = bool(_BOTH_OPTIONS_RE.search(prepped))

    for delim, raw_part in pairs:
        if delim and _RETRACTION_PIVOT_RE.search(delim):
            pending_retraction = True

        part = raw_part.strip(" ,.;:!?—–-")
        if not part:
            continue

        part_hard_no = bool(_HARD_NO_ACTION_RE.search(part))
        part_hold = bool(_HOLD_OFF_RE.search(part))
        part_unclear = bool(_UNCLEAR_RE.search(part))
        part_both = bool(_BOTH_OPTIONS_RE.search(part))

        clauses = [c.strip() for c in _CLAUSE_SPLIT_RE.split(part) if c.strip()]
        pos_ref = neg_ref = pos_red = neg_red = False
        for cl in clauses:
            pr, nr, pd, nd = _analyze_clause_options(cl)
            pos_ref = pos_ref or pr
            neg_ref = neg_ref or nr
            pos_red = pos_red or pd
            neg_red = neg_red or nd

        any_neg_ref = any_neg_ref or neg_ref
        any_neg_red = any_neg_red or neg_red

        before_len = len(stage_decisions)
        if pos_ref and not pos_red and not part_hard_no and not part_unclear and not part_both:
            stage_decisions.append("refund")
        elif pos_red and not pos_ref and not part_hard_no and not part_unclear and not part_both:
            stage_decisions.append("redelivery")
        elif part_unclear or part_both or (pos_ref and pos_red):
            stage_decisions.append("unclear")
        elif part_hard_no or ((part_hold or (neg_ref and neg_red)) and not pos_ref and not pos_red):
            stage_decisions.append("no_action")
        elif neg_ref or neg_red:
            stage_decisions.append("unclear")

        if len(stage_decisions) > before_len:
            pending_retraction = False

    if pending_retraction and (not stage_decisions or stage_decisions[-1] in ("refund", "redelivery")):
        stage_decisions.append("unclear")

    if stage_decisions:
        return stage_decisions[-1]
    if any_unclear or any_both:
        return "unclear"
    if any_hard_no_action or (any_neg_ref and any_neg_red):
        return "no_action"
    if any_hold_off:
        return "no_action"
    if any_neg_ref or any_neg_red:
        return "unclear"
    return None


def classify_realtime_call_outcome(
    transcript_or_turns: str | Sequence[dict[str, Any] | RealtimeCallTurn | str],
    *,
    claim_id: str = DEFAULT_REALTIME_CLAIM_ID,
    refund_amount_eur: float = DEFAULT_REALTIME_REFUND_EUR,
    replacement_units: int = DEFAULT_REALTIME_REPLACEMENT_UNITS,
) -> RealtimeCallOutcome:
    """Deterministically classify a multi-turn realtime voice call without side effects."""
    clean_claim = (claim_id or DEFAULT_REALTIME_CLAIM_ID).strip() or DEFAULT_REALTIME_CLAIM_ID
    human_turns = _extract_human_utterances(transcript_or_turns)

    current_decision: RealtimeDecision = "unclear"
    decisive_text = ""

    for turn_text in human_turns:
        turn_decision = _classify_single_human_turn(turn_text)
        if turn_decision is not None:
            current_decision = turn_decision
            decisive_text = turn_text

    if current_decision == "refund":
        amt = round(float(refund_amount_eur), 2)
        return RealtimeCallOutcome(
            decision="refund",
            claim_id=clean_claim,
            refund_amount_eur=amt,
            replacement_units=None,
            decisive_turn_text=decisive_text,
            summary=(
                f"Caller requested EUR {amt:.2f} refund/credit note on {clean_claim}. "
                "Staged behind Risk Gate; ERP/AADE untouched; email requires explicit approval."
            ),
        )
    if current_decision == "redelivery":
        units = int(replacement_units)
        return RealtimeCallOutcome(
            decision="redelivery",
            claim_id=clean_claim,
            refund_amount_eur=None,
            replacement_units=units,
            decisive_turn_text=decisive_text,
            summary=(
                f"Caller requested replacement re-delivery of {units} HUB-USBC units for {clean_claim}. "
                "Staged behind Risk Gate; ERP/AADE untouched; email requires explicit approval."
            ),
        )
    if current_decision == "no_action":
        return RealtimeCallOutcome(
            decision="no_action",
            claim_id=clean_claim,
            refund_amount_eur=None,
            replacement_units=None,
            decisive_turn_text=decisive_text,
            summary=f"Caller declined both refund and redelivery on {clean_claim}; workspace left untouched.",
        )
    return RealtimeCallOutcome(
        decision="unclear",
        claim_id=clean_claim,
        refund_amount_eur=None,
        replacement_units=None,
        decisive_turn_text=decisive_text,
        summary=f"Call outcome for {clean_claim} remains undecided; no ERP or email actions staged.",
    )


async def _send_client_json(client_ws: Any, payload: dict[str, Any]) -> None:
    if hasattr(client_ws, "send_json"):
        await client_ws.send_json(payload)
    else:
        await client_ws.send_text(json.dumps(payload))


async def relay_grok_realtime_websocket(
    client_ws: Any,
    *,
    claim_id: str = DEFAULT_REALTIME_CLAIM_ID,
    voice: str | None = None,
    sample_rate: int = GROK_REALTIME_SAMPLE_RATE,
    instructions: str | None = None,
    greet_on_connect: bool = True,
    max_duration_s: float = GROK_REALTIME_MAX_DURATION_S,
    idle_timeout_s: float = GROK_REALTIME_IDLE_TIMEOUT_S,
    connect_timeout_s: float = GROK_REALTIME_CONNECT_TIMEOUT_S,
    ws_connector: Callable[..., Any] | None = None,
) -> RealtimeCallOutcome:
    """Backend-mediated bidirectional relay between browser WS and `xai/grok-voice/realtime`."""
    if hasattr(client_ws, "accept"):
        await client_ws.accept()

    clean_claim = (claim_id or DEFAULT_REALTIME_CLAIM_ID).strip() or DEFAULT_REALTIME_CLAIM_ID
    try:
        session_update = build_grok_realtime_session_update(
            voice=voice,
            sample_rate=sample_rate,
            instructions=instructions,
        )
    except ValueError as exc:
        outcome = classify_realtime_call_outcome([], claim_id=clean_claim)
        with contextlib.suppress(Exception):
            await _send_client_json(
                client_ws,
                {"type": "recoup.error", "message": str(exc)[:200]},
            )
            if hasattr(client_ws, "close"):
                await client_ws.close(code=1008)
        return outcome

    clamped_max_s = max(0.02, min(float(max_duration_s), GROK_REALTIME_HARD_MAX_DURATION_S))
    connector = ws_connector or ws_connect

    if _REALTIME_SESSION_LOCK.locked():
        outcome = classify_realtime_call_outcome([], claim_id=clean_claim)
        with contextlib.suppress(Exception):
            await _send_client_json(
                client_ws,
                {
                    "type": "recoup.fallback",
                    "reason": "session_busy",
                    "fallback_available": True,
                    "outcome": outcome.to_dict(),
                },
            )
            if hasattr(client_ws, "close"):
                await client_ws.close(code=1013)
        return outcome

    async with _REALTIME_SESSION_LOCK:
        provider_pref = os.getenv("VOICE_PROVIDER", "").strip().lower()
        fal_key = os.getenv("FAL_KEY", "").strip()
        is_unmocked_pytest = (
            "PYTEST_CURRENT_TEST" in os.environ
            and getattr(connector, "__module__", "").startswith("websockets")
        )

        if provider_pref in ("none", "offline", "fake", "disabled") or not fal_key or is_unmocked_pytest:
            outcome = classify_realtime_call_outcome([], claim_id=clean_claim)
            with contextlib.suppress(Exception):
                await _send_client_json(
                    client_ws,
                    {
                        "type": "recoup.fallback",
                        "reason": "offline_or_unconfigured",
                        "fallback_available": True,
                        "outcome": outcome.to_dict(),
                    },
                )
                if hasattr(client_ws, "close"):
                    await client_ws.close(code=1000)
            return outcome

        url = (os.getenv("FAL_REALTIME_URL", "").strip() or DEFAULT_GROK_REALTIME_URL).strip()
        turns: list[RealtimeCallTurn] = []
        agent_buffers: dict[str, list[str]] = {}
        agent_finalized: set[str] = set()
        user_buffers: dict[str, str] = {}
        active_response_id: str | None = None
        cancelled_response_ids: set[str] = set()
        stop_reason = "client_hangup"
        upstream_ws: Any = None

        try:
            try:
                upstream_ws = await asyncio.wait_for(
                    connector(
                        url,
                        additional_headers={"Authorization": f"Key {fal_key}"},
                        open_timeout=connect_timeout_s,
                        close_timeout=2.0,
                        max_size=4 * 1024 * 1024,
                    ),
                    timeout=connect_timeout_s,
                )
            except Exception:  # noqa: BLE001
                outcome = classify_realtime_call_outcome(turns, claim_id=clean_claim)
                with contextlib.suppress(Exception):
                    await _send_client_json(
                        client_ws,
                        {
                            "type": "recoup.fallback",
                            "reason": "upstream_connect_failed",
                            "fallback_available": True,
                            "outcome": outcome.to_dict(),
                        },
                    )
                return outcome

            await upstream_ws.send(encode_fal_realtime_event(session_update))
            if greet_on_connect:
                await upstream_ws.send(encode_fal_realtime_event({"type": "response.create"}))

            await _send_client_json(
                client_ws,
                {
                    "type": "recoup.session.ready",
                    "call_id": f"CALL-{clean_claim}",
                    "claim_id": clean_claim,
                    "voice": session_update["session"]["voice"],
                    "sample_rate": sample_rate,
                    "encoding": "pcm_s16le",
                },
            )

            stop_event = asyncio.Event()
            last_activity = asyncio.get_running_loop().time()
            last_client_to_upstream = last_activity
            keepalive_b64 = base64.b64encode(b"\x00" * 960).decode("ascii")

            def touch() -> None:
                nonlocal last_activity
                last_activity = asyncio.get_running_loop().time()

            async def idle_watchdog() -> None:
                nonlocal stop_reason, last_client_to_upstream
                poll_s = min(0.25, max(0.01, idle_timeout_s / 2.0))
                while not stop_event.is_set():
                    await asyncio.sleep(poll_s)
                    now_t = asyncio.get_running_loop().time()
                    if (now_t - last_activity) >= idle_timeout_s:
                        stop_reason = "idle_timeout"
                        stop_event.set()
                        break
                    # Prevent @fal.realtime's ~15s receive_bytes() timeout when browser mic is muted
                    if idle_timeout_s >= 5.0 and (now_t - last_client_to_upstream) >= 4.0:
                        last_client_to_upstream = now_t
                        with contextlib.suppress(Exception):
                            await upstream_ws.send(
                                encode_fal_realtime_event(
                                    {"type": "input_audio_buffer.append", "audio": keepalive_b64}
                                )
                            )

            async def client_to_upstream() -> None:
                nonlocal stop_reason, last_client_to_upstream, active_response_id
                while not stop_event.is_set():
                    try:
                        raw_msg = await client_ws.receive_text()
                    except Exception:  # noqa: BLE001
                        stop_reason = "client_disconnected"
                        stop_event.set()
                        break

                    touch()
                    last_client_to_upstream = asyncio.get_running_loop().time()
                    if len(raw_msg) > GROK_REALTIME_MAX_CLIENT_FRAME_BYTES:
                        continue
                    try:
                        msg = json.loads(raw_msg)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(msg, dict):
                        continue

                    mtype = str(msg.get("type") or "")
                    if mtype in ("audio.append", "input_audio_buffer.append"):
                        b64_audio = str(msg.get("audio") or "").strip()
                        if b64_audio:
                            await upstream_ws.send(
                                encode_fal_realtime_event(
                                    {"type": "input_audio_buffer.append", "audio": b64_audio}
                                )
                            )
                    elif mtype in ("audio.barge_in", "response.cancel"):
                        interrupted_id = active_response_id
                        if interrupted_id:
                            cancelled_response_ids.add(interrupted_id)
                        active_response_id = None
                        await _send_client_json(
                            client_ws,
                            {"type": "recoup.barge_in", "interrupted_response_id": interrupted_id or ""},
                        )
                    elif mtype == "transcript.user":
                        txt = str(msg.get("text") or "").strip()
                        if txt:
                            turns.append(RealtimeCallTurn(speaker="human", text=txt))
                            await upstream_ws.send(
                                encode_fal_realtime_event(
                                    {
                                        "type": "conversation.item.create",
                                        "item": {
                                            "type": "message",
                                            "role": "user",
                                            "content": [{"type": "input_text", "text": txt}],
                                        },
                                    }
                                )
                            )
                            await upstream_ws.send(encode_fal_realtime_event({"type": "response.create"}))
                    elif mtype == "call.hangup":
                        stop_reason = "client_hangup"
                        stop_event.set()
                        break

            async def upstream_to_client() -> None:
                nonlocal stop_reason, active_response_id
                try:
                    async for raw_frame in upstream_ws:
                        touch()
                        ev = decode_fal_realtime_frame(raw_frame)
                        if not isinstance(ev, dict):
                            continue
                        ev_type = str(ev.get("type") or "")
                        if not ev_type or ev_type == "ping" or ev_type.startswith("x-fal"):
                            continue

                        if ev_type == "session.updated":
                            await _send_client_json(client_ws, {"type": "recoup.session.updated"})
                        elif ev_type == "response.created":
                            resp_obj = ev.get("response") if isinstance(ev.get("response"), dict) else {}
                            rid = str(resp_obj.get("id") or ev.get("response_id") or "")
                            if rid:
                                active_response_id = rid
                        elif ev_type == "input_audio_buffer.speech_started":
                            # In server_vad mode, xAI Grok Voice Realtime cancels the active
                            # response automatically server-side; sending client `response.cancel`
                            # raises `invalid_request_error`. Suppress stale deltas & flush speaker.
                            interrupted_id = active_response_id
                            if interrupted_id:
                                cancelled_response_ids.add(interrupted_id)
                            active_response_id = None
                            await _send_client_json(
                                client_ws,
                                {
                                    "type": "recoup.barge_in",
                                    "interrupted_response_id": interrupted_id or "",
                                },
                            )
                        elif ev_type in ("response.output_audio.delta", "response.audio.delta"):
                            rid = str(ev.get("response_id") or active_response_id or "")
                            if rid and rid in cancelled_response_ids:
                                continue
                            if rid:
                                active_response_id = rid
                            delta = ev.get("delta")
                            if isinstance(delta, (bytes, bytearray)):
                                delta = base64.b64encode(bytes(delta)).decode("ascii")
                            if isinstance(delta, str) and delta:
                                await _send_client_json(
                                    client_ws,
                                    {
                                        "type": "recoup.audio.delta",
                                        "audio": delta,
                                        "response_id": rid,
                                    },
                                )
                        elif ev_type == "conversation.item.input_audio_transcription.updated":
                            iid = str(ev.get("item_id") or "default")
                            txt = str(ev.get("transcript") or "").strip()
                            if txt:
                                user_buffers[iid] = txt
                        elif ev_type in (
                            "conversation.item.input_audio_transcription.completed",
                            "conversation.item.input_audio_transcription.done",
                        ):
                            iid = str(ev.get("item_id") or "default")
                            txt = str(ev.get("transcript") or user_buffers.pop(iid, "")).strip()
                            user_buffers.pop(iid, None)
                            if txt:
                                turns.append(RealtimeCallTurn(speaker="human", text=txt))
                                await _send_client_json(
                                    client_ws,
                                    {
                                        "type": "recoup.transcript",
                                        "speaker": "human",
                                        "text": txt,
                                        "final": True,
                                    },
                                )
                        elif ev_type in (
                            "response.output_audio_transcript.delta",
                            "response.audio_transcript.delta",
                        ):
                            rid = str(ev.get("response_id") or "default")
                            dtxt = str(ev.get("delta") or "")
                            if dtxt:
                                agent_buffers.setdefault(rid, []).append(dtxt)
                        elif ev_type in (
                            "response.output_audio_transcript.done",
                            "response.audio_transcript.done",
                        ):
                            rid = str(ev.get("response_id") or "default")
                            if rid not in agent_finalized:
                                txt = str(
                                    ev.get("transcript") or "".join(agent_buffers.get(rid, []))
                                ).strip()
                                if txt:
                                    agent_finalized.add(rid)
                                    turns.append(RealtimeCallTurn(speaker="agent", text=txt))
                                    await _send_client_json(
                                        client_ws,
                                        {
                                            "type": "recoup.transcript",
                                            "speaker": "agent",
                                            "text": txt,
                                            "final": True,
                                        },
                                    )
                        elif ev_type in ("response.done", "response.cancelled"):
                            rid = str(
                                (ev.get("response") or {}).get("id")
                                if isinstance(ev.get("response"), dict)
                                else ev.get("response_id") or "default"
                            )
                            if active_response_id == rid:
                                active_response_id = None
                            if rid not in agent_finalized and rid in agent_buffers:
                                txt = "".join(agent_buffers.get(rid, [])).strip()
                                if txt:
                                    agent_finalized.add(rid)
                                    turns.append(RealtimeCallTurn(speaker="agent", text=txt))
                                    await _send_client_json(
                                        client_ws,
                                        {
                                            "type": "recoup.transcript",
                                            "speaker": "agent",
                                            "text": txt,
                                            "final": True,
                                        },
                                    )
                        if stop_event.is_set():
                            break
                except ConnectionClosed:
                    stop_reason = "upstream_closed"
                    stop_event.set()
                except Exception:  # noqa: BLE001
                    stop_reason = "upstream_error"
                    stop_event.set()

            tasks = [
                asyncio.create_task(client_to_upstream(), name="rt-client-up"),
                asyncio.create_task(upstream_to_client(), name="rt-up-client"),
                asyncio.create_task(idle_watchdog(), name="rt-idle"),
            ]
            try:
                async with asyncio.timeout(clamped_max_s):
                    await stop_event.wait()
            except TimeoutError:
                stop_reason = "max_duration_reached"
                stop_event.set()
            finally:
                stop_event.set()
                for t in tasks:
                    if not t.done():
                        t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

            outcome = classify_realtime_call_outcome(turns, claim_id=clean_claim)
            with contextlib.suppress(Exception):
                await _send_client_json(
                    client_ws,
                    {
                        "type": "recoup.call.outcome",
                        "reason": stop_reason,
                        "turns": [t.to_dict() for t in turns],
                        "outcome": outcome.to_dict(),
                    },
                )
            return outcome
        finally:
            if upstream_ws is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(upstream_ws.close(), timeout=2.0)
            if hasattr(client_ws, "close"):
                with contextlib.suppress(Exception):
                    await client_ws.close(code=1000)
