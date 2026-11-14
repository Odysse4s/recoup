import sqlite3

import pytest

from app.engine.env import Env, diff_databases, fingerprint_env, make_rehearsal_env, make_shadow
from app.engine.seed import populate_default_seed
from app.engine.tools import REGISTRY, DeleteRows, PatchFile, QueryDB, UpsertRow, WriteFile
from app.engine.undo import UndoLog


@pytest.fixture
def env(tmp_path):
    ws = tmp_path / "ws"
    populate_default_seed(ws)
    return Env(root_dir=ws, db_path=ws / "app.db")


SAMPLE_CALLS = [
    (WriteFile(), {"path": "claims/CLM-D-1042.md", "content": "# Vendor Credit Claim CLM-D-1042\nEUR 587.30\n"}),
    (
        WriteFile(),
        {"path": "inbox/D-1042_receiving_note.md", "content": "# Updated Receiving Note\nVerified 98 units.\n"},
    ),
    (
        PatchFile(),
        {
            "path": "inbox/D-1042_receiving_note.md",
            "target": "104 units delivered",
            "replacement": "104 units counted (98 accepted)",
        },
    ),
    (
        UpsertRow(),
        {
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
        },
    ),
    (
        UpsertRow(),
        {"table": "invoices", "pk_col": "id", "row": {"id": "INV-7781", "status": "disputed"}},
    ),
    (
        DeleteRows(),
        {"table": "invoices", "where_col": "status", "where_val": "paid"},
    ),
]


@pytest.mark.parametrize("tool,args", SAMPLE_CALLS)
def test_do_undo_roundtrip(tool, args, env):
    before = fingerprint_env(env)
    receipt = tool.do(args, env)
    assert fingerprint_env(env) != before
    tool.undo(receipt, env)
    assert fingerprint_env(env) == before


def test_seed_populates_recoup_tables_and_files(env):
    assert (env.root_dir / "inbox/D-1042_receiving_note.md").exists()
    assert (env.root_dir / "contracts/kappa_foods_terms.md").exists()
    assert (env.root_dir / "policies/claims_policy.md").exists()

    out = QueryDB().do({"sql": "SELECT id, amount, status FROM invoices WHERE id = ?", "params": ["INV-7781"]}, env)
    assert out == {"rows": [{"id": "INV-7781", "amount": 2268.0, "status": "unpaid"}], "count": 1}


def test_rehearsal_env_is_isolated_and_diffs_cleanly(env):
    before = fingerprint_env(env)
    staged = make_rehearsal_env(env)
    assert make_shadow is make_rehearsal_env
    assert staged.is_rehearsal and staged.is_shadow

    WriteFile().do({"path": "claims/CLM-D-1042.md", "content": "credit memo"}, staged)
    UpsertRow().do(
        {
            "table": "claims",
            "pk_col": "id",
            "row": {
                "id": "CLM-D-1042",
                "supplier_id": "SUP-KAPPA",
                "delivery_id": "D-1042",
                "invoice_id": "INV-7781",
                "amount": 587.30,
                "reason": "audit",
                "status": "drafted",
            },
        },
        staged,
    )
    UpsertRow().do({"table": "invoices", "pk_col": "id", "row": {"id": "INV-7781", "status": "disputed"}}, staged)

    assert fingerprint_env(env) == before
    summary, max_del = diff_databases(env.db_path, staged.db_path)
    assert summary == {
        "claims": {"inserted": 1, "updated": 0, "deleted": 0},
        "invoices": {"inserted": 0, "updated": 1, "deleted": 0},
    }
    assert max_del == 0
    staged.cleanup()


def test_query_db_select_only(env):
    out = QueryDB().do({"sql": "SELECT name FROM suppliers WHERE id = ?", "params": ["SUP-KAPPA"]}, env)
    assert out == {"rows": [{"name": "Kappa Office Systems S.A."}], "count": 1}
    with pytest.raises(ValueError, match="SELECT"):
        QueryDB().do({"sql": "DELETE FROM invoices"}, env)


def test_upsert_text_primary_key_updates_in_place(env):
    """TEXT primary keys (e.g. invoices.id) must update in place so rowids and the SQLite dump survive undo."""
    before = fingerprint_env(env)
    with sqlite3.connect(env.db_path) as conn:
        orig_rowid = conn.execute("SELECT rowid FROM invoices WHERE id = 'INV-7781'").fetchone()[0]

    tool = UpsertRow()
    receipt = tool.do(
        {"table": "invoices", "pk_col": "id", "row": {"id": "INV-7781", "status": "disputed"}},
        env,
    )
    with sqlite3.connect(env.db_path) as conn:
        assert conn.execute("SELECT rowid, status FROM invoices WHERE id = 'INV-7781'").fetchone() == (
            orig_rowid,
            "disputed",
        )
    tool.undo(receipt, env)
    assert fingerprint_env(env) == before


def test_partial_undo_checkpoints(env):
    """UndoLog.undo_steps(k) rewinds to any intermediate checkpoint and records human summaries."""
    log = UndoLog()
    fp0 = fingerprint_env(env)

    a1 = {"table": "invoices", "pk_col": "id", "row": {"id": "INV-7781", "status": "disputed"}}
    r1 = UpsertRow().do(a1, env)
    log.record(1, "upsert_row", a1, r1)
    fp1 = fingerprint_env(env)

    a2 = {"path": "claims/CLM-D-1042.md", "content": "claim memo\nline 2"}
    r2 = WriteFile().do(a2, env)
    log.record(2, "write_file", a2, r2)
    fp2 = fingerprint_env(env)

    a3 = {"path": "claims/CLM-KAPPA-FOLLOWUP.md", "content": "follow-up audit"}
    r3 = WriteFile().do(a3, env)
    log.record(3, "write_file", a3, r3)

    assert len(log.entries) == 3
    assert "Updated invoices #INV-7781" in log.entries[0]["summary"]
    assert "Wrote claims/CLM-D-1042.md" in log.entries[1]["summary"]

    log.undo_steps(1, REGISTRY, env)
    assert len(log.entries) == 2
    assert fingerprint_env(env) == fp2

    log.undo_steps(1, REGISTRY, env)
    assert len(log.entries) == 1
    assert fingerprint_env(env) == fp1

    log.undo_steps(1, REGISTRY, env)
    assert len(log.entries) == 0
    assert fingerprint_env(env) == fp0


def test_delete_rows_text_pk_roundtrip_is_byte_identical(env):
    """Deleting and undoing a middle row on a TEXT PRIMARY KEY table must restore the exact rowid."""
    before = fingerprint_env(env)
    tool = DeleteRows()
    receipt = tool.do({"table": "deliveries", "where_col": "id", "where_val": "D-1031"}, env)
    assert fingerprint_env(env) != before
    tool.undo(receipt, env)
    assert fingerprint_env(env) == before
