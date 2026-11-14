"""Phase 3 evaluations: fal Grok Voice Realtime protocol, barge-in, outcome intelligence, and security."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

import pytest

import app.voice as voice_pkg
from app.contracts import ChangeReport, ToolCall
from app.engine.env import Env, fingerprint_env
from app.engine.risk import RiskDecision, assess_risk
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

        forbidden = ("FAL_KEY", "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "Authorization: Key")
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
