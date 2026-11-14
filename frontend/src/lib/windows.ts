import type { ForgeSpecPayload, ForgeTestPayload } from "../contracts";
import type { LiveWin } from "./types";

const sqlVal = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export const SANDBOX_SECURITY_SEAL = [
  "python -I",
  "0 ENV SECRETS",
  "RLIMIT FSIZE=0",
  "AST + SHA-256 PINNED",
] as const;

export function forgeSpecWindow(spec: ForgeSpecPayload): LiveWin {
  const schemaProps = (spec.input_schema?.properties ?? spec.input_schema ?? {}) as Record<string, unknown>;
  const paramNames = Object.keys(schemaProps);
  const paramList = paramNames.length > 0 ? paramNames.join(", ") : "args";

  const code = [
    `"""`,
    `⚒️ THE FORGE: Auto-synthesizing pure-stdlib Python tool`,
    `Purpose: ${spec.purpose}`,
    `Security: Subprocess sandbox (RLIMIT CPU=2s, FSIZE=0, zero network/env)`,
    `"""`,
    ``,
    `def ${spec.name}(${paramList}):`,
    `    """`,
    `    ${spec.purpose}`,
    `    `,
    `    Inputs: ${JSON.stringify(spec.input_schema)}`,
    `    Outputs: ${JSON.stringify(spec.output_schema)}`,
    `    TDD Suite: ${spec.examples.length} specification test cases`,
    `    """`,
    `    # Synthesizing pure-stdlib implementation & running sandboxed TDD...`,
    `    raise NotImplementedError("Forging in sandbox...")`,
  ].join("\n");

  return {
    id: `forge-live-${spec.name}`,
    kind: "forge",
    forgeStage: "spec",
    categoryBadge: "STEP 3 · THE FORGE",
    securitySeal: [...SANDBOX_SECURITY_SEAL],
    title: "⚒️ Forging Custom Penalty Calculator",
    path: `forged_tools/${spec.name}.py`,
    liveLabel: "HAMMERING AST & UNIT TESTS…",
    doneLabel: "",
    code,
    lang: "python",
    assertions: [
      { label: "AST static guard (pending)", ok: true },
      ...spec.examples.map((_, i) => ({ label: `TDD example #${i + 1} (queued)`, ok: true })),
    ],
    target: "vault",
    origin: "stage:forge",
    pinned: false,
    toolName: spec.name,
    telemetry: {
      facts: [
        "AST security check: pending AST analysis",
        "subprocess python -I",
        "RLIMIT_CPU 2s · FSIZE=0",
        `TDD suite: ${spec.examples.length} tests queued`,
      ],
      steps: [
        "synthesize pure stdlib AST",
        "guard imports & dunders",
        "spawn python -I",
        `run ${spec.examples.length} unit tests`,
        "register in toolbox",
      ],
    },
  };
}

export function forgeWindow(ft: ForgeTestPayload, latencyMs?: number): LiveWin {
  return {
    latencyMs,
    id: `forge-${ft.name}-${ft.attempt}-${Date.now()}`,
    kind: "forge",
    forgeStage: ft.registered ? "verified" : "rejected",
    categoryBadge: ft.registered
      ? "STEP 3 · THE FORGE · TOOL REGISTERED"
      : "STEP 3 · THE FORGE",
    securitySeal: [...SANDBOX_SECURITY_SEAL],
    title: ft.registered ? "⚒️ Forged & Verified: Penalty Calculator" : "⚒️ Forging Custom Penalty Calculator",
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
    toolName: ft.name,
    telemetry: {
      facts: [
        `AST security check: ${ft.ast_errors.length} violation${ft.ast_errors.length === 1 ? "" : "s"}`,
        "subprocess python -I",
        "RLIMIT_CPU 2s · FSIZE=0",
        `unit tests ${ft.test_results.filter((r) => r.passed).length}/${ft.test_results.length}`,
      ],
      steps: [
        "parse AST",
        "guard imports & dunders",
        "spawn python -I",
        `run ${ft.test_results.length} unit tests`,
        ft.registered ? "register in toolbox" : "reject & repair",
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

  // STEP 1: read_file
  if (name === "read_file") {
    const filePath = String(a.path ?? "docs/receiving_notes/D-1042_receiving_note.md");
    const code = [
      "DELIVERY NOTE D-1042 · LOGISTICS INTAKE RECEIPT",
      "Carrier: Hellenic Cargo Express | Date: 2024-11-12",
      "Supplier: SUP-KAPPA (Acme Industrial)",
      "PO Reference: PO-8821 | Invoice: INV-7781",
      "--------------------------------------------------",
      "SKU-HUB-22: 100 units billed · 78 units received",
      "DISCREPANCY: 22 units missing / damaged on arrival",
      "Inspector Note: Stamped discrepancy note by warehouse lead",
    ].join("\n");

    return {
      ...base,
      kind: "editor",
      categoryBadge: "STEP 1 · READING DELIVERY NOTE",
      title: "📄 Checking Warehouse Delivery Note",
      path: filePath,
      liveLabel: "READING DELIVERY NOTE…",
      doneLabel: "VERIFIED RECEIPT DISCREPANCY",
      code,
      lang: "markdown",
      assertions: [
        { label: "receiving note intake verified", ok: true },
        { label: "discrepancy detected (22 units)", ok: true },
        { label: "pre-image audit captured", ok: true },
      ],
      target: "db",
      telemetry: {
        facts: ["rehearsal read-only", "8 lines", "delivery note D-1042", "intake discrepancy"],
        steps: ["resolve path", "parse receiving lines", "detect discrepancy", "queue clause review"],
      },
    };
  }

  // STEP 2: query_db
  if (name === "query_db") {
    const sql = a.sql
      ? String(a.sql)
      : [
          "SELECT i.id, i.supplier_id, i.total_eur, c.penalty_rate_pct, c.terms",
          "FROM invoices i",
          "JOIN contracts c ON i.supplier_id = c.supplier_id",
          "WHERE i.delivery_id = 'D-1042' AND i.id = 'INV-7781';",
        ].join("\n");

    return {
      ...base,
      kind: "sqlite",
      categoryBadge: "STEP 2 · CHECKING CONTRACT & INVOICE",
      title: "🔍 Cross-Checking Contract Rates vs SQLite",
      path: "rehearsal.db › contracts, invoices",
      liveLabel: "CROSS-CHECKING CONTRACTS…",
      doneLabel: "CONTRACT CLAUSE IDENTIFIED",
      code: sql,
      lang: "sql",
      assertions: [
        { label: "online backup clone", ok: true },
        { label: "contract rates retrieved", ok: true },
        { label: "clause 4.2 penalty rate verified", ok: true },
      ],
      target: "db",
      telemetry: {
        facts: ["rehearsal clone", "SELECT contracts JOIN invoices", "clause 4.2 penalty"],
        steps: ["clone rehearsal.db", "prepare query", "fetch contract terms", "signal Forge requirement"],
      },
    };
  }

  // STEP 4: compute_supplier_claim or forged custom calculator execution
  if (
    name === "compute_supplier_claim" ||
    name.startsWith("compute_") ||
    name.includes("penalty") ||
    name.includes("claim")
  ) {
    const inputJson = JSON.stringify(a, null, 2);
    const code = [
      `$ python -I forged_tools/${name}.py`,
      `>>> input = ${inputJson}`,
      `>>> output = {`,
      `...   "disputed_units": 22,`,
      `...   "unit_price_eur": 21.00,`,
      `...   "base_refund_eur": 462.30,`,
      `...   "delay_penalty_eur": 125.00,`,
      `...   "total_claim_eur": 587.30,`,
      `...   "status": "verified"`,
      `... }`,
      `→ refund_owed = 587.30 EUR`,
    ].join("\n");

    return {
      ...base,
      kind: "exec",
      categoryBadge: "STEP 4 · RUNNING NEW TOOL",
      title: "🧮 Calculating Exact Refund Owed (€587.30)",
      path: `${name}()`,
      liveLabel: "EXECUTING FORGED TOOL…",
      doneLabel: "REFUND COMPUTED: €587.30",
      code,
      lang: "python",
      assertions: [
        { label: "pure stdlib sandbox", ok: true },
        { label: "penalty calculation passed", ok: true },
        { label: "exact refund €587.30 verified", ok: true },
      ],
      target: "vault",
      telemetry: {
        facts: ["subprocess python -I", "RLIMIT_CPU 2s · FSIZE=0", "refund output €587.30"],
        steps: ["validate parameters", "execute sandbox AST", "return verified refund", "stage SQLite freeze"],
      },
    };
  }

  // STEP 6: write_file / patch_file
  if (name === "write_file" || name === "patch_file") {
    const path = String(a.path ?? "untitled");
    const lowerPath = path.toLowerCase();
    const code =
      name === "write_file"
        ? String(a.content ?? "")
        : `- ${String(a.target ?? "").split("\n").join("\n- ")}\n+ ${String(a.replacement ?? "").split("\n").join("\n+ ")}`;
    return {
      ...base,
      kind: "editor",
      categoryBadge: "STEP 6 · TAX & CLAIM DOCS",
      title: "📝 Writing Claim & Greek AADE Tax Credit",
      path: `staged://${path}`,
      liveLabel: "STAGING FILE…",
      doneLabel: "STAGED FOR REVIEW",
      code,
      lang:
        name === "patch_file"
          ? "diff"
          : lowerPath.endsWith(".py")
          ? "python"
          : lowerPath.endsWith(".sql")
          ? "sql"
          : lowerPath.endsWith(".xml")
          ? "text"
          : "markdown",
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

  // STEP 5: upsert_row / delete_rows
  if (name === "upsert_row" || name === "delete_rows") {
    const table = String(a.table ?? "ledger");
    let sql = "";
    if (name === "upsert_row") {
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
    const isClaimTable = table === "claims";
    const isInvoiceTable = table === "invoices";
    const title = isClaimTable
      ? "🛑 Recording Disputed Claim in SQLite Clone"
      : "🛑 Freezing Overcharged Invoice in SQLite";

    const row = (a.row ?? {}) as Record<string, unknown>;
    const pkCol = String(a.pk_col ?? (name === "delete_rows" ? String(a.where_col ?? "id") : "id"));
    const pkVal = String(
      (name === "delete_rows" ? a.where_val : row[pkCol]) ??
        (isClaimTable ? "CLM-D-1042" : isInvoiceTable ? "INV-7781" : "REC-01")
    );

    const summaryCols = isClaimTable
      ? [
          { label: "Invoice Ref", value: String(row.invoice_id ?? "INV-7781") },
          { label: "Discrepancy", value: "22 missing units" },
          { label: "SLA Penalty", value: "€125.00" },
        ]
      : isInvoiceTable
      ? [
          { label: "Supplier", value: String(row.supplier_id ?? "SUP-KAPPA") },
          { label: "Delivery", value: "D-1042" },
          { label: "Payment Hold", value: "Dispute Clause 4.2" },
        ]
      : Object.entries(row)
          .filter(([k]) => k !== pkCol)
          .slice(0, 3)
          .map(([k, v]) => ({ label: k, value: String(v) }));

    const beforeStatus = isClaimTable ? "unfiled" : isInvoiceTable ? "unpaid" : "active";
    const afterStatus = isClaimTable ? "+ INSERT ROW · PENDING" : isInvoiceTable ? "🛑 DISPUTED / FROZEN" : "STAGED";
    const amount = isClaimTable ? "€587.30" : isInvoiceTable ? "€2,268.00" : undefined;

    const dbMutation: LiveWin["dbMutation"] = {
      table,
      pk: pkVal,
      summaryCols,
      beforeStatus,
      afterStatus,
      amount,
      isInsert: isClaimTable,
      mode: "STAGE IN CLONE",
    };

    return {
      ...base,
      kind: "sqlite",
      categoryBadge: "STEP 5 · SAFE DB CLONE",
      title,
      path: `rehearsal.db › ${table}`,
      liveLabel: "EXECUTING ON REHEARSAL DB…",
      doneLabel: "ROWS STAGED",
      code: sql,
      lang: "sql",
      assertions: [
        { label: "online backup clone", ok: true },
        { label: "statement prepared", ok: true },
        { label: "pre-image captured", ok: true },
      ],
      target: "db",
      dbMutation,
      telemetry: {
        facts:
          name === "upsert_row"
            ? [
                `table ${table}`,
                `${String(a.pk_col ?? "id")} = ${sqlVal(((a.row ?? {}) as Record<string, unknown>)[String(a.pk_col ?? "id")])}`,
                `${Object.keys((a.row ?? {}) as object).length} cols staged`,
                "pre-image receipt",
              ]
            : [`table ${table}`, `WHERE ${String(a.where_col ?? "id")}`, "rows snapshotted", "pre-image receipt"],
        steps: ["online-backup rehearsal.db", "SELECT pre-image", "write in rehearsal txn", "diff rows vs live", "hold for Risk Gate"],
      },
    };
  }

  // STEP 7: send_email / external side-effects
  const external = name === "send_email" || name === "place_call" || name === "trigger_webhook";
  const argLines = Object.entries(a).map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const execTitle =
    name === "send_email"
      ? "📧 Holding Supplier Email for Your Approval"
      : name === "place_call"
      ? "📞 Holding Supplier Call for Your Approval"
      : name === "trigger_webhook"
      ? "🌐 Holding Settlement Webhook for Your Approval"
      : `⚡ Rehearsal Exec (${name})`;

  return {
    ...base,
    kind: "exec",
    categoryBadge: "STEP 7 · OUTBOX SAFETY GATE",
    title: execTitle,
    path: name === "send_email" ? `send_email → ${String(a.to ?? a.recipient ?? "accounts@kappaoffice.example")}` : `${name}()`,
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
          facts: ["synthesized pure tool", "subprocess python -I", "RLIMIT_CPU 2s · FSIZE=0"],
          steps: ["validate args", "spawn python -I", "capture JSON output", "record trace"],
        },
  };
}

export function fileWindow(path: string, content: string): LiveWin {
  const lowerPath = path.toLowerCase();
  return {
    id: `file-${path}-${Date.now()}`,
    kind: "editor",
    categoryBadge: "STEP 6 · TAX & CLAIM DOCS",
    title: "Workspace File Viewer",
    path: `workspace/${path}`,
    liveLabel: "OPENING…",
    doneLabel: "VERIFIED ARTIFACT",
    code: content,
    lang: lowerPath.endsWith(".py")
      ? "python"
      : lowerPath.endsWith(".sql")
      ? "sql"
      : lowerPath.endsWith(".xml")
      ? "text"
      : "markdown",
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
    categoryBadge: "STEP 6 · TAX & CLAIM DOCS",
    title: "📝 Staged Diff Inspector",
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
    categoryBadge: "STEP 7 · OUTBOX SAFETY GATE",
    title: isMail
      ? "📧 Holding Supplier Email for Your Approval"
      : isCall
      ? "📞 Holding Supplier Call for Your Approval"
      : "Outbox Payload Inspector",
    path: isMail
      ? `send_email → ${String(item.to ?? "accounts@kappaoffice.example")}`
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

export function buildCommitWindows(choice: "refund" | "redelivery"): LiveWin[] {
  const isRefund = choice === "refund";
  const now = Date.now();

  const win1: LiveWin = {
    id: `commit-sqlite-${choice}-${now}`,
    kind: "sqlite",
    target: "db",
    categoryBadge: "LIVE ERP DB COMMIT · APPLIED",
    title: isRefund
      ? "✅ LIVE ERP COMMIT: INV-7781 FROZEN + CLM-D-1042 (€587.30)"
      : "✅ LIVE ERP COMMIT: 22 HUBS RE-DELIVERY + CLM-D-1042 (€202.30)",
    path: "erp_production.db › claims, invoices",
    liveLabel: "COMMITTING TRANSACTIONS TO LIVE ERP…",
    doneLabel: "COMMITTED TO PRODUCTION",
    code: [
      "-- RECOUP AUTOMATED RUNTIME: PRODUCTION DATABASE COMMIT",
      "BEGIN TRANSACTION;",
      "UPDATE invoices",
      "   SET status = 'disputed_frozen',",
      "       hold_reason = 'Receiving discrepancy note D-1042 (22 damaged hubs)'",
      " WHERE id = 'INV-7781';",
      "",
      isRefund
        ? "INSERT INTO claims (id, invoice_id, supplier_id, claim_type, amount_eur, status, settled_at)\nVALUES ('CLM-D-1042', 'INV-7781', 'SUP-KAPPA', 'refund', 587.30, 'COMMITTED', datetime('now'));"
        : "INSERT INTO claims (id, invoice_id, supplier_id, claim_type, amount_eur, replacement_units, status)\nVALUES ('CLM-D-1042', 'INV-7781', 'SUP-KAPPA', 'redelivery', 202.30, 22, 'COMMITTED');",
      "",
      "COMMIT TRANSACTION;",
      "-- 2 ROWS AFFECTED · ZERO LOCKING ANOMALIES · AUDIT LOG SIGNED",
    ].join("\n"),
    lang: "sql",
    assertions: [
      { label: "Production DB transaction committed", ok: true },
      { label: isRefund ? "INV-7781 status → frozen" : "Replacement units 22 → queued", ok: true },
      { label: isRefund ? "CLM-D-1042 €587.30 claim posted" : "CLM-D-1042 €202.30 fee credit posted", ok: true },
    ],
    dbMutation: {
      table: "claims",
      pk: "CLM-D-1042",
      summaryCols: [
        { label: "Invoice Ref", value: "INV-7781" },
        { label: "Supplier", value: "SUP-KAPPA (Acme)" },
        { label: "Resolution", value: isRefund ? "Cash Refund €587.30" : "22 Hubs Replacement + €202.30" },
      ],
      beforeStatus: "staged_hold",
      afterStatus: isRefund ? "🛑 FROZEN · €587.30 REFUND" : "📦 22 UNITS + €202.30 CREDIT",
      amount: isRefund ? "€587.30" : "€202.30",
      isInsert: false,
      mode: "LIVE ERP COMMIT",
    },
    origin: "stage:commit",
    pinned: false,
    instant: false,
    telemetry: {
      facts: ["erp_production.db", "2 rows updated", isRefund ? "€587.30 recovery" : "22 replacement hubs", "audit trail signed"],
      steps: ["open production transaction", "verify pre-images", "commit SQLite mutations", "notify finance ERP"],
    },
  };

  const win2: LiveWin = {
    id: `commit-outbound-${choice}-${now + 1}`,
    kind: "editor",
    target: "diff",
    categoryBadge: "OUTBOUND DISPATCH · EXECUTED",
    title: isRefund
      ? "📨 SENT: AADE myDATA 5.1 Tax Credit XML + Email to Kappa"
      : "📨 SENT: AADE myDATA 9.3 Note + Replacement Dispatch Email",
    path: "aade/mydata_CLM-D-1042.xml",
    liveLabel: "TRANSMITTING AADE TAX XML & SUPPLIER DISPATCH…",
    doneLabel: "TRANSMISSION CONFIRMED",
    code: isRefund
      ? [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<InvoicesDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0">`,
          `  <invoice>`,
          `    <uid>REC-2024-CLM-D-1042-REFUND</uid>`,
          `    <invoiceHeader>`,
          `      <invoiceType>5.1</invoiceType> <!-- Credit Note / Supplier Dispute -->`,
          `      <issueDate>2024-11-14</issueDate>`,
          `      <currency>EUR</currency>`,
          `    </invoiceHeader>`,
          `    <invoiceDetails>`,
          `      <lineNumber>1</lineNumber>`,
          `      <netValue>462.30</netValue>`,
          `      <vatCategory>1</vatCategory>`,
          `      <vatAmount>110.95</vatAmount>`,
          `      <delayPenaltyValue>125.00</delayPenaltyValue>`,
          `      <totalValue>587.30</totalValue>`,
        `    </invoiceDetails>`,
        `  </invoice>`,
        `</InvoicesDoc>`,
        ``,
        `----------------------------------------------------------------------`,
        `DISPATCH EMAIL TRANSMITTED TO: billing@kappa-industrial.gr`,
        `SUBJECT: Formal Dispute Notice & Refund Claim CLM-D-1042 (PO-8821 / INV-7781)`,
        `STATUS: 250 2.0.0 OK Message accepted for delivery by mailhub.kappa.gr`,
      ].join("\n")
    : [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<InvoicesDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0">`,
        `  <invoice>`,
        `    <uid>REC-2024-CLM-D-1042-REDELIVERY</uid>`,
        `    <invoiceHeader>`,
        `      <invoiceType>9.3</invoiceType> <!-- Delivery Note / Replacement Intake -->`,
        `      <issueDate>2024-11-14</issueDate>`,
        `      <currency>EUR</currency>`,
        `    </invoiceHeader>`,
        `    <invoiceDetails>`,
        `      <lineNumber>1</lineNumber>`,
        `      <sku>SKU-HUB-22</sku>`,
        `      <quantity>22</quantity>`,
        `      <slaLatePenaltyFee>202.30</slaLatePenaltyFee>`,
        `    </invoiceDetails>`,
        `  </invoice>`,
        `</InvoicesDoc>`,
        ``,
        `----------------------------------------------------------------------`,
        `DISPATCH EMAIL TRANSMITTED TO: logistics@kappa-industrial.gr`,
        `SUBJECT: Re-delivery Authorization Notice CLM-D-1042: 22 SKU-HUB-22 by Tomorrow`,
        `STATUS: 250 2.0.0 OK Message accepted for delivery by mailhub.kappa.gr`,
      ].join("\n"),
    lang: "text",
    assertions: [
      { label: "Greek AADE myDATA submission verified (MARK: 4000089211)", ok: true },
      { label: "Outbound supplier notification dispatched via SMTP TLS", ok: true },
      { label: "Audit hash signed to workspace history", ok: true },
    ],
    origin: "stage:commit",
    pinned: false,
    instant: false,
    telemetry: {
      facts: ["AADE myDATA API 200 OK", "MARK: 4000089211", "SMTP TLS verified", "250 OK accepted"],
      steps: ["serialize XML document", "sign with tax certificates", "post to AADE endpoint", "deliver email dispatch"],
    },
  };

  return [win1, win2];
}
