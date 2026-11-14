"""Undo log with human-readable checkpoint summaries and partial LIFO rollback."""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .env import Env
from .tools import Tool


def _summarize_entry(tool: str, args: dict[str, Any]) -> str:
    if tool == "write_file":
        path = args.get("path", "file")
        lines = len(str(args.get("content", "")).splitlines())
        return f"Wrote {path} ({lines} ln)"
    if tool == "patch_file":
        return f"Patched {args.get('path', 'file')}"
    if tool == "upsert_row":
        table = args.get("table", "table")
        pk_col = str(args.get("pk_col", "id"))
        row = args.get("row") or {}
        pk_val = row.get(pk_col, "?") if isinstance(row, dict) else "?"
        cols = [k for k in (row.keys() if isinstance(row, dict) else []) if k != pk_col]
        col_str = f" ({', '.join(cols)})" if cols else ""
        return f"Updated {table} #{pk_val}{col_str}"
    if tool == "delete_rows":
        return f"Deleted from {args.get('table', 'table')} ({args.get('where_col')}={args.get('where_val')})"
    if tool == "send_email":
        return f"Sent email to {args.get('to', 'recipient')}"
    if tool == "place_call":
        return f"Placed call to {args.get('counterparty') or args.get('to', 'counterparty')}"
    if tool == "trigger_webhook":
        return f"Webhook {args.get('event', '')} -> {args.get('endpoint', '')}"
    return f"Executed {tool}"


class UndoLog:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.entries: list[dict[str, Any]] = []

    def _flush(self) -> None:
        if self.path:
            self.path.write_text(json.dumps(self.entries, indent=2), encoding="utf-8")

    def record(self, step: int, tool: str, args: dict, receipt: dict, summary: str | None = None) -> None:
        self.entries.append(
            {
                "step": step,
                "tool": tool,
                "args": args,
                "receipt": receipt,
                "summary": summary or _summarize_entry(tool, args),
                "ts": time.time(),
            }
        )
        self._flush()

    def undo_steps(
        self,
        count: int | None,
        registry: dict[str, Tool],
        env: Env,
        on_step: Callable[[dict], None] | None = None,
    ) -> list[str]:
        """Rewinds the last `count` entries (or all entries when count is None or <= 0)."""
        skipped: list[str] = []
        remaining = len(self.entries) if (count is None or count <= 0) else min(count, len(self.entries))
        while self.entries and remaining > 0:
            remaining -= 1
            e = self.entries[-1]
            tool = registry.get(e["tool"])
            if tool and tool.reversible:
                tool.undo(e["receipt"], env)
                self.entries.pop()
                if on_step:
                    on_step(e)
            else:
                self.entries.pop()
                skipped.append(e["tool"])
            self._flush()
        return skipped

    def undo_all(
        self, registry: dict[str, Tool], env: Env, on_step: Callable[[dict], None] | None = None
    ) -> list[str]:
        """Rewinds all reversible entries and returns names of irreversible steps that were skipped."""
        return self.undo_steps(None, registry, env, on_step=on_step)
