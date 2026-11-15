"""Tests for Oumi Iris System-1 Decision Client and FastAPI integration."""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app import server
from app.engine.env import Env
from app.engine.events import BUS
from app.engine.orchestrator import PENDING, PENDING_OFFERS, PENDING_PAYLOADS
from app.engine.seed import populate_default_seed
from app.engine.undo import UndoLog
from app.oumi_iris import (
    classify_voice_turn_with_iris,
    evaluate_gate_with_iris,
    get_oumi_api_key,
    get_oumi_model,
)

SAMPLE_GATE_RESPONSE: dict[str, Any] = {
    "model": "projects/7HBTQDVH6J-24/models/iris-latest",
    "answers": {
        "needs_human_gate": {"type": "noul", "noul": 0.999379},
        "escalation_route": {
            "type": "choice",
            "choice": "iphone_voice_call",
            "confidence": 0.4343,
            "probabilities": {
                "auto_execute": 0.086,
                "desktop_queue": 0.291,
                "iphone_voice_call": 0.623,
            },
        },
        "financial_impact": {
            "type": "score",
            "score": 1.9991,
            "confidence": 0.9911,
            "probabilities": {"0": 0.0008, "1": 0.0024, "2": 0.9933, "3": 0.0033},
        },
    },
    "usage": {"inputTokens": 400, "outputTokens": 0},
}

SAMPLE_TURN_RESPONSE: dict[str, Any] = {
    "model": "projects/7HBTQDVH6J-24/models/iris-latest",
    "answers": {
        "intent": {
            "type": "choice",
            "choice": "commit_refund",
            "confidence": 0.952,
            "probabilities": {"commit_refund": 0.952, "commit_replacement": 0.02},
        },
        "is_binding_authorization": {"type": "noul", "noul": 0.985},
    },
    "usage": {"inputTokens": 280, "outputTokens": 0},
}


class MockHttpResponse:
    def __init__(self, json_data: dict[str, Any], status_code: int = 200) -> None:
        self._json_data = json_data
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("Mock error", request=None, response=None)  # type: ignore[arg-type]

    def json(self) -> dict[str, Any]:
        return self._json_data


@pytest.fixture
def isolated_server(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Provide isolated environment for server state and event bus."""
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    real = Env(root_dir=ws, db_path=ws / "app.db")
    log = UndoLog(tmp_path / "undo_log.json")

    monkeypatch.setattr(server, "WS", ws)
    monkeypatch.setattr(server, "REAL", real)
    monkeypatch.setattr(server, "LOG", log)
    monkeypatch.setattr(server, "_EXTRA_VOICE_COST_EUR", 0.0)
    monkeypatch.setenv("VOICE_PROVIDER", "offline")
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    BUS.history.clear()
    PENDING.clear()
    PENDING_PAYLOADS.clear()
    PENDING_OFFERS.clear()
    server.ACTIVE_CALL = None
    server.LATEST_IRIS_GATE = None
    server.IRIS_USAGE_STATS = {"calls": 0, "input_tokens": 0, "output_tokens": 0}

    with TestClient(server.app) as client:
        yield client, ws, real, log

    PENDING.clear()
    PENDING_PAYLOADS.clear()
    PENDING_OFFERS.clear()
    server.ACTIVE_CALL = None
    server.LATEST_IRIS_GATE = None
    server.IRIS_USAGE_STATS = {"calls": 0, "input_tokens": 0, "output_tokens": 0}


def test_oumi_model_and_key_helpers(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OUMI_MODEL", "projects/custom/models/iris-test")
    monkeypatch.setenv("OUMI_API_KEY", "test_key_12345")
    assert get_oumi_model() == "projects/custom/models/iris-test"
    assert get_oumi_api_key() == "test_key_12345"


@pytest.mark.asyncio
async def test_evaluate_gate_with_iris_live_mocked(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OUMI_API_KEY", "test_key_live")
    mock_post = AsyncMock(return_value=MockHttpResponse(SAMPLE_GATE_RESPONSE, 200))

    with patch("httpx.AsyncClient.post", mock_post):
        res = await evaluate_gate_with_iris("Shipment D-1042 short 22 hubs...")

    assert res["live"] is True
    assert res["model"] == "projects/7HBTQDVH6J-24/models/iris-latest"
    assert res["gate_probability"] == 0.9994
    assert res["route"] == "iphone_voice_call"
    assert res["route_confidence"] == 0.623
    assert res["risk_score"] == 2.0
    assert res["risk_max"] == 3
    assert res["input_tokens"] == 400
    assert res["output_tokens"] == 0
    assert res["latency_ms"] >= 0


@pytest.mark.asyncio
async def test_evaluate_gate_with_iris_deterministic_fallback(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OUMI_API_KEY", raising=False)
    res = await evaluate_gate_with_iris({"claim_id": "CLM-D-1042", "amount": 587.30})

    assert res["live"] is False
    assert res["gate_probability"] == 0.994
    assert res["route"] == "iphone_voice_call"
    assert res["route_confidence"] == 0.91
    assert res["risk_score"] == 2.2
    assert res["risk_max"] == 3
    assert res["input_tokens"] == 0
    assert res["output_tokens"] == 0


@pytest.mark.asyncio
async def test_classify_voice_turn_with_iris_live_mocked(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OUMI_API_KEY", "test_key_live")
    mock_post = AsyncMock(return_value=MockHttpResponse(SAMPLE_TURN_RESPONSE, 200))

    with patch("httpx.AsyncClient.post", mock_post):
        res = await classify_voice_turn_with_iris("Demand the full 587 euro refund.")

    assert res["live"] is True
    assert res["intent"] == "commit_refund"
    assert res["confidence"] == 0.952
    assert res["is_binding_authorization"] == 0.985
    assert res["input_tokens"] == 280
    assert res["output_tokens"] == 0


@pytest.mark.asyncio
async def test_classify_voice_turn_with_iris_fallback(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OUMI_API_KEY", raising=False)
    res = await classify_voice_turn_with_iris("freeze invoice and refund")

    assert res["live"] is False
    assert res["intent"] == "commit_refund"
    assert res["is_binding_authorization"] >= 0.65
    assert res["output_tokens"] == 0


def test_api_state_and_call_status_exposes_iris_gate(isolated_server, monkeypatch: pytest.MonkeyPatch):
    client, _, _, _ = isolated_server
    monkeypatch.setenv("OUMI_API_KEY", "test_key_api")
    mock_post = AsyncMock(return_value=MockHttpResponse(SAMPLE_GATE_RESPONSE, 200))

    with patch("httpx.AsyncClient.post", mock_post):
        c_resp = client.post("/api/call/user-consult", json={})
        assert c_resp.status_code == 200
        c_body = c_resp.json()
        assert "iris_gate" in c_body
        assert c_body["iris_gate"]["gate_probability"] == 0.9994

    # GET /api/state
    s_resp = client.get("/api/state")
    assert s_resp.status_code == 200
    s_body = s_resp.json()
    assert "iris_gate" in s_body
    assert s_body["iris_gate"]["gate_probability"] == 0.9994
    assert "iris_usage" in s_body
    assert s_body["iris_usage"]["calls"] >= 1
    assert s_body["iris_usage"]["output_tokens"] == 0

    # GET /api/call/status
    cs_resp = client.get("/api/call/status")
    assert cs_resp.status_code == 200
    cs_body = cs_resp.json()
    assert cs_body["ok"] is True
    assert cs_body["iris_gate"]["route"] == "iphone_voice_call"
    assert cs_body["iris_usage"]["calls"] >= 1

    # GET /api/health
    h_resp = client.get("/api/health")
    assert h_resp.status_code == 200
    h_body = h_resp.json()
    assert "iris_gate" in h_body
    assert h_body["iris_gate"] is not None
    assert "iris_usage" in h_body


def test_api_call_user_respond_attaches_iris_intent_with_zero_output_tokens(
    isolated_server, monkeypatch: pytest.MonkeyPatch
):
    client, _, _, _ = isolated_server
    monkeypatch.setenv("OUMI_API_KEY", "test_key_api")
    mock_post = AsyncMock(return_value=MockHttpResponse(SAMPLE_TURN_RESPONSE, 200))

    with patch("httpx.AsyncClient.post", mock_post):
        r_resp = client.post("/api/call/user-respond", json={"transcript": "Freeze invoice and give refund"})
        assert r_resp.status_code == 200
        body = r_resp.json()
        assert body["ok"] is True
        assert "iris_intent" in body
        assert body["iris_intent"]["output_tokens"] == 0
        assert body["iris_intent"]["intent"] == "commit_refund"

        # Check turn history in ACTIVE_CALL
        assert server.ACTIVE_CALL is not None
        user_turns = [t for t in server.ACTIVE_CALL.get("turns", []) if t.get("speaker") == "user"]
        assert len(user_turns) >= 1
        assert "iris_intent" in user_turns[-1]
        assert user_turns[-1]["iris_intent"]["output_tokens"] == 0


def test_api_reset_cleans_iris_state(isolated_server):
    client, _, _, _ = isolated_server
    server.LATEST_IRIS_GATE = {"route": "iphone_voice_call"}
    server.IRIS_USAGE_STATS = {"calls": 5, "input_tokens": 1000, "output_tokens": 0}

    r_resp = client.post("/api/reset")
    assert r_resp.status_code == 200

    s_resp = client.get("/api/state")
    assert s_resp.status_code == 200
    s_body = s_resp.json()
    assert s_body["iris_gate"] is None
    assert s_body["iris_usage"]["calls"] == 0
    assert s_body["iris_usage"]["input_tokens"] == 0
    assert s_body["iris_usage"]["output_tokens"] == 0
