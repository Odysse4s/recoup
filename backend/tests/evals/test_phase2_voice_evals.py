"""Phase 2 evaluations: dual-speaker vendor call TTS, fal Wizper STT, and real-sandbox Forge archetypes."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Self

import httpx
import pytest

from app.agent import forge as forge_module
from app.agent.forge import _extract_python_code, forge_missing_tool
from app.agent.llm import LLMResponse
from app.contracts import EventType
from app.engine import sandbox as sandbox_module
from app.engine.env import Env
from app.engine.tools import REGISTRY
from app.voice import (
    AGENT_VOICE,
    COUNTERPARTY_VOICE,
    synthesize_call_turn,
    transcribe_and_decide,
    transcribe_audio_bytes,
)
from app.voice import call_audio as call_audio_module

_VOICE_ENV_KEYS = (
    "FAL_KEY",
    "FAL_TTS_MODEL",
    "FAL_STT_MODEL",
    "FAL_STT_LANGUAGE",
    "FAL_AGENT_VOICE",
    "FAL_COUNTERPARTY_VOICE",
    "AGENT_VOICE",
    "COUNTERPARTY_VOICE",
    "GROK_VOICE",
    "VOICE_PROVIDER",
    "VOICE_CACHE_DIR",
)

_PHASE2_FORGE_TOOLS = (
    "compute_tiered_volume_rebate",
    "audit_fx_invoice_discrepancy",
    "compute_sla_uptime_credit",
    "compute_freight_cap",
)


@pytest.fixture(autouse=True)
def _clean_phase2_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    for env_key in _VOICE_ENV_KEYS:
        monkeypatch.delenv(env_key, raising=False)
    cache_dir = tmp_path / ".voice_cache"
    monkeypatch.setattr(call_audio_module, "VOICE_CACHE_DIR", cache_dir)
    call_audio_module._turn_audio_lru.clear()
    for tool_name in _PHASE2_FORGE_TOOLS:
        REGISTRY.pop(tool_name, None)
    yield cache_dir
    call_audio_module._turn_audio_lru.clear()
    for tool_name in _PHASE2_FORGE_TOOLS:
        REGISTRY.pop(tool_name, None)


class _StubHTTPResponse:
    def __init__(
        self,
        content: bytes = b"",
        json_data: dict[str, Any] | None = None,
        content_type: str = "audio/mpeg",
        status_code: int = 200,
    ) -> None:
        self.content = content
        self._json_data = json_data
        self.headers = {"content-type": content_type}
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            req = httpx.Request("POST", "https://api.example/voice")
            resp = httpx.Response(self.status_code, request=req)
            raise httpx.HTTPStatusError("HTTP error", request=req, response=resp)

    def json(self) -> Any:
        if self._json_data is None:
            raise ValueError("Response is not JSON")
        return self._json_data


class _SequenceLLM:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def complete(
        self,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        self.calls.append({"system": system, "messages": messages, "tools": tools})
        if not self._responses:
            raise AssertionError("SequenceLLM exhausted unexpectedly.")
        return self._responses.pop(0)


# ---------------------------------------------------------------------------
# 1. Dual-Speaker Call Turn TTS & Cache Key Isolation
# ---------------------------------------------------------------------------


class TestDualSpeakerCallSynthesis:
    def test_fal_dual_speaker_cache_isolation_and_distinct_voices(
        self,
        monkeypatch: pytest.MonkeyPatch,
        _clean_phase2_state: Path,
    ) -> None:
        assert AGENT_VOICE != COUNTERPARTY_VOICE
        monkeypatch.setenv("FAL_KEY", "fal-live-key")

        requests_log: list[tuple[str, str, dict[str, Any]]] = []

        class FalDualClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _StubHTTPResponse:
                requests_log.append(("POST", url, json))
                voice_tag = json["voice"]
                return _StubHTTPResponse(
                    json_data={"audio": {"url": f"https://fal.media/turn-{voice_tag}.mp3"}},
                    content_type="application/json",
                )

            def get(self, url: str) -> _StubHTTPResponse:
                requests_log.append(("GET", url, {}))
                return _StubHTTPResponse(content=f"MP3::{url}".encode(), content_type="audio/mpeg")

        monkeypatch.setattr(call_audio_module.httpx, "Client", FalDualClient)

        shared_line = "Confirmed at 85 percent for EUR 499.21 on claim CLM-D-1042."
        agent_audio = synthesize_call_turn("agent", shared_line)
        counterparty_audio = synthesize_call_turn("counterparty", shared_line)

        assert agent_audio is not None
        assert counterparty_audio is not None
        assert agent_audio != counterparty_audio

        post_payloads = [item[2] for item in requests_log if item[0] == "POST"]
        assert len(post_payloads) == 2
        assert post_payloads[0]["voice"] == AGENT_VOICE
        assert post_payloads[1]["voice"] == COUNTERPARTY_VOICE

        cached_files = sorted(_clean_phase2_state.glob("*.mp3"))
        assert len(cached_files) == 2

        # Subsequent calls hit distinct disk cache entries with zero extra HTTP calls
        call_count_before = len(requests_log)
        assert synthesize_call_turn("agent", shared_line) == agent_audio
        assert synthesize_call_turn("counterparty", shared_line) == counterparty_audio
        assert len(requests_log) == call_count_before

        # And once warm, repeated lines are served from the in-memory LRU without even
        # touching disk (deleting the backing .mp3 files must not change the result).
        for f in cached_files:
            f.unlink()
        assert synthesize_call_turn("agent", shared_line) == agent_audio
        assert synthesize_call_turn("counterparty", shared_line) == counterparty_audio
        assert len(requests_log) == call_count_before

    def test_turn_audio_lru_evicts_oldest_entry_past_max_size(
        self,
        monkeypatch: pytest.MonkeyPatch,
        _clean_phase2_state: Path,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-live-key")

        post_count = {"n": 0}

        class FalLruClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _StubHTTPResponse:
                post_count["n"] += 1
                return _StubHTTPResponse(
                    json_data={"audio": {"url": f"https://fal.media/turn-{post_count['n']}.mp3"}},
                    content_type="application/json",
                )

            def get(self, url: str) -> _StubHTTPResponse:
                return _StubHTTPResponse(content=f"MP3::{url}".encode(), content_type="audio/mpeg")

        monkeypatch.setattr(call_audio_module.httpx, "Client", FalLruClient)

        max_size = call_audio_module._TURN_AUDIO_LRU_MAX
        first_line = "Line number zero, the oldest one."
        synthesize_call_turn("agent", first_line)
        for i in range(1, max_size + 5):
            synthesize_call_turn("agent", f"Line number {i}, filler to push the LRU past capacity.")

        assert len(call_audio_module._turn_audio_lru) == max_size
        # Deleting the disk cache proves whether an entry is still warm in the LRU or not.
        for f in call_audio_module.VOICE_CACHE_DIR.glob("*.mp3"):
            f.unlink()

        recent_line = f"Line number {max_size + 4}, filler to push the LRU past capacity."
        calls_before = post_count["n"]
        assert synthesize_call_turn("agent", recent_line) is not None  # still in the LRU
        assert post_count["n"] == calls_before  # no new network call needed

        assert synthesize_call_turn("agent", first_line) is not None  # evicted long ago -> refetched
        assert post_count["n"] == calls_before + 1

    def test_fal_turn_tts_and_env_override_send_distinct_voices(
        self,
        monkeypatch: pytest.MonkeyPatch,
        _clean_phase2_state: Path,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-dual-key")

        seen_voices: list[str] = []

        class FalVoiceDualClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _StubHTTPResponse:
                assert headers["Authorization"] == "Key fal-dual-key"
                v = str(json.get("voice", ""))
                seen_voices.append(v)
                return _StubHTTPResponse(content=f"FAL::{v}".encode(), content_type="audio/mpeg")

        monkeypatch.setattr(call_audio_module.httpx, "Client", FalVoiceDualClient)

        same_utterance = "We can settle CLM-D-1042 today."
        a_mp3 = synthesize_call_turn("agent", same_utterance)
        c_mp3 = synthesize_call_turn("counterparty", same_utterance)

        assert a_mp3 != c_mp3
        assert seen_voices[:2] == ["ara", "eve"]

        # Custom env voice overrides produce distinct fal.run requests and cache entries
        monkeypatch.setenv("AGENT_VOICE", "rex")
        monkeypatch.setenv("COUNTERPARTY_VOICE", "leo")
        a_override = synthesize_call_turn("agent", same_utterance)
        c_override = synthesize_call_turn("counterparty", same_utterance)
        assert a_override != c_override
        assert seen_voices[2:] == ["rex", "leo"]

    def test_strips_bracketed_speaker_stage_directions_before_tts(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-stage-key")
        sent_texts: list[str] = []

        class TagStripClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _StubHTTPResponse:
                sent_texts.append(json["text"])
                return _StubHTTPResponse(content=b"ID3-clean-turn", content_type="audio/mpeg")

        monkeypatch.setattr(call_audio_module.httpx, "Client", TagStripClient)

        audio = synthesize_call_turn(
            "agent",
            "[Recoup Procurement Agent] Calling Kappa Office Systems regarding CLM-D-1042.",
        )
        assert audio == b"ID3-clean-turn"
        assert sent_texts == ["Calling Kappa Office Systems regarding CLM-D-1042."]
        assert synthesize_call_turn("agent", "[Recoup Procurement Agent]") is None


# ---------------------------------------------------------------------------
# 2. Mocked fal Wizper STT -> `transcribe_and_decide`
# ---------------------------------------------------------------------------


class TestFalWizperSttAndDecision:
    @pytest.mark.parametrize(
        ("spoken_reply", "mime_type", "expected_mime", "expected_decision"),
        [
            ("Approve and commit the staged claim.", "audio/mp4;codecs=mp4a.40.2", "audio/mpeg", "approve"),
            ("Reject and roll back immediately.", "audio/webm;codecs=opus", "video/webm", "reject"),
            ("Can you read out the delivery date on D-1042?", "audio/wav", "audio/x-wav", "unknown"),
        ],
    )
    def test_wizper_stt_transcribes_safari_and_webm_audio_into_decisions(
        self,
        monkeypatch: pytest.MonkeyPatch,
        spoken_reply: str,
        mime_type: str,
        expected_mime: str,
        expected_decision: str,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-stt-secret")
        raw_audio = b"\x00\x00\x00\x1cftypisom-safari-mic-recording"
        expected_b64 = base64.b64encode(raw_audio).decode("ascii")
        captured: list[tuple[str, dict[str, Any]]] = []

        class WizperClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _StubHTTPResponse:
                assert headers["Authorization"] == "Key fal-stt-secret"
                captured.append((url, json))
                return _StubHTTPResponse(
                    json_data={"text": f"  {spoken_reply}  "},
                    content_type="application/json",
                )

        monkeypatch.setattr(call_audio_module.httpx, "Client", WizperClient)

        result = transcribe_and_decide(audio_bytes=raw_audio, mime_type=mime_type)
        assert result == {"transcript": spoken_reply, "decision": expected_decision}
        assert len(captured) == 1
        assert captured[0][0] == "https://fal.run/fal-ai/wizper"
        assert captured[0][1]["audio_url"] == f"data:{expected_mime};base64,{expected_b64}"
        assert captured[0][1]["task"] == "transcribe"

    def test_explicit_transcript_bypasses_wizper_network_call(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-stt-secret")

        class ForbiddenClient:
            def __init__(self, **kwargs: Any) -> None:
                raise AssertionError("HTTP client should not be instantiated when transcript is provided")

        monkeypatch.setattr(call_audio_module.httpx, "Client", ForbiddenClient)

        out = transcribe_and_decide(audio_bytes=b"unused", transcript="Confirm, ship it!")
        assert out == {"transcript": "Confirm, ship it!", "decision": "approve"}


# ---------------------------------------------------------------------------
# 3. Offline Graceful Degradation (Zero API Keys)
# ---------------------------------------------------------------------------


class TestOfflineGracefulDegradation:
    def test_zero_api_keys_return_none_and_empty_strings_cleanly(self) -> None:
        assert synthesize_call_turn("agent", "Calling regarding CLM-D-1042.") is None
        assert synthesize_call_turn("counterparty", "We offer 70 percent.") is None
        assert synthesize_call_turn("agent", "   ") is None

        assert transcribe_audio_bytes(b"webm-audio-bytes", mime_type="audio/webm") == ""
        assert transcribe_audio_bytes(b"") == ""

        assert transcribe_and_decide(audio_bytes=b"webm-audio-bytes") == {
            "transcript": "",
            "decision": "unknown",
        }

    def test_http_failure_in_stt_or_tts_degrades_cleanly_without_raising(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal- transient-error")

        class BrokenClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _StubHTTPResponse:
                return _StubHTTPResponse(status_code=502)

        monkeypatch.setattr(call_audio_module.httpx, "Client", BrokenClient)

        assert synthesize_call_turn("agent", "Testing 502 fallback.") is None
        assert transcribe_audio_bytes(b"sample-bytes") == ""
        assert transcribe_and_decide(audio_bytes=b"sample-bytes") == {
            "transcript": "",
            "decision": "unknown",
        }


# ---------------------------------------------------------------------------
# 4. Three Adversarial Enterprise Forge Archetypes via REAL Subprocess Sandbox
# ---------------------------------------------------------------------------


class TestRealSandboxEnterpriseForgeArchetypes:
    def test_uses_real_subprocess_sandbox_verifier(self) -> None:
        assert forge_module.verify_and_register_forged_tool is sandbox_module.verify_and_register_forged_tool

    def test_archetype_1_tiered_volume_rebate_with_top_level_constants_and_repair(
        self,
        tmp_path: Path,
    ) -> None:
        """Progressive bracket rebate (0-100 @ 0%, 101-500 @ 3%, 501+ @ 6%) + early-pay bonus + cap."""
        spec = {
            "name": "compute_tiered_volume_rebate",
            "purpose": (
                "Calculate marginal tiered procurement rebate plus early-settlement bonus "
                "capped at max_rebate_eur"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "units_purchased": {"type": "integer"},
                    "unit_price_eur": {"type": "number"},
                    "early_pay_bonus_pct": {"type": "number"},
                    "max_rebate_eur": {"type": "number"},
                },
                "required": [
                    "units_purchased",
                    "unit_price_eur",
                    "early_pay_bonus_pct",
                    "max_rebate_eur",
                ],
            },
            "output_schema": {"type": "object"},
            "examples": [
                {
                    # 600 units @ EUR 20: tier1=100*0%=0, tier2=400*20*3%=240, tier3=100*20*6%=120 -> 360
                    # gross spend = 12,000; early_pay 1% = 120; raw=480 <= 600 cap -> 480.0
                    "in": {
                        "units_purchased": 600,
                        "unit_price_eur": 20.0,
                        "early_pay_bonus_pct": 1.0,
                        "max_rebate_eur": 600.0,
                    },
                    "out": {
                        "tier_rebate_eur": 360.0,
                        "early_pay_eur": 120.0,
                        "net_rebate_eur": 480.0,
                        "capped": False,
                    },
                },
                {
                    # 80 units @ EUR 20: below 100 threshold -> tier=0, early_pay=0 -> 0.0
                    "in": {
                        "units_purchased": 80,
                        "unit_price_eur": 20.0,
                        "early_pay_bonus_pct": 0.0,
                        "max_rebate_eur": 500.0,
                    },
                    "out": {
                        "tier_rebate_eur": 0.0,
                        "early_pay_eur": 0.0,
                        "net_rebate_eur": 0.0,
                        "capped": False,
                    },
                },
                {
                    # 1000 units @ EUR 25: tier2=400*25*3%=300, tier3=500*25*6%=750 -> 1050
                    # gross=25,000; early_pay 1%=250; raw=1300 capped at 1000.0 -> capped=True
                    "in": {
                        "units_purchased": 1000,
                        "unit_price_eur": 25.0,
                        "early_pay_bonus_pct": 1.0,
                        "max_rebate_eur": 1000.0,
                    },
                    "out": {
                        "tier_rebate_eur": 1050.0,
                        "early_pay_eur": 250.0,
                        "net_rebate_eur": 1000.0,
                        "capped": True,
                    },
                },
            ],
        }

        # Attempt 1 omits the `max_rebate_eur` cap (fails Example 2); Attempt 2 repairs with top-level constant
        attempt1_uncapped = """\
def compute_tiered_volume_rebate(args: dict) -> dict:
    units = max(0, int(args.get("units_purchased", 0)))
    price = max(0.0, float(args.get("unit_price_eur", 0.0)))
    bonus_pct = max(0.0, float(args.get("early_pay_bonus_pct", 0.0)))
    tier2_units = max(0, min(units, 500) - 100)
    tier3_units = max(0, units - 500)
    tier_rebate = (tier2_units * 0.03 + tier3_units * 0.06) * price
    early_pay = (units * price) * (bonus_pct / 100.0)
    raw_total = tier_rebate + early_pay
    return {
        "tier_rebate_eur": round(tier_rebate, 2),
        "early_pay_eur": round(early_pay, 2),
        "net_rebate_eur": round(raw_total, 2),
        "capped": False,
    }
"""
        attempt2_repaired = """\
REBATE_TIERS = ((100, 500, 0.03), (500, None, 0.06))

def compute_tiered_volume_rebate(args: dict) -> dict:
    units = max(0, int(args.get("units_purchased", 0)))
    price = max(0.0, float(args.get("unit_price_eur", 0.0)))
    bonus_pct = max(0.0, float(args.get("early_pay_bonus_pct", 0.0)))
    cap = max(0.0, float(args.get("max_rebate_eur", 0.0)))

    tier_rebate = 0.0
    for low, high, rate in REBATE_TIERS:
        if units > low:
            upper = units if high is None else min(units, high)
            tier_rebate += (upper - low) * price * rate

    early_pay = (units * price) * (bonus_pct / 100.0)
    raw_total = tier_rebate + early_pay
    net_total = min(raw_total, cap)
    return {
        "tier_rebate_eur": round(tier_rebate, 2),
        "early_pay_eur": round(early_pay, 2),
        "net_rebate_eur": round(net_total, 2),
        "capped": raw_total > cap,
    }
"""
        assert "REBATE_TIERS" in _extract_python_code(attempt2_repaired)

        llm = _SequenceLLM(
            [
                LLMResponse(text=json.dumps(spec)),
                LLMResponse(text=attempt1_uncapped),
                LLMResponse(text=attempt2_repaired),
            ]
        )
        events: list[tuple[EventType, dict[str, Any]]] = []

        ok = forge_missing_tool(
            llm,
            "MISSING:compute_tiered_volume_rebate",
            "Audit annual procurement volume rebate tiers against vendor master contract",
            emit=lambda et, p, _t, _c: events.append((et, p)),
            save_dir=tmp_path / "forged",
            max_attempts=3,
        )
        assert ok is True
        assert "compute_tiered_volume_rebate" in REGISTRY

        reg_payload = next(p for t, p in events if t == EventType.FORGE_REGISTERED)
        assert reg_payload["attempt"] == 2

        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")
        live_res = REGISTRY["compute_tiered_volume_rebate"].do(
            {
                "units_purchased": 600,
                "unit_price_eur": 20.0,
                "early_pay_bonus_pct": 1.0,
                "max_rebate_eur": 600.0,
            },
            env,
        )
        assert live_res["result"] == {
            "tier_rebate_eur": 360.0,
            "early_pay_eur": 120.0,
            "net_rebate_eur": 480.0,
            "capped": False,
        }

    def test_archetype_2_multi_currency_fx_invoice_discrepancy(self, tmp_path: Path) -> None:
        """FX invoice conversion to EUR (`Decimal` `ROUND_HALF_UP`) + tolerance gate."""
        spec = {
            "name": "audit_fx_invoice_discrepancy",
            "purpose": (
                "Convert foreign-currency vendor invoice to EUR, compare against contracted PO EUR "
                "total, and flag AP hold when overcharge exceeds tolerance_eur"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "billed_foreign": {"type": "number"},
                    "currency": {"type": "string"},
                    "fx_rate_to_eur": {"type": "number"},
                    "po_contract_eur": {"type": "number"},
                    "tolerance_eur": {"type": "number"},
                },
                "required": [
                    "billed_foreign",
                    "currency",
                    "fx_rate_to_eur",
                    "po_contract_eur",
                    "tolerance_eur",
                ],
            },
            "output_schema": {"type": "object"},
            "examples": [
                {
                    # USD 2,500.00 * 0.9235 = EUR 2,308.75 vs PO EUR 2,150.00 -> +158.75 (> 5.00 tol)
                    "in": {
                        "billed_foreign": 2500.00,
                        "currency": "usd",
                        "fx_rate_to_eur": 0.9235,
                        "po_contract_eur": 2150.00,
                        "tolerance_eur": 5.00,
                    },
                    "out": {
                        "currency": "USD",
                        "billed_eur": 2308.75,
                        "discrepancy_eur": 158.75,
                        "within_tolerance": False,
                        "hold_recommended": True,
                    },
                },
                {
                    # GBP 1,000.00 * 1.1720 = EUR 1,172.00 vs PO EUR 1,170.00 -> +2.00 (<= 5.00 tol)
                    "in": {
                        "billed_foreign": 1000.00,
                        "currency": "GBP",
                        "fx_rate_to_eur": 1.1720,
                        "po_contract_eur": 1170.00,
                        "tolerance_eur": 5.00,
                    },
                    "out": {
                        "currency": "GBP",
                        "billed_eur": 1172.00,
                        "discrepancy_eur": 2.00,
                        "within_tolerance": True,
                        "hold_recommended": False,
                    },
                },
                {
                    # EUR 840.00 * 1.0 = EUR 840.00 vs PO EUR 850.00 -> -10.00 (underbilled, no hold)
                    "in": {
                        "billed_foreign": 840.00,
                        "currency": "EUR",
                        "fx_rate_to_eur": 1.0,
                        "po_contract_eur": 850.00,
                        "tolerance_eur": 2.00,
                    },
                    "out": {
                        "currency": "EUR",
                        "billed_eur": 840.00,
                        "discrepancy_eur": -10.00,
                        "within_tolerance": True,
                        "hold_recommended": False,
                    },
                },
            ],
        }

        fx_code = """\
from decimal import Decimal, ROUND_HALF_UP

def audit_fx_invoice_discrepancy(args: dict) -> dict:
    ccy = str(args.get("currency", "EUR")).strip().upper()
    billed_f = Decimal(str(args.get("billed_foreign", 0)))
    rate = Decimal("1") if ccy == "EUR" else Decimal(str(args.get("fx_rate_to_eur", 1)))
    po_eur = Decimal(str(args.get("po_contract_eur", 0)))
    tol = Decimal(str(max(0.0, float(args.get("tolerance_eur", 0)))))

    billed_eur = (billed_f * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    diff = (billed_eur - po_eur).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    over_tol = diff > tol
    return {
        "currency": ccy,
        "billed_eur": float(billed_eur),
        "discrepancy_eur": float(diff),
        "within_tolerance": not over_tol,
        "hold_recommended": over_tol,
    }
"""
        llm = _SequenceLLM(
            [
                LLMResponse(text=json.dumps(spec)),
                LLMResponse(text=f"```python\n{fx_code}\n```"),
            ]
        )

        assert (
            forge_missing_tool(
                llm,
                "audit_fx_invoice_discrepancy",
                "Reconcile USD and GBP vendor invoices against EUR master purchase orders",
                save_dir=tmp_path / "forged",
            )
            is True
        )

        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")
        out = REGISTRY["audit_fx_invoice_discrepancy"].do(
            {
                "billed_foreign": 2500.00,
                "currency": "usd",
                "fx_rate_to_eur": 0.9235,
                "po_contract_eur": 2150.00,
                "tolerance_eur": 5.00,
            },
            env,
        )
        assert out["result"]["billed_eur"] == 2308.75
        assert out["result"]["hold_recommended"] is True

    def test_archetype_3_sla_uptime_credit_with_adversarial_ast_recovery(
        self,
        tmp_path: Path,
    ) -> None:
        """Monthly SaaS/workplace SLA availability credit per full 10 bps breach, capped at max_credit_pct."""
        spec = {
            "name": "compute_sla_uptime_credit",
            "purpose": (
                "Compute monthly SLA service credit for each full 0.10% (10 bps) below promised "
                "uptime percentage, capped at max_credit_pct of monthly_fee_eur"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "promised_uptime_pct": {"type": "number"},
                    "actual_uptime_pct": {"type": "number"},
                    "monthly_fee_eur": {"type": "number"},
                    "credit_pct_per_10bps": {"type": "number"},
                    "max_credit_pct": {"type": "number"},
                },
                "required": [
                    "promised_uptime_pct",
                    "actual_uptime_pct",
                    "monthly_fee_eur",
                    "credit_pct_per_10bps",
                    "max_credit_pct",
                ],
            },
            "output_schema": {"type": "object"},
            "examples": [
                {
                    # 99.90% promised vs 99.40% actual -> 50 bps -> 5 steps * 2.5% = 12.5% of 2,400 = 300.0
                    "in": {
                        "promised_uptime_pct": 99.90,
                        "actual_uptime_pct": 99.40,
                        "monthly_fee_eur": 2400.00,
                        "credit_pct_per_10bps": 2.5,
                        "max_credit_pct": 25.0,
                    },
                    "out": {
                        "shortfall_bps": 50,
                        "applied_credit_pct": 12.5,
                        "credit_eur": 300.0,
                    },
                },
                {
                    # 99.90% promised vs 99.95% actual -> 0 bps breach -> 0.0
                    "in": {
                        "promised_uptime_pct": 99.90,
                        "actual_uptime_pct": 99.95,
                        "monthly_fee_eur": 2400.00,
                        "credit_pct_per_10bps": 2.5,
                        "max_credit_pct": 25.0,
                    },
                    "out": {
                        "shortfall_bps": 0,
                        "applied_credit_pct": 0.0,
                        "credit_eur": 0.0,
                    },
                },
                {
                    # 99.90% promised vs 98.00% actual -> 190 bps -> 19 * 2.5% = 47.5% capped at 25.0% -> 600.0
                    "in": {
                        "promised_uptime_pct": 99.90,
                        "actual_uptime_pct": 98.00,
                        "monthly_fee_eur": 2400.00,
                        "credit_pct_per_10bps": 2.5,
                        "max_credit_pct": 25.0,
                    },
                    "out": {
                        "shortfall_bps": 190,
                        "applied_credit_pct": 25.0,
                        "credit_eur": 600.0,
                    },
                },
            ],
        }

        # Attempt 1 tries forbidden `__import__` call -> rejected by real `sandbox.validate_ast`
        adversarial_code = (
            "def compute_sla_uptime_credit(args: dict) -> dict:\n"
            "    _os = __import__('os')\n"
            "    return {'shortfall_bps': 0, 'applied_credit_pct': 0.0, 'credit_eur': 0.0}\n"
        )
        clean_sla_code = """\
from decimal import Decimal, ROUND_HALF_UP

def compute_sla_uptime_credit(args: dict) -> dict:
    promised = Decimal(str(args.get("promised_uptime_pct", 0)))
    actual = Decimal(str(args.get("actual_uptime_pct", 0)))
    fee = Decimal(str(max(0.0, float(args.get("monthly_fee_eur", 0)))))
    step_pct = Decimal(str(max(0.0, float(args.get("credit_pct_per_10bps", 0)))))
    cap_pct = Decimal(str(max(0.0, float(args.get("max_credit_pct", 0)))))

    diff_pct = max(Decimal("0"), promised - actual)
    shortfall_bps = int((diff_pct * Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    steps = shortfall_bps // 10
    applied_pct = min(Decimal(steps) * step_pct, cap_pct)
    credit = (fee * applied_pct / Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {
        "shortfall_bps": shortfall_bps,
        "applied_credit_pct": float(round(applied_pct, 2)),
        "credit_eur": float(credit),
    }
"""
        llm = _SequenceLLM(
            [
                LLMResponse(text=json.dumps(spec)),
                LLMResponse(text=adversarial_code),
                LLMResponse(text=clean_sla_code),
            ]
        )
        test_events: list[dict[str, Any]] = []

        ok = forge_missing_tool(
            llm,
            "compute_sla_uptime_credit",
            "Calculate Nova Workplace Cloud monthly SLA availability credit",
            emit=lambda et, p, _t, _c: test_events.append(p) if et == EventType.FORGE_TEST_RESULT else None,
            save_dir=tmp_path / "forged",
            max_attempts=3,
        )
        assert ok is True
        assert len(test_events) == 2
        assert test_events[0]["ast_passed"] is False
        assert any("__import__" in err for err in test_events[0]["ast_errors"])
        assert test_events[1]["ast_passed"] is True
        assert test_events[1]["registered"] is True

        env = Env(root_dir=tmp_path, db_path=tmp_path / "app.db")
        res = REGISTRY["compute_sla_uptime_credit"].do(
            {
                "promised_uptime_pct": 99.90,
                "actual_uptime_pct": 99.40,
                "monthly_fee_eur": 2400.00,
                "credit_pct_per_10bps": 2.5,
                "max_credit_pct": 25.0,
            },
            env,
        )
        assert res["result"] == {
            "shortfall_bps": 50,
            "applied_credit_pct": 12.5,
            "credit_eur": 300.0,
        }

    def test_forge_missing_tool_recovers_from_truncated_spec_json(self, tmp_path: Path) -> None:
        truncated_spec = '{"name":"compute_freight_cap","purpose":"Cap freight overbill","input_schema":{"type":"object"'
        compact_spec = {
            "name": "compute_freight_cap",
            "purpose": "Cap contracted freight surcharge overbill.",
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object"},
            "examples": [
                {"in": {"billed_eur": 180.0, "cap_eur": 125.0}, "out": {"refund_eur": 55.0}},
                {"in": {"billed_eur": 100.0, "cap_eur": 125.0}, "out": {"refund_eur": 0.0}},
            ],
        }
        code = (
            "def compute_freight_cap(args: dict) -> dict:\n"
            "    billed = max(0.0, float(args.get('billed_eur', 0)))\n"
            "    cap = max(0.0, float(args.get('cap_eur', 0)))\n"
            "    return {'refund_eur': round(max(0.0, billed - cap), 2)}\n"
        )
        llm = _SequenceLLM(
            [
                LLMResponse(text=truncated_spec, input_tokens=100, output_tokens=200),
                LLMResponse(
                    text=json.dumps(compact_spec, separators=(",", ":")),
                    input_tokens=200,
                    output_tokens=100,
                ),
                LLMResponse(text=code, input_tokens=100, output_tokens=80),
            ]
        )
        emitted_costs: list[tuple[EventType, float]] = []

        ok = forge_missing_tool(
            llm,
            "MISSING:compute_freight_cap",
            "Cap contracted freight surcharge overbill on inbound deliveries",
            emit=lambda et, _p, _t, c: emitted_costs.append((et, c)),
            save_dir=tmp_path / "forged",
            max_attempts=2,
        )
        assert ok is True
        assert len(llm.calls) == 3
        assert "STRICT single-line minified JSON" in llm.calls[1]["messages"][-1]["content"]
        assert emitted_costs[0][0] == EventType.FORGE_SPEC
        assert emitted_costs[0][1] == pytest.approx(0.0054)
        assert "compute_freight_cap" in REGISTRY

