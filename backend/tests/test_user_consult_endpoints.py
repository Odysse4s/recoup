"""Unit & integration tests for operator consult escalation, AADE myDATA XML, dynamic SQLite DDL, and single-voice routing."""
from __future__ import annotations

import asyncio
import contextlib
import sqlite3
import types
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import server
from app.contracts import EventType
from app.engine.env import Env, fingerprint_env
from app.engine.events import BUS
from app.engine.orchestrator import PENDING, PENDING_PAYLOADS
from app.engine.seed import populate_default_seed
from app.engine.tools import REGISTRY
from app.engine.undo import UndoLog


@pytest.fixture
def isolated_consult_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolate workspace, SQLite DB, undo log, and voice environment per test."""
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    real = Env(root_dir=ws, db_path=ws / "app.db")
    log = UndoLog(tmp_path / "undo_log.json")

    monkeypatch.setattr(server, "WS", ws)
    monkeypatch.setattr(server, "REAL", real)
    monkeypatch.setattr(server, "LOG", log)
    monkeypatch.setattr(server, "_EXTRA_VOICE_COST_EUR", 0.0)
    monkeypatch.setenv("VOICE_PROVIDER", "offline")
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    BUS.history.clear()
    PENDING.clear()
    PENDING_PAYLOADS.clear()
    with TestClient(server.app) as client:
        yield client, ws, real, log
    PENDING.clear()
    PENDING_PAYLOADS.clear()


def test_state_exposes_dynamic_schema_sql(isolated_consult_server):
    client, _, real, _ = isolated_consult_server

    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        conn.execute(
            "CREATE TABLE aade_filings (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, invoice_type TEXT NOT NULL)"
        )
        conn.commit()

    resp = client.get("/api/state")
    assert resp.status_code == 200
    body = resp.json()
    assert "schema_sql" in body
    schema_sql = body["schema_sql"]
    assert {"suppliers", "contract_prices", "deliveries", "invoices", "claims", "aade_filings"} <= set(schema_sql)
    for tbl, ddl in schema_sql.items():
        assert "CREATE TABLE" in ddl.upper(), f"Expected CREATE TABLE DDL for {tbl}"


def test_user_consult_emits_call_start_and_opening_turn(isolated_consult_server):
    client, _, _, _ = isolated_consult_server

    resp = client.post("/api/call/user-consult", json={})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["call_id"] == "CONSULT-CLM-D-1042"
    assert data["mode"] == "user_consult"
    assert data["claim_id"] == "CLM-D-1042"
    assert data["claim_amount"] == pytest.approx(587.30)
    assert "587 euro 30 cent" in data["opening_text"]
    assert "AADE myDATA" in data["opening_text"]

    starts = [e for e in BUS.history if e.type == EventType.CALL_START]
    turns = [e for e in BUS.history if e.type == EventType.CALL_TURN]
    assert len(starts) == 1
    assert starts[0].payload == {
        "call_id": "CONSULT-CLM-D-1042",
        "mode": "user_consult",
        "counterparty": "Operator Mobile",
        "req_id": None,
        "claim_id": "CLM-D-1042",
        "claim_amount": 587.30,
    }
    assert len(turns) == 1
    assert turns[0].payload["speaker"] == "agent"
    assert turns[0].payload["audio_url"] == "/api/voice/turn-audio"
    assert turns[0].cost_eur == 0.0


def test_user_respond_refund_creates_aade_51_xml_updates_db_and_undoes_cleanly(isolated_consult_server):
    client, ws, real, log = isolated_consult_server

    # Seed existing drafted claim CLM-D-1042 so undo restores exact pre-consult DB + filesystem state
    upsert = REGISTRY["upsert_row"]
    seed_args = {
        "table": "claims",
        "pk_col": "id",
        "row": {
            "id": "CLM-D-1042",
            "supplier_id": "SUP-KAPPA",
            "delivery_id": "D-1042",
            "invoice_id": "INV-7781",
            "amount": 587.30,
            "reason": "overcharge 168.00, short 280.00, damaged 105.00, late 34.30",
            "status": "drafted",
        },
    }
    seed_receipt = upsert.do(seed_args, real)
    log.record(1, "upsert_row", seed_args, seed_receipt)
    baseline_fp = fingerprint_env(real)
    entries_before = len(log.entries)

    resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "Enforce the 587 refund hold and stage the AADE myDATA filing now."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["call_id"] == "CONSULT-CLM-D-1042"
    assert body["choice"] == "refund"
    assert body["agreed_amount"] == pytest.approx(587.30)
    assert body["aade_xml_path"] == "aade/mydata_CLM-D-1042.xml"
    assert "5.1" in body["confirmation_text"]

    xml_file = ws / "aade" / "mydata_CLM-D-1042.xml"
    assert xml_file.exists()
    xml_text = xml_file.read_text(encoding="utf-8")
    root = ET.fromstring(xml_text)
    assert root.tag == "{http://www.aade.gr/myDATA/invoice/v1.0}InvoicesDoc"
    assert "<invoiceType>5.1</invoiceType>" in xml_text
    assert "<vatNumber>EL094281773</vatNumber>" in xml_text
    assert "<series>CR-AADE</series>" in xml_text
    assert "<correlatedInvoices>INV-7781</correlatedInvoices>" in xml_text
    assert "<totalNetValue>587.30</totalNetValue>" in xml_text
    assert "<totalVatAmount>140.95</totalVatAmount>" in xml_text
    assert "<totalGrossValue>728.25</totalGrossValue>" in xml_text
    assert "<classificationType>E3_561_001</classificationType>" in xml_text

    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        claim_row = conn.execute("SELECT amount, status, reason FROM claims WHERE id = 'CLM-D-1042'").fetchone()
    assert claim_row is not None
    assert claim_row[0] == pytest.approx(587.30)
    assert claim_row[1] == "settled"
    assert "AADE myDATA 5.1" in claim_row[2]

    turns = [e for e in BUS.history if e.type == EventType.CALL_TURN]
    ends = [e for e in BUS.history if e.type == EventType.CALL_END]
    assert [t.payload["speaker"] for t in turns] == ["user", "agent"]
    assert turns[1].payload["audio_url"] == "/api/voice/turn-audio"
    assert len(ends) == 1
    assert ends[0].payload["outcome"] == "accepted"
    assert ends[0].payload["agreed_amount"] == pytest.approx(587.30)

    consult_steps = len(log.entries) - entries_before
    assert consult_steps >= 2

    # Reversible 1-click undo removes XML file + directory and restores exact SQLite snapshot
    undo_resp = client.post("/api/undo", json={"steps": consult_steps})
    assert undo_resp.status_code == 200
    assert not xml_file.exists()
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        restored = conn.execute("SELECT status FROM claims WHERE id = 'CLM-D-1042'").fetchone()
    assert restored is not None and restored[0] == "drafted"
    assert fingerprint_env(real) == baseline_fp


async def test_user_respond_redelivery_multipart_audio_resolves_pending_and_populates_dynamic_aade_table(
    isolated_consult_server,
    monkeypatch: pytest.MonkeyPatch,
):
    client, ws, real, _ = isolated_consult_server

    # Add a dynamic aade_mydata_filings table with CHECK constraint to verify schema introspection
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE aade_mydata_filings (
                id TEXT PRIMARY KEY,
                claim_id TEXT NOT NULL,
                invoice_type TEXT NOT NULL,
                net_amount REAL NOT NULL,
                vat_amount REAL NOT NULL,
                gross_amount REAL NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('staged', 'filed'))
            )
            """
        )
        conn.commit()

    baseline_fp = fingerprint_env(real)

    loop = asyncio.get_running_loop()
    gate_fut: asyncio.Future[bool] = loop.create_future()
    PENDING["req_gate_42"] = gate_fut
    PENDING_PAYLOADS["req_gate_42"] = {"req_id": "req_gate_42", "tool_name": "place_call"}

    # Consult auto-binds active PENDING req_id when omitted
    c_resp = client.post("/api/call/user-consult", content=b"")
    assert c_resp.status_code == 200
    assert c_resp.json()["req_id"] == "req_gate_42"

    fake_call_audio = types.ModuleType("app.voice.call_audio")
    fake_call_audio.transcribe_operator_voice = lambda audio_bytes, mime_type="audio/webm": (  # type: ignore[attr-defined]
        "Please schedule replacement re-delivery for all 22 hubs tomorrow."
    )
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_call_audio)

    resp = client.post(
        "/api/call/user-respond",
        data={"claim_id": "CLM-D-1042"},
        files={"audio": ("operator.webm", b"\x1aE\xdf\xa3fake-webm-opus", "audio/webm")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["choice"] == "redelivery"
    assert body["agreed_amount"] == pytest.approx(202.30)
    assert "22 hubs" in body["transcript"]
    assert gate_fut.done() and gate_fut.result() is True
    assert "req_gate_42" not in PENDING

    xml_file = ws / "aade" / "mydata_CLM-D-1042.xml"
    assert xml_file.exists()
    xml_text = xml_file.read_text(encoding="utf-8")
    assert "<invoiceType>9.3</invoiceType>" in xml_text
    assert "<quantity>22</quantity>" in xml_text
    assert "<totalNetValue>202.30</totalNetValue>" in xml_text
    assert "<totalVatAmount>48.55</totalVatAmount>" in xml_text
    assert "<totalGrossValue>250.85</totalGrossValue>" in xml_text

    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        filing = conn.execute(
            "SELECT claim_id, invoice_type, net_amount, vat_amount, gross_amount, status FROM aade_mydata_filings"
        ).fetchone()
    assert filing == ("CLM-D-1042", "9.3", 202.30, 48.55, 250.85, "staged")
    assert any(e.type == EventType.APPROVAL_RESULT for e in BUS.history)

    # Full undo rewinds XML, claims, deliveries, and dynamic aade_mydata_filings back to baseline
    undo_resp = client.post("/api/undo")
    assert undo_resp.status_code == 200
    assert fingerprint_env(real) == baseline_fp


def test_single_agent_voice_routing_and_live_fal_micro_cost(
    isolated_consult_server,
    monkeypatch: pytest.MonkeyPatch,
):
    client, _, _, _ = isolated_consult_server
    monkeypatch.setenv("VOICE_PROVIDER", "fal")
    monkeypatch.setenv("FAL_KEY", "fal-live-test-key")

    seen_speakers: list[str] = []

    def _stub_synth_turn(speaker: str, text: str) -> bytes:
        seen_speakers.append(speaker)
        return f"ID3-{speaker}-{len(text)}".encode()

    fake_call_audio = types.ModuleType("app.voice.call_audio")
    fake_call_audio.synthesize_call_turn = _stub_synth_turn  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_call_audio)

    # Even if speaker='counterparty' is requested, turn-audio forces single calm 'agent' voice
    audio_resp = client.post(
        "/api/voice/turn-audio",
        json={"speaker": "counterparty", "text": "Confirming settlement terms on shipment D-1042."},
    )
    assert audio_resp.status_code == 200
    assert seen_speakers == ["agent"]
    assert audio_resp.content.startswith(b"ID3-agent-")
    assert "x-voice-cost-eur" in audio_resp.headers
    hdr_cost = float(audio_resp.headers["x-voice-cost-eur"])
    assert 0.0005 <= hdr_cost <= 0.0012

    consult_resp = client.post("/api/call/user-consult", json={"claim_id": "CLM-D-1042"})
    assert consult_resp.status_code == 200
    turn_events = [e for e in BUS.history if e.type == EventType.CALL_TURN]
    assert len(turn_events) == 1
    assert 0.0005 <= turn_events[0].cost_eur <= 0.0012

    state_cost = client.get("/api/state").json()["metrics"]["cost_eur"]
    assert state_cost >= hdr_cost + turn_events[0].cost_eur - 1e-6


def test_user_respond_explicit_choice_fallback_transcript_and_empty_422(
    isolated_consult_server,
    monkeypatch: pytest.MonkeyPatch,
):
    client, _, _, _ = isolated_consult_server

    # Empty body with no choice, transcript, or audio returns 422
    r_empty = client.post("/api/call/user-respond", json={})
    assert r_empty.status_code == 422

    # Explicit choice='redelivery' synthesizes natural fallback transcript
    r_explicit = client.post("/api/call/user-respond", json={"choice": "redelivery"})
    assert r_explicit.status_code == 200
    b_exp = r_explicit.json()
    assert b_exp["choice"] == "redelivery"
    assert "22 hubs" in b_exp["transcript"]
    assert b_exp["agreed_amount"] == pytest.approx(202.30)

    # Custom parse_user_resolution_intent hook on app.voice.call_audio is respected
    fake_call_audio = types.ModuleType("app.voice.call_audio")
    fake_call_audio.parse_user_resolution_intent = lambda _t: {"choice": "redelivery"}  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_call_audio)

    r_hook = client.post("/api/call/user-respond", json={"transcript": "Handle per warehouse preference."})
    assert r_hook.status_code == 200
    assert r_hook.json()["choice"] == "redelivery"

