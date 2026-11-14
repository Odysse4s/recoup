"""Deterministic risk gate enforcing enterprise governance rules without LLM judgment."""
from __future__ import annotations

from ..contracts import ChangeReport, RiskDecision, ToolCall
from ..domain_config import get_domain
from .tools import Tool

BLOCKLIST: set[str] = set()
PROTECTED_PREFIXES = (".git", ".env", "..", "/")
DEFAULT_BLOCKED_TABLES = {"audit_log", "schema_migrations", "users_auth"}
DEFAULT_CRITICAL_STATUSES = {"written_off", "terminated", "deleted"}
DEFAULT_EXTERNAL_TOOLS = {"send_email", "place_call", "trigger_webhook"}


def assess_risk(call: ToolCall, tool: Tool, report: ChangeReport) -> tuple[RiskDecision, str]:
    rules = get_domain().get("risk_rules", {})
    raw_path = str(call.args.get("path", "")).strip()
    if (
        call.name in BLOCKLIST
        or raw_path.startswith(PROTECTED_PREFIXES)
        or ".." in raw_path.replace("\\", "/").split("/")
        or (len(raw_path) > 1 and raw_path[1] == ":")
    ):
        return RiskDecision.BLOCK, "blocklisted tool or protected path"

    blocked_tables = set(rules.get("blocked_tables", DEFAULT_BLOCKED_TABLES))
    table = str(call.args.get("table", ""))
    if table and table in blocked_tables:
        return RiskDecision.BLOCK, f"blocked table `{table}`"

    external_tools = set(rules.get("external_tools", DEFAULT_EXTERNAL_TOOLS))
    if call.name in external_tools or not tool.reversible:
        return RiskDecision.ASK, f"external or irreversible action (`{call.name}`)"

    if tool.source == "forged" and tool.uses == 0 and tool.mutating:
        return RiskDecision.ASK, "first run of a synthesized tool"

    max_deleted = int(rules.get("max_auto_deleted_rows", rules.get("max_deleted_rows", 0)))
    if report.db_max_deleted > max_deleted:
        return RiskDecision.ASK, f"deletes {report.db_max_deleted} rows"
    if call.name == "delete_rows" and max_deleted == 0:
        return RiskDecision.ASK, "row deletion requires manager approval"

    max_ext = int(rules.get("max_external_calls", 5))
    if len(report.external_outbox) > max_ext:
        return RiskDecision.ASK, "multiple external side effects queued"

    if call.name == "upsert_row":
        row = call.args.get("row") or {}
        money_table = str(rules.get("money_table", "claims"))
        money_col = str(rules.get("money_column", "amount"))
        threshold = float(rules.get("approval_threshold_eur", 250.0))
        if (not money_table or table == money_table) and isinstance(row.get(money_col), (int, float)):
            val = float(row[money_col])
            if val >= threshold:
                return (
                    RiskDecision.ASK,
                    f"{table}.{money_col} EUR {val:.2f} >= EUR {threshold:.2f} policy threshold",
                )

        crit_statuses = {str(s).lower() for s in rules.get("critical_statuses", DEFAULT_CRITICAL_STATUSES)}
        status = str(row.get("status", "")).lower()
        if status and status in crit_statuses:
            return RiskDecision.ASK, f"critical status `{status}`"

    if tool.risk == "high":
        return RiskDecision.ASK, "tool marked high risk"
    return RiskDecision.AUTO, "low risk, reversible"
