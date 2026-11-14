"""Workspace file & SQLite seeder driven by `backend/app/domain_config.py`."""
from __future__ import annotations

import contextlib
import csv
import json
import sqlite3
from pathlib import Path

from ..domain_config import get_domain
from .tools import _ident


def ingest_file_to_sqlite(file_path: Path, table_name: str, db_path: Path) -> int:
    """Ingest a .csv or .json dataset file into a SQLite table."""
    safe_table = _ident(table_name)
    if file_path.suffix.lower() == ".json":
        rows = json.loads(file_path.read_text(encoding="utf-8"))
    else:
        with file_path.open(encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
    if not rows:
        return 0
    cols = [_ident(c) for c in rows[0]]
    col_defs = ", ".join(f"{c} TEXT" for c in cols)
    placeholders = ", ".join("?" for _ in cols)
    with contextlib.closing(sqlite3.connect(db_path)) as conn:
        conn.execute(f"CREATE TABLE IF NOT EXISTS {safe_table} ({col_defs})")
        conn.executemany(
            f"INSERT INTO {safe_table} ({', '.join(cols)}) VALUES ({placeholders})",
            [[r.get(c) for c in cols] for r in rows],
        )
        conn.commit()
    return len(rows)


def populate_default_seed(ws_dir: Path) -> None:
    """Populate the workspace files and SQLite ERP tables from the Recoup domain configuration."""
    domain = get_domain()
    ws_dir.mkdir(parents=True, exist_ok=True)

    for rel_path, content in domain.get("files", {}).items():
        fp = ws_dir / rel_path
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")

    db_path = ws_dir / "app.db"
    with contextlib.closing(sqlite3.connect(db_path)) as conn:
        existing_tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        ]
        for t in existing_tables:
            conn.execute(f'DROP TABLE IF EXISTS "{t}"')
        for ddl in domain.get("tables_sql", []):
            conn.execute(ddl)
        for table, rows in domain.get("seed_rows", {}).items():
            if not rows:
                continue
            safe_table = _ident(table)
            placeholders = ", ".join("?" for _ in rows[0])
            conn.executemany(f"INSERT INTO {safe_table} VALUES ({placeholders})", rows)
        conn.commit()
