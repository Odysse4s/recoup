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
from app.contracts import AnticipatePrediction, ChangeReport, EventType
from app.engine.env import Env, fingerprint_env
from app.engine.events import BUS
from app.engine.orchestrator import PENDING, PENDING_OFFERS, PENDING_PAYLOADS, PreparedOffer
from app.engine.sandbox import validate_ast
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
    PENDING_OFFERS.clear()
    server.ACTIVE_CALL = None
    if server.STAGE_DEMO_TASK and not server.STAGE_DEMO_TASK.done():
        server.STAGE_DEMO_TASK.cancel()
    server.STAGE_DEMO_TASK = None

    with TestClient(server.app) as client:
        yield client, ws, real, log

    PENDING.clear()
    PENDING_PAYLOADS.clear()
    PENDING_OFFERS.clear()
    server.ACTIVE_CALL = None
    if server.STAGE_DEMO_TASK and not server.STAGE_DEMO_TASK.done():
        server.STAGE_DEMO_TASK.cancel()
    server.STAGE_DEMO_TASK = None


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
        "channel": "voice_call",
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


async def test_state_lifecycle_pending_approval_active_call_and_latest_offer(isolated_consult_server):
    client, _, real, _ = isolated_consult_server

    # 1. Idle state
    s0 = client.get("/api/state").json()
    assert s0["pending_approval"] is None
    assert s0["active_call"] is None
    assert s0["latest_offer"] is None

    # 2. Awaiting approval (Tier 1: notification)
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[bool] = loop.create_future()
    PENDING["req_tier1"] = fut
    PENDING_PAYLOADS["req_tier1"] = {
        "req_id": "req_tier1",
        "tool_name": "send_email",
        "args": {"to": "vendor@example.com", "amount": 100.0},
        "diff_preview": "email preview",
        "risk_reason": "Low value email",
        "channel": "notification",
    }
    s1 = client.get("/api/state").json()
    assert s1["pending_approval"] is not None
    assert s1["pending_approval"]["req_id"] == "req_tier1"
    assert s1["pending_approval"]["channel"] == "notification"

    # 3. Active Call escalation
    c_resp = client.post("/api/call/user-consult", json={"req_id": "req_tier1"})
    assert c_resp.status_code == 200
    s2 = client.get("/api/state").json()
    ac = s2["active_call"]
    assert ac is not None
    assert ac["active"] is True
    assert ac["ringing"] is True
    assert ac["mode"] == "user_consult"
    assert ac["req_id"] == "req_tier1"
    assert len(ac["turns"]) == 1

    # 4. Resolved call & offer
    r_resp = client.post("/api/call/user-respond", json={"req_id": "req_tier1", "choice": "refund"})
    assert r_resp.status_code == 200
    s3 = client.get("/api/state").json()
    assert s3["pending_approval"] is None
    ac_done = s3["active_call"]
    assert ac_done is not None
    assert ac_done["active"] is False
    assert ac_done["ringing"] is False
    assert ac_done["selected_choice"] == "refund"
    assert ac_done["end"]["outcome"] == "accepted"
    assert len(ac_done["turns"]) == 3

    # Add prepared offer
    pred = AnticipatePrediction(
        need="Recover EUR 175.00 in unclaimed credits",
        goal_prompt="Audit historical shipments",
        evidence="Late deliveries",
        confidence=0.92,
        kind="draft",
    )
    report = ChangeReport()
    PENDING_OFFERS["off_test_1"] = PreparedOffer(
        offer_id="off_test_1",
        prediction=pred,
        commit_plan=[],
        report=report,
        fp=fingerprint_env(real),
        previews={},
    )
    s4 = client.get("/api/state").json()
    assert s4["latest_offer"] is not None
    assert s4["latest_offer"]["offer_id"] == "off_test_1"
    assert s4["latest_offer"]["prediction"]["confidence"] == pytest.approx(0.92)

    # 5. Reset restores clean slate
    reset_resp = client.post("/api/reset")
    assert reset_resp.status_code == 200
    s5 = client.get("/api/state").json()
    assert s5["pending_approval"] is None
    assert s5["active_call"] is None
    assert s5["latest_offer"] is None


async def test_demo_run_fast_rehearsal_and_approval_via_approve_endpoint(isolated_consult_server):
    client, ws, real, _ = isolated_consult_server

    resp = client.post("/api/demo/run", json={"pace_ms": 0, "anticipate_after": True})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["mode"] == "stage_demo"

    await asyncio.sleep(0.05)

    s = client.get("/api/state").json()
    pa = s["pending_approval"]
    assert pa is not None
    assert pa["channel"] == "voice_call"
    assert pa["tool_name"] == "send_email"
    assert "587.30" in pa["risk_reason"]
    req_id = pa["req_id"]
    assert req_id in PENDING

    # Check forged tools registered
    assert any(t["name"] == "compute_supplier_claim" for t in s["forged_tools"])

    # Check events emitted
    event_types = [e.type for e in BUS.history]
    assert EventType.REHEARSE_START in event_types
    assert EventType.PLAN_CREATED in event_types
    assert EventType.FORGE_SPEC in event_types
    assert EventType.FORGE_TEST_RESULT in event_types
    assert EventType.FORGE_REGISTERED in event_types
    assert EventType.TOOL_CALL in event_types
    assert EventType.VERIFY_RESULT in event_types
    assert EventType.REHEARSE_REPORT in event_types
    assert EventType.APPROVAL_NEEDED in event_types

    # Vendors are NEVER called
    tool_names = [e.payload.get("call", {}).get("name") for e in BUS.history if e.type == EventType.TOOL_CALL]
    assert "place_call" not in tool_names

    # Approve via /api/approve/{req_id}
    app_resp = client.post(f"/api/approve/{req_id}", json={"approved": True})
    assert app_resp.status_code == 200

    await asyncio.sleep(0.05)

    # Check committed to REAL
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        claim_row = conn.execute("SELECT amount, status FROM claims WHERE id = 'CLM-D-1042'").fetchone()
        invoice_row = conn.execute("SELECT status FROM invoices WHERE id = 'INV-7781'").fetchone()
    assert claim_row is not None and claim_row[0] == pytest.approx(587.30)
    assert invoice_row is not None and invoice_row[0] == "disputed"
    assert (ws / "claims" / "CLM-D-1042.md").exists()
    assert any(m["to"] == "accounts@kappaoffice.example" for m in real.outbox)

    # Anticipate offer created
    s_after = client.get("/api/state").json()
    assert s_after["pending_approval"] is None
    assert s_after["latest_offer"] is not None
    assert "175.00" in s_after["latest_offer"]["prediction"]["need"]

    # Undo rewinds cleanly
    undo_resp = client.post("/api/undo", json={"steps": 3})
    assert undo_resp.status_code == 200
    assert not (ws / "claims" / "CLM-D-1042.md").exists()


async def test_demo_run_approval_via_user_respond_and_vendor_email_outbox(isolated_consult_server):
    client, ws, real, _ = isolated_consult_server

    d_resp = client.post("/api/demo/run", json={"pace_ms": 0, "anticipate_after": True})
    assert d_resp.status_code == 200

    await asyncio.sleep(0.05)
    pa = client.get("/api/state").json()["pending_approval"]
    assert pa is not None
    req_id = pa["req_id"]

    # Counterparty consult call initiated
    c_resp = client.post("/api/call/user-consult", json={"req_id": req_id})
    assert c_resp.status_code == 200

    # Operator resolves via voice reply
    r_resp = client.post("/api/call/user-respond", json={"req_id": req_id, "choice": "refund"})
    assert r_resp.status_code == 200

    await asyncio.sleep(0.1)

    # Check vendor notification email queued in outbox and NO place_call made
    vendor_emails = [
        m for m in real.outbox if m.get("to") == "accounts@kappaoffice.example" and "CLM-D-1042" in str(m.get("subject", ""))
    ]
    assert len(vendor_emails) >= 1
    assert not any(m.get("tool") == "place_call" for m in real.outbox)

    # Check AADE XML created and claims updated to settled
    assert (ws / "aade" / "mydata_CLM-D-1042.xml").exists()
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        claim_row = conn.execute("SELECT status FROM claims WHERE id = 'CLM-D-1042'").fetchone()
    assert claim_row is not None and claim_row[0] == "settled"


def test_two_tier_channels_notification_vs_voice_call(isolated_consult_server):
    _client, _, _real, _ = isolated_consult_server

    # Tier 1: Small amounts (< 250) or non-claim actions default to notification
    p_low = {
        "req_id": "req_low",
        "tool_name": "send_email",
        "args": {"to": "vendor@example.com", "amount": 180.00},
        "diff_preview": "Email vendor regarding discount",
        "risk_reason": "Outbound email < 250 threshold",
    }
    assert server._determine_channel(p_low) == "notification"

    # Tier 2: High stakes (>= 250 or 587.3) escalates to voice_call
    p_high = {
        "req_id": "req_high",
        "tool_name": "send_email",
        "args": {"to": "accounts@kappaoffice.example", "amount": 587.30},
        "diff_preview": "Holding EUR 587.30 on D-1042",
        "risk_reason": "Claim CLM-D-1042 is EUR 587.30 (>= EUR 250 threshold)",
    }
    assert server._determine_channel(p_high) == "voice_call"


def test_validate_ast_blocks_io_open_and_operator_attrgetter_while_allowing_safe_calc():
    io_code = (
        "import io\n"
        "def compute_claim(args: dict) -> dict:\n"
        "    f = io.open('leak.txt')\n"
        "    return {'data': f.read()}\n"
    )
    ok_io, errs_io = validate_ast(io_code, "compute_claim")
    assert ok_io is False
    assert any("io" in e or "open" in e for e in errs_io)

    op_code = (
        "import operator\n"
        "def compute_claim(args: dict) -> dict:\n"
        "    getter = operator.attrgetter('__class__')\n"
        "    return {'cls': str(getter(args))}\n"
    )
    ok_op, errs_op = validate_ast(op_code, "compute_claim")
    assert ok_op is False
    assert any("operator" in e or "attrgetter" in e for e in errs_op)

    safe_code = (
        "import math\n"
        "import decimal\n"
        "import json\n"
        "def compute_supplier_claim(args: dict) -> dict:\n"
        "    qty = int(args.get('qty', 0))\n"
        "    price = decimal.Decimal(str(args.get('price', '0.0')))\n"
        "    subtotal = float(price * qty)\n"
        "    rounded = round(subtotal, 2)\n"
        "    return {'total': rounded, 'ceil': math.ceil(rounded), 'json': json.dumps({'qty': qty})}\n"
    )
    ok_safe, errs_safe = validate_ast(safe_code, "compute_supplier_claim")
    assert ok_safe is True
    assert errs_safe == []


def test_user_respond_and_consult_block_path_traversal_claim_id(isolated_consult_server):
    client, _, _, _ = isolated_consult_server

    resp_consult = client.post("/api/call/user-consult", json={"claim_id": "../../etc/passwd"})
    assert resp_consult.status_code == 400
    assert "invalid claim_id format" in resp_consult.text

    resp_respond = client.post("/api/call/user-respond", json={"claim_id": "../../etc/passwd", "choice": "refund"})
    assert resp_respond.status_code == 400
    assert "invalid claim_id format" in resp_respond.text


def test_undo_empty_payload_returns_integer_steps_undone_and_removes_aade_dir_cleanly(isolated_consult_server):
    client, ws, _, _ = isolated_consult_server

    resp = client.post("/api/call/user-respond", json={"choice": "refund"})
    assert resp.status_code == 200

    xml_path = ws / "aade" / "mydata_CLM-D-1042.xml"
    aade_dir = ws / "aade"
    assert xml_path.exists()
    assert aade_dir.exists()

    undo_resp = client.post("/api/undo", json={})
    assert undo_resp.status_code == 200
    data = undo_resp.json()
    assert data["ok"] is True
    assert isinstance(data["steps_undone"], int)
    assert data["steps_undone"] >= 1

    assert not xml_path.exists()
    assert not aade_dir.exists()


async def test_approve_double_resolution_returns_already_resolved(isolated_consult_server):
    client, _, _, _ = isolated_consult_server

    loop = asyncio.get_running_loop()
    gate_fut: asyncio.Future[bool] = loop.create_future()
    PENDING["req_test_double"] = gate_fut

    r1 = client.post("/api/approve/req_test_double", json={"approved": True})
    assert r1.status_code == 200
    assert r1.json() == {"ok": True}

    r2 = client.post("/api/approve/req_test_double", json={"approved": True})
    assert r2.status_code == 200
    assert r2.json() == {"ok": True, "already_resolved": True}

    r_unknown = client.post("/api/approve/req_completely_unknown", json={"approved": True})
    assert r_unknown.status_code == 404



