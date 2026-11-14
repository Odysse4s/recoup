import type { ForgeTestPayload } from "../contracts";
import type { LiveWin } from "./types";

const sqlVal = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export function forgeWindow(ft: ForgeTestPayload, latencyMs?: number): LiveWin {
  return {
    latencyMs,
    id: `forge-${ft.name}-${ft.attempt}-${Date.now()}`,
    kind: "forge",
    title: "Forge TDD Compiler",
    path: `forged_tools/${ft.name}.py`,
    liveLabel: "RUNNING SANDBOX AST…",
    doneLabel: ft.registered ? "REGISTERED" : "REJECTED",
    code: ft.code,
    lang: "python",
    assertions: [
      { label: "AST static guard", ok: ft.ast_passed },
      ...ft.test_results.map((r) => ({ label: `unit test #${r.index + 1}`, ok: r.passed })),
    ],
    target: "vault",
    origin: "stage:forge",
    pinned: false,
    toolName: ft.registered ? ft.name : undefined,
    telemetry: {
      facts: [
        `AST security check: ${ft.ast_errors.length} violation${ft.ast_errors.length === 1 ? "" : "s"}`,
        "subprocess python -I",
        "RLIMIT_CPU 2s · FSIZE 1MB",
        `unit tests ${ft.test_results.filter((r) => r.passed).length}/${ft.test_results.length}`,
      ],
      steps: [
        "parse AST",
        "guard imports & dunders",
        "spawn python -I",
        `run ${ft.test_results.length} unit tests`,
        ft.registered ? "register in vault" : "reject & repair",
      ],
    },
  };
}

export function toolWindow(
  call: { id?: string; name?: string; args?: Record<string, unknown> },
  latencyMs?: number
): LiveWin {
  const name = call.name ?? "tool";
  const a = call.args ?? {};
  const id = `${name}-${call.id ?? ""}-${Date.now()}`;
  const base = { id, pinned: false, origin: "stage:rehearse", latencyMs, callId: call.id } as const;
  const bytes = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v ?? "")).length;

  if (name === "read_file") {
    const path = String(a.path ?? "document.md");
    return {
      ...base,
      kind: "editor",
      title: "Evidence Reader",
      path: `rehearsal://${path}`,
      liveLabel: "READING EVIDENCE…",
      doneLabel: "PARSED",
      code: `# Inspecting workspace evidence\npath: ${path}\nmode: read-only rehearsal clone`,
      lang: "markdown",
      assertions: [
        { label: "isolated clone", ok: true },
        { label: "read-only access", ok: true },
      ],
      target: "db",
      telemetry: {
        facts: ["rehearsal fs", "read-only", path],
        steps: ["open rehearsal clone", "read UTF-8", "extract facts"],
      },
    };
  }

  if (name === "write_file" || name === "patch_file") {
    const path = String(a.path ?? "untitled");
    const code =
      name === "write_file"
        ? String(a.content ?? "")
        : `- ${String(a.target ?? "").split("\n").join("\n- ")}\n+ ${String(a.replacement ?? "").split("\n").join("\n+ ")}`;
    return {
      ...base,
      kind: "editor",
      title: "Staged File Editor",
      path: `staged://${path}`,
      liveLabel: "STAGING FILE…",
      doneLabel: "STAGED FOR REVIEW",
      code,
      lang: name === "patch_file" ? "diff" : path.endsWith(".py") ? "python" : "markdown",
      assertions: [
        { label: "rehearsal fs write", ok: true },
        { label: "unified diff", ok: true },
        { label: "pre-image receipt", ok: true },
      ],
      target: "diff",
      telemetry: {
        facts: [`${bytes(code)} bytes`, `${code.split("\n").length} lines`, "rehearsal copy only", "pre-image receipt"],
        steps: ["open rehearsal fs", "write bytes", "compute unified diff", "store receipt"],
      },
    };
  }

  if (name === "upsert_row" || name === "delete_rows" || name === "query_db") {
    const table = String(a.table ?? "ledger");
    let sql = "";
    if (name === "query_db") sql = String(a.sql ?? "SELECT 1;");
    else if (name === "upsert_row") {
      const row = (a.row ?? {}) as Record<string, unknown>;
      const cols = Object.keys(row);
      const pk = String(a.pk_col ?? "id");
      const updateCols = cols.filter((c) => c !== pk);
      sql =
        `INSERT INTO ${table} (${cols.join(", ")})\n` +
        `VALUES (${cols.map((c) => sqlVal(row[c])).join(", ")})\n` +
        (updateCols.length
          ? `ON CONFLICT(${pk}) DO UPDATE SET\n` + updateCols.map((c) => `  ${c} = excluded.${c}`).join(",\n") + ";"
          : ";");
    } else {
      sql = `DELETE FROM ${table}\nWHERE ${String(a.where_col ?? "id")} = ${sqlVal(a.where_val)};`;
    }
    return {
      ...base,
      kind: "sqlite",
      title: "SQLite Rehearsal Inspector",
      path: `rehearsal.db › ${table}`,
      liveLabel: "EXECUTING ON REHEARSAL DB…",
      doneLabel: name === "query_db" ? "ROWS FETCHED" : "ROWS STAGED",
      code: sql,
      lang: "sql",
      assertions: [
        { label: "online backup clone", ok: true },
        { label: "statement prepared", ok: true },
        { label: "pre-image captured", ok: name !== "query_db" },
      ],
      target: "db",
      telemetry: {
        facts:
          name === "upsert_row"
            ? [
                `table ${table}`,
                `${String(a.pk_col ?? "id")} = ${sqlVal(((a.row ?? {}) as Record<string, unknown>)[String(a.pk_col ?? "id")])}`,
                `${Object.keys((a.row ?? {}) as object).length} cols staged`,
                "pre-image receipt",
              ]
            : name === "delete_rows"
            ? [`table ${table}`, `WHERE ${String(a.where_col ?? "id")}`, "rows snapshotted", "pre-image receipt"]
            : ["read-only SELECT", "rehearsal.db"],
        steps:
          name === "query_db"
            ? ["online-backup rehearsal.db", "prepare SELECT", "fetch rows"]
            : ["online-backup rehearsal.db", "SELECT pre-image", "write in rehearsal txn", "diff rows vs live", "hold for Risk Gate"],
      },
    };
  }

  const external = name === "send_email" || name === "place_call" || name === "trigger_webhook";
  const argLines = Object.entries(a).map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return {
    ...base,
    kind: "exec",
    title: external ? "Outbox Interceptor" : "Rehearsal Exec Console",
    path: `${name}()`,
    liveLabel: external ? "INTERCEPTING SIDE-EFFECT…" : "EXECUTING IN SANDBOX…",
    doneLabel: external ? "HELD IN DRY-RUN OUTBOX" : "VERIFIED OUTPUT",
    code: [`$ recoup exec --rehearse --tool ${name}`, ...argLines, external ? "→ dry_run_external = true" : "→ ok"].join("\n"),
    lang: "shell",
    assertions: external
      ? [
          { label: "external call intercepted", ok: true },
          { label: "queued for risk gate", ok: true },
        ]
      : [
          { label: "rlimit sandbox", ok: true },
          { label: "pure output", ok: true },
        ],
    target: "diff",
    telemetry: external
      ? {
          facts: ["dry_run_external = true", `payload ${bytes(a)}B`, "irreversible · Risk Gate"],
          steps: ["intercept side-effect", "serialize payload", "hold in dry-run outbox", "queue for Risk Gate"],
        }
      : {
          facts: ["synthesized pure tool", "subprocess python -I", "RLIMIT_CPU 2s · FSIZE 1MB"],
          steps: ["validate args", "spawn python -I", "capture JSON output", "record trace"],
        },
  };
}

export function fileWindow(path: string, content: string): LiveWin {
  return {
    id: `file-${path}-${Date.now()}`,
    kind: "editor",
    title: "Workspace File Viewer",
    path: `workspace/${path}`,
    liveLabel: "OPENING…",
    doneLabel: "VERIFIED ARTIFACT",
    code: content,
    lang: path.endsWith(".py") ? "python" : path.endsWith(".sql") ? "sql" : "markdown",
    assertions: [{ label: "live workspace artifact", ok: true }],
    telemetry: {
      facts: ["live workspace", `${content.split("\n").length} lines`, "read-only view"],
      steps: ["resolve path", "read UTF-8", "render"],
    },
    target: "db",
    origin: "anchor:files",
    pinned: false,
    manual: true,
  };
}

/** Pinned inspector for a full unified diff from Staged Changes. */
export function diffWindow(path: string, diff: string, created: boolean): LiveWin {
  const lines = diff.split("\n");
  const adds = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const dels = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return {
    id: `diff-${path}-${Date.now()}`,
    kind: "editor",
    title: "Staged Diff Inspector",
    path: `staged://${path}`,
    liveLabel: "OPENING…",
    doneLabel: created ? "NEW FILE · STAGED" : "MODIFIED · STAGED",
    code: diff,
    lang: "diff",
    assertions: [
      { label: `+${adds} / −${dels} lines`, ok: true },
      { label: "pre-image receipt", ok: true },
    ],
    telemetry: {
      facts: [`rehearsal vs live`, `+${adds} −${dels}`, created ? "new file" : "modified file", "awaiting commit"],
      steps: ["clone rehearsal ws", "apply tool calls", "unified diff", "stage for Risk Gate"],
    },
    target: "diff",
    origin: `diff:${path}`,
    pinned: true,
    manual: true,
    instant: true,
  };
}

const mimeHeader = (v: unknown) => String(v ?? "").replace(/[\r\n]+/g, " ");

/** Pinned inspector showing the exact payload the Risk Gate intercepted in the dry-run outbox. */
export function outboxWindow(item: Record<string, unknown>, index: number): LiveWin {
  const tool = String(
    item.tool ?? (item.to !== undefined ? "send_email" : item.phone !== undefined || item.counterparty !== undefined ? "place_call" : "trigger_webhook")
  );
  const isMail = tool === "send_email";
  const isCall = tool === "place_call";
  const json = JSON.stringify(item, null, 2);
  const code = isMail
    ? [
        "# Intercepted MIME message (dry_run_external = true)",
        "From: recoup-agent@rehearsal.local",
        `To: ${mimeHeader(item.to)}`,
        `Subject: ${mimeHeader(item.subject)}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "X-Recoup-Risk-Gate: held",
        "",
        String(item.body ?? ""),
        "",
        "# Raw outbox payload",
        json,
      ].join("\n")
    : isCall
    ? [
        "# Intercepted voice settlement call (dry_run_external = true)",
        `Counterparty: ${mimeHeader(item.counterparty)}`,
        `Phone: ${mimeHeader(item.phone)}`,
        `Objective: ${mimeHeader(item.objective)}`,
        "X-Recoup-Risk-Gate: held",
        "",
        "# Raw outbox payload",
        json,
      ].join("\n")
    : [
        "# Intercepted webhook request (dry_run_external = true)",
        `POST ${String(item.endpoint ?? "")}`,
        "Content-Type: application/json",
        `X-Recoup-Event: ${mimeHeader(item.event)}`,
        "X-Recoup-Risk-Gate: held",
        "",
        JSON.stringify(item.payload ?? {}, null, 2),
        "",
        "# Raw outbox payload",
        json,
      ].join("\n");
  return {
    id: `outbox-${index}-${Date.now()}`,
    kind: "exec",
    title: "Outbox Payload Inspector",
    path: isMail
      ? `send_email → ${String(item.to ?? "")}`
      : isCall
      ? `place_call → ${String(item.counterparty ?? item.phone ?? "")}`
      : `trigger_webhook → ${String(item.endpoint ?? "")}`,
    liveLabel: "OPENING…",
    doneLabel: "HELD BY RISK GATE",
    code,
    lang: "text",
    assertions: [
      { label: "external call intercepted", ok: true },
      { label: "irreversible · needs approval", ok: true },
    ],
    telemetry: {
      facts: ["dry_run_external = true", `payload ${new TextEncoder().encode(json).length}B`, "not dispatched"],
      steps: ["intercept side-effect", "serialize payload", "hold in dry-run outbox", "await approval"],
    },
    target: "diff",
    origin: `outbox:${index}`,
    pinned: true,
    manual: true,
    instant: true,
  };
}
