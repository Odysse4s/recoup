"""Voice Risk Gate briefings, dual-speaker vendor call audio, and Wizper STT decisions."""
from __future__ import annotations

from .call_audio import (
    AGENT_VOICE,
    COUNTERPARTY_VOICE,
    synthesize_call_turn,
    transcribe_and_decide,
    transcribe_audio_bytes,
)
from .elevenlabs_agent import (
    VOICE_CACHE_DIR,
    build_briefing_script,
    parse_voice_decision,
    simulate_vendor_negotiation_turns,
    summarize_negotiation_outcome,
    synthesize_briefing,
)

__all__ = [
    "AGENT_VOICE",
    "COUNTERPARTY_VOICE",
    "VOICE_CACHE_DIR",
    "build_briefing_script",
    "parse_voice_decision",
    "simulate_vendor_negotiation_turns",
    "summarize_negotiation_outcome",
    "synthesize_briefing",
    "synthesize_call_turn",
    "transcribe_and_decide",
    "transcribe_audio_bytes",
]
