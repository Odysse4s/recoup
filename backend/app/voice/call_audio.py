"""Dual-speaker vendor negotiation TTS and fal Wizper speech-to-text decision helpers."""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
from typing import Any, Literal

import httpx

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


def synthesize_call_turn(
    speaker: Literal["agent", "counterparty"],
    text: str,
) -> bytes | None:
    """Synthesize a vendor negotiation turn using distinct voices per speaker role."""
    cleaned = (text or "").strip()
    if not cleaned:
        return None

    provider_pref = os.getenv("VOICE_PROVIDER", "").strip().lower()
    if provider_pref in ("none", "offline", "fake", "disabled"):
        return None

    role: Literal["agent", "counterparty"] = "counterparty" if speaker == "counterparty" else "agent"
    voice = _resolve_speaker_voice(role)
    cache_key = hashlib.sha256(f"{role}:{voice}:{cleaned}".encode()).hexdigest()

    cache_dir = _resolve_cache_dir()
    cache_path = cache_dir / f"{cache_key}.mp3"
    if cache_path.is_file():
        cached_bytes = cache_path.read_bytes()
        if cached_bytes:
            return cached_bytes

    fal_key = os.getenv("FAL_KEY", "").strip()
    wonderful_key = os.getenv("WONDERFUL_API_KEY", "").strip()
    eleven_key = os.getenv("ELEVENLABS_API_KEY", "").strip()

    if not (fal_key or wonderful_key or eleven_key):
        return None

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

    fal_key = os.getenv("FAL_KEY", "").strip()
    if not fal_key:
        return ""

    clean_mime = (mime_type or "audio/webm").split(";", 1)[0].strip() or "audio/webm"
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
