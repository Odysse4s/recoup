"""Offline unit evaluations for Recoup's Voice Risk Gate and vendor call negotiation module."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Self

import httpx
import pytest

from app.contracts import ApprovalNeededPayload, CallEndPayload, CallTurnPayload, ChangeReport
from app.domain_config import DOMAIN
from app.voice import (
    build_briefing_script,
    parse_voice_decision,
    simulate_vendor_negotiation_turns,
    summarize_negotiation_outcome,
    synthesize_briefing,
)
from app.voice import elevenlabs_agent as voice_module

_VOICE_ENV_VARS = (
    "FAL_KEY",
    "FAL_TTS_MODEL",
    "FAL_VOICE_ID",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_VOICE_ID",
    "ELEVENLABS_MODEL_ID",
    "WONDERFUL_API_KEY",
    "WONDERFUL_TTS_URL",
    "VOICE_PROVIDER",
    "VOICE_CACHE_DIR",
)


@pytest.fixture(autouse=True)
def _isolated_voice_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Clear all voice API keys and point `.voice_cache` to an isolated `tmp_path`."""
    for key in _VOICE_ENV_VARS:
        monkeypatch.delenv(key, raising=False)
    cache_dir = tmp_path / ".voice_cache"
    monkeypatch.setattr(voice_module, "VOICE_CACHE_DIR", cache_dir)
    return cache_dir


# ---------------------------------------------------------------------------
# 1. Executive Risk Gate Briefing Script (`build_briefing_script`)
# ---------------------------------------------------------------------------


class TestBuildBriefingScript:
    def test_hero_change_report_produces_crisp_under_18_word_script(self) -> None:
        notify = DOMAIN["demo"]["notify"]
        report = ChangeReport(
            files_created=["claims/CLM-D-1042.md"],
            db_summary={
                "claims": {"inserted": 1, "updated": 0, "deleted": 0},
                "invoices": {"inserted": 0, "updated": 1, "deleted": 0},
            },
            external_outbox=[
                {
                    "tool": "send_email",
                    "to": notify["to"],
                    "subject": notify["subject"],
                    "body": notify["body"],
                }
            ],
        )

        script = build_briefing_script(report.model_dump())
        words = script.split()

        assert len(words) < 18, f"Expected <18 words, got {len(words)}: {script!r}"
        assert "Recoup" in script
        assert "CLM-D-1042" in script
        assert "587 euros" in script
        assert script.endswith("Say approve to commit, or reject to roll back.")

    def test_approval_needed_payload_for_call_and_followup_stay_under_18_words(self) -> None:
        approval = ApprovalNeededPayload(
            req_id="req-call-1",
            tool_name="place_call",
            args={
                "to": "+30 210 000 0001",
                "counterparty": "Kappa Office Systems S.A. AR desk",
                "claim_id": "CLM-D-1042",
                "claim_amount": 587.30,
                "purpose": "Negotiate credit note settlement",
            },
            diff_preview="VOICE CALL to=Kappa Office Systems AR desk",
            risk_reason="External vendor call requires human manager approval",
        )
        call_script = build_briefing_script(approval.model_dump())
        assert len(call_script.split()) < 18
        assert "CLM-D-1042" in call_script
        assert "587 euros" in call_script

        followup_script = build_briefing_script(
            {
                "claim_id": "CLM-KAPPA-FOLLOWUP",
                "amount": 175.00,
                "vendor": "Kappa Office Systems S.A.",
                "external_outbox": [{"tool": "send_email", "to": "accounts@kappaoffice.example"}],
            }
        )
        assert len(followup_script.split()) < 18
        assert "175 euros" in followup_script
        assert "cents" not in followup_script

    def test_generic_and_verbose_summaries_always_respect_18_word_ceiling(self) -> None:
        empty_script = build_briefing_script({})
        assert len(empty_script.split()) < 18
        assert empty_script.endswith("Say approve to commit, or reject to roll back.")

        db_only_script = build_briefing_script(
            {"db_summary": {"invoices": {"inserted": 0, "updated": 1, "deleted": 0}}}
        )
        assert len(db_only_script.split()) < 18

        verbose_script = build_briefing_script(
            {
                "claim_id": "CLM-D-1042-EXTENDED-BATCH",
                "amount": 12450.75,
                "invoice_id": "INV-998877",
                "vendor": "Continental European Enterprise Workplace Hardware Logistics Partner Group",
                "db_summary": {"invoices": {"updated": 1}},
                "external_outbox": [{"tool": "send_email", "to": "ap@continental-hardware.example"}],
            }
        )
        assert len(verbose_script.split()) < 18
        assert verbose_script.endswith("Say approve to commit, or reject to roll back.")


# ---------------------------------------------------------------------------
# 2. Multi-Provider TTS Synthesis & SHA-256 Disk Cache (`synthesize_briefing`)
# ---------------------------------------------------------------------------


class _FakeHTTPResponse:
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
            req = httpx.Request("POST", "https://tts.example/test")
            resp = httpx.Response(self.status_code, request=req)
            raise httpx.HTTPStatusError("HTTP error", request=req, response=resp)

    def json(self) -> Any:
        if self._json_data is None:
            raise ValueError("Not JSON")
        return self._json_data


class TestSynthesizeBriefing:
    def test_returns_none_cleanly_when_offline_or_blank(self) -> None:
        assert synthesize_briefing("Recoup rehearsed claim CLM-D-1042.") is None
        assert synthesize_briefing("") is None
        assert synthesize_briefing("   ") is None

    def test_serves_sha256_disk_cache_first_even_without_api_keys(
        self, _isolated_voice_env: Path
    ) -> None:
        text = "Recoup rehearsed claim CLM-D-1042. Say approve to commit, or reject to roll back."
        voice_id = "exec-voice-1"
        digest = hashlib.sha256(f"{voice_id}:{text}".encode()).hexdigest()

        _isolated_voice_env.mkdir(parents=True, exist_ok=True)
        expected_mp3 = b"ID3\x04\x00\x00\x00\x00\x00\x0bcached-audio"
        (_isolated_voice_env / f"{digest}.mp3").write_bytes(expected_mp3)

        result = synthesize_briefing(text, voice_id=voice_id)
        assert result == expected_mp3

    def test_fal_tts_fetches_audio_url_and_populates_disk_cache(
        self, monkeypatch: pytest.MonkeyPatch, _isolated_voice_env: Path
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "fal-test-secret")
        monkeypatch.setenv("FAL_TTS_MODEL", "eleven_turbo_v2_5")

        calls: list[tuple[str, str, dict[str, Any]]] = []
        fake_mp3 = b"ID3-fal-synthesized-mp3"

        class FakeClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _FakeHTTPResponse:
                calls.append(("POST", url, {"headers": headers, "json": json}))
                return _FakeHTTPResponse(
                    json_data={"audio": {"url": "https://fal.media/files/briefing.mp3"}},
                    content_type="application/json",
                )

            def get(self, url: str) -> _FakeHTTPResponse:
                calls.append(("GET", url, {}))
                return _FakeHTTPResponse(content=fake_mp3, content_type="audio/mpeg")

        monkeypatch.setattr(voice_module.httpx, "Client", FakeClient)

        text = "Recoup rehearsed claim CLM-D-1042."
        out1 = synthesize_briefing(text, voice_id="Rachel")
        assert out1 == fake_mp3
        assert len(calls) == 2
        assert calls[0][1] == "https://fal.run/fal-ai/elevenlabs/tts/turbo-v2.5"
        assert calls[0][2]["headers"]["Authorization"] == "Key fal-test-secret"

        # Second call must hit `.voice_cache/<hash>.mp3` with zero extra network calls
        out2 = synthesize_briefing(text, voice_id="Rachel")
        assert out2 == fake_mp3
        assert len(calls) == 2

    def test_elevenlabs_and_wonderful_providers_and_http_failover(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAL_KEY", "broken-fal-key")
        monkeypatch.setenv("FAL_TTS_MODEL", "fal-ai/elevenlabs/tts/eleven-v3")
        monkeypatch.setenv("ELEVENLABS_API_KEY", "xi-live-key")
        monkeypatch.setenv("WONDERFUL_API_KEY", "wonderful-key")

        eleven_mp3 = b"ID3-elevenlabs-mp3"

        class FailoverClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _FakeHTTPResponse:
                if "fal.run" in url:
                    return _FakeHTTPResponse(status_code=503)
                if "elevenlabs.io" in url:
                    assert headers["xi-api-key"] == "xi-live-key"
                    return _FakeHTTPResponse(content=eleven_mp3, content_type="audio/mpeg")
                raise AssertionError(f"Unexpected URL: {url}")

        monkeypatch.setattr(voice_module.httpx, "Client", FailoverClient)
        assert synthesize_briefing("Approve claim CLM-D-1042.") == eleven_mp3

        # Direct Wonderful provider check
        monkeypatch.delenv("FAL_KEY")
        monkeypatch.delenv("ELEVENLABS_API_KEY")
        wonderful_mp3 = b"ID3-wonderful-mp3"

        class WonderfulClient:
            def __init__(self, **kwargs: Any) -> None:
                pass

            def __enter__(self) -> Self:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def post(self, url: str, headers: dict[str, str], json: dict[str, Any]) -> _FakeHTTPResponse:
                assert headers["Authorization"] == "Bearer wonderful-key"
                return _FakeHTTPResponse(content=wonderful_mp3, content_type="audio/mpeg")

        monkeypatch.setattr(voice_module.httpx, "Client", WonderfulClient)
        assert synthesize_briefing("Stage vendor call for CLM-D-1042.") == wonderful_mp3


# ---------------------------------------------------------------------------
# 3. Deterministic Voice Decision Classifier (`parse_voice_decision`)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("transcript", "expected"),
    [
        ("approve", "approve"),
        ("Yes, confirm and proceed with the claim.", "approve"),
        ("Ship it!", "approve"),
        ("Go ahead and commit the staged changes.", "approve"),
        ("Authorized.", "approve"),
        ("reject", "reject"),
        ("Abort immediately!", "reject"),
        ("Please cancel the outbound email.", "reject"),
        ("Undo and roll back to checkpoint.", "reject"),
        ("Do not approve this invoice hold.", "reject"),
        ("Don't ship it yet.", "reject"),
        ("Should I approve or reject this claim?", "unknown"),
        ("What was the unit price on shipment D-1042?", "unknown"),
        ("", "unknown"),
        ("   ", "unknown"),
    ],
)
def test_parse_voice_decision_classification(transcript: str, expected: str) -> None:
    assert parse_voice_decision(transcript) == expected


# ---------------------------------------------------------------------------
# 4. Vendor Negotiation Call Turns (`simulate_vendor_negotiation_turns`)
# ---------------------------------------------------------------------------


class TestVendorNegotiationSimulation:
    def test_hero_claim_d1042_negotiation_validates_against_contracts(self) -> None:
        neg = DOMAIN["negotiation"]
        turns = simulate_vendor_negotiation_turns(
            claim_id=neg["claim_id"],
            claim_amount=neg["claim_amount"],
            opening_pct=float(neg["opening_counter_pct"]),
            floor_pct=float(neg["accept_floor_pct"]),
        )

        assert len(turns) >= 4
        validated = [CallTurnPayload.model_validate(t) for t in turns]
        assert validated[0].speaker == "agent"
        assert validated[0].offer_pct == 100.0
        assert validated[1].speaker == "counterparty"
        assert validated[1].offer_pct == 70.0
        assert "411.11" in validated[1].text
        assert validated[-1].speaker == "agent"
        assert validated[-1].offer_pct == 85.0
        assert "499.21" in validated[-1].text

        outcome = summarize_negotiation_outcome(
            claim_id=neg["claim_id"],
            claim_amount=neg["claim_amount"],
            turns=turns,
            floor_pct=float(neg["accept_floor_pct"]),
        )
        end_payload = CallEndPayload.model_validate(outcome)
        assert end_payload.outcome == "accepted"
        assert end_payload.agreed_amount == 499.21

    def test_immediate_acceptance_and_escalation_branches(self) -> None:
        # Counterparty opens above floor -> 3-turn immediate acceptance
        fast_turns = simulate_vendor_negotiation_turns(
            claim_id="CLM-D-1042",
            claim_amount=587.30,
            opening_pct=90.0,
            floor_pct=85.0,
        )
        assert len(fast_turns) == 3
        for turn in fast_turns:
            CallTurnPayload.model_validate(turn)
        fast_end = CallEndPayload.model_validate(
            summarize_negotiation_outcome("CLM-D-1042", 587.30, fast_turns, floor_pct=85.0)
        )
        assert fast_end.outcome == "accepted"
        assert fast_end.agreed_amount == round(587.30 * 0.90, 2)

        # Unreachable floor -> escalates cleanly
        esc_turns = simulate_vendor_negotiation_turns(
            claim_id="CLM-D-1042",
            claim_amount=587.30,
            opening_pct=65.0,
            floor_pct=105.0,
        )
        for turn in esc_turns:
            CallTurnPayload.model_validate(turn)
        esc_end = CallEndPayload.model_validate(
            summarize_negotiation_outcome("CLM-D-1042", 587.30, esc_turns, floor_pct=105.0)
        )
        assert esc_end.outcome == "escalated"
        assert esc_end.agreed_amount is None
