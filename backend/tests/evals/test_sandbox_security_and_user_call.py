"""Phase 3 evaluations: sandbox adversarial security, Grok Voice Realtime protocol, and governance."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import json
import os
import signal
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

import app.engine.sandbox as sandbox_mod
import app.voice as voice_pkg
from app.contracts import ChangeReport, ToolCall
from app.domain_config import get_domain
from app.engine.env import Env, fingerprint_env
from app.engine.risk import RiskDecision, assess_risk
from app.engine.sandbox import (
    ForgedTool,
    _sandbox_env,
    run_in_sandbox,
    validate_ast,
    verify_and_register_forged_tool,
)
from app.engine.seed import populate_default_seed
from app.engine.tools import REGISTRY
from app.voice import (
    AGENT_VOICE,
    ALLOWED_GROK_REALTIME_VOICES,
    COUNTERPARTY_VOICE,
    DEFAULT_GROK_REALTIME_MODEL,
    DEFAULT_GROK_REALTIME_URL,
    DEFAULT_GROK_REALTIME_VOICE,
    GROK_REALTIME_SAMPLE_RATE,
    RECOUP_REALTIME_SYSTEM_PROMPT,
    VOICE_CACHE_DIR,
    RealtimeCallOutcome,
    RealtimeCallTurn,
    build_briefing_script,
    build_grok_realtime_session_update,
    classify_realtime_call_outcome,
    decode_fal_realtime_frame,
    encode_fal_realtime_event,
    parse_voice_decision,
    relay_grok_realtime_websocket,
    simulate_vendor_negotiation_turns,
    summarize_negotiation_outcome,
    synthesize_briefing,
    synthesize_call_turn,
    transcribe_and_decide,
    transcribe_audio_bytes,
)


@pytest.fixture(autouse=True)
def _clean_realtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("FAL_KEY", "FAL_REALTIME_URL", "GROK_VOICE", "VOICE_PROVIDER"):
        monkeypatch.delenv(key, raising=False)


class _StubClientWebSocket:
    """In-memory Starlette-compatible client WebSocket double."""

    def __init__(
        self,
        inbound_messages: list[str | Exception | float] | None = None,
    ) -> None:
        self._queue: asyncio.Queue[str | Exception | float] = asyncio.Queue()
        for item in inbound_messages or []:
            self._queue.put_nowait(item)
        self.accepted = False
        self.closed = False
        self.close_code: int | None = None
        self.sent_json: list[dict[str, Any]] = []

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        item = await self._queue.get()
        if isinstance(item, (int, float)):
            await asyncio.sleep(float(item))
            return await self.receive_text()
        if isinstance(item, Exception):
            raise item
        return item

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent_json.append(payload)

    async def close(self, code: int = 1000) -> None:
        self.closed = True
        self.close_code = code

    def push(self, raw: str | Exception) -> None:
        self._queue.put_nowait(raw)


class _StubUpstreamFalWS:
    """In-memory `wss://fal.run/xai/grok-voice/realtime` upstream double."""

    def __init__(
        self,
        server_frames: list[str | bytes | float] | None = None,
        *,
        keep_open_after_frames: bool = False,
        infinite_audio_interval_s: float = 0.0,
    ) -> None:
        self._frames = list(server_frames or [])
        self._keep_open = keep_open_after_frames
        self._infinite_interval = infinite_audio_interval_s
        self.sent_binary: list[bytes] = []
        self.decoded_sent: list[dict[str, Any]] = []
        self.closed = False
        self._close_event = asyncio.Event()

    async def send(self, data: bytes | str) -> None:
        assert isinstance(data, bytes), "fal.run requires MessagePack binary frames from client"
        self.sent_binary.append(data)
        decoded = decode_fal_realtime_frame(data)
        if decoded is not None:
            self.decoded_sent.append(decoded)

    async def close(self) -> None:
        self.closed = True
        self._close_event.set()

    def __aiter__(self) -> _StubUpstreamFalWS:
        return self

    async def __anext__(self) -> str | bytes:
        if self._close_event.is_set():
            raise StopAsyncIteration
        while self._frames:
            nxt = self._frames.pop(0)
            if isinstance(nxt, (int, float)):
                await asyncio.sleep(float(nxt))
                if self._close_event.is_set():
                    raise StopAsyncIteration
                continue
            return nxt
        if self._infinite_interval > 0:
            await asyncio.sleep(self._infinite_interval)
            if self._close_event.is_set():
                raise StopAsyncIteration
            return encode_fal_realtime_event(
                {
                    "type": "response.output_audio.delta",
                    "response_id": "resp-stream",
                    "delta": base64.b64encode(b"\x01\x00" * 160).decode("ascii"),
                }
            )
        if self._keep_open:
            await self._close_event.wait()
        raise StopAsyncIteration


# ---------------------------------------------------------------------------
# 1. Session Config, Singular Voice & Offline Fallback
# ---------------------------------------------------------------------------


class TestRealtimeSessionConfigAndSingularVoice:
    def test_session_config_targets_fal_grok_realtime_with_singular_voice(self) -> None:
        assert DEFAULT_GROK_REALTIME_MODEL == "xai/grok-voice/realtime"
        assert DEFAULT_GROK_REALTIME_URL == "wss://fal.run/xai/grok-voice/realtime"
        assert DEFAULT_GROK_REALTIME_VOICE in ALLOWED_GROK_REALTIME_VOICES

        cfg = build_grok_realtime_session_update(voice="Ara")
        assert cfg["type"] == "session.update"
        session = cfg["session"]
        assert session["voice"] == "ara"
        assert session["turn_detection"]["type"] == "server_vad"
        assert session["turn_detection"]["threshold"] == 0.5
        assert session["audio"]["input"]["format"] == {
            "type": "audio/pcm",
            "rate": GROK_REALTIME_SAMPLE_RATE,
        }
        assert session["audio"]["input"]["transcription"]["model"] == "grok-transcribe"
        assert session["audio"]["output"]["format"] == {
            "type": "audio/pcm",
            "rate": GROK_REALTIME_SAMPLE_RATE,
        }
        assert session["tools"] == []

        prompt = session["instructions"]
        assert prompt == RECOUP_REALTIME_SYSTEM_PROMPT
        assert "CLM-D-1042" in prompt
        assert "587.30" in prompt
        assert "22" in prompt
        assert "Risk Gate" in prompt
        assert "AADE" in prompt

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"counterparty_ai": True},
            {"voice": "ara,rex"},
            {"voice": "ara rex"},
            {"voice": "nonexistent_voice"},
            {"sample_rate": 11025},
        ],
    )
    def test_rejects_dual_ai_or_invalid_voice_or_sample_rate(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ValueError):
            build_grok_realtime_session_update(**kwargs)

    async def test_missing_fal_key_or_offline_provider_fails_closed_cleanly(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _StubClientWebSocket()
        outcome = await relay_grok_realtime_websocket(client)
        assert client.accepted is True
        assert client.closed is True
        assert outcome.decision == "unclear"
        assert client.sent_json[0]["type"] == "recoup.fallback"
        assert client.sent_json[0]["fallback_available"] is True

        monkeypatch.setenv("FAL_KEY", "test-key-should-not-leak")
        monkeypatch.setenv("VOICE_PROVIDER", "offline")
        client2 = _StubClientWebSocket()
        await relay_grok_realtime_websocket(client2)
        assert client2.sent_json[0]["type"] == "recoup.fallback"
        assert "test-key-should-not-leak" not in json.dumps(client2.sent_json)


# ---------------------------------------------------------------------------
# 2. MessagePack & Hybrid Frame Codec
# ---------------------------------------------------------------------------


class TestMessagePackAndHybridFrameCodec:
    def test_roundtrips_complex_realtime_events_and_handles_malformed_frames(self) -> None:
        payload = {
            "type": "response.output_audio.delta",
            "prompt": None,
            "ok": True,
            "disabled": False,
            "seq": -12,
            "large_int": 987654,
            "ratio": 0.85,
            "tags": ["clm", "d-1042"],
            "raw_pcm": b"\x00\x01\xfe\xff" * 80,
            "delta": "AAAA",
        }
        packed = encode_fal_realtime_event(payload)
        assert isinstance(packed, bytes)
        unpacked = decode_fal_realtime_frame(packed)
        assert unpacked == payload

        # Hybrid JSON text frame from fal runner
        fal_ctrl = '{"type": "x-fal-message", "action": "timings", "timing": 0.09}'
        assert decode_fal_realtime_frame(fal_ctrl) == {
            "type": "x-fal-message",
            "action": "timings",
            "timing": 0.09,
        }

        # Malformed / truncated inputs return None safely without raising
        assert decode_fal_realtime_frame("") is None
        assert decode_fal_realtime_frame("{not-json") is None
        assert decode_fal_realtime_frame(b"") is None
        assert decode_fal_realtime_frame(b"\xd9\x50short") is None
        assert decode_fal_realtime_frame(b"\xc4\x20short") is None


# ---------------------------------------------------------------------------
# 3. Protocol Relay, Multi-Turn Transcripts & Barge-In
# ---------------------------------------------------------------------------


class TestRealtimeProtocolRelayAndBargeIn:
    async def test_relays_audio_both_delta_schemas_transcripts_and_barge_in(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-mock-secret")
        b64_mic = base64.b64encode(b"\x10\x00" * 240).decode("ascii")
        b64_ai_1 = base64.b64encode(b"\x20\x00" * 240).decode("ascii")
        b64_ai_2 = base64.b64encode(b"\x30\x00" * 240).decode("ascii")

        upstream = _StubUpstreamFalWS(
            server_frames=[
                '{"type": "x-fal-message", "action": "timings", "timing": 0.05}',
                encode_fal_realtime_event({"type": "ping", "timestamp": 12345}),
                encode_fal_realtime_event({"type": "session.updated", "session": {"voice": "ara"}}),
                encode_fal_realtime_event(
                    {"type": "response.output_audio.delta", "response_id": "r1", "delta": b64_ai_1}
                ),
                encode_fal_realtime_event(
                    {"type": "response.output_audio_transcript.delta", "response_id": "r1", "delta": "Hello "}
                ),
                encode_fal_realtime_event(
                    {
                        "type": "response.output_audio_transcript.done",
                        "response_id": "r1",
                        "transcript": "Hello from Recoup.",
                    }
                ),
                # User barges in while response 2 is streaming legacy response.audio.delta
                encode_fal_realtime_event(
                    {"type": "response.audio.delta", "response_id": "r2", "delta": b64_ai_2}
                ),
                encode_fal_realtime_event({"type": "input_audio_buffer.speech_started", "item_id": "u1"}),
                encode_fal_realtime_event(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "u1",
                        "transcript": "Do not send replacements, issue the EUR 587.30 refund instead.",
                    }
                ),
                0.05,
            ],
            keep_open_after_frames=True,
        )

        seen_headers: dict[str, str] = {}

        async def fake_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            assert url == "wss://fal.run/xai/grok-voice/realtime"
            seen_headers.update(kwargs.get("additional_headers") or {})
            return upstream

        client = _StubClientWebSocket(
            inbound_messages=[
                json.dumps({"type": "audio.append", "audio": b64_mic}),
                0.08,
                json.dumps({"type": "call.hangup"}),
            ]
        )

        outcome = await relay_grok_realtime_websocket(
            client,
            claim_id="CLM-D-1042",
            ws_connector=fake_connector,
        )

        assert seen_headers == {"Authorization": "Key fal-mock-secret"}
        assert upstream.closed is True
        assert client.closed is True

        sent_types = [d["type"] for d in upstream.decoded_sent]
        assert sent_types[0] == "session.update"
        assert "input_audio_buffer.append" in sent_types
        # server_vad cancels automatically server-side; client must NOT send response.cancel
        assert "response.cancel" not in sent_types

        client_types = [m["type"] for m in client.sent_json]
        assert "recoup.session.ready" in client_types
        assert "recoup.session.updated" in client_types
        assert client_types.count("recoup.audio.delta") == 2
        assert "recoup.barge_in" in client_types
        assert client_types[-1] == "recoup.call.outcome"

        assert outcome.decision == "refund"
        assert outcome.refund_amount_eur == 587.30
        assert outcome.requires_risk_gate is True
        assert outcome.erp_authorized is False
        assert outcome.email_requires_explicit_approval is True

    async def test_suppresses_stale_interrupted_audio_deltas_and_rejects_bad_params_cleanly(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-mock-secret")
        b64_ok = base64.b64encode(b"\x10\x00" * 80).decode("ascii")
        b64_stale = base64.b64encode(b"\x7f\x7f" * 80).decode("ascii")
        b64_next = base64.b64encode(b"\x20\x00" * 80).decode("ascii")

        upstream = _StubUpstreamFalWS(
            server_frames=[
                encode_fal_realtime_event({"type": "response.created", "response": {"id": "resp-interrupted"}}),
                encode_fal_realtime_event(
                    {"type": "response.output_audio.delta", "response_id": "resp-interrupted", "delta": b64_ok}
                ),
                encode_fal_realtime_event({"type": "input_audio_buffer.speech_started", "item_id": "u-barge"}),
                # Stale in-flight audio delta from interrupted response must be dropped server-side
                encode_fal_realtime_event(
                    {"type": "response.output_audio.delta", "response_id": "resp-interrupted", "delta": b64_stale}
                ),
                # Fresh post-barge-in response must stream cleanly
                encode_fal_realtime_event({"type": "response.created", "response": {"id": "resp-fresh"}}),
                encode_fal_realtime_event(
                    {"type": "response.output_audio.delta", "response_id": "resp-fresh", "delta": b64_next}
                ),
                0.04,
            ],
            keep_open_after_frames=True,
        )

        async def fake_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            return upstream

        client = _StubClientWebSocket(inbound_messages=[0.08, json.dumps({"type": "call.hangup"})])
        await relay_grok_realtime_websocket(client, ws_connector=fake_connector)

        audio_msgs = [m for m in client.sent_json if m["type"] == "recoup.audio.delta"]
        assert [m["response_id"] for m in audio_msgs] == ["resp-interrupted", "resp-fresh"]
        assert all(m["audio"] != b64_stale for m in audio_msgs)
        barge_msgs = [m for m in client.sent_json if m["type"] == "recoup.barge_in"]
        assert barge_msgs and barge_msgs[0]["interrupted_response_id"] == "resp-interrupted"

        # Invalid voice or sample_rate closes socket cleanly with 1008 after accept
        bad_client = _StubClientWebSocket()
        bad_out = await relay_grok_realtime_websocket(bad_client, voice="nonexistent_voice")
        assert bad_out.decision == "unclear"
        assert bad_client.sent_json[0]["type"] == "recoup.error"
        assert bad_client.close_code == 1008


# ---------------------------------------------------------------------------
# 4. Fault Tolerance, Timeouts, Hard Max Duration & Concurrency Cap
# ---------------------------------------------------------------------------


class TestRealtimeFaultToleranceTimeoutsAndHardCutoff:
    async def test_malformed_frames_and_abrupt_disconnect_close_upstream_cleanly(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-mock-secret")
        upstream = _StubUpstreamFalWS(
            server_frames=[
                "{broken-json",
                b"\xff\x00",
                encode_fal_realtime_event({"type": "xai.experimental.unknown", "foo": 1}),
            ],
            keep_open_after_frames=True,
        )

        async def fake_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            return upstream

        client = _StubClientWebSocket(
            inbound_messages=[
                "{bad-client-json",
                "[]",
                "x" * 300_000,  # oversize frame > 256 KB safely dropped
                0.03,
                RuntimeError("abrupt mobile socket drop"),
            ]
        )

        outcome = await relay_grok_realtime_websocket(client, ws_connector=fake_connector)
        assert upstream.closed is True
        assert outcome.decision == "unclear"

    async def test_connect_timeout_idle_timeout_and_hard_max_duration_cutoff(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-mock-secret")

        # 1. Connect timeout
        async def stalling_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            await asyncio.sleep(1.0)
            return _StubUpstreamFalWS()

        c_conn = _StubClientWebSocket()
        out_conn = await relay_grok_realtime_websocket(
            c_conn,
            connect_timeout_s=0.03,
            ws_connector=stalling_connector,
        )
        assert out_conn.decision == "unclear"
        assert c_conn.sent_json[0]["reason"] == "upstream_connect_failed"

        # 2. Idle timeout
        idle_up = _StubUpstreamFalWS(keep_open_after_frames=True)

        async def idle_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            return idle_up

        c_idle = _StubClientWebSocket(inbound_messages=[2.0])
        await relay_grok_realtime_websocket(
            c_idle,
            idle_timeout_s=0.04,
            max_duration_s=2.0,
            ws_connector=idle_connector,
        )
        assert idle_up.closed is True
        assert c_idle.sent_json[-1]["reason"] == "idle_timeout"

        # 3. Hard max_duration_s cutoff even while continuous audio deltas arrive
        busy_up = _StubUpstreamFalWS(infinite_audio_interval_s=0.01)

        async def busy_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            return busy_up

        c_max = _StubClientWebSocket(inbound_messages=[2.0])
        await relay_grok_realtime_websocket(
            c_max,
            idle_timeout_s=5.0,
            max_duration_s=0.06,
            ws_connector=busy_connector,
        )
        assert busy_up.closed is True
        assert c_max.sent_json[-1]["reason"] == "max_duration_reached"

    async def test_concurrent_session_lock_blocks_parallel_billing_sockets(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-mock-secret")
        dial_count = 0
        hold_up = _StubUpstreamFalWS(keep_open_after_frames=True)

        async def counting_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            nonlocal dial_count
            dial_count += 1
            return hold_up

        c1 = _StubClientWebSocket(inbound_messages=[0.12, json.dumps({"type": "call.hangup"})])
        t1 = asyncio.create_task(relay_grok_realtime_websocket(c1, ws_connector=counting_connector))
        await asyncio.sleep(0.03)

        c2 = _StubClientWebSocket()
        await relay_grok_realtime_websocket(c2, ws_connector=counting_connector)
        assert c2.sent_json[0]["type"] == "recoup.fallback"
        assert c2.sent_json[0]["reason"] == "session_busy"
        assert dial_count == 1

        await t1
        assert hold_up.closed is True


# ---------------------------------------------------------------------------
# 5. Structured Conversation Outcome Intelligence (Negations & Mind-Changes)
# ---------------------------------------------------------------------------


class TestRealtimeConversationOutcomeIntelligence:
    @pytest.mark.parametrize(
        ("turns", "expected_decision", "expected_refund", "expected_units"),
        [
            (
                ["Please issue the EUR 587.30 refund credit note against INV-7781."],
                "refund",
                587.30,
                None,
            ),
            (
                ["Ship a replacement redelivery of the 22 USB-C hubs right away."],
                "redelivery",
                None,
                22,
            ),
            (
                ["Do not send replacements, we want the 587.30 refund instead."],
                "refund",
                587.30,
                None,
            ),
            (
                ["Don't refund us, we urgently need the 22 hubs re-delivered."],
                "redelivery",
                None,
                22,
            ),
            (
                ["No problem, instead of a refund let's do a replacement redelivery."],
                "redelivery",
                None,
                22,
            ),
            (
                ["Actually hold off, don't do a refund and don't redeliver anything, cancel it."],
                "no_action",
                None,
                None,
            ),
            (
                ["Leave everything untouched, take no action for now."],
                "no_action",
                None,
                None,
            ),
            (
                ["I'm not sure yet, let me check our warehouse inventory first."],
                "unclear",
                None,
                None,
            ),
            (
                ["Should we take the EUR 587.30 refund or a replacement redelivery?"],
                "unclear",
                None,
                None,
            ),
            (
                [
                    "Let's arrange a replacement redelivery of the 22 hubs.",
                    "Wait, scratch that—our stockroom is full, issue the 587.30 refund instead.",
                ],
                "refund",
                587.30,
                None,
            ),
            (
                [
                    RealtimeCallTurn(
                        speaker="agent",
                        text="Would you prefer the EUR 587.30 refund or replacement of 22 hubs?",
                    ),
                    RealtimeCallTurn(
                        speaker="human",
                        text="Let me think about it and call you back.",
                    ),
                ],
                "unclear",
                None,
                None,
            ),
        ],
    )
    def test_classifies_refund_redelivery_negations_pivots_and_uncertainty(
        self,
        turns: list[Any],
        expected_decision: str,
        expected_refund: float | None,
        expected_units: int | None,
    ) -> None:
        outcome = classify_realtime_call_outcome(turns)
        assert outcome.decision == expected_decision
        assert outcome.refund_amount_eur == expected_refund
        assert outcome.replacement_units == expected_units
        assert outcome.requires_risk_gate is True
        assert outcome.email_requires_explicit_approval is True
        assert outcome.erp_authorized is False

    async def test_exact_manual_live_test_utterance_and_risk_gate_parser_separation(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Regression for manual live-test utterance & Risk Gate vs call-settlement parser separation.

        `parse_voice_decision` is strictly a post-rehearsal Risk Gate binary command parser
        (`'approve' | 'reject' | 'unknown'`) that matches commands like `'Approve and commit'` or
        `'Reject and roll back'`. Passing a live vendor-call barge-in utterance like
        `"Stop there. Don't send replacements. Request the refund instead."` to `parse_voice_decision`
        triggers `_REJECT_PATTERNS` (`r"stop"`) because `'refund'` is a call-settlement option, not a
        Risk Gate commit verb. Live call transcripts must be classified via `classify_realtime_call_outcome`.
        """
        live_utterance = "Stop there. Don't send replacements. Request the refund instead."

        # 1. Direct classification across list, turn dataclass, and speaker-tagged transcript forms
        for payload in (
            [live_utterance],
            [
                RealtimeCallTurn(
                    speaker="agent",
                    text="We can arrange a replacement delivery of the 22 HUB-USBC units.",
                ),
                RealtimeCallTurn(speaker="human", text=live_utterance),
            ],
            f"Agent: Sending 22 replacement hubs.\nHuman: {live_utterance}",
        ):
            outcome = classify_realtime_call_outcome(payload)
            assert outcome.decision == "refund"
            assert outcome.refund_amount_eur == 587.30
            assert outcome.replacement_units is None
            assert outcome.erp_authorized is False
            assert outcome.requires_risk_gate is True
            assert outcome.email_requires_explicit_approval is True

        # 2. End-to-end mocked realtime relay with barge-in carrying the exact utterance
        monkeypatch.setenv("FAL_KEY", "fal-mock-secret")
        upstream = _StubUpstreamFalWS(
            server_frames=[
                encode_fal_realtime_event({"type": "session.updated", "session": {"voice": "ara"}}),
                encode_fal_realtime_event({"type": "input_audio_buffer.speech_started", "item_id": "u-live"}),
                encode_fal_realtime_event(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "u-live",
                        "transcript": live_utterance,
                    }
                ),
                0.03,
            ],
            keep_open_after_frames=True,
        )

        async def fake_connector(url: str, **kwargs: Any) -> _StubUpstreamFalWS:
            return upstream

        client = _StubClientWebSocket(
            inbound_messages=[0.06, json.dumps({"type": "call.hangup"})]
        )
        relayed_outcome = await relay_grok_realtime_websocket(client, ws_connector=fake_connector)
        assert relayed_outcome.decision == "refund"
        assert relayed_outcome.refund_amount_eur == 587.30
        assert relayed_outcome.erp_authorized is False
        assert relayed_outcome.requires_risk_gate is True
        assert relayed_outcome.email_requires_explicit_approval is True
        assert client.sent_json[-1]["type"] == "recoup.call.outcome"
        assert client.sent_json[-1]["outcome"]["decision"] == "refund"

        # 3. Risk Gate binary command parser contract vs call-settlement classification
        assert parse_voice_decision("Approve and commit") == "approve"
        assert parse_voice_decision("Reject and roll back") == "reject"
        assert parse_voice_decision("Do not approve, roll back") == "reject"
        assert parse_voice_decision("What was the invoice number again?") == "unknown"
        # Demonstrates why live call speech must NOT be routed to `parse_voice_decision`:
        # `"Stop"` hits `_REJECT_PATTERNS` while `"refund"` is not an approval verb.
        assert parse_voice_decision(live_utterance) == "reject"

    @pytest.mark.parametrize(
        ("utterance", "expected_decision", "expected_refund", "expected_units"),
        [
            ("Please issue a credit note against INV-7781.", "refund", 587.30, None),
            ("Go ahead and reimburse EUR 587.30 to our account.", "refund", 587.30, None),
            ("We just want our money back on the short-shipped invoice.", "refund", 587.30, None),
            ("Apply a credit memo for the 587.30 euros discrepancy.", "refund", 587.30, None),
            ("Please reship the 22 USB-C hubs right away.", "redelivery", None, 22),
            ("Schedule a replacement delivery for the missing items.", "redelivery", None, 22),
            ("Please send replacement units to our Athens warehouse.", "redelivery", None, 22),
            ("We need a re-shipment of the 22 HUB-USBC units.", "redelivery", None, 22),
        ],
    )
    def test_refund_vs_redelivery_across_realistic_phrasings(
        self,
        utterance: str,
        expected_decision: str,
        expected_refund: float | None,
        expected_units: int | None,
    ) -> None:
        outcome = classify_realtime_call_outcome([utterance])
        assert outcome.decision == expected_decision
        assert outcome.refund_amount_eur == expected_refund
        assert outcome.replacement_units == expected_units
        assert outcome.erp_authorized is False
        assert outcome.requires_risk_gate is True
        assert outcome.email_requires_explicit_approval is True

    def test_negations_and_interruption_prefixes(self) -> None:
        out_red = classify_realtime_call_outcome(
            ["Hold on, stop there. Don't issue a refund, send the 22 replacement hubs instead."]
        )
        assert out_red.decision == "redelivery"
        assert out_red.replacement_units == 22
        assert out_red.refund_amount_eur is None
        assert out_red.erp_authorized is False
        assert out_red.requires_risk_gate is True
        assert out_red.email_requires_explicit_approval is True

        out_ref = classify_realtime_call_outcome(
            ["Wait — no replacement shipment, please request the credit note instead."]
        )
        assert out_ref.decision == "refund"
        assert out_ref.refund_amount_eur == 587.30
        assert out_ref.replacement_units is None
        assert out_ref.erp_authorized is False
        assert out_ref.requires_risk_gate is True
        assert out_ref.email_requires_explicit_approval is True

        out_drop = classify_realtime_call_outcome(
            ["Do not send replacements and do not issue a refund, drop it."]
        )
        assert out_drop.decision in ("no_action", "unclear")
        assert out_drop.decision == "no_action"
        assert out_drop.refund_amount_eur is None
        assert out_drop.replacement_units is None
        assert out_drop.erp_authorized is False
        assert out_drop.requires_risk_gate is True
        assert out_drop.email_requires_explicit_approval is True

    def test_multi_turn_changes_of_mind(self) -> None:
        # 1. Turn 1 redelivery -> Turn 2 neutral question -> Turn 3 refund -> refund
        out_red_q_ref = classify_realtime_call_outcome(
            [
                "Send the 22 replacement hubs.",
                "How many business days does courier transit usually take?",
                "On second thought, request the EUR 587.30 refund instead.",
            ]
        )
        assert out_red_q_ref.decision == "refund"
        assert out_red_q_ref.refund_amount_eur == 587.30
        assert out_red_q_ref.replacement_units is None
        assert out_red_q_ref.erp_authorized is False

        # 2. Turn 1 refund -> Turn 2 redelivery -> redelivery
        out_ref_red = classify_realtime_call_outcome(
            [
                "Please issue the EUR 587.30 refund.",
                "Wait, send the 22 replacement hubs instead.",
            ]
        )
        assert out_ref_red.decision == "redelivery"
        assert out_ref_red.replacement_units == 22
        assert out_ref_red.refund_amount_eur is None
        assert out_ref_red.erp_authorized is False

        # 3. Turn 1 refund -> Turn 2 uncertain finance check -> revokes back to unclear
        out_revoked_uncertain = classify_realtime_call_outcome(
            [
                "Please issue the EUR 587.30 refund.",
                "Actually wait, I'm not sure yet, let me check with finance first",
            ]
        )
        assert out_revoked_uncertain.decision == "unclear"
        assert out_revoked_uncertain.refund_amount_eur is None
        assert out_revoked_uncertain.replacement_units is None
        assert out_revoked_uncertain.erp_authorized is False

        # 4. Turn 1 redelivery -> Turn 2 explicit cancel / no action -> no_action
        out_revoked_cancel = classify_realtime_call_outcome(
            [
                "Send the 22 replacement hubs.",
                "Cancel that, take no action for now",
            ]
        )
        assert out_revoked_cancel.decision == "no_action"
        assert out_revoked_cancel.refund_amount_eur is None
        assert out_revoked_cancel.replacement_units is None
        assert out_revoked_cancel.erp_authorized is False

    def test_conflicting_ambiguous_empty_noise_and_agent_only_speech(self) -> None:
        # 1. Ambiguous exploratory options question -> unclear
        out_ambig = classify_realtime_call_outcome(
            ["Maybe a refund or maybe a replacement redelivery, what are my options?"]
        )
        assert out_ambig.decision == "unclear"
        assert out_ambig.refund_amount_eur is None
        assert out_ambig.replacement_units is None
        assert out_ambig.erp_authorized is False

        # 2. Simultaneous un-negated demand for both options -> safely unclear (never guesses)
        out_both = classify_realtime_call_outcome(
            ["Send us both the 22 replacement hubs and the 587.30 euro refund"]
        )
        assert out_both.decision == "unclear"
        assert out_both.refund_amount_eur is None
        assert out_both.replacement_units is None
        assert out_both.erp_authorized is False

        # 3. Empty, whitespace, and ASR filler/noise inputs -> unclear
        for empty_or_noise in ([], "", "   \n\t  ", ["   ", "\t"], ["uh um hmm... [static]"]):
            out_noise = classify_realtime_call_outcome(empty_or_noise)
            assert out_noise.decision == "unclear"
            assert out_noise.refund_amount_eur is None
            assert out_noise.replacement_units is None
            assert out_noise.erp_authorized is False

        # 4. Agent speech mentioning EUR 587.30 refund and 22 replacement hubs MUST NEVER self-trigger
        agent_line = (
            "For CLM-D-1042 we can stage a EUR 587.30 refund credit note or reship 22 replacement hubs."
        )
        for turns in (
            [
                RealtimeCallTurn(speaker="agent", text=agent_line),
                RealtimeCallTurn(speaker="human", text="Okay, tell me more"),
            ],
            [
                {"speaker": "assistant", "text": agent_line},
                {"role": "recoup", "content": "Please issue the EUR 587.30 refund."},
                {"speaker": "caller", "text": "Okay, tell me more"},
            ],
            f"Agent: {agent_line}\nHuman: Okay, tell me more",
            [RealtimeCallTurn(speaker="agent", text="Issue the EUR 587.30 refund right now.")],
        ):
            out_agent_only = classify_realtime_call_outcome(turns)
            assert out_agent_only.decision == "unclear"
            assert out_agent_only.refund_amount_eur is None
            assert out_agent_only.replacement_units is None
            assert out_agent_only.erp_authorized is False

    def test_no_action_and_pending_decisions(self) -> None:
        out_no_action = classify_realtime_call_outcome(
            ["No action needed, leave the invoice as is"]
        )
        assert out_no_action.decision == "no_action"
        assert out_no_action.refund_amount_eur is None
        assert out_no_action.replacement_units is None
        assert out_no_action.erp_authorized is False
        assert out_no_action.requires_risk_gate is True
        assert out_no_action.email_requires_explicit_approval is True

        out_pending = classify_realtime_call_outcome(
            ["Let me talk to my manager and get back to you"]
        )
        assert out_pending.decision == "unclear"
        assert out_pending.refund_amount_eur is None
        assert out_pending.replacement_units is None
        assert out_pending.erp_authorized is False
        assert out_pending.requires_risk_gate is True
        assert out_pending.email_requires_explicit_approval is True

    def test_asr_unpunctuated_and_conjunction_negation_clauses(self) -> None:
        """Edge-case regression: ASR (`grok-transcribe`/`wizper`) often omits punctuation or joins with `and`.

        When a negated option precedes a positive `request` / `send replacement` clause without a comma
        or period, the negation must NOT bleed across into the positive clause and misclassify as `no_action`.
        """
        out_unpunct_live = classify_realtime_call_outcome(
            ["Stop there don't send replacements request the refund instead"]
        )
        assert out_unpunct_live.decision == "refund"
        assert out_unpunct_live.refund_amount_eur == 587.30

        out_and_request = classify_realtime_call_outcome(
            ["Don't send replacements and request the refund instead."]
        )
        assert out_and_request.decision == "refund"
        assert out_and_request.refund_amount_eur == 587.30

        out_just_send = classify_realtime_call_outcome(
            ["Don't issue a refund just send replacement units instead."]
        )
        assert out_just_send.decision == "redelivery"
        assert out_just_send.replacement_units == 22

    def test_multi_turn_revocation_talk_to_manager_and_cancel_that(self) -> None:
        """Edge-case regression: later tentative/cancellation turns must revoke an earlier commitment."""
        out_manager_revoke = classify_realtime_call_outcome(
            [
                "Please issue the EUR 587.30 refund.",
                "Actually wait, let me talk to my manager first.",
            ]
        )
        assert out_manager_revoke.decision == "unclear"
        assert out_manager_revoke.refund_amount_eur is None

        out_cancel_that = classify_realtime_call_outcome(
            [
                "Send the 22 replacement hubs.",
                "Cancel that, never mind.",
            ]
        )
        assert out_cancel_that.decision in ("no_action", "unclear")
        assert out_cancel_that.replacement_units is None

    def test_tentative_single_option_question_remains_unclear(self) -> None:
        """Edge-case regression: exploratory single-option question must stay `unclear`, not stage refund."""
        out_tentative = classify_realtime_call_outcome(
            ["Maybe a refund? What are my options?"]
        )
        assert out_tentative.decision == "unclear"
        assert out_tentative.refund_amount_eur is None


# ---------------------------------------------------------------------------
# 6. Governance Safety Invariants, Pytest Paid-Socket Guard & Secret Hygiene
# ---------------------------------------------------------------------------


class TestGovernanceAndSecretHygieneInvariants:
    def test_outcome_dataclass_enforces_strict_governance_flags(self) -> None:
        with pytest.raises(ValueError, match="requires_risk_gate"):
            RealtimeCallOutcome(decision="refund", requires_risk_gate=False)  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="email_requires_explicit_approval"):
            RealtimeCallOutcome(decision="refund", email_requires_explicit_approval=False)  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="erp_authorized"):
            RealtimeCallOutcome(decision="refund", erp_authorized=True)  # type: ignore[arg-type]

    def test_phone_accept_never_mutates_erp_and_staged_actions_require_risk_gate(
        self,
        tmp_path: Path,
    ) -> None:
        ws = tmp_path / "ws"
        populate_default_seed(ws)
        real = Env(root_dir=ws, db_path=ws / "app.db")
        fp_before = fingerprint_env(real)

        outcome = classify_realtime_call_outcome(
            ["Yes, give us the EUR 587.30 refund and send the confirmation email!"]
        )
        assert outcome.decision == "refund"
        assert outcome.erp_authorized is False
        assert fingerprint_env(real) == fp_before
        assert real.outbox == []

        claim_call = ToolCall(
            id="tc_claim",
            name="upsert_row",
            args={
                "table": "claims",
                "pk_col": "id",
                "row": {"id": "CLM-D-1042", "amount": 587.30, "status": "pending_refund"},
            },
        )
        email_call = ToolCall(
            id="tc_mail",
            name="send_email",
            args={"to": "accounts@kappaoffice.example", "subject": "CLM-D-1042", "body": "Draft"},
        )
        empty_report = ChangeReport()
        d_claim, _ = assess_risk(claim_call, REGISTRY["upsert_row"], empty_report)
        d_email, _ = assess_risk(email_call, REGISTRY["send_email"], empty_report)
        assert d_claim == RiskDecision.ASK
        assert d_email == RiskDecision.ASK

    def test_explicit_phone_acceptance_still_enforces_risk_gate_and_email_approval(
        self,
        tmp_path: Path,
    ) -> None:
        ws = tmp_path / "ws_accept"
        populate_default_seed(ws)
        real = Env(root_dir=ws, db_path=ws / "app.db")
        fp_before = fingerprint_env(real)

        outcome = classify_realtime_call_outcome(
            ["Yes, I accept the EUR 587.30 refund, update the ERP and send the email right now!"]
        )
        assert outcome.decision == "refund"
        assert outcome.refund_amount_eur == 587.30
        assert outcome.replacement_units is None
        assert outcome.erp_authorized is False
        assert outcome.requires_risk_gate is True
        assert outcome.email_requires_explicit_approval is True
        assert fingerprint_env(real) == fp_before
        assert real.outbox == []

        empty_report = ChangeReport()
        for gated_amt in (250.0, 587.30):
            claim_call = ToolCall(
                id=f"tc_claim_{gated_amt}",
                name="upsert_row",
                args={
                    "table": "claims",
                    "pk_col": "id",
                    "row": {"id": "CLM-D-1042", "amount": gated_amt, "status": "pending_refund"},
                },
            )
            decision, reason = assess_risk(claim_call, REGISTRY["upsert_row"], empty_report)
            assert decision == RiskDecision.ASK
            assert "250.00" in reason

        below_threshold_call = ToolCall(
            id="tc_claim_low",
            name="upsert_row",
            args={
                "table": "claims",
                "pk_col": "id",
                "row": {"id": "CLM-MINOR", "amount": 249.99, "status": "open"},
            },
        )
        low_decision, _ = assess_risk(below_threshold_call, REGISTRY["upsert_row"], empty_report)
        assert low_decision == RiskDecision.AUTO

        email_call = ToolCall(
            id="tc_mail_urgent",
            name="send_email",
            args={"to": "accounts@kappaoffice.example", "subject": "CLM-D-1042", "body": "Approved"},
        )
        email_decision, _ = assess_risk(email_call, REGISTRY["send_email"], empty_report)
        assert email_decision == RiskDecision.ASK

    def test_phase1_phase2_voice_backwards_compatibility_and_offline_safety(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Verify Phase 1/2 TTS, dual-speaker call TTS, Wizper STT, and Risk Gate parser stay intact."""
        monkeypatch.setenv("VOICE_CACHE_DIR", str(tmp_path / "voice_cache"))
        monkeypatch.setenv("FAL_KEY", "00000000-1111-2222-3333-444444444444:syntheticsecret")

        # Phase 1 TTS (`synthesize_briefing`, plus `synthesize_speech` alias if present)
        tts_fn = getattr(voice_pkg, "synthesize_speech", synthesize_briefing)
        assert callable(tts_fn)
        assert callable(synthesize_briefing)
        assert tts_fn("") is None
        # Pytest guard prevents live HTTP spend when httpx.Client is unmocked
        assert tts_fn("Recoup rehearsed claim CLM-D-1042.") is None

        # Phase 2 dual-speaker TTS (`synthesize_call_turn`) & Wizper STT (`transcribe_audio_bytes`)
        assert callable(synthesize_call_turn)
        assert synthesize_call_turn("agent", "") is None
        assert synthesize_call_turn("agent", "Calling regarding CLM-D-1042.") is None
        assert synthesize_call_turn("counterparty", "We can issue a credit note.") is None

        assert callable(transcribe_audio_bytes)
        assert transcribe_audio_bytes(b"") == ""
        assert transcribe_audio_bytes(b"mock-webm-bytes", mime_type="audio/webm") == ""

        # Phase 1/2 Risk Gate voice decision helpers (`parse_voice_decision`, `transcribe_and_decide`)
        assert callable(parse_voice_decision)
        assert callable(transcribe_and_decide)
        assert parse_voice_decision("Approve and commit") == "approve"
        assert parse_voice_decision("Reject and roll back") == "reject"
        assert parse_voice_decision("") == "unknown"
        assert transcribe_and_decide(transcript="Approve and commit") == {
            "transcript": "Approve and commit",
            "decision": "approve",
        }
        assert transcribe_and_decide(audio_bytes=b"mock-webm-bytes") == {
            "transcript": "",
            "decision": "unknown",
        }

        # Phase 1 script builder & Phase 2 deterministic simulator remain backwards-compatible
        script = build_briefing_script({"claim_id": "CLM-D-1042", "claim_amount": 587.30})
        assert "CLM-D-1042" in script
        assert len(script.split()) < 35
        sim_turns = simulate_vendor_negotiation_turns("CLM-D-1042", 587.30)
        sim_end = summarize_negotiation_outcome("CLM-D-1042", 587.30, sim_turns)
        assert sim_end["outcome"] == "accepted"

    async def test_pytest_guard_blocks_unmocked_live_fal_websocket_with_fal_key_set(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "00000000-1111-2222-3333-444444444444:syntheticsecret")
        client = _StubClientWebSocket()
        outcome = await relay_grok_realtime_websocket(client)
        assert outcome.decision == "unclear"
        assert client.sent_json[0]["type"] == "recoup.fallback"
        assert client.sent_json[0]["reason"] == "offline_or_unconfigured"

    def test_frontend_source_and_bundles_never_contain_fal_key_and_exports_intact(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        gitignore_txt = (repo_root / ".gitignore").read_text(encoding="utf-8")
        assert ".env" in gitignore_txt

        forbidden = ("FAL_KEY", "GEMINI_API_KEY", "OUMI_API_KEY", "Authorization: Key")
        scan_dirs = [repo_root / "frontend" / "src"]
        dist_dir = repo_root / "frontend" / "dist"
        if dist_dir.is_dir():
            scan_dirs.append(dist_dir)

        for folder in scan_dirs:
            for fp in folder.rglob("*"):
                if fp.is_file() and fp.suffix in {".ts", ".tsx", ".js", ".html"}:
                    content = fp.read_text(encoding="utf-8", errors="ignore")
                    for marker in forbidden:
                        assert marker not in content, f"Secret marker {marker} found in {fp}"

        # Phase 1 & 2 backwards-compatibility exports check
        assert AGENT_VOICE != COUNTERPARTY_VOICE
        assert isinstance(VOICE_CACHE_DIR, Path)
        assert callable(build_briefing_script)
        assert callable(parse_voice_decision)
        assert callable(simulate_vendor_negotiation_turns)
        assert callable(summarize_negotiation_outcome)
        assert callable(synthesize_briefing)
        assert callable(synthesize_call_turn)
        assert callable(transcribe_audio_bytes)
        assert callable(transcribe_and_decide)


# ---------------------------------------------------------------------------
# 7. Step 2 Sandbox Adversarial Security & Stdlib Compatibility Suite
# ---------------------------------------------------------------------------

_BACKEND_DIR = Path(__file__).resolve().parents[2]

_DUMMY_PROVIDER_SECRETS: dict[str, str] = {
    "FAL_KEY": "dummy-fal-key-0000",
    "GEMINI_API_KEY": "dummy-gemini-key-0000",
    "ANTHROPIC_API_KEY": "dummy-anthropic-key-0000",
    "OPENAI_API_KEY": "dummy-openai-key-0000",
}
_DUMMY_HOST_HOME = "/tmp/dummy_host_home_should_not_leak"

_GUARDED_CHILD_SCRIPT = """
import json
import sys

payload = json.loads(sys.stdin.read())
try:
    import resource
    rlimit_as = int(payload["outer_rlimit_as_bytes"])
    resource.setrlimit(resource.RLIMIT_AS, (rlimit_as, rlimit_as))
except Exception:
    pass

from app.engine.sandbox import run_in_sandbox

res = run_in_sandbox(
    payload["code"],
    payload["func_name"],
    payload["args"],
    timeout=float(payload["sandbox_timeout"]),
)
out = {"ok": bool(res.get("ok"))}
if "error" in res:
    err = str(res["error"])
    out["error"] = err[:1_048_576]
    out["error_len"] = len(err)
if "output" in res:
    out["has_output"] = True
sys.stdout.write(json.dumps(out))
"""


def _run_sandbox_in_guarded_child(
    code: str,
    func_name: str,
    args: dict[str, Any],
    *,
    sandbox_timeout: float = 2.0,
    outer_rlimit_as_bytes: int = 1536 * 1024 * 1024,
    outer_timeout: float = 5.0,
) -> dict[str, Any]:
    """Run `run_in_sandbox` inside a tightly controlled child process with an outer RLIMIT_AS backstop."""
    child_env: dict[str, str] = {"PYTHONPATH": str(_BACKEND_DIR)}
    if "PATH" in os.environ:
        child_env["PATH"] = os.environ["PATH"]

    proc = subprocess.Popen(
        [sys.executable, "-c", _GUARDED_CHILD_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(_BACKEND_DIR),
        env=child_env,
        start_new_session=True,
    )
    payload = json.dumps(
        {
            "code": code,
            "func_name": func_name,
            "args": args,
            "sandbox_timeout": sandbox_timeout,
            "outer_rlimit_as_bytes": outer_rlimit_as_bytes,
        }
    )
    try:
        stdout_data, stderr_data = proc.communicate(input=payload, timeout=outer_timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=2.0)
        pytest.fail(f"Guarded child wrapper timed out after {outer_timeout}s")

    assert proc.returncode == 0, (
        f"Guarded child wrapper exited with {proc.returncode}: {stderr_data[:500]}"
    )
    parsed: dict[str, Any] = json.loads(stdout_data)
    return parsed


@pytest.fixture
def _preserve_tool_registry() -> Iterator[None]:
    """Guarantee REGISTRY is restored identically even when testing overwrite attacks."""
    snapshot = dict(REGISTRY)
    try:
        yield
    finally:
        REGISTRY.clear()
        REGISTRY.update(snapshot)


class TestSandboxASTAdversarialBypasses:
    """Item 1: Static AST analyzer coverage across builtins, aliases, imports, io/operator, and frames."""

    @pytest.mark.parametrize(
        "snippet",
        [
            "import os\ndef pwn(args):\n    return {}\n",
            "import subprocess\ndef pwn(args):\n    return {}\n",
            "import urllib.request\ndef pwn(args):\n    return {}\n",
            "def pwn(args):\n    return open('pyproject.toml').read()\n",
            "def pwn(args):\n    return getattr(args, 'keys')()\n",
            "def pwn(args):\n    return eval('1 + 1')\n",
            "def pwn(args):\n    exec('x = 1')\n    return {}\n",
            "def pwn(args):\n    return __import__('os').getcwd()\n",
            "def pwn(args):\n    return ().__class__.__base__\n",
            "def pwn(args):\n    return str(__builtins__)\n",
            "def wrong_func_name(args):\n    return {}\n",
            "def pwn(args):\n    return (\n",
        ],
    )
    def test_ast_baseline_rejections(self, snippet: str) -> None:
        ok, errors = validate_ast(snippet, "pwn")
        assert ok is False
        assert errors

    @pytest.mark.parametrize(
        ("label", "snippet"),
        [
            ("alias_open", "def pwn(args):\n    f = open\n    return {'ok': bool(f)}\n"),
            ("alias_getattr", "def pwn(args):\n    g = getattr\n    return list(g(args, 'keys')())\n"),
            ("alias_eval", "def pwn(args):\n    e = eval\n    return {'v': e('2 + 2')}\n"),
            ("alias_exec", "def pwn(args):\n    ex = exec\n    return {'v': str(ex)}\n"),
            ("alias_compile", "def pwn(args):\n    c = compile\n    return {'v': str(c)}\n"),
            ("alias_globals", "def pwn(args):\n    gl = globals\n    return {'v': len(gl())}\n"),
            ("alias_locals", "def pwn(args):\n    lo = locals\n    return {'v': len(lo())}\n"),
            ("alias_vars", "def pwn(args):\n    v = vars\n    return {'v': len(v())}\n"),
            ("alias_setattr", "def pwn(args):\n    s = setattr\n    return {'v': str(s)}\n"),
            ("alias_delattr", "def pwn(args):\n    d = delattr\n    return {'v': str(d)}\n"),
            ("alias_input", "def pwn(args):\n    inp = input\n    return {'v': str(inp)}\n"),
            ("alias_breakpoint", "def pwn(args):\n    bp = breakpoint\n    return {'v': str(bp)}\n"),
        ],
    )
    def test_ast_blocks_builtin_aliasing_and_first_class_references(
        self,
        label: str,
        snippet: str,
    ) -> None:
        ok, errors = validate_ast(snippet, "pwn")
        assert ok is False, f"AST failed to reject {label}"
        assert errors

    @pytest.mark.parametrize(
        ("label", "snippet"),
        [
            ("from_urllib_request", "from urllib import request\ndef pwn(args):\n    return {'v': str(request)}\n"),
            ("io_open_attr", "import io\ndef pwn(args):\n    return {'v': str(io.open)}\n"),
            ("io_open_code_attr", "import io\ndef pwn(args):\n    return {'v': str(io.open_code)}\n"),
            ("io_fileio_attr", "import io\ndef pwn(args):\n    return {'v': str(io.FileIO)}\n"),
            ("from_io_open", "from io import open\ndef pwn(args):\n    return {'ok': 1}\n"),
            ("from_io_open_alias", "from io import open as rdr\ndef pwn(args):\n    return {'v': str(rdr)}\n"),
            ("from_io_open_code", "from io import open_code\ndef pwn(args):\n    return {'v': str(open_code)}\n"),
            ("from_io_fileio", "from io import FileIO\ndef pwn(args):\n    return {'v': str(FileIO)}\n"),
            ("operator_attrgetter", "import operator\ndef pwn(args):\n    return {'v': str(operator.attrgetter('keys'))}\n"),
            ("operator_methodcaller", "import operator\ndef pwn(args):\n    return {'v': str(operator.methodcaller('keys'))}\n"),
            ("from_operator_attrgetter", "from operator import attrgetter\ndef pwn(args):\n    return {'v': str(attrgetter)}\n"),
            ("from_operator_methodcaller", "from operator import methodcaller\ndef pwn(args):\n    return {'v': str(methodcaller)}\n"),
            ("from_uuid_os", "from uuid import os\ndef pwn(args):\n    return {'v': str(os)}\n"),
            ("uuid_os_attr", "import uuid\ndef pwn(args):\n    return {'v': str(uuid.os)}\n"),
            ("from_enum_bltns", "from enum import bltns\ndef pwn(args):\n    return {'v': str(bltns)}\n"),
            ("enum_bltns_attr", "import enum\ndef pwn(args):\n    return {'v': str(enum.bltns)}\n"),
            ("from_enum_sys", "from enum import sys\ndef pwn(args):\n    return {'v': str(sys)}\n"),
        ],
    )
    def test_ast_blocks_dangerous_imports_io_operator_and_transitive_stdlib_symbols(
        self,
        label: str,
        snippet: str,
    ) -> None:
        ok, errors = validate_ast(snippet, "pwn")
        assert ok is False, f"AST failed to reject {label}"
        assert errors

    @pytest.mark.parametrize(
        ("label", "snippet"),
        [
            ("gi_frame", "def pwn(args):\n    g = (x for x in (1,))\n    return {'v': str(g.gi_frame)}\n"),
            ("cr_frame", "def pwn(args):\n    return {'v': str(args.cr_frame)}\n"),
            ("tb_frame", "def pwn(args):\n    return {'v': str(args.tb_frame)}\n"),
            ("f_builtins", "def pwn(args):\n    return {'v': str(args.f_builtins)}\n"),
            ("f_globals", "def pwn(args):\n    return {'v': str(args.f_globals)}\n"),
            ("str_format", "def pwn(args):\n    return {'v': '{0.__class__}'.format(args)}\n"),
            ("str_format_map", "def pwn(args):\n    return {'v': '{x.__class__}'.format_map({'x': args})}\n"),
            ("mangled_dunder_attr", "def pwn(args):\n    return {'v': str(args._Probe__class__)}\n"),
            ("mangled_dunder_name", "def pwn(args):\n    _Probe__class__ = 1\n    return {'v': _Probe__class__}\n"),
            ("match_class_dunder", "def pwn(args):\n    match 1:\n        case int(__class__=c):\n            return {'v': str(c)}\n    return {}\n"),
            ("def_dunder_init", "def __init__(self):\n    return None\ndef pwn(args):\n    return {}\n"),
            ("class_def", "class Probe:\n    x = 1\ndef pwn(args):\n    return {'x': 1}\n"),
            ("yield_gen", "def _g():\n    yield 1\ndef pwn(args):\n    return {'v': list(_g())}\n"),
            ("yield_from_gen", "def _g():\n    yield from (1, 2)\ndef pwn(args):\n    return {'v': list(_g())}\n"),
            ("async_def", "async def _coro(x):\n    return x\ndef pwn(args):\n    return {'ok': 1}\n"),
        ],
    )
    def test_ast_blocks_introspection_frames_format_mangled_dunders_classes_and_async(
        self,
        label: str,
        snippet: str,
    ) -> None:
        ok, errors = validate_ast(snippet, "pwn")
        assert ok is False, f"AST failed to reject {label}"
        assert errors


class TestSandboxWorkingDirectoryAndSecretIsolation:
    """Item 2: Isolated temporary cwd and minimal secret-free environment without provider keys or HOME."""

    def test_all_four_provider_keys_stripped_from_sandbox_env_and_popen(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        for key, dummy_val in _DUMMY_PROVIDER_SECRETS.items():
            monkeypatch.setenv(key, dummy_val)

        env_snapshot = _sandbox_env()
        for key, dummy_val in _DUMMY_PROVIDER_SECRETS.items():
            assert key not in env_snapshot, f"{key} leaked into _sandbox_env()"
            assert dummy_val not in env_snapshot.values(), f"{key} value leaked into _sandbox_env()"

        seen_envs: list[dict[str, str] | None] = []
        real_popen = subprocess.Popen

        def spy_popen(*popenargs: Any, **kwargs: Any) -> Any:
            env_arg = kwargs.get("env")
            seen_envs.append(dict(env_arg) if isinstance(env_arg, dict) else None)
            return real_popen(*popenargs, **kwargs)

        monkeypatch.setattr(subprocess, "Popen", spy_popen)
        if hasattr(sandbox_mod, "Popen"):
            monkeypatch.setattr(sandbox_mod, "Popen", spy_popen)
        res = run_in_sandbox("def ping(args):\n    return {'pong': args['x']}\n", "ping", {"x": 7})
        assert res == {"ok": True, "output": {"pong": 7}}
        assert seen_envs and seen_envs[-1] is not None
        popen_env = seen_envs[-1]
        for key, dummy_val in _DUMMY_PROVIDER_SECRETS.items():
            assert key not in popen_env, f"{key} leaked into subprocess.Popen env"
            assert dummy_val not in popen_env.values(), f"{key} value leaked into subprocess.Popen env"

    def test_sandbox_env_and_popen_omit_home_and_provider_keys(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        for key, dummy_val in _DUMMY_PROVIDER_SECRETS.items():
            monkeypatch.setenv(key, dummy_val)
        monkeypatch.setenv("HOME", _DUMMY_HOST_HOME)

        env_snapshot = _sandbox_env()
        for forbidden_key in (*_DUMMY_PROVIDER_SECRETS.keys(), "HOME"):
            assert forbidden_key not in env_snapshot, f"{forbidden_key} still present in _sandbox_env()"
        for forbidden_val in (*_DUMMY_PROVIDER_SECRETS.values(), _DUMMY_HOST_HOME):
            assert forbidden_val not in env_snapshot.values()

        seen_envs: list[dict[str, str] | None] = []
        real_popen = subprocess.Popen

        def spy_popen(*popenargs: Any, **kwargs: Any) -> Any:
            env_arg = kwargs.get("env")
            seen_envs.append(dict(env_arg) if isinstance(env_arg, dict) else None)
            return real_popen(*popenargs, **kwargs)

        monkeypatch.setattr(subprocess, "Popen", spy_popen)
        if hasattr(sandbox_mod, "Popen"):
            monkeypatch.setattr(sandbox_mod, "Popen", spy_popen)
        res = run_in_sandbox("def ping(args):\n    return {'ok': 1}\n", "ping", {})
        assert res == {"ok": True, "output": {"ok": 1}}
        assert seen_envs and seen_envs[-1] is not None
        popen_env = seen_envs[-1]
        for forbidden_key in (*_DUMMY_PROVIDER_SECRETS.keys(), "HOME"):
            assert forbidden_key not in popen_env, f"{forbidden_key} leaked into subprocess.Popen env"
        for forbidden_val in (*_DUMMY_PROVIDER_SECRETS.values(), _DUMMY_HOST_HOME):
            assert forbidden_val not in popen_env.values()

    @pytest.mark.parametrize(
        ("label", "snippet"),
        [
            ("direct_import_os", "import os\ndef leak(args):\n    return dict(os.environ)\n"),
            ("from_uuid_import_os", "from uuid import os\ndef leak(args):\n    return dict(os.environ)\n"),
            ("uuid_os_attr", "import uuid\ndef leak(args):\n    return dict(uuid.os.environ)\n"),
        ],
    )
    def test_forged_tool_cannot_read_os_environ_directly_or_via_uuid_os(
        self,
        label: str,
        snippet: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        for key, dummy_val in _DUMMY_PROVIDER_SECRETS.items():
            monkeypatch.setenv(key, dummy_val)
        monkeypatch.setenv("HOME", _DUMMY_HOST_HOME)

        res = run_in_sandbox(snippet, "leak", {})
        assert res["ok"] is False, f"Forged tool {label} was not rejected"
        serialized = json.dumps(res)
        for forbidden_val in (*_DUMMY_PROVIDER_SECRETS.values(), _DUMMY_HOST_HOME):
            assert forbidden_val not in serialized

    def test_isolated_temp_cwd_hides_repo_files_and_cleans_up(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        parent_cwd = Path.cwd().resolve()
        captured: dict[str, Any] = {}
        real_popen = subprocess.Popen

        def spy_popen(*popenargs: Any, **kwargs: Any) -> Any:
            cwd_arg = kwargs.get("cwd")
            cwd_path = Path(cwd_arg).resolve() if cwd_arg is not None else None
            captured["cwd"] = cwd_path
            if cwd_path is not None and cwd_path.is_dir():
                captured["visible_targets"] = [
                    rel
                    for rel in ("pyproject.toml", ".env", "workspace")
                    if (cwd_path / rel).exists()
                ]
            return real_popen(*popenargs, **kwargs)

        monkeypatch.setattr(subprocess, "Popen", spy_popen)
        if hasattr(sandbox_mod, "Popen"):
            monkeypatch.setattr(sandbox_mod, "Popen", spy_popen)
        res = run_in_sandbox("def ok_fn(args):\n    return {'ok': 1}\n", "ok_fn", {})
        assert res == {"ok": True, "output": {"ok": 1}}

        child_cwd: Path | None = captured.get("cwd")
        assert child_cwd is not None and child_cwd != parent_cwd, (
            f"Sandbox inherited parent cwd ({child_cwd}) instead of isolated temp dir"
        )
        assert captured.get("visible_targets") == []
        assert not child_cwd.exists(), "Temporary sandbox cwd was not cleaned up"


class TestSandboxResourceLimitsTimeoutMemoryAndDisk:
    """Item 3: CPU timeout, child-process-guarded RLIMIT_AS check, and RLIMIT_FSIZE=(0,0)."""

    def test_cpu_infinite_loop_times_out_cleanly(self) -> None:
        code = "def spin(args):\n    while True:\n        pass\n"
        res = run_in_sandbox(code, "spin", {}, timeout=0.4)
        assert res["ok"] is False
        assert "timeout" in res.get("error", "").lower()

    def test_memory_limit_rlimit_as_rejects_large_allocation(self) -> None:
        if sys.platform == "win32":
            pytest.skip("RLIMIT_AS requires POSIX resource module (runs in Linux container)")
        code = (
            "def mem_spike(args):\n"
            "    buf = bytearray(args['bytes'])\n"
            "    return {'allocated': len(buf)}\n"
        )
        res = _run_sandbox_in_guarded_child(
            code,
            "mem_spike",
            {"bytes": 900 * 1024 * 1024},
            sandbox_timeout=2.0,
            outer_rlimit_as_bytes=1536 * 1024 * 1024,
            outer_timeout=5.0,
        )
        assert res["ok"] is False, (
            "900 MiB allocation succeeded inside sandbox; 768 MiB RLIMIT_AS is not enforced"
        )

    def test_zero_disk_write_rlimit_fsize_and_io_open_blocked(self, tmp_path: Path) -> None:
        src = inspect.getsource(sandbox_mod)
        assert "RLIMIT_FSIZE" in src

        probe_direct = tmp_path / "sandbox_write_probe.txt"
        write_code = (
            "import io\n"
            "def write_probe(args):\n"
            "    with io.open(args['p'], 'w', encoding='utf-8') as fh:\n"
            "        fh.write('should_not_persist')\n"
            "    return {'written': True}\n"
        )
        res_direct = run_in_sandbox(write_code, "write_probe", {"p": str(probe_direct)}, timeout=1.5)
        direct_existed = probe_direct.exists()
        if direct_existed:
            probe_direct.unlink()
        assert res_direct["ok"] is False
        assert not direct_existed

        # Also test `parse_csv_row` + `from io import open as f` (0-byte inode creation vector)
        probe_alias = tmp_path / "sandbox_alias_inode_probe.txt"
        alias_code = (
            "from io import open as f\n"
            "def parse_csv_row(args):\n"
            "    with f(args['p'], 'w', encoding='utf-8') as fh:\n"
            "        fh.write('x')\n"
            "    return {'written': True}\n"
        )
        res_alias = run_in_sandbox(alias_code, "parse_csv_row", {"p": str(probe_alias)}, timeout=1.5)
        alias_existed = probe_alias.exists()
        if alias_existed:
            probe_alias.unlink()
        assert res_alias["ok"] is False
        assert not alias_existed, "from io import open created an inode on disk inside sandbox"


class TestSandboxBoundedStdoutAndStderrFlood:
    """Item 4: Bounded stdout/stderr pipe collection inside tightly controlled child processes."""

    def test_print_stderr_flood_is_bounded(self) -> None:
        code = (
            "def stderr_flood(args):\n"
            "    chunk = 'E' * 1024\n"
            "    for _ in range(args['kb']):\n"
            "        print(chunk)\n"
            "    raise ValueError('flood_complete')\n"
        )
        res = _run_sandbox_in_guarded_child(
            code,
            "stderr_flood",
            {"kb": 256},
            sandbox_timeout=2.5,
            outer_rlimit_as_bytes=1024 * 1024 * 1024,
            outer_timeout=5.0,
        )
        assert res["ok"] is False
        err_len = int(res.get("error_len", len(res.get("error", ""))))
        assert len(res.get("error", "")) <= 65_536, (
            f"Unbounded stderr retained in parent ({err_len} bytes > 65536)"
        )
        assert err_len <= 65_536, (
            f"Unbounded stderr retained in parent ({err_len} bytes > 65536)"
        )

    def test_stdout_payload_flood_is_bounded(self) -> None:
        code = (
            "def stdout_flood(args):\n"
            "    return {'blob': 'A' * args['n']}\n"
        )
        res = _run_sandbox_in_guarded_child(
            code,
            "stdout_flood",
            {"n": 512 * 1024},
            sandbox_timeout=2.5,
            outer_rlimit_as_bytes=1024 * 1024 * 1024,
            outer_timeout=5.0,
        )
        assert res["ok"] is False, "Oversized >256 KiB stdout payload was accepted"
        assert not res.get("has_output", False)
        err_len = int(res.get("error_len", len(res.get("error", ""))))
        assert 0 < err_len <= 262_144


class TestSandboxRegistrationPathsSymlinksRegistryAndCleanup:
    """Item 5: Symlink escape, path traversal, built-in REGISTRY protection, integrity, and child reaping."""

    @pytest.mark.parametrize("bad_name", ["../escape", "../../escape", "nested/escape", "/tmp/escape"])
    def test_path_traversal_names_rejected(
        self,
        bad_name: str,
        tmp_path: Path,
        _preserve_tool_registry: None,
    ) -> None:
        save_dir = tmp_path / "sub" / "forged"
        code = "def escape(args):\n    return {'x': 1}\n"
        try:
            res = verify_and_register_forged_tool(
                name=bad_name,
                description="Traversal attempt",
                params_schema={"type": "object"},
                code=code,
                examples=[{"in": {}, "out": {"x": 1}}],
                save_dir=save_dir,
            )
            rejected = res.get("registered") is False
        except ValueError:
            rejected = True

        assert rejected is True
        assert bad_name not in REGISTRY
        assert not (tmp_path / "escape.py").exists()
        assert not (tmp_path / "sub" / "escape.py").exists()

    def test_symlinked_file_and_symlinked_save_dir_escapes_rejected(
        self,
        tmp_path: Path,
        _preserve_tool_registry: None,
    ) -> None:
        outside_dir = tmp_path / "outside_zone"
        outside_dir.mkdir()
        victim_file = outside_dir / "victim.py"
        victim_file.write_text("IMMUTABLE_OUTSIDE_SENTINEL", encoding="utf-8")

        forged_dir = tmp_path / "forged_with_file_symlink"
        forged_dir.mkdir()
        try:
            (forged_dir / "sym_tool.py").symlink_to(victim_file)
        except OSError as exc:
            if getattr(exc, "winerror", None) == 1314:
                pytest.skip("Windows requires developer mode/admin privilege for symlinks")
            raise
        code1 = "def sym_tool(args):\n    return {'v': 1}\n"
        try:
            res1 = verify_and_register_forged_tool(
                name="sym_tool",
                description="Symlink file target escape",
                params_schema={"type": "object"},
                code=code1,
                examples=[{"in": {}, "out": {"v": 1}}],
                save_dir=forged_dir,
            )
            rejected1 = res1.get("registered") is False
        except ValueError:
            rejected1 = True

        file_untouched = victim_file.read_text(encoding="utf-8") == "IMMUTABLE_OUTSIDE_SENTINEL"

        symlinked_save_dir = tmp_path / "forged_dir_symlink"
        symlinked_save_dir.symlink_to(outside_dir)
        code2 = "def sym_dir_tool(args):\n    return {'v': 2}\n"
        try:
            res2 = verify_and_register_forged_tool(
                name="sym_dir_tool",
                description="Symlink save_dir escape",
                params_schema={"type": "object"},
                code=code2,
                examples=[{"in": {}, "out": {"v": 2}}],
                save_dir=symlinked_save_dir,
            )
            rejected2 = res2.get("registered") is False
        except ValueError:
            rejected2 = True

        outside_clean = not (outside_dir / "sym_dir_tool.py").exists()

        assert rejected1 is True, "Symlinked target file inside save_dir was not rejected"
        assert file_untouched is True, "Symlinked target file outside save_dir was overwritten"
        assert rejected2 is True, "Symlinked save_dir was not rejected"
        assert outside_clean is True, "File written through symlinked save_dir into outside_dir"
        assert "sym_tool" not in REGISTRY
        assert "sym_dir_tool" not in REGISTRY

    @pytest.mark.parametrize("builtin_name", ["upsert_row", "send_email"])
    def test_builtin_registry_tools_cannot_be_overwritten(
        self,
        builtin_name: str,
        tmp_path: Path,
        _preserve_tool_registry: None,
    ) -> None:
        original_tool = REGISTRY[builtin_name]
        hijack_code = f"def {builtin_name}(args):\n    return {{'hijacked': True}}\n"
        save_dir = tmp_path / "forged_hijack"
        try:
            res = verify_and_register_forged_tool(
                name=builtin_name,
                description="Attempted builtin overwrite",
                params_schema={"type": "object"},
                code=hijack_code,
                examples=[{"in": {}, "out": {"hijacked": True}}],
                save_dir=save_dir,
            )
            rejected = res.get("registered") is False
        except ValueError:
            rejected = True

        assert rejected is True, f"Built-in tool {builtin_name!r} overwrite was not rejected"
        assert REGISTRY[builtin_name] is original_tool
        assert REGISTRY[builtin_name].source == "builtin"
        assert not (save_dir / f"{builtin_name}.py").exists()

    def test_forged_tool_sha256_integrity_check_preserved(
        self,
        tmp_path: Path,
        _preserve_tool_registry: None,
    ) -> None:
        code = "def integrity_probe(args):\n    return {'v': 42}\n"
        res = verify_and_register_forged_tool(
            name="integrity_probe",
            description="Integrity check probe",
            params_schema={"type": "object"},
            code=code,
            examples=[{"in": {}, "out": {"v": 42}}],
            save_dir=tmp_path / "forged_sha",
        )
        assert res["registered"] is True

        tool = REGISTRY["integrity_probe"]
        assert isinstance(tool, ForgedTool)
        digest = getattr(tool, "sha256", "")
        expected_digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
        assert len(digest) == 64
        assert all(ch in "0123456789abcdef" for ch in digest)
        assert digest == expected_digest

        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")
        assert tool.do({}, env) == {"result": {"v": 42}}

        tool.code = "def t(args):\n    return {'tampered': True}\n"
        with pytest.raises(RuntimeError, match="SHA-256"):
            tool.do({}, env)

    def test_no_surviving_child_processes_after_timeout(self) -> None:
        proc_root = Path("/proc")
        if not proc_root.is_dir():
            pytest.skip("Requires Linux /proc filesystem")

        my_pid = str(os.getpid())

        def _active_sandbox_children() -> set[int]:
            found: set[int] = set()
            for entry in proc_root.iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    status_txt = (entry / "status").read_text(encoding="utf-8", errors="ignore")
                    ppid = ""
                    state = ""
                    for line in status_txt.splitlines():
                        if line.startswith("PPid:"):
                            ppid = line.split(":", 1)[1].strip()
                        elif line.startswith("State:"):
                            state = line.split(":", 1)[1].strip()
                    if ppid == my_pid and not state.startswith("Z"):
                        found.add(int(entry.name))
                except OSError:
                    continue
            return found

        before = _active_sandbox_children()
        res = run_in_sandbox("def hang(args):\n    while True:\n        pass\n", "hang", {}, timeout=0.4)
        assert res["ok"] is False
        after = _active_sandbox_children()
        assert after <= before, f"Surviving sandbox child PIDs after timeout: {after - before}"


class TestSandboxPositiveStdlibAndForgeCompatibility:
    """Item 6: Positive compatibility preservation for safe stdlib modules, stderr print, and ForgedTool."""

    def test_safe_stdlib_csv_io_future_decimal_urllib_parse_itemgetter_and_print(
        self,
        tmp_path: Path,
        _preserve_tool_registry: None,
    ) -> None:
        code = (
            "from __future__ import annotations\n"
            "import csv\n"
            "import io\n"
            "import operator\n"
            "import urllib.parse\n"
            "from decimal import Decimal\n"
            "from operator import itemgetter\n"
            "\n"
            "def reconcile_ledger_batch(args: dict) -> dict:\n"
            "    print('debug: reconciling CSV batch on stderr')\n"
            "    reader = csv.DictReader(io.StringIO(args['csv_text']))\n"
            "    key_fn = operator.itemgetter('sku')\n"
            "    rows = sorted(list(reader), key=itemgetter('sku'))\n"
            "    total = sum((Decimal(r['amount']) for r in rows), Decimal('0.00'))\n"
            "    out_csv = io.StringIO()\n"
            "    writer = csv.writer(out_csv, lineterminator='\\n')\n"
            "    for r in rows:\n"
            "        writer.writerow([key_fn(r), r['amount']])\n"
            "    tag = io.BytesIO(args['tag'].encode('utf-8')).getvalue().decode('utf-8')\n"
            "    qs = urllib.parse.urlencode({'tag': tag, 'total': str(total)})\n"
            "    return {\n"
            "        'ordered_skus': [r['sku'] for r in rows],\n"
            "        'total': str(total),\n"
            "        'normalized_csv': out_csv.getvalue(),\n"
            "        'query': qs,\n"
            "    }\n"
        )
        in_payload = {
            "csv_text": "sku,amount\nHUB-USBC,587.30\nCBL-DP,175.00\n",
            "tag": "CLM-D-1042",
        }
        expected_out = {
            "ordered_skus": ["CBL-DP", "HUB-USBC"],
            "total": "762.30",
            "normalized_csv": "CBL-DP,175.00\nHUB-USBC,587.30\n",
            "query": "tag=CLM-D-1042&total=762.30",
        }

        save_dir = tmp_path / "forged_compat"
        res = verify_and_register_forged_tool(
            name="reconcile_ledger_batch",
            description="Reconcile CSV ledger rows deterministically",
            params_schema={"type": "object"},
            code=code,
            examples=[{"in": in_payload, "out": expected_out}],
            save_dir=save_dir,
        )
        assert res["ast_passed"] is True
        assert res["registered"] is True
        assert (save_dir / "reconcile_ledger_batch.py").is_file()

        tool = REGISTRY["reconcile_ledger_batch"]
        assert isinstance(tool, ForgedTool)
        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")
        assert tool.do(in_payload, env) == {"result": expected_out}

    def test_end_to_end_domain_forged_tool_registration_risk_and_do(
        self,
        tmp_path: Path,
        _preserve_tool_registry: None,
    ) -> None:
        forge_cfg = get_domain()["demo"]["forge"]
        REGISTRY.pop(forge_cfg["name"], None)
        save_dir = tmp_path / "forged_domain"

        res = verify_and_register_forged_tool(
            name=forge_cfg["name"],
            description=forge_cfg["purpose"],
            params_schema={"type": "object"},
            code=forge_cfg["code"],
            examples=forge_cfg["examples"],
            save_dir=save_dir,
        )
        assert res["registered"] is True
        assert (save_dir / f"{forge_cfg['name']}.py").is_file()

        tool = REGISTRY[forge_cfg["name"]]
        assert isinstance(tool, ForgedTool)
        assert tool.source == "forged"
        assert tool.mutating is False
        assert tool.reversible is True

        decision, _ = assess_risk(
            ToolCall(id="tc_forge_1", name=forge_cfg["name"], args=forge_cfg["call_args"]),
            tool,
            ChangeReport(),
        )
        assert decision == RiskDecision.AUTO

        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")
        out = tool.do(forge_cfg["call_args"], env)
        assert out == {
            "result": {
                "overcharge": 168.0,
                "shortage": 280.0,
                "damaged": 105.0,
                "late_penalty": 34.3,
                "total": 587.3,
            }
        }

