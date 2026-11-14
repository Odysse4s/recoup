"""Isolated workspace & SQLite environment abstraction for staged rehearsal and live execution."""
from __future__ import annotations

import contextlib
import hashlib
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DB_SUFFIXES = (".db", ".sqlite", ".sqlite3", "-wal", "-shm", "-journal")


def is_db_file(path: Path, db_path: Path) -> bool:
    if path.resolve() == db_path.resolve():
        return True
    name = path.name.lower()
    return any(name.endswith(s) for s in DB_SUFFIXES)


@dataclass
class Env:
    root_dir: Path
    db_path: Path
    dry_run_external: bool = False
    outbox: list[dict[str, Any]] = field(default_factory=list)
    _tmp_dir: Path | None = None

    @property
    def is_rehearsal(self) -> bool:
        return self.dry_run_external

    @property
    def is_shadow(self) -> bool:
        return self.dry_run_external

    def cleanup(self) -> None:
        if self._tmp_dir is not None:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None


def make_rehearsal_env(real: Env) -> Env:
    """Clone workspace files and SQLite database (via online backup API) into an isolated temp directory."""
    tmp = Path(tempfile.mkdtemp(prefix="rehearsal_"))
    ws = tmp / "ws"
    if real.root_dir.exists():
        shutil.copytree(
            real.root_dir,
            ws,
            ignore=shutil.ignore_patterns("*.db", "*.sqlite", "*.sqlite3", "*-wal", "*-shm", "*-journal"),
        )
    else:
        ws.mkdir(parents=True)
    staged_db = tmp / "rehearsal.db"
    if real.db_path.exists():
        with (
            contextlib.closing(sqlite3.connect(real.db_path)) as src,
            contextlib.closing(sqlite3.connect(staged_db)) as dst,
        ):
            src.backup(dst)
    return Env(root_dir=ws, db_path=staged_db, dry_run_external=True, outbox=[], _tmp_dir=tmp)


make_shadow = make_rehearsal_env


def fingerprint_env(env: Env) -> str:
    """Deterministic SHA-256 hash of workspace files and SQLite dump for concurrency checks and undo verification."""
    h = hashlib.sha256()
    if env.root_dir.exists():
        for p in sorted(env.root_dir.rglob("*")):
            if p.is_file() and not is_db_file(p, env.db_path):
                h.update(p.relative_to(env.root_dir).as_posix().encode())
                h.update(p.read_bytes())
    if env.db_path.exists():
        with contextlib.closing(sqlite3.connect(env.db_path)) as c:
            for line in c.iterdump():
                h.update(line.encode())
    return h.hexdigest()


def _db_snapshot(db_path: Path) -> dict[str, dict[Any, dict[str, Any]]]:
    """Snapshot every user table keyed by primary key (when present) or rowid for row-level diffing."""
    if not db_path.exists():
        return {}
    out: dict[str, dict[Any, dict[str, Any]]] = {}
    with contextlib.closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        ]
        for t in tables:
            pk_info = conn.execute(f'PRAGMA table_info("{t}")').fetchall()
            pk_cols = [r["name"] for r in sorted((r for r in pk_info if r["pk"] > 0), key=lambda r: r["pk"])]
            if pk_cols:
                rows = conn.execute(f'SELECT * FROM "{t}"').fetchall()
                out[t] = {
                    (r[pk_cols[0]] if len(pk_cols) == 1 else tuple(r[c] for c in pk_cols)): dict(r)
                    for r in rows
                }
                continue
            try:
                rows = conn.execute(f'SELECT rowid AS _rid, * FROM "{t}"').fetchall()
                out[t] = {r["_rid"]: {k: r[k] for k in r.keys() if k != "_rid"} for r in rows}  # noqa: SIM118
            except sqlite3.OperationalError:
                rows = conn.execute(f'SELECT * FROM "{t}"').fetchall()
                out[t] = {i: dict(r) for i, r in enumerate(rows)}
    return out


def diff_databases(real_db: Path, staged_db: Path) -> tuple[dict[str, dict[str, int]], int]:
    """Compare live SQLite database against rehearsed copy and return (db_summary, db_max_deleted)."""
    before = _db_snapshot(real_db)
    after = _db_snapshot(staged_db)
    summary: dict[str, dict[str, int]] = {}
    max_deleted = 0
    for table in sorted(set(before) | set(after)):
        b_rows = before.get(table, {})
        a_rows = after.get(table, {})
        inserted = len(set(a_rows) - set(b_rows))
        deleted = len(set(b_rows) - set(a_rows))
        updated = sum(1 for k in (set(a_rows) & set(b_rows)) if a_rows[k] != b_rows[k])
        if inserted or updated or deleted:
            summary[table] = {"inserted": inserted, "updated": updated, "deleted": deleted}
        max_deleted = max(max_deleted, deleted)
    return summary, max_deleted
