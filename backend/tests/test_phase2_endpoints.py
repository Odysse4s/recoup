"""Offline test suite for Phase 2 endpoints and PlaceCall tool."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import sqlite3
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import server
from app.contracts import EventType, EvidencePayload
from app.engine.env import Env, fingerprint_env
from app.engine.events import BUS
from app.engine.orchestrator import PENDING
from app.engine.seed import populate_default_seed
from app.engine.tools import REGISTRY
from app.engine.undo import UndoLog


@pytest.fixture
def isolated_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolate server workspace, SQLite DB, undo log, and offline voice env per test."""
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    real = Env(root_dir=ws, db_path=ws / "app.db")
    log = UndoLog(tmp_path / "undo_log.json")

    monkeypatch.setattr(server, "WS", ws)
    monkeypatch.setattr(server, "REAL", real)
    monkeypatch.setattr(server, "LOG", log)
    monkeypatch.setenv("VOICE_PROVIDER", "offline")
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    BUS.history.clear()
    PENDING.clear()
    with TestClient(server.app) as client:
        yield client, ws, real, log
    PENDING.clear()


def test_place_call_tool_registered_and_queues_outbox(tmp_path: Path):
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    rehearsal_env = Env(root_dir=ws, db_path=ws / "app.db", dry_run_external=True)

    tool = REGISTRY["place_call"]
    assert tool.name == "place_call"
    assert tool.risk == "high"
    assert tool.reversible is False
    assert tool.mutating is True

    args = {
        "to": "+30 210 000 0001",
        "counterparty": "Kappa Office Systems AR desk",
        "claim_id": "CLM-D-1042",
        "objective": "Settle EUR 587.30 claim at >= 85% floor",
    }
    preview = tool.preview(args, rehearsal_env)
    assert "CLM-D-1042" in preview
    res = tool.do(args, rehearsal_env)
    assert res["placed"] is False
    assert len(rehearsal_env.outbox) == 1
    assert rehearsal_env.outbox[0]["tool"] == "place_call"
    assert rehearsal_env.outbox[0]["to"] == "+30 210 000 0001"
    assert rehearsal_env.outbox[0]["claim_id"] == "CLM-D-1042"
    assert rehearsal_env.outbox[0]["objective"] == "Settle EUR 587.30 claim at >= 85% floor"


def test_evidence_upload_multipart_and_json_b64(isolated_server, monkeypatch: pytest.MonkeyPatch):
    client, ws, _, _ = isolated_server

    md_bytes = b"# Dock Inspection D-1042\n- 6 HUB-USBC units arrived with crushed USB-C housings\n- Quarantined on rack B4\n"
    resp = client.post(
        "/api/evidence/upload",
        files={"file": ("D-1042_photo_notes.md", md_bytes, "text/markdown")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "inbox/D-1042_photo_notes.md"
    assert body["kind"] == "document"
    assert any("crushed USB-C housings" in f for f in body["findings"])
    assert (ws / "inbox" / "D-1042_photo_notes.md").exists()
    assert any(e.type == EventType.EVIDENCE for e in BUS.history)

    # JSON base64 photo upload + path traversal sanitization
    png_header = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    resp_photo = client.post(
        "/api/evidence/upload",
        json={
            "filename": "../../damaged_hubs_D-1042.png",
            "content_b64": base64.b64encode(png_header).decode("ascii"),
        },
    )
    assert resp_photo.status_code == 200
    photo_body = resp_photo.json()
    assert photo_body["source"] == "inbox/damaged_hubs_D-1042.png"
    assert photo_body["kind"] == "photo"
    assert len(photo_body["findings"]) >= 1
    assert (ws / "inbox" / "damaged_hubs_D-1042.png").exists()

    # Lazy vision module hook when available
    fake_vision = types.ModuleType("app.agent.vision")
    fake_vision.inspect_evidence_file = lambda p: EvidencePayload(  # type: ignore[attr-defined]
        source=f"inbox/{p.name}",
        kind="photo",
        findings=["Vision model verified 6 crushed HUB-USBC cartons on pallet 2"],
    )
    monkeypatch.setitem(__import__("sys").modules, "app.agent.vision", fake_vision)
    resp_vision = client.post(
        "/api/evidence/upload",
        files={"file": ("pallet2.jpg", b"\xff\xd8\xff\xe0JFIF", "image/jpeg")},
    )
    assert resp_vision.status_code == 200
    assert resp_vision.json()["findings"] == ["Vision model verified 6 crushed HUB-USBC cartons on pallet 2"]


def test_call_negotiate_settles_claim_reversibly(isolated_server):
    client, _, real, log = isolated_server

    # Seed committed drafted claim CLM-D-1042 first so we can verify reversible status transition
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
    fp_drafted = fingerprint_env(real)

    resp = client.post("/api/call/negotiate", json={"claim_id": "CLM-D-1042", "pace_seconds": 0.01})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["outcome"] == "accepted"
    assert data["agreed_amount"] == pytest.approx(528.57)
    assert data["claim_status"] == "settled"
    assert len(data["turns"]) >= 4
    assert all(t["audio_url"] == "/api/voice/turn-audio" for t in data["turns"])

    call_events = [
        e.type
        for e in BUS.history
        if e.type in {EventType.CALL_START, EventType.CALL_TURN, EventType.CALL_END}
    ]
    assert call_events[0] == EventType.CALL_START
    assert call_events[-1] == EventType.CALL_END
    assert call_events.count(EventType.CALL_TURN) == len(data["turns"])

    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        status_after = conn.execute("SELECT status FROM claims WHERE id = 'CLM-D-1042'").fetchone()[0]
    assert status_after == "settled"
    assert len(log.entries) == 2

    # Undo 1 step -> restores CLM-D-1042 status from 'settled' back to 'drafted' byte-for-byte
    undo_resp = client.post("/api/undo", json={"steps": 1})
    assert undo_resp.status_code == 200
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        status_reverted = conn.execute("SELECT status FROM claims WHERE id = 'CLM-D-1042'").fetchone()[0]
    assert status_reverted == "drafted"
    assert fingerprint_env(real) == fp_drafted


def test_call_negotiate_escalates_when_below_floor(isolated_server):
    client, _, real, log = isolated_server

    resp = client.post(
        "/api/call/negotiate",
        json={"claim_id": "CLM-D-1042", "opening_pct": 65.0, "floor_pct": 105.0, "pace_seconds": 0.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["outcome"] == "escalated"
    assert data["agreed_amount"] is None
    assert len(log.entries) == 0
    with contextlib.closing(sqlite3.connect(real.db_path)) as conn:
        rows = conn.execute("SELECT * FROM claims").fetchall()
    assert rows == []


def test_voice_turn_audio_204_offline_and_lazy_module(isolated_server, monkeypatch: pytest.MonkeyPatch):
    client, _, _, _ = isolated_server

    r_fallback = client.post(
        "/api/voice/turn-audio",
        json={"speaker": "counterparty", "text": "We can offer 70% credit today."},
    )
    assert r_fallback.status_code == 204

    fake_call_audio = types.ModuleType("app.voice.call_audio")
    fake_call_audio.synthesize_call_turn = lambda speaker, text: f"ID3-{speaker}-{len(text)}".encode()  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_call_audio)

    r_mp3 = client.post(
        "/api/voice/turn-audio",
        json={"speaker": "agent", "text": "Per policy floor we settle at 85%."},
    )
    assert r_mp3.status_code == 200
    assert r_mp3.headers["content-type"].startswith("audio/mpeg")
    assert r_mp3.content.startswith(b"ID3-agent-")


async def test_voice_decision_json_and_multipart_audio(isolated_server, monkeypatch: pytest.MonkeyPatch):
    client, _, _, _ = isolated_server
    loop = asyncio.get_running_loop()

    # 1. JSON transcript approve
    fut_ok: asyncio.Future[bool] = loop.create_future()
    PENDING["req_v1"] = fut_ok
    r1 = client.post("/api/voice/decision", json={"req_id": "req_v1", "transcript": "Looks good, ship it"})
    assert r1.status_code == 200
    assert r1.json()["decision"] == "approve"
    assert r1.json()["resolved"] is True
    assert fut_ok.done() and fut_ok.result() is True

    # 2. Unknown transcript leaves future pending, then negated approve rejects
    fut_no: asyncio.Future[bool] = loop.create_future()
    PENDING["req_v2"] = fut_no
    r_unk = client.post("/api/voice/decision", json={"req_id": "req_v2", "transcript": "wait one moment"})
    assert r_unk.status_code == 200
    assert r_unk.json()["decision"] == "unknown"
    assert not fut_no.done()

    r2 = client.post("/api/voice/decision", json={"req_id": "req_v2", "transcript": "do not approve, roll back"})
    assert r2.status_code == 200
    assert r2.json()["decision"] == "reject"
    assert fut_no.done() and fut_no.result() is False

    # 3. Multipart audio upload (iPhone Safari MediaRecorder path) via lazy call_audio hook
    fake_call_audio = types.ModuleType("app.voice.call_audio")
    fake_call_audio.transcribe_and_decide = lambda audio_bytes, mime_type="audio/mp4": (  # type: ignore[attr-defined]
        "approve claim now",
        "approve",
    )
    monkeypatch.setitem(__import__("sys").modules, "app.voice.call_audio", fake_call_audio)

    fut_mic: asyncio.Future[bool] = loop.create_future()
    PENDING["req_v3"] = fut_mic
    r3 = client.post(
        "/api/voice/decision",
        data={"req_id": "req_v3"},
        files={"audio": ("safari_clip.mp4", b"\x00\x00\x00\x18ftypmp42", "audio/mp4")},
    )
    assert r3.status_code == 200
    body3 = r3.json()
    assert body3["decision"] == "approve"
    assert body3["approved"] is True
    assert body3["resolved"] is True
    assert fut_mic.done() and fut_mic.result() is True
