import asyncio
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from app import server
from app.contracts import (
    AnticipatePrediction,
    ChangeReport,
    EventType,
    PlanPayload,
    PlanStep,
    RiskDecision,
    ToolCall,
    VerifyCriterionResult,
    VerifyPayload,
)
from app.domain_config import get_domain
from app.engine import orchestrator
from app.engine.env import Env, diff_databases, fingerprint_env, make_rehearsal_env
from app.engine.events import BUS
from app.engine.risk import assess_risk
from app.engine.sandbox import run_in_sandbox, validate_ast, verify_and_register_forged_tool
from app.engine.seed import populate_default_seed
from app.engine.tools import REGISTRY, DeleteRows, UpsertRow
from app.engine.undo import UndoLog
from app.server import app


@pytest.mark.parametrize("tool_name", ["send_email", "place_call", "trigger_webhook"])
def test_external_tools_require_approval(tool_name):
    d, reason = assess_risk(ToolCall(id="1", name=tool_name, args={}), REGISTRY[tool_name], ChangeReport())
    assert d == RiskDecision.ASK
    assert tool_name in reason


def test_claims_amount_threshold_risk_gate():
    high_claim = ToolCall(
        id="c1",
        name="upsert_row",
        args={"table": "claims", "pk_col": "id", "row": {"id": "CLM-D-1042", "amount": 587.30}},
    )
    d_high, reason_high = assess_risk(high_claim, REGISTRY["upsert_row"], ChangeReport())
    assert d_high == RiskDecision.ASK
    assert "587.30" in reason_high and "250.00" in reason_high

    boundary_claim = ToolCall(
        id="c2",
        name="upsert_row",
        args={"table": "claims", "pk_col": "id", "row": {"id": "CLM-250", "amount": 250.00}},
    )
    d_bound, _ = assess_risk(boundary_claim, REGISTRY["upsert_row"], ChangeReport())
    assert d_bound == RiskDecision.ASK

    low_claim = ToolCall(
        id="c3",
        name="upsert_row",
        args={"table": "claims", "pk_col": "id", "row": {"id": "CLM-FOLLOWUP", "amount": 175.00}},
    )
    d_low, _ = assess_risk(low_claim, REGISTRY["upsert_row"], ChangeReport())
    assert d_low == RiskDecision.AUTO

    invoice_hold = ToolCall(
        id="c4",
        name="upsert_row",
        args={"table": "invoices", "pk_col": "id", "row": {"id": "INV-7781", "status": "disputed"}},
    )
    d_inv, _ = assess_risk(invoice_hold, REGISTRY["upsert_row"], ChangeReport())
    assert d_inv == RiskDecision.AUTO


def test_protected_path_and_blocked_table():
    d_path, _ = assess_risk(
        ToolCall(id="1", name="write_file", args={"path": ".env"}),
        REGISTRY["write_file"],
        ChangeReport(),
    )
    assert d_path == RiskDecision.BLOCK

    d_table, _ = assess_risk(
        ToolCall(id="2", name="upsert_row", args={"table": "audit_log", "pk_col": "id", "row": {"id": 1}}),
        REGISTRY["upsert_row"],
        ChangeReport(),
    )
    assert d_table == RiskDecision.BLOCK


def test_db_diff_and_row_deletion_risk(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    db = ws / "app.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, tag TEXT)")
        conn.executemany("INSERT INTO items VALUES (?, 'old')", [(i,) for i in range(1, 15)])
        conn.commit()
    real = Env(root_dir=ws, db_path=db)
    staged = make_rehearsal_env(real)
    UpsertRow().do({"table": "items", "pk_col": "id", "row": {"id": 1, "tag": "updated"}}, staged)
    UpsertRow().do({"table": "items", "pk_col": "id", "row": {"id": 99, "tag": "new"}}, staged)
    DeleteRows().do({"table": "items", "where_col": "tag", "where_val": "old"}, staged)

    summary, max_del = diff_databases(real.db_path, staged.db_path)
    assert summary["items"] == {"inserted": 1, "updated": 1, "deleted": 13}
    assert max_del == 13

    report = ChangeReport(db_summary=summary, db_max_deleted=max_del)
    d, reason = assess_risk(ToolCall(id="d1", name="delete_rows", args={}), REGISTRY["delete_rows"], report)
    assert d == RiskDecision.ASK
    assert "13 rows" in reason
    staged.cleanup()


def test_forge_ast_and_compute_supplier_claim_sandbox(tmp_path):
    bad_code = "import os\ndef bad_tool(args):\n    os.system('echo pwn')\n    return {}\n"
    ok, errs = validate_ast(bad_code, "bad_tool")
    assert not ok
    assert any("Disallowed import: os" in e for e in errs)

    dunder_code = "def dunder_tool(args):\n    return ().__class__.__base__\n"
    ok2, errs2 = validate_ast(dunder_code, "dunder_tool")
    assert not ok2
    assert any("dunder" in e for e in errs2)

    forge_cfg = get_domain()["demo"]["forge"]
    REGISTRY.pop(forge_cfg["name"], None)
    res = verify_and_register_forged_tool(
        name=forge_cfg["name"],
        description=forge_cfg["purpose"],
        params_schema={"type": "object"},
        code=forge_cfg["code"],
        examples=forge_cfg["examples"],
        save_dir=tmp_path / "forged_tools",
    )
    assert res["registered"] is True
    assert (tmp_path / "forged_tools" / "compute_supplier_claim.py").exists()
    tool = REGISTRY["compute_supplier_claim"]

    d, _ = assess_risk(
        ToolCall(id="f1", name="compute_supplier_claim", args=forge_cfg["call_args"]),
        tool,
        ChangeReport(),
    )
    # Pure forged calculators are non-mutating (sandbox.py enforces mutating=False) and
    # already passed AST + sandbox tests, so first use auto-commits without a Risk Gate pause.
    assert d == RiskDecision.AUTO
    out = tool.do(forge_cfg["call_args"], Env(root_dir=tmp_path, db_path=tmp_path / "app.db"))
    assert out == {
        "result": {
            "overcharge": 168.0,
            "shortage": 280.0,
            "damaged": 105.0,
            "late_penalty": 34.3,
            "total": 587.3,
        }
    }
    REGISTRY.pop("compute_supplier_claim", None)


def test_sandbox_allows_future_io_and_print_debug(tmp_path):
    code = (
        "from __future__ import annotations\n"
        "import csv\n"
        "import io\n"
        "def parse_csv_row(args: dict) -> dict:\n"
        "    print('debug trace to stderr')\n"
        "    rows = list(csv.reader(io.StringIO(args['line'])))\n"
        "    return {'cols': rows[0]}\n"
    )
    res = verify_and_register_forged_tool(
        name="parse_csv_row",
        description="Parse single CSV line",
        params_schema={"type": "object"},
        code=code,
        examples=[{"in": {"line": "a,b,c"}, "out": {"cols": ["a", "b", "c"]}}],
        save_dir=tmp_path / "forged",
    )
    assert res["registered"] is True
    REGISTRY.pop("parse_csv_row", None)


def test_sandbox_kills_runaway_cpu_loop_instead_of_hanging():
    """A tight infinite loop has no disallowed import/dunder, so AST validation must let it
    through - only the sandbox's own CPU rlimit / subprocess timeout can stop it from running
    forever if the Forge Engineer ever synthesizes something pathological."""
    code = (
        "def spin(args: dict) -> dict:\n"
        "    total = 0\n"
        "    while True:\n"
        "        total += 1\n"
        "    return {'total': total}\n"
    )
    ok, errors = validate_ast(code, "spin")
    assert ok, f"a plain loop with no forbidden imports/attrs must pass static AST validation: {errors}"

    start = time.monotonic()
    result = run_in_sandbox(code, "spin", {}, timeout=3.0)
    elapsed = time.monotonic() - start

    assert elapsed < 6.0, "sandbox must be killed near its own timeout budget, not hang indefinitely"
    assert result["ok"] is False
    # The subprocess's own RLIMIT_CPU=2s fires first (SIGKILL, "Exited with -9"); if it didn't,
    # subprocess.run's wall-clock `timeout=` would still catch it ("Sandbox timeout ..."). Either
    # way the call must come back promptly with a failure, never hang or report success.
    assert "-9" in result["error"] or "timeout" in result["error"].lower()


async def test_orchestrator_hero_run_rehearse_replay_undo_and_anticipate(tmp_path, monkeypatch):
    """Test full orchestrator lifecycle using a local agent-loop stub until branches merge."""
    domain = get_domain()
    demo = domain["demo"]
    forge_cfg = demo["forge"]
    monkeypatch.setattr(orchestrator, "FORGED_DIR", tmp_path / "forged")
    REGISTRY.pop(forge_cfg["name"], None)

    async def stub_agent_loop(goal: str, execute, emit=None, shadow_env=None, forged_dir=None):
        done: list[ToolCall] = []
        if goal == domain["default_goal"]:
            plan = PlanPayload(
                goal=goal,
                steps=[
                    PlanStep(id=1, intent=demo["evidence"]["intent"], tool="read_file"),
                    PlanStep(id=2, intent=demo["lookup"]["intent"], tool="query_db"),
                    PlanStep(id=3, intent=forge_cfg["step_title"], tool=f"MISSING:{forge_cfg['name']}"),
                    PlanStep(id=4, intent=demo["mutations"][0]["intent"], tool="upsert_row"),
                    PlanStep(id=5, intent=demo["mutations"][1]["intent"], tool="upsert_row"),
                    PlanStep(id=6, intent=demo["report"]["intent"], tool="write_file"),
                    PlanStep(id=7, intent=demo["notify"]["intent"], tool="send_email"),
                ],
                success_criteria=[f"{demo['report']['path']} exists", demo["notify"]["criterion"]],
            )
            if emit:
                emit(EventType.PLAN_CREATED, plan.model_dump(), "Created 7-step vendor audit plan.", 0.002)
                emit(
                    EventType.FORGE_SPEC,
                    {
                        "name": forge_cfg["name"],
                        "purpose": forge_cfg["purpose"],
                        "input_schema": {"type": "object"},
                        "output_schema": {"type": "object"},
                        "examples": forge_cfg["examples"],
                    },
                    "Synthesizing SLA claim calculator spec.",
                    0.002,
                )
            res = verify_and_register_forged_tool(
                name=forge_cfg["name"],
                description=forge_cfg["purpose"],
                params_schema={"type": "object"},
                code=forge_cfg["code"],
                examples=forge_cfg["examples"],
                save_dir=forged_dir,
            )
            if emit:
                emit(
                    EventType.FORGE_TEST_RESULT,
                    {
                        "name": forge_cfg["name"],
                        "attempt": 1,
                        "code": forge_cfg["code"],
                        **res,
                    },
                    "Sandbox unit tests passed.",
                    0.002,
                )
                emit(
                    EventType.FORGE_REGISTERED,
                    {"name": forge_cfg["name"], "description": forge_cfg["purpose"], "attempt": 1},
                    "Registered compute_supplier_claim.",
                    0.0,
                )

            calls = [
                ToolCall(id="c1", name="read_file", args={"path": demo["evidence"]["path"]}),
                ToolCall(id="c2", name="query_db", args={"sql": demo["lookup"]["sql"]}),
                ToolCall(id="c3", name=forge_cfg["name"], args=forge_cfg["call_args"]),
                ToolCall(
                    id="c4",
                    name="upsert_row",
                    args={
                        "table": demo["mutations"][0]["table"],
                        "pk_col": demo["mutations"][0]["pk_col"],
                        "row": demo["mutations"][0]["row"],
                    },
                ),
                ToolCall(
                    id="c5",
                    name="upsert_row",
                    args={
                        "table": demo["mutations"][1]["table"],
                        "pk_col": demo["mutations"][1]["pk_col"],
                        "row": demo["mutations"][1]["row"],
                    },
                ),
                ToolCall(
                    id="c6",
                    name="write_file",
                    args={"path": demo["report"]["path"], "content": demo["report"]["content"]},
                ),
                ToolCall(
                    id="c7",
                    name="send_email",
                    args={
                        "to": demo["notify"]["to"],
                        "subject": demo["notify"]["subject"],
                        "body": demo["notify"]["body"],
                    },
                ),
            ]
            for c in calls:
                r = await execute(c)
                assert r.ok
                done.append(c)
            if emit:
                vp = VerifyPayload(
                    passed=True,
                    criteria=[
                        VerifyCriterionResult(criterion=f"{demo['report']['path']} exists", passed=True),
                        VerifyCriterionResult(criterion=demo["notify"]["criterion"], passed=True),
                    ],
                )
                emit(EventType.VERIFY_RESULT, vp.model_dump(), "All criteria verified.", 0.0)
            return done

        # Follow-up Anticipate rehearsal: EUR 175.00 consolidated claim (< EUR 250 gate) + memo
        ant = demo["anticipate"]
        calls = [
            ToolCall(
                id="a1",
                name="upsert_row",
                args={
                    "table": "claims",
                    "pk_col": "id",
                    "row": {
                        "id": "CLM-KAPPA-FOLLOWUP",
                        "supplier_id": "SUP-KAPPA",
                        "delivery_id": "D-1017,D-1031",
                        "invoice_id": "INV-7702,INV-7735",
                        "amount": 175.00,
                        "reason": "6 short on D-1017 (105.00) + 4 DOA on D-1031 (70.00)",
                        "status": "drafted",
                    },
                },
            ),
            ToolCall(id="a2", name="write_file", args={"path": ant["path"], "content": ant["content"]}),
        ]
        for c in calls:
            r = await execute(c)
            assert r.ok
            done.append(c)
        return done

    def stub_predict_next(completed_goal: str, env: Env, feedback_path=None):
        ant = demo["anticipate"]
        return AnticipatePrediction(
            need=ant["need"],
            goal_prompt=ant["goal_prompt"],
            evidence=ant["evidence"],
            confidence=0.92,
            kind="draft",
        )

    monkeypatch.setattr(orchestrator, "run_agent_loop", stub_agent_loop)
    monkeypatch.setattr(orchestrator, "predict_next_need", stub_predict_next)

    ws = tmp_path / "ws"
    populate_default_seed(ws)
    real = Env(root_dir=ws, db_path=ws / "app.db")
    before = fingerprint_env(real)
    log = UndoLog()
    q = BUS.subscribe()
    seen_types: list[EventType] = []

    async def auto_approver():
        while True:
            ev = await q.get()
            seen_types.append(ev.type)
            if ev.type == EventType.APPROVAL_NEEDED:
                assert ev.payload["spoken_summary"].startswith("Recoup ")
                req_id = ev.payload["req_id"]
                if req_id in orchestrator.PENDING and not orchestrator.PENDING[req_id].done():
                    orchestrator.PENDING[req_id].set_result(True)

    approver_task = asyncio.create_task(auto_approver())
    plan, report, fp, previews = await orchestrator.rehearse(domain["default_goal"], real, "hero1")

    assert fingerprint_env(real) == before
    assert report.db_summary == {
        "claims": {"inserted": 1, "updated": 0, "deleted": 0},
        "invoices": {"inserted": 0, "updated": 1, "deleted": 0},
    }
    assert report.files_created == ["claims/CLM-D-1042.md"]
    assert len(report.external_outbox) == 1

    status = await orchestrator.replay("hero1", plan, report, fp, previews, real, log)
    assert status == "committed"
    assert (ws / "claims/CLM-D-1042.md").exists()

    offer = await orchestrator.speculate_next_offer(domain["default_goal"], real, "hero1")
    assert offer is not None
    assert "INV-7702" in offer.prediction.evidence and "INV-7735" in offer.prediction.evidence
    assert len(offer.commit_plan) == 2
    await asyncio.sleep(0.05)
    approver_task.cancel()
    BUS.unsubscribe(q)

    for expected in (
        EventType.PLAN_CREATED,
        EventType.FORGE_SPEC,
        EventType.FORGE_TEST_RESULT,
        EventType.FORGE_REGISTERED,
        EventType.VERIFY_RESULT,
        EventType.APPROVAL_NEEDED,
        EventType.ANTICIPATE_OFFER,
    ):
        assert expected in seen_types

    ant_status = await orchestrator.replay(
        "ant1", offer.commit_plan, offer.report, offer.fp, offer.previews, real, log
    )
    assert ant_status == "committed"
    assert (ws / "claims/CLM-KAPPA-FOLLOWUP.md").exists()

    skipped = log.undo_all(REGISTRY, real)
    assert skipped == ["send_email"]
    assert fingerprint_env(real) == before
    REGISTRY.pop(forge_cfg["name"], None)


async def test_replay_rejection_preserves_prior_committed_run(tmp_path):
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    real = Env(root_dir=ws, db_path=ws / "app.db")
    log = UndoLog()

    run1_calls = [ToolCall(id="r1", name="write_file", args={"path": "claims/run1.md", "content": "ok"})]
    status1 = await orchestrator.replay("r1", run1_calls, ChangeReport(), fingerprint_env(real), {}, real, log)
    assert status1 == "committed"
    assert (ws / "claims/run1.md").exists()
    assert len(log.entries) == 1

    run2_calls = [
        ToolCall(id="r2a", name="write_file", args={"path": "claims/run2.md", "content": "temp"}),
        ToolCall(id="r2b", name="write_file", args={"path": ".env", "content": "SECRET=1"}),
    ]
    status2 = await orchestrator.replay("r2", run2_calls, ChangeReport(), fingerprint_env(real), {}, real, log)
    assert status2 == "blocked"
    assert (ws / "claims/run1.md").exists()
    assert not (ws / "claims/run2.md").exists()
    assert len(log.entries) == 1


def test_server_endpoints_and_dropped_pack_routes(monkeypatch, tmp_path):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("WONDERFUL_API_KEY", raising=False)
    monkeypatch.setenv("VOICE_CACHE_DIR", str(tmp_path / "voice_cache"))
    with TestClient(app) as client:
        h = client.get("/api/health")
        assert h.status_code == 200
        assert h.json()["brand"] == "Recoup"

        st = client.get("/api/state")
        assert st.status_code == 200
        body = st.json()
        assert body["domain"]["brand_name"] == "Recoup"
        assert body["domain"]["primary_color"] == "emerald"
        assert "active_pack" not in body["domain"]
        assert {"suppliers", "contract_prices", "deliveries", "invoices", "claims"} <= set(body["tables"])

        vb = client.post("/api/voice/briefing", json={"text": "Risk gate active on shipment D-1042."})
        assert vb.status_code == 204

        rep = client.get("/api/runs/report?download=1")
        assert rep.status_code == 200
        assert "Recoup Audit & Execution Report" in rep.text
        assert "recoup_run_" in rep.headers.get("content-disposition", "")

        assert client.get("/api/domain-packs").status_code == 404
        assert client.post("/api/pack/finance").status_code == 404


@pytest.fixture
def isolated_goal_server(tmp_path, monkeypatch):
    """Isolate workspace, SQLite DB, and undo log for /api/goal concurrency tests."""
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    real = Env(root_dir=ws, db_path=ws / "app.db")
    log = UndoLog(tmp_path / "undo_log.json")

    monkeypatch.setattr(server, "WS", ws)
    monkeypatch.setattr(server, "REAL", real)
    monkeypatch.setattr(server, "LOG", log)
    monkeypatch.setenv("VOICE_PROVIDER", "offline")
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    BUS.history.clear()
    orchestrator.PENDING.clear()
    server.GOAL_RUN_TASK = None
    with TestClient(server.app) as client:
        yield client, ws, real, log
    if server.GOAL_RUN_TASK and not server.GOAL_RUN_TASK.done():
        server.GOAL_RUN_TASK.cancel()
    server.GOAL_RUN_TASK = None
    orchestrator.PENDING.clear()


async def _poll(predicate, *, attempts: int = 100, delay: float = 0.2):
    """Poll `predicate()` until truthy, sleeping `delay`s between tries. Returns the last value."""
    value = predicate()
    for _ in range(attempts):
        if value:
            return value
        await asyncio.sleep(delay)
        value = predicate()
    return value


async def _fast_single_gate_loop(goal, execute, emit=None, shadow_env=None, forged_dir=None):
    """Minimal `run_agent_loop` stand-in: stage one >=EUR250 claim (single ASK gate), no forging."""
    plan = PlanPayload(
        goal=goal,
        steps=[PlanStep(id=1, intent="Stage vendor credit claim", tool="upsert_row")],
        success_criteria=["claim staged"],
    )
    if emit:
        emit(EventType.PLAN_CREATED, plan.model_dump(), "Created 1-step plan.", 0.0)
    call = ToolCall(
        id="c1",
        name="upsert_row",
        args={
            "table": "claims",
            "pk_col": "id",
            "row": {
                "id": "CLM-D-1042",
                "supplier_id": "SUP-KAPPA",
                "delivery_id": "D-1042",
                "invoice_id": "INV-7781",
                "amount": 587.30,
                "reason": "overcharge+shortage+damaged+late",
                "status": "drafted",
            },
        },
    )
    r = await execute(call)
    assert r.ok
    return [call]


async def test_goal_endpoint_double_submit_cancels_prior_run(isolated_goal_server, monkeypatch):
    """A second /api/goal call must cancel the still-running prior run, not race it on REAL/LOG."""
    client, _ws, real, _log = isolated_goal_server
    monkeypatch.setattr(orchestrator, "run_agent_loop", _fast_single_gate_loop)
    domain = get_domain()
    goal = domain["default_goal"]

    r1 = client.post("/api/goal", json={"goal": goal, "anticipate_after": False})
    assert r1.status_code == 200
    run_id_1 = r1.json()["run_id"]
    task_1 = server.GOAL_RUN_TASK
    assert task_1 is not None

    r2 = client.post("/api/goal", json={"goal": goal, "anticipate_after": False})
    assert r2.status_code == 200
    run_id_2 = r2.json()["run_id"]
    task_2 = server.GOAL_RUN_TASK

    assert run_id_1 != run_id_2
    assert task_2 is not task_1

    cancelled = await _poll(lambda: task_1.cancelled())
    assert cancelled, "prior /api/goal run must be cancelled, not left racing REAL/LOG"

    pa = await _poll(lambda: client.get("/api/state").json()["pending_approval"])
    assert pa is not None, "surviving run never reached its approval gate"
    assert len(orchestrator.PENDING) == 1, "only the surviving run should hold a pending approval"

    client.post(f"/api/approve/{pa['req_id']}", json={"approved": True})

    def _claim_rows():
        with sqlite3.connect(real.db_path) as conn:
            return conn.execute("SELECT amount, status FROM claims WHERE id = 'CLM-D-1042'").fetchall()

    rows = await _poll(_claim_rows)
    assert rows == [(587.30, "drafted")], "the cancelled run must not have written a duplicate/partial claim"
