"""Tool contract: preview / do / undo with pre-image receipts for deterministic rollback."""
from __future__ import annotations

import contextlib
import difflib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, ClassVar, Literal

from .env import Env, is_db_file

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _ident(name: str) -> str:
    if not _IDENT_RE.match(name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    return name


def _resolve_safe_path(env: Env, raw_path: str) -> tuple[Path, str]:
    rel = str(raw_path).strip().replace("\\", "/")
    if not rel or rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        raise ValueError(f"Unsafe workspace path: {raw_path!r}")
    parts = [p for p in rel.split("/") if p]
    if any(p in (".git", ".env", "..") or p.startswith(".env") for p in parts):
        raise ValueError(f"Protected path blocked: {raw_path!r}")
    root = env.root_dir.resolve()
    target = (root / rel).resolve()
    try:
        norm_rel = target.relative_to(root).as_posix()
    except ValueError as exc:
        raise ValueError(f"Path escapes workspace: {raw_path!r}") from exc
    if is_db_file(target, env.db_path):
        raise ValueError(f"Direct access to SQLite file blocked: {raw_path!r}")
    return target, norm_rel


class Tool:
    name: ClassVar[str]
    description: ClassVar[str]
    params_schema: ClassVar[dict[str, Any]]
    risk: ClassVar[Literal["low", "high"]] = "low"
    reversible: ClassVar[bool] = True
    mutating: ClassVar[bool] = True
    source: ClassVar[Literal["builtin", "forged", "mcp"]] = "builtin"

    def __init__(self) -> None:
        self.uses = 0

    def preview(self, args: dict[str, Any], env: Env) -> str:
        return f"{self.name}({args})"

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        raise NotImplementedError

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        if self.reversible:
            raise NotImplementedError

    def spec(self) -> dict[str, Any]:
        """Tool specification passed to native function calling."""
        return {"name": self.name, "description": self.description, "input_schema": self.params_schema}


def unified_diff(old: str, new: str, path: str) -> str:
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True), new.splitlines(keepends=True), f"a/{path}", f"b/{path}"
        )
    )


class ReadFile(Tool):
    name = "read_file"
    description = "Read a UTF-8 text file from the workspace."
    params_schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}
    mutating = False

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        p, _ = _resolve_safe_path(env, args["path"])
        return {"content": p.read_text(encoding="utf-8")}

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        return None


class WriteFile(Tool):
    name = "write_file"
    description = "Create or overwrite a UTF-8 text file in the workspace."
    params_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
    }

    def preview(self, args: dict[str, Any], env: Env) -> str:
        p, norm = _resolve_safe_path(env, args["path"])
        old = p.read_text(encoding="utf-8") if p.exists() else ""
        return unified_diff(old, args["content"], norm)

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        p, norm = _resolve_safe_path(env, args["path"])
        old = p.read_text(encoding="utf-8") if p.exists() else None
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(args["content"], encoding="utf-8")
        return {"path": norm, "old_content": old}

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        p, _ = _resolve_safe_path(env, receipt["path"])
        root = env.root_dir.resolve()
        if receipt["old_content"] is None:
            p.unlink(missing_ok=True)
            parent = p.parent
            while parent != root and parent.exists():
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
        else:
            p.write_text(receipt["old_content"], encoding="utf-8")


class PatchFile(Tool):
    """Surgical search-and-replace inside an existing UTF-8 file (fully reversible)."""

    name = "patch_file"
    description = "Replace an exact target snippet inside an existing workspace text file."
    params_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "target": {"type": "string"},
            "replacement": {"type": "string"},
        },
        "required": ["path", "target", "replacement"],
    }

    def preview(self, args: dict[str, Any], env: Env) -> str:
        p, norm = _resolve_safe_path(env, args["path"])
        old = p.read_text(encoding="utf-8") if p.exists() else ""
        new = old.replace(args["target"], args["replacement"], 1)
        return unified_diff(old, new, norm)

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        p, norm = _resolve_safe_path(env, args["path"])
        old = p.read_text(encoding="utf-8")
        if args["target"] not in old:
            raise ValueError(f"target snippet not found in {norm}")
        new = old.replace(args["target"], args["replacement"], 1)
        p.write_text(new, encoding="utf-8")
        return {"path": norm, "old_content": old}

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        p, _ = _resolve_safe_path(env, receipt["path"])
        p.write_text(receipt["old_content"], encoding="utf-8")


class QueryDB(Tool):
    """Read-only SQLite SELECT query tool."""

    name = "query_db"
    description = "Execute a read-only SELECT query against the workspace SQLite database."
    params_schema = {
        "type": "object",
        "properties": {
            "sql": {"type": "string", "description": "SELECT statement"},
            "params": {"type": "array", "items": {}, "default": []},
        },
        "required": ["sql"],
    }
    mutating = False

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        sql = str(args["sql"]).strip()
        if not sql.upper().startswith("SELECT"):
            raise ValueError("query_db only permits SELECT queries")
        params = args.get("params") or []
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        return {"rows": rows, "count": len(rows)}

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        return None


class UpsertRow(Tool):
    """Reversible SQLite row insert/update with pre-image receipt."""

    name = "upsert_row"
    description = "Insert or update a row in a SQLite table by primary key column."
    params_schema = {
        "type": "object",
        "properties": {
            "table": {"type": "string"},
            "pk_col": {"type": "string"},
            "row": {"type": "object"},
        },
        "required": ["table", "pk_col", "row"],
    }

    def _fetch(self, conn: sqlite3.Connection, table: str, pk_col: str, pk_val: Any) -> dict[str, Any] | None:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(f"SELECT * FROM {_ident(table)} WHERE {_ident(pk_col)} = ?", (pk_val,))
        rows = cur.fetchall()
        if len(rows) > 1:
            raise ValueError(f"Column '{pk_col}' matched multiple rows in `{table}`; specify a unique key")
        return dict(rows[0]) if rows else None

    def preview(self, args: dict[str, Any], env: Env) -> str:
        table, pk_col, row = _ident(args["table"]), _ident(args["pk_col"]), args["row"]
        if pk_col not in row:
            raise ValueError(f"Primary key '{pk_col}' missing from row payload")
        pk_val = row[pk_col]
        old: dict[str, Any] | None = None
        if env.db_path.exists():
            with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
                try:
                    old = self._fetch(conn, table, pk_col, pk_val)
                except sqlite3.OperationalError:
                    old = None
        old_s = json.dumps(old, indent=2, sort_keys=True) + "\n" if old else ""
        new_s = json.dumps({**(old or {}), **row}, indent=2, sort_keys=True) + "\n"
        return unified_diff(old_s, new_s, f"db/{table}/{pk_val}.json")

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        table, pk_col, row = _ident(args["table"]), _ident(args["pk_col"]), dict(args["row"])
        if pk_col not in row:
            raise ValueError(f"Primary key '{pk_col}' missing from row payload")
        cols = [_ident(k) for k in row]
        pk_val = row[pk_col]
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            old = self._fetch(conn, table, pk_col, pk_val)
            if old is None:
                conn.execute(
                    f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                    [row[k] for k in cols],
                )
            else:
                # UPDATE in place (not INSERT OR REPLACE) so the rowid survives for TEXT primary keys.
                self._update(conn, table, pk_col, pk_val, row)
            conn.commit()
        return {"table": table, "pk_col": pk_col, "pk_val": pk_val, "old_row": old, "cols": cols}

    @staticmethod
    def _update(
        conn: sqlite3.Connection, table: str, pk_col: str, pk_val: Any, values: dict[str, Any]
    ) -> None:
        set_cols = [_ident(k) for k in values if k != pk_col]
        if not set_cols:
            return
        conn.execute(
            f"UPDATE {table} SET {', '.join(f'{c} = ?' for c in set_cols)} WHERE {pk_col} = ?",
            [*(values[c] for c in set_cols), pk_val],
        )

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        table, pk_col, pk_val, old = (
            _ident(receipt["table"]),
            _ident(receipt["pk_col"]),
            receipt["pk_val"],
            receipt["old_row"],
        )
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            if old is None:
                conn.execute(f"DELETE FROM {table} WHERE {pk_col} = ?", (pk_val,))
            else:
                self._update(conn, table, pk_col, pk_val, old)
            conn.commit()


class DeleteRows(Tool):
    """Reversible SQLite row deletion — snapshots matching rows and rowids into receipt before deleting."""

    name = "delete_rows"
    description = "Delete rows from a SQLite table matching a column value (reversible via snapshot)."
    params_schema = {
        "type": "object",
        "properties": {
            "table": {"type": "string"},
            "where_col": {"type": "string"},
            "where_val": {},
        },
        "required": ["table", "where_col", "where_val"],
    }

    def preview(self, args: dict[str, Any], env: Env) -> str:
        table, col, val = _ident(args["table"]), _ident(args["where_col"]), args["where_val"]
        if not env.db_path.exists():
            return f"DELETE FROM {table} WHERE {col}={val!r} (0 rows)"
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE {col} = ?", (val,)).fetchall()]
        old_s = json.dumps(rows, indent=2, sort_keys=True) + "\n" if rows else ""
        return unified_diff(old_s, "", f"db/{table}/{col}={val}.json")

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        table, col, val = _ident(args["table"]), _ident(args["where_col"]), args["where_val"]
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = [
                dict(r)
                for r in conn.execute(
                    f"SELECT rowid AS _recoup_rowid, * FROM {table} WHERE {col} = ?", (val,)
                ).fetchall()
            ]
            conn.execute(f"DELETE FROM {table} WHERE {col} = ?", (val,))
            conn.commit()
        return {"table": table, "deleted_rows": rows}

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        table = _ident(receipt["table"])
        rows: list[dict[str, Any]] = receipt.get("deleted_rows", [])
        if not rows:
            return
        has_rowid = "_recoup_rowid" in rows[0]
        cols = [_ident(k) for k in rows[0] if k != "_recoup_rowid"]
        if has_rowid and "rowid" not in cols:
            insert_cols = ["rowid", *cols]
            placeholders = ", ".join("?" for _ in insert_cols)
            values = [[r["_recoup_rowid"], *(r[k] for k in cols)] for r in rows]
        else:
            insert_cols = cols
            placeholders = ", ".join("?" for _ in insert_cols)
            values = [[r[k] for k in cols] for r in rows]
        with contextlib.closing(sqlite3.connect(env.db_path)) as conn:
            conn.executemany(
                f"INSERT OR REPLACE INTO {table} ({', '.join(insert_cols)}) VALUES ({placeholders})",
                values,
            )
            conn.commit()


class TriggerWebhook(Tool):
    """Outbound REST/ERP webhook call — held in dry-run outbox during isolated rehearsal."""

    name = "trigger_webhook"
    description = "POST a JSON payload to an external REST webhook, messaging channel, or ERP endpoint."
    params_schema = {
        "type": "object",
        "properties": {
            "endpoint": {"type": "string"},
            "event": {"type": "string"},
            "payload": {"type": "object"},
        },
        "required": ["endpoint", "event", "payload"],
    }
    risk = "high"
    reversible = False

    def preview(self, args: dict[str, Any], env: Env) -> str:
        endpoint = args.get("endpoint", "")
        event = args.get("event", "")
        payload = args.get("payload", {})
        return f"WEBHOOK POST {endpoint} event={event!r} payload={json.dumps(payload)}"

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        env.outbox.append({"tool": self.name, **args})
        return {"dispatched": not env.dry_run_external, "endpoint": args.get("endpoint", "")}


class SendEmail(Tool):
    """Outbound email dispatch — irreversible external communication held in outbox during rehearsal."""

    name = "send_email"
    description = "Send an outbound email to a vendor or stakeholder."
    params_schema = {
        "type": "object",
        "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
        "required": ["to", "subject", "body"],
    }
    risk = "high"
    reversible = False

    def preview(self, args: dict[str, Any], env: Env) -> str:
        return f"EMAIL to={args.get('to', '')} subject={args.get('subject', '')!r}"

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        env.outbox.append({"tool": self.name, **args})
        return {"sent": not env.dry_run_external}


class PlaceCall(Tool):
    """Outbound voice negotiation call — irreversible external action held in outbox during rehearsal."""

    name = "place_call"
    description = "Place an outbound voice call to a vendor AR desk to negotiate a credit settlement."
    params_schema = {
        "type": "object",
        "properties": {
            "to": {"type": "string"},
            "counterparty": {"type": "string"},
            "claim_id": {"type": "string"},
            "claim_amount": {"type": "number"},
            "objective": {"type": "string"},
            "purpose": {"type": "string"},
        },
        "required": ["to"],
    }
    risk = "high"
    reversible = False
    mutating = True

    def preview(self, args: dict[str, Any], env: Env) -> str:
        target = args.get("counterparty") or args.get("to", "")
        claim_id = args.get("claim_id", "")
        objective = args.get("objective") or args.get("purpose", "")
        claim_part = f" claim_id={claim_id}" if claim_id else ""
        return f"VOICE CALL to={target}{claim_part} objective={objective!r}"

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        to_target = str(args.get("to") or args.get("phone") or args.get("counterparty") or "")
        claim_id = str(args.get("claim_id") or "")
        objective = str(args.get("objective") or args.get("purpose") or "")
        env.outbox.append(
            {
                "tool": self.name,
                **args,
                "to": to_target,
                "claim_id": claim_id,
                "objective": objective,
            }
        )
        return {
            "placed": not env.dry_run_external,
            "to": to_target,
            "claim_id": claim_id,
            "objective": objective,
        }


REGISTRY: dict[str, Tool] = {
    t.name: t
    for t in (
        ReadFile(),
        WriteFile(),
        PatchFile(),
        QueryDB(),
        UpsertRow(),
        DeleteRows(),
        TriggerWebhook(),
        SendEmail(),
        PlaceCall(),
    )
}
