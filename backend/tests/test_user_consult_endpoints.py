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
    assert any(h in data["opening_text"] for h in ("22 hubs", "22 bad hubs", "short 22 hubs", "22"))
    assert "587 euros" in data["opening_text"]

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
        "call_status": "ringing",
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
        json={
            "transcript": "Enforce the 587 refund hold and stage the AADE myDATA filing now.",
            "hangup": True,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["call_id"] == "CONSULT-CLM-D-1042"
    assert body["choice"] == "refund"
    assert body["agreed_amount"] == pytest.approx(587.30)
    assert body["aade_xml_path"] == "aade/mydata_CLM-D-1042.xml"
    confirm_text = body.get("confirmation_text") or body.get("reply_text") or ""
    assert "7781" in confirm_text
    assert "587" in confirm_text

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
    r_resp = client.post("/api/call/user-respond", json={"req_id": "req_tier1", "choice": "refund", "hangup": True})
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


def test_call_pickup_sets_connected_and_emits_call_start(isolated_consult_server):
    client, _, _, _ = isolated_consult_server

    c_resp = client.post("/api/call/user-consult", json={})
    assert c_resp.status_code == 200
    s_before = client.get("/api/state").json()
    assert s_before["active_call"]["call_status"] == "ringing"
    assert s_before["active_call"]["ringing"] is True

    p_resp = client.post("/api/call/pickup", json={"claim_id": "CLM-D-1042"})
    assert p_resp.status_code == 200
    p_data = p_resp.json()
    assert p_data["ok"] is True
    assert p_data["call_status"] == "connected"

    s_after = client.get("/api/state").json()
    assert s_after["active_call"]["call_status"] == "connected"
    assert s_after["active_call"]["ringing"] is False
    assert s_after["active_call"]["active"] is True

    starts = [e for e in BUS.history if e.type == EventType.CALL_START]
    assert len(starts) == 2
    assert starts[-1].payload["call_status"] == "connected"
    assert starts[-1].payload["counterparty"] == "Operator Mobile"


async def test_multi_turn_conversational_desktop_ui_control(isolated_consult_server):
    client, ws, _, _ = isolated_consult_server

    loop = asyncio.get_running_loop()
    gate_fut: asyncio.Future[bool] = loop.create_future()
    PENDING["req_multi_turn"] = gate_fut
    PENDING_PAYLOADS["req_multi_turn"] = {"req_id": "req_multi_turn", "tool_name": "send_email"}

    c_resp = client.post("/api/call/user-consult", json={"req_id": "req_multi_turn"})
    assert c_resp.status_code == 200

    pickup_resp = client.post("/api/call/pickup", json={"req_id": "req_multi_turn"})
    assert pickup_resp.status_code == 200
    assert pickup_resp.json()["call_status"] == "connected"

    # Turn 1: "Show me the AADE tax filing"
    t1_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "Show me the AADE tax filing", "req_id": "req_multi_turn"},
    )
    assert t1_resp.status_code == 200
    b1 = t1_resp.json()
    assert b1["ok"] is True
    assert b1["keep_call_open"] is True
    assert b1["call_status"] == "connected"
    assert b1["choice"] is None
    assert b1["ui_action"]["action"] == "open_file"
    assert b1["ui_action"]["path"] == "aade/mydata_CLM-D-1042.xml"
    assert "<invoiceType>5.1</invoiceType>" in b1["ui_action"]["content"]
    assert "req_multi_turn" in PENDING
    assert not gate_fut.done()
    assert not any(e.type == EventType.CALL_END for e in BUS.history)

    # Turn 2: "Show me the database"
    t2_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "Show me the database", "req_id": "req_multi_turn"},
    )
    assert t2_resp.status_code == 200
    b2 = t2_resp.json()
    assert b2["ok"] is True
    assert b2["keep_call_open"] is True
    assert b2["call_status"] == "connected"
    assert b2["choice"] is None
    assert b2["ui_action"]["action"] == "switch_view"
    assert b2["ui_action"]["table"] == "invoices"
    assert "req_multi_turn" in PENDING
    assert not gate_fut.done()
    assert not any(e.type == EventType.CALL_END for e in BUS.history)

    # Turn 3: "Enforce the refund" (commits resolution and auto-resolves gate, keeps line open)
    t3_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "Enforce the refund", "req_id": "req_multi_turn"},
    )
    assert t3_resp.status_code == 200
    b3 = t3_resp.json()
    assert b3["ok"] is True
    assert b3["keep_call_open"] is True
    assert b3["call_status"] == "connected"
    assert b3["choice"] == "refund"
    assert b3["ui_action"]["action"] == "commit_resolution"
    assert b3["agreed_amount"] == pytest.approx(587.30)
    assert gate_fut.done() and gate_fut.result() is True
    assert "req_multi_turn" not in PENDING
    assert (ws / "aade" / "mydata_CLM-D-1042.xml").exists()
    assert not any(e.type == EventType.CALL_END for e in BUS.history)
    assert client.get("/api/state").json()["active_call"]["call_status"] == "connected"

    # Turn 4: "no thanks, bye" (hangup intent closes call and emits CALL_END)
    t4_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "no thanks, bye", "req_id": "req_multi_turn"},
    )
    assert t4_resp.status_code == 200
    b4 = t4_resp.json()
    assert b4["ok"] is True
    assert b4["keep_call_open"] is False
    assert b4["call_status"] == "ended"
    assert "undo" in b4["reply_text"].lower()
    assert any(e.type == EventType.CALL_END for e in BUS.history)
    assert client.get("/api/state").json()["active_call"]["call_status"] == "ended"


def test_grok_tts_offline_fallback_and_caching(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app.voice import call_audio

    cache_dir = tmp_path / "voice_cache"
    monkeypatch.setattr(call_audio, "VOICE_CACHE_DIR", cache_dir)
    monkeypatch.setenv("VOICE_CACHE_DIR", str(cache_dir))

    # 1. Offline fallback
    monkeypatch.setenv("VOICE_PROVIDER", "offline")
    assert call_audio.synthesize_grok_tts("Hello operator") is None

    # 2. Missing FAL_KEY fallback
    monkeypatch.delenv("VOICE_PROVIDER", raising=False)
    monkeypatch.delenv("FAL_KEY", raising=False)
    assert call_audio.synthesize_grok_tts("Hello operator") is None

    # 3. Cache hit returns cached bytes directly without HTTP
    monkeypatch.setenv("FAL_KEY", "fal-mock-key")
    cache_dir.mkdir(parents=True, exist_ok=True)
    digest = call_audio.hashlib.sha256(b"ara:Cached audio turn").hexdigest()
    cache_file = cache_dir / f"grok_ara_{digest}.mp3"
    cache_file.write_bytes(b"MOCK-GROK-MP3-BYTES")

    cached_res = call_audio.synthesize_grok_tts("Cached audio turn", voice="ara")
    assert cached_res == b"MOCK-GROK-MP3-BYTES"


async def test_live_audio_stt_noise_and_open_question_do_not_prematurely_hang_up_call(
    isolated_consult_server,
    monkeypatch: pytest.MonkeyPatch,
):
    client, _, _, _ = isolated_consult_server

    loop = asyncio.get_running_loop()
    gate_fut: asyncio.Future[bool] = loop.create_future()
    PENDING["req_vad_guard"] = gate_fut
    PENDING_PAYLOADS["req_vad_guard"] = {"req_id": "req_vad_guard", "tool_name": "send_email"}

    client.post("/api/call/user-consult", json={"req_id": "req_vad_guard"})
    client.post("/api/call/pickup", json={"req_id": "req_vad_guard"})

    # 1. Wizper silence hallucination ("Thank you.") is ignored cleanly without ending call
    fake_noise = types.ModuleType("app.voice.call_audio")
    fake_noise.transcribe_operator_voice = lambda audio_bytes, mime_type="audio/webm": "Thank you."  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_noise)

    r_noise = client.post(
        "/api/call/user-respond",
        data={"req_id": "req_vad_guard", "claim_id": "CLM-D-1042"},
        files={"audio": ("noise.webm", b"\x1aE\xdf\xa3room-cough-bytes", "audio/webm")},
    )
    assert r_noise.status_code == 200
    b_noise = r_noise.json()
    assert b_noise["keep_call_open"] is True
    assert b_noise["ignored_noise"] is True
    assert not gate_fut.done()

    # 2. Open conversational question keeps call open and replies with summary
    fake_q = types.ModuleType("app.voice.call_audio")
    fake_q.transcribe_operator_voice = lambda audio_bytes, mime_type="audio/webm": "Wait what are my options again?"  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_q)

    r_q = client.post(
        "/api/call/user-respond",
        data={"req_id": "req_vad_guard", "claim_id": "CLM-D-1042"},
        files={"audio": ("question.webm", b"\x1aE\xdf\xa3question-bytes", "audio/webm")},
    )
    assert r_q.status_code == 200
    b_q = r_q.json()
    assert b_q["keep_call_open"] is True
    assert b_q["call_status"] == "connected"
    assert b_q["choice"] is None
    assert "587 euros" in b_q["reply_text"]
    assert not gate_fut.done()


def test_user_respond_explicit_hangup_and_redelivery_flows(isolated_consult_server):
    client, _, _, _ = isolated_consult_server

    # 1. Start consult call
    c_resp = client.post("/api/call/user-consult", json={"claim_id": "CLM-D-1042"})
    assert c_resp.status_code == 200

    # 2. Operator picks redelivery (keep_call_open=True, call_status="connected")
    r_redeliv = client.post(
        "/api/call/user-respond",
        json={"choice": "redelivery", "claim_id": "CLM-D-1042", "hangup": False},
    )
    assert r_redeliv.status_code == 200
    b_red = r_redeliv.json()
    assert b_red["ok"] is True
    assert b_red["choice"] == "redelivery"
    assert b_red["agreed_amount"] == pytest.approx(202.30)
    assert b_red["keep_call_open"] is True
    assert b_red["call_status"] == "connected"
    assert "22" in b_red["reply_text"]
    assert not any(e.type == EventType.CALL_END for e in BUS.history)

    # 3. Explicit hangup closes the active call and emits CALL_END
    r_hangup = client.post(
        "/api/call/user-respond",
        json={"hangup": True, "claim_id": "CLM-D-1042"},
    )
    assert r_hangup.status_code == 200
    b_hang = r_hangup.json()
    assert b_hang["ok"] is True
    assert b_hang["keep_call_open"] is False
    assert b_hang["call_status"] == "ended"
    assert "undo" in b_hang["reply_text"].lower()
    assert any(e.type == EventType.CALL_END for e in BUS.history)


def test_voice_realtime_websocket_offline_fallback(isolated_consult_server):
    client, _, _, _ = isolated_consult_server
    with client.websocket_connect("/api/voice/realtime?claim_id=CLM-D-1042") as ws:
        data = ws.receive_json()
        assert data["type"] == "recoup.fallback"
        assert data["reason"] == "offline_or_unconfigured"
        assert data["fallback_available"] is True
        assert data["outcome"]["claim_id"] == "CLM-D-1042"


def test_voice_realtime_websocket_invalid_voice_rejected(isolated_consult_server):
    client, _, _, _ = isolated_consult_server
    with client.websocket_connect("/api/voice/realtime?voice=nonexistent_voice_xyz") as ws:
        err = ws.receive_json()
        assert err["type"] == "recoup.error"
        assert "Unsupported Grok realtime voice" in err["message"]


def test_voice_realtime_stage_endpoint_classification(isolated_consult_server):
    client, _, _, _ = isolated_consult_server

    # 1. Refund classification
    resp_ref = client.post(
        "/api/voice/realtime/stage",
        json={
            "claim_id": "CLM-D-1042",
            "turns": [{"speaker": "human", "text": "Let's take the 587.30 euro refund credit note."}],
        },
    )
    assert resp_ref.status_code == 200
    body_ref = resp_ref.json()
    assert body_ref["ok"] is True
    assert body_ref["staged"] is True
    assert body_ref["outcome"]["decision"] == "refund"
    assert body_ref["outcome"]["refund_amount_eur"] == pytest.approx(587.30)
    assert body_ref["outcome"]["requires_risk_gate"] is True
    assert body_ref["outcome"]["erp_authorized"] is False

    # 2. Redelivery classification
    resp_red = client.post(
        "/api/voice/realtime/stage",
        json={
            "claim_id": "CLM-D-1042",
            "turns": [{"speaker": "human", "text": "Please ship the 22 replacement hubs tomorrow."}],
        },
    )
    assert resp_red.status_code == 200
    body_red = resp_red.json()
    assert body_red["ok"] is True
    assert body_red["staged"] is True
    assert body_red["outcome"]["decision"] == "redelivery"
    assert body_red["outcome"]["replacement_units"] == 22

    # 3. Unclear / undecided classification
    resp_unc = client.post(
        "/api/voice/realtime/stage",
        json={
            "claim_id": "CLM-D-1042",
            "turns": [{"speaker": "human", "text": "I'm not sure yet, let me check with accounting."}],
        },
    )
    assert resp_unc.status_code == 200
    body_unc = resp_unc.json()
    assert body_unc["ok"] is True
    assert body_unc["staged"] is False
    assert body_unc["outcome"]["decision"] == "unclear"


def test_early_hangup_before_commit_keeps_gate_paused(isolated_consult_server):
    """Early hangup before committing keeps gate paused and avoids claiming one-click undo."""
    client, _, _, _ = isolated_consult_server

    c_resp = client.post("/api/call/user-consult", json={"claim_id": "CLM-D-1042"})
    assert c_resp.status_code == 200

    r_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "hang up", "claim_id": "CLM-D-1042"},
    )
    assert r_resp.status_code == 200
    b = r_resp.json()
    assert b["keep_call_open"] is False
    assert b["choice"] is None
    reply_text = b["reply_text"].lower()
    assert "paused" in reply_text
    assert "saved with one-click undo" not in reply_text

    ends = [e for e in BUS.history if e.type == EventType.CALL_END]
    assert len(ends) >= 1
    assert ends[-1].payload["outcome"] == "escalated"


def test_away_from_desk_multiturn_options_commit_and_goodbye(isolated_consult_server):
    """Multi-turn away-from-desk assistant flow: options -> commit refund -> goodbye."""
    client, _, _, _ = isolated_consult_server

    c_resp = client.post("/api/call/user-consult", json={"claim_id": "CLM-D-1042"})
    assert c_resp.status_code == 200

    # Turn 1: "what are my options?"
    t1_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "what are my options?", "claim_id": "CLM-D-1042"},
    )
    assert t1_resp.status_code == 200
    b1 = t1_resp.json()
    assert b1["keep_call_open"] is True
    assert b1["choice"] is None
    assert "screen" not in b1["reply_text"].lower()
    assert "587" in b1["reply_text"]
    assert "22" in b1["reply_text"]

    # Turn 2: "take the 587 refund"
    t2_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "take the 587 refund", "claim_id": "CLM-D-1042"},
    )
    assert t2_resp.status_code == 200
    b2 = t2_resp.json()
    assert b2["keep_call_open"] is True
    assert b2["choice"] == "refund"
    assert "7781" in b2["reply_text"]

    # Turn 3: "thanks bye"
    t3_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "thanks bye", "claim_id": "CLM-D-1042"},
    )
    assert t3_resp.status_code == 200
    b3 = t3_resp.json()
    assert b3["keep_call_open"] is False
    assert "applied" in b3["reply_text"].lower()
    assert "undo" in b3["reply_text"].lower()

    ends = [e for e in BUS.history if e.type == EventType.CALL_END]
    assert len(ends) >= 1
    assert ends[-1].payload["outcome"] == "accepted"


def test_user_consult_dynamic_non_kappa_scenario(isolated_consult_server):
    """Verify non-Kappa staged scenario (Atlas Paper) uses dynamic context without falling back to Kappa defaults."""
    client, ws, real, _ = isolated_consult_server

    req_id = "req_atlas_3005"
    fut = asyncio.new_event_loop().create_future()
    PENDING[req_id] = fut

    # Stage Atlas claim payload in PENDING_PAYLOADS
    gate_payload = {
        "req_id": req_id,
        "tool_name": "send_email",
        "args": {
            "to": "accounts@atlaspaper.example",
            "subject": "Credit Claim CLM-3005 on Invoice INV-9901: EUR 500.00 (AADE myDATA 5.1)",
            "body": "Discrepancy of EUR 500.00 on delivery D-3005",
        },
        "diff_preview": "EMAIL to=accounts@atlaspaper.example subject='Credit Claim CLM-3005 on Invoice INV-9901'",
        "risk_reason": "Claim CLM-3005 is EUR 500.00 (>= EUR 250 threshold) on INV-9901",
        "spoken_summary": "",
        "report": {
            "external_outbox": [
                {
                    "to": "accounts@atlaspaper.example",
                    "subject": "Credit Claim CLM-3005 on Invoice INV-9901: EUR 500.00",
                    "body": "Claim CLM-3005 for EUR 500.00 on delivery D-3005",
                }
            ]
        },
    }
    PENDING_PAYLOADS[req_id] = gate_payload

    # Emit staged claim tool call in BUS history
    BUS.emit(
        "run_atlas_1",
        EventType.TOOL_CALL,
        {
            "call": {
                "id": "call_upsert_clm_3005",
                "name": "upsert_row",
                "args": {
                    "table": "claims",
                    "pk_col": "id",
                    "row": {
                        "id": "CLM-3005",
                        "supplier_id": "SUP-ATLAS",
                        "delivery_id": "D-3005",
                        "invoice_id": "INV-9901",
                        "amount": 500.0,
                        "reason": "damaged paper rolls and pricing discrepancy",
                        "status": "drafted",
                    },
                },
            }
        },
    )

    # 1. POST /api/call/user-consult produces dynamic Atlas opening
    c_resp = client.post("/api/call/user-consult", json={"req_id": req_id})
    assert c_resp.status_code == 200
    data = c_resp.json()
    assert data["ok"] is True
    assert data["claim_id"] == "CLM-3005"
    assert data["claim_amount"] == pytest.approx(500.0)
    assert "Atlas" in data["opening_text"]
    assert "D-3005" in data["opening_text"]
    assert "500 euro" in data["opening_text"]
    assert "INV-9901" in data["opening_text"]
    assert "Kappa" not in data["opening_text"]
    assert "587.30" not in data["opening_text"]
    assert "587" not in data["opening_text"]
    assert "22" not in data["opening_text"]

    # 2. Options and breakdown Q&A return Atlas details with zero Kappa
    opt_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "What are my options?", "req_id": req_id, "claim_id": "CLM-3005"},
    )
    assert opt_resp.status_code == 200
    opt_body = opt_resp.json()
    assert "500" in opt_body["reply_text"]
    assert "INV-9901" in opt_body["reply_text"]
    assert "Atlas" in opt_body["reply_text"]
    assert "Kappa" not in opt_body["reply_text"]
    assert "587" not in opt_body["reply_text"]
    assert "22" not in opt_body["reply_text"]

    why_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "Why do they owe 500?", "req_id": req_id, "claim_id": "CLM-3005"},
    )
    assert why_resp.status_code == 200
    why_body = why_resp.json()
    assert "500" in why_body["reply_text"]
    assert "INV-9901" in why_body["reply_text"]
    assert "D-3005" in why_body["reply_text"]
    assert "Kappa" not in why_body["reply_text"]
    assert "587" not in why_body["reply_text"]
    assert "22" not in why_body["reply_text"]

    # 3. Approving commits via _resolve_gate, writes AADE XML, updates DB, does not overwrite with Kappa
    commit_resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "yes approve, enforce the claim right now", "req_id": req_id, "claim_id": "CLM-3005"},
    )
    assert commit_resp.status_code == 200
    commit_body = commit_resp.json()
    assert commit_body["ok"] is True
    assert commit_body["choice"] == "refund"
    assert commit_body["agreed_amount"] == pytest.approx(500.0)
    assert commit_body["aade_xml_path"] == "aade/mydata_CLM-3005.xml"
    assert fut.done() and fut.result() is True
    assert req_id not in PENDING

    confirm_text = commit_body.get("confirmation_text") or commit_body.get("reply_text") or ""
    assert "On it—freezing invoice INV-9901, filing the 500 euro AADE tax credit, and emailing Atlas Paper right now! All done. Need anything else?" == confirm_text

    # Verify AADE XML file
    xml_file = ws / "aade" / "mydata_CLM-3005.xml"
    assert xml_file.exists()
    xml_text = xml_file.read_text(encoding="utf-8")
    root = ET.fromstring(xml_text)
    assert root.tag == "{http://www.aade.gr/myDATA/invoice/v1.0}InvoicesDoc"
    assert "<invoiceType>5.1</invoiceType>" in xml_text
    assert "<netValue>500.00</netValue>" in xml_text
    assert "<totalGrossValue>620.00</totalGrossValue>" in xml_text
    assert "<correlatedInvoices>INV-9901</correlatedInvoices>" in xml_text
    assert "<deliveryRef>D-3005</deliveryRef>" in xml_text
    assert "Kappa" not in xml_text

    # Verify SQLite DB
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        conn.row_factory = sqlite3.Row
        clm_row = conn.execute("SELECT * FROM claims WHERE id = 'CLM-3005'").fetchone()
        assert clm_row is not None
        assert clm_row["supplier_id"] == "SUP-ATLAS"
        assert clm_row["amount"] == pytest.approx(500.0)
        assert clm_row["status"] == "settled"

        inv_row = conn.execute("SELECT * FROM invoices WHERE id = 'INV-9901'").fetchone()
        assert inv_row is not None
        assert inv_row["status"] == "held"


def test_user_respond_dynamic_non_kappa_hold_off(isolated_consult_server):
    """Verify non-Kappa rejection/hold off safely pauses without mentioning Kappa."""
    client, _, _, _ = isolated_consult_server

    req_id = "req_atlas_hold"
    fut = asyncio.new_event_loop().create_future()
    PENDING[req_id] = fut

    PENDING_PAYLOADS[req_id] = {
        "req_id": req_id,
        "tool_name": "send_email",
        "args": {
            "to": "accounts@atlaspaper.example",
            "subject": "Credit Claim CLM-3005 on Invoice INV-9901: EUR 500.00",
            "body": "Discrepancy on D-3005",
        },
    }

    c_resp = client.post("/api/call/user-consult", json={"req_id": req_id, "claim_id": "CLM-3005"})
    assert c_resp.status_code == 200

    resp = client.post(
        "/api/call/user-respond",
        json={"transcript": "hold off for now, do not proceed", "req_id": req_id, "claim_id": "CLM-3005", "choice": "escalated"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["keep_call_open"] is False
    assert "Kappa" not in body["reply_text"]






