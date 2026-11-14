import type { ChangeReport, ServerEvent } from "./contracts";

export const HERO_GOAL =
  "Audit shipment D-1042 against our Kappa Office Systems contract, hold the overbilled invoice, and send the credit claim";
export const FOLLOW_UP_GOAL =
  "Recover unclaimed vendor credits across earlier Kappa Office Systems shipments D-1017 and D-1031";

const FORGE_CODE = `def compute_supplier_claim(args: dict) -> dict:
    billed = int(args.get("qty_billed", 0))
    received = int(args.get("qty_received", 0))
    damaged = int(args.get("qty_damaged", 0))
    billed_price = float(args.get("billed_unit_price", 0))
    contract_price = float(args.get("contract_unit_price", 0))
    days_late = max(0, int(args.get("days_late", 0)))
    pct_per_day = float(args.get("late_penalty_pct_per_day", 0))
    max_pct = float(args.get("max_penalty_pct", 0))

    overcharge = max(0.0, billed_price - contract_price) * billed
    shortage = max(0, billed - received) * contract_price
    damaged_credit = max(0, damaged) * contract_price
    accepted_value = max(0, received - damaged) * contract_price
    late_penalty = accepted_value * min(days_late * pct_per_day, max_pct) / 100
    total = overcharge + shortage + damaged_credit + late_penalty
    return {
        "overcharge": round(overcharge, 2),
        "shortage": round(shortage, 2),
        "damaged": round(damaged_credit, 2),
        "late_penalty": round(late_penalty, 2),
        "total": round(total, 2),
    }`;

const CLAIM_LETTER = `# Vendor Credit Claim CLM-D-1042: Kappa Office Systems S.A.

**Shipment:** D-1042 (USB-C Enterprise Workstation Hub, SKU HUB-USBC)
**Invoice:** INV-7781 (billed EUR 2,268.00)

| Line item | Basis | Amount |
|---|---|---|
| Rate above master contract | 120 units x (EUR 18.90 - EUR 17.50) | EUR 168.00 |
| Short-shipped units | 16 units x EUR 17.50 | EUR 280.00 |
| Damaged in transit (DOA) | 6 units x EUR 17.50 | EUR 105.00 |
| SLA late-delivery penalty | 2 days x 1% of EUR 1,715.00 accepted goods | EUR 34.30 |
| **Total credit note requested** | | **EUR 587.30** |

Per clauses 2-4 of our Master Procurement Agreement, please issue a credit note for EUR 587.30
against INV-7781 within 7 business days. IT receiving log and inspection notes are attached.
`;

const CLAIM_DIFF = [
  "--- a/claims/CLM-D-1042.md",
  "+++ b/claims/CLM-D-1042.md",
  "@@ -0,0 +1,15 @@",
  ...CLAIM_LETTER.trimEnd()
    .split("\n")
    .map((line) => `+${line}`),
].join("\n");

const FOLLOW_UP_CONTENT = `# Follow-up Vendor Audit: Kappa Office Systems S.A.

| Shipment | Invoice | Discrepancy | Amount |
|---|---|---|---|
| D-1017 | INV-7702 (paid) | 6 units short-shipped x EUR 17.50 | EUR 105.00 |
| D-1031 | INV-7735 (paid) | 4 units DOA damaged x EUR 17.50 | EUR 70.00 |
| **Total** | | | **EUR 175.00** |
`;

const FOLLOW_UP_DIFF = [
  "--- a/claims/CLM-KAPPA-FOLLOWUP.md",
  "+++ b/claims/CLM-KAPPA-FOLLOWUP.md",
  "@@ -0,0 +1,7 @@",
  ...FOLLOW_UP_CONTENT.trimEnd()
    .split("\n")
    .map((line) => `+${line}`),
].join("\n");

const EMAIL_ARGS = {
  to: "accounts@kappaoffice.example",
  subject: "Credit Claim CLM-D-1042 on Invoice INV-7781: EUR 587.30",
  body:
    "Hello Kappa Office Systems AR team,\n\nShipment D-1042 arrived 2 days past SLA with " +
    "16 units short, 6 DOA units, and unit pricing above our FY2026 Master Agreement. " +
    "Please issue a credit note of EUR 587.30 against INV-7781. Full audit attached.\n\nRegards,\nFinance & Workplace Ops",
};

const HERO_REPORT: ChangeReport = {
  files_created: ["claims/CLM-D-1042.md"],
  files_modified: [{ path: "claims/CLM-D-1042.md", diff: CLAIM_DIFF }],
  files_deleted: [],
  db_summary: {
    claims: { inserted: 1, updated: 0, deleted: 0 },
    invoices: { inserted: 0, updated: 1, deleted: 0 },
  },
  db_max_deleted: 0,
  external_outbox: [{ tool: "send_email", ...EMAIL_ARGS }],
};

export function mockEvents(): ServerEvent[] {
  const t0 = Date.now() / 1000;
  let id = 1;
  const ev = (
    dt: number,
    type: ServerEvent["type"],
    payload: Record<string, unknown>,
    opts: { step?: number | null; thought?: string; cost?: number; latency?: number } = {}
  ): ServerEvent => ({
    id: id++,
    run_id: "demo_d1042",
    ts: t0 + dt,
    type,
    step: opts.step ?? null,
    thought: opts.thought ?? null,
    cost_eur: opts.cost ?? 0,
    latency_ms: opts.latency ?? 0,
    payload,
  });

  return [
    ev(
      0.0,
      "rehearse_start",
      { goal: HERO_GOAL },
      { thought: "Cloning workspace & SQLite online backup into an isolated rehearsal copy." }
    ),
    ev(
      0.4,
      "plan",
      {
        goal: HERO_GOAL,
        steps: [
          { id: 1, intent: "Read IT receiving log for shipment D-1042", tool: "read_file", status: "pending" },
          { id: 2, intent: "Cross-check shipment, AP invoice and master contract rates", tool: "query_db", status: "pending" },
          { id: 3, intent: "Synthesize & verify SLA contract claim calculator", tool: "MISSING:compute_supplier_claim", status: "pending" },
          { id: 4, intent: "Stage vendor credit claim CLM-D-1042 for EUR 587.30", tool: "upsert_row", status: "pending" },
          { id: 5, intent: "Place AP payment hold (disputed) on invoice INV-7781", tool: "upsert_row", status: "pending" },
          { id: 6, intent: "Draft formal vendor credit claim memo", tool: "write_file", status: "pending" },
          { id: 7, intent: "Dispatch credit claim notice to Kappa Office Systems AR desk", tool: "send_email", status: "pending" },
        ],
        success_criteria: [
          "claims/CLM-D-1042.md exists with EUR 587.30 credit calculation",
          "INV-7781 placed on disputed hold in AP invoices table",
          "claim email queued for Kappa Office Systems",
        ],
      },
      {
        thought: "Planned 7 steps; `compute_supplier_claim` is missing — synthesizing pure Python calculator via TDD.",
        cost: 0.00042,
        latency: 310,
      }
    ),
    ev(
      1.0,
      "forge_spec",
      {
        name: "compute_supplier_claim",
        purpose:
          "Compute unit overcharge, short-shipped, DOA damaged and capped SLA late-delivery credits for an office vendor shipment and return each line item plus total rounded to cents",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        examples: [
          {
            in: {
              qty_billed: 120,
              qty_received: 104,
              qty_damaged: 6,
              billed_unit_price: 18.9,
              contract_unit_price: 17.5,
              days_late: 2,
              late_penalty_pct_per_day: 1.0,
              max_penalty_pct: 10.0,
            },
            out: { overcharge: 168.0, shortage: 280.0, damaged: 105.0, late_penalty: 34.3, total: 587.3 },
          },
          {
            in: {
              qty_billed: 40,
              qty_received: 40,
              qty_damaged: 0,
              billed_unit_price: 14.2,
              contract_unit_price: 14.2,
              days_late: 0,
              late_penalty_pct_per_day: 0.5,
              max_penalty_pct: 5.0,
            },
            out: { overcharge: 0.0, shortage: 0.0, damaged: 0.0, late_penalty: 0.0, total: 0.0 },
          },
          {
            in: {
              qty_billed: 10,
              qty_received: 10,
              qty_damaged: 0,
              billed_unit_price: 10.0,
              contract_unit_price: 10.0,
              days_late: 15,
              late_penalty_pct_per_day: 1.0,
              max_penalty_pct: 10.0,
            },
            out: { overcharge: 0.0, shortage: 0.0, damaged: 0.0, late_penalty: 10.0, total: 10.0 },
          },
        ],
      },
      { thought: "Drafted 3 TDD unit test examples (including 10% SLA late-penalty cap) for `compute_supplier_claim`.", cost: 0.00038, latency: 260 }
    ),
    ev(
      1.6,
      "forge_test",
      {
        name: "compute_supplier_claim",
        attempt: 1,
        code: FORGE_CODE,
        ast_passed: true,
        ast_errors: [],
        test_results: [
          { index: 0, passed: true, actual: { overcharge: 168.0, shortage: 280.0, damaged: 105.0, late_penalty: 34.3, total: 587.3 } },
          { index: 1, passed: true, actual: { overcharge: 0.0, shortage: 0.0, damaged: 0.0, late_penalty: 0.0, total: 0.0 } },
          { index: 2, passed: true, actual: { overcharge: 0.0, shortage: 0.0, damaged: 0.0, late_penalty: 10.0, total: 10.0 } },
        ],
        registered: true,
      },
      { thought: "AST static safety check clean (0 violations); 3/3 isolated `python -I` unit tests passed.", cost: 0.00051, latency: 185 }
    ),
    ev(
      2.0,
      "forge_registered",
      { name: "compute_supplier_claim" },
      { thought: "Registered `compute_supplier_claim` in Synthesized Tools." }
    ),
    ev(
      2.4,
      "tool_call",
      { call: { id: "c1", name: "read_file", args: { path: "inbox/D-1042_receiving_note.md" } } },
      { step: 1, thought: "Checking IT stockroom receiving log against the Kappa Office Systems purchase order." }
    ),
    ev(
      2.7,
      "tool_done",
      {
        call: { id: "c1", name: "read_file", args: { path: "inbox/D-1042_receiving_note.md" } },
        output: { size: 312 },
        preview: "read inbox/D-1042_receiving_note.md",
      },
      { step: 1, latency: 14, thought: "Found D-1042 delivered 2 days late: 104/120 HUB-USBC received, 6 DOA damaged." }
    ),
    ev(
      3.1,
      "tool_call",
      {
        call: {
          id: "c2",
          name: "query_db",
          args: {
            table: "deliveries",
            sql:
              "SELECT d.id, d.qty_ordered, d.qty_received, d.qty_damaged, d.promised_date, d.delivered_date, " +
              "i.id AS invoice_id, i.qty_billed, i.unit_price AS billed_unit_price, i.amount, " +
              "c.unit_price AS contract_unit_price, c.late_penalty_pct_per_day, c.max_penalty_pct " +
              "FROM deliveries d JOIN invoices i ON i.delivery_id = d.id " +
              "JOIN contract_prices c ON c.supplier_id = d.supplier_id AND c.sku = d.sku WHERE d.id = 'D-1042'",
          },
        },
      },
      { step: 2, thought: "Cross-checking shipment D-1042, invoice INV-7781, and FY2026 master contract rates." }
    ),
    ev(
      3.4,
      "tool_done",
      {
        call: { id: "c2", name: "query_db", args: { table: "deliveries" } },
        output: { count: 1 },
        preview: "INV-7781 billed 120 x EUR 18.90 (EUR 2,268.00) vs contract EUR 17.50",
      },
      { step: 2, latency: 19, thought: "INV-7781 overbilled at EUR 18.90/unit vs contracted EUR 17.50/unit." }
    ),
    ev(
      3.8,
      "tool_call",
      {
        call: {
          id: "c3",
          name: "compute_supplier_claim",
          args: {
            qty_billed: 120,
            qty_received: 104,
            qty_damaged: 6,
            billed_unit_price: 18.9,
            contract_unit_price: 17.5,
            days_late: 2,
            late_penalty_pct_per_day: 1.0,
            max_penalty_pct: 10.0,
          },
        },
      },
      { step: 3, thought: "Computing exact line-item vendor credits with synthesized `compute_supplier_claim`." }
    ),
    ev(
      4.2,
      "tool_done",
      {
        call: { id: "c3", name: "compute_supplier_claim", args: {} },
        output: { result: { overcharge: 168.0, shortage: 280.0, damaged: 105.0, late_penalty: 34.3, total: 587.3 } },
        preview: "total = EUR 587.30 (overcharge 168.00 + short 280.00 + damaged 105.00 + late 34.30)",
      },
      { step: 3, latency: 92, thought: "Computed exact claim total: EUR 587.30." }
    ),
    ev(
      4.6,
      "tool_call",
      {
        call: {
          id: "c4",
          name: "upsert_row",
          args: {
            table: "claims",
            pk_col: "id",
            row: {
              id: "CLM-D-1042",
              supplier_id: "SUP-KAPPA",
              delivery_id: "D-1042",
              invoice_id: "INV-7781",
              amount: 587.3,
              reason: "overcharge 168.00, short 280.00, damaged 105.00, late 34.30",
              status: "drafted",
            },
          },
        },
      },
      { step: 4, thought: "Staging EUR 587.30 vendor credit claim `CLM-D-1042` in isolated rehearsal DB." }
    ),
    ev(
      4.9,
      "tool_done",
      {
        call: {
          id: "c4",
          name: "upsert_row",
          args: {
            table: "claims",
            pk_col: "id",
            row: {
              id: "CLM-D-1042",
              supplier_id: "SUP-KAPPA",
              delivery_id: "D-1042",
              invoice_id: "INV-7781",
              amount: 587.3,
              reason: "overcharge 168.00, short 280.00, damaged 105.00, late 34.30",
              status: "drafted",
            },
          },
        },
        output: { pk_val: "CLM-D-1042" },
        preview: "upsert claims where id='CLM-D-1042'",
      },
      { step: 4, latency: 18, thought: "Staged `CLM-D-1042` (EUR 587.30) with reversible pre-image receipt." }
    ),
    ev(
      5.3,
      "tool_call",
      {
        call: {
          id: "c5",
          name: "upsert_row",
          args: {
            table: "invoices",
            pk_col: "id",
            row: { id: "INV-7781", status: "disputed" },
          },
        },
      },
      { step: 5, thought: "Placing AP payment hold (`disputed`) on overbilled invoice `INV-7781`." }
    ),
    ev(
      5.6,
      "tool_done",
      {
        call: {
          id: "c5",
          name: "upsert_row",
          args: {
            table: "invoices",
            pk_col: "id",
            row: { id: "INV-7781", status: "disputed" },
          },
        },
        output: { pk_val: "INV-7781" },
        preview: "upsert invoices where id='INV-7781' -> status='disputed'",
      },
      { step: 5, latency: 16, thought: "Staged AP payment hold on `INV-7781` (`unpaid` -> `disputed`)." }
    ),
    ev(
      6.0,
      "tool_call",
      {
        call: {
          id: "c6",
          name: "write_file",
          args: { path: "claims/CLM-D-1042.md", content: CLAIM_LETTER },
        },
      },
      { step: 6, thought: "Drafting itemized credit claim memo `claims/CLM-D-1042.md` in rehearsal workspace." }
    ),
    ev(
      6.3,
      "tool_done",
      {
        call: {
          id: "c6",
          name: "write_file",
          args: { path: "claims/CLM-D-1042.md", content: CLAIM_LETTER },
        },
        output: { existed: false },
        preview: CLAIM_DIFF,
      },
      { step: 6, latency: 12, thought: "Staged `claims/CLM-D-1042.md` unified diff." }
    ),
    ev(
      6.7,
      "tool_call",
      { call: { id: "c7", name: "send_email", args: EMAIL_ARGS } },
      { step: 7, thought: "Queueing credit claim dispatch to `accounts@kappaoffice.example` in dry-run outbox." }
    ),
    ev(
      7.0,
      "tool_done",
      {
        call: { id: "c7", name: "send_email", args: EMAIL_ARGS },
        output: { sent: false, queued_in_rehearsal: true },
        preview: `SEND EMAIL -> ${EMAIL_ARGS.to} | subj='${EMAIL_ARGS.subject}'`,
      },
      { step: 7, latency: 9, thought: "Intercepted external email in dry-run outbox (`dry_run_external=True`)." }
    ),
    ev(
      7.4,
      "verify",
      {
        passed: true,
        criteria: [
          { criterion: "claims/CLM-D-1042.md exists with EUR 587.30 credit calculation", passed: true, detail: "Verified in rehearsal workspace" },
          { criterion: "INV-7781 placed on disputed hold in AP invoices table", passed: true, detail: "invoices.status = disputed" },
          { criterion: "claim email queued for Kappa Office Systems", passed: true, detail: "1 message staged in outbox" },
        ],
      },
      { thought: "Verification PASSED (3/3 audit criteria satisfied in rehearsal)." }
    ),
    ev(
      7.8,
      "rehearse_report",
      { report: HERO_REPORT, mutations: 4 },
      { thought: "Rehearsal complete: 2 ERP row changes, 1 claim memo, and 1 outbound vendor email staged for Risk Gate." }
    ),
    ev(
      8.2,
      "approval_needed",
      {
        req_id: "req_demo_d1042",
        tool_name: "send_email",
        args: EMAIL_ARGS,
        diff_preview: CLAIM_DIFF,
        risk_reason: "claims.amount EUR 587.30 >= EUR 250.00 policy threshold & external action (`send_email`)",
        spoken_summary:
          "Recoup risk gate active: holding vendor claim CLM-D-1042 for 587 euros and 30 cents and outbound email to Kappa Office Systems. Approve to commit staged ERP changes, or reject to roll back.",
        report: HERO_REPORT,
      },
      {
        thought: "Risk Gate paused `send_email` (EUR 587.30 >= EUR 250.00 threshold & outbound email) — awaiting manager sign-off.",
      }
    ),
  ];
}

export function mockDecisionEvents(approved: boolean): ServerEvent[] {
  const t0 = Date.now() / 1000;
  let id = 200;
  const ev = (
    dt: number,
    type: ServerEvent["type"],
    payload: Record<string, unknown>,
    opts: { step?: number | null; thought?: string } = {}
  ): ServerEvent => ({
    id: id++,
    run_id: "demo_d1042",
    ts: t0 + dt,
    type,
    step: opts.step ?? null,
    thought: opts.thought ?? null,
    cost_eur: 0,
    latency_ms: 0,
    payload,
  });

  if (!approved) {
    return [
      ev(
        0.1,
        "approval_result",
        { approved: false, outcome: "rejected", tool: "send_email" },
        { step: 3, thought: "Manager REJECTED `send_email` — rolling back staged changes." }
      ),
      ev(
        0.5,
        "run_done",
        { status: "aborted_by_human", fingerprint: "offline-seed" },
        { thought: "Run aborted by manager. Live ERP ledger preserved at exact baseline." }
      ),
    ];
  }

  return [
    ev(
      0.1,
      "approval_result",
      { approved: true, outcome: "approved", tool: "send_email" },
      { step: 3, thought: "Manager APPROVED `send_email`." }
    ),
    ev(
      0.35,
      "replay_step_done",
      { step: 0, tool: "upsert_row", receipt: { table: "claims", pk_col: "id", pk_val: "CLM-D-1042", prev_row: null } },
      { step: 0, thought: "Committed `upsert_row` (`claims` CLM-D-1042) to live ledger with reversible receipt." }
    ),
    ev(
      0.55,
      "replay_step_done",
      { step: 1, tool: "upsert_row", receipt: { table: "invoices", pk_col: "id", pk_val: "INV-7781", prev_row: { status: "unpaid" } } },
      { step: 1, thought: "Committed `upsert_row` (`invoices` INV-7781 -> `disputed`) with reversible receipt." }
    ),
    ev(
      0.75,
      "replay_step_done",
      { step: 2, tool: "write_file", receipt: { path: "claims/CLM-D-1042.md", existed: false, prev: null } },
      { step: 2, thought: "Committed `claims/CLM-D-1042.md` to live workspace." }
    ),
    ev(
      0.95,
      "replay_step_done",
      { step: 3, tool: "send_email", receipt: { sent: true } },
      { step: 3, thought: "Dispatched credit claim notice to `accounts@kappaoffice.example`." }
    ),
    ev(
      1.2,
      "run_done",
      { status: "committed", fingerprint: "94e7c2b18d0a" },
      { thought: "Run finished with status `committed`." }
    ),
    ...buildCallSequence(t0 + 1.6, 230, "demo_d1042", "CLM-D-1042", 587.3),
    ev(
      4.4,
      "offer",
      {
        offer_id: "offer_demo_kappa",
        prediction: {
          need: "Recover EUR 175.00 in unclaimed credits across two paid AP invoices",
          goal_prompt: FOLLOW_UP_GOAL,
          evidence:
            "Shipments D-1017 (6 units short) and D-1031 (4 DOA units) were paid in full on INV-7702 and INV-7735 without credit notes",
          confidence: 0.92,
          kind: "draft",
        },
        report: {
          files_created: ["claims/CLM-KAPPA-FOLLOWUP.md"],
          files_modified: [{ path: "claims/CLM-KAPPA-FOLLOWUP.md", diff: FOLLOW_UP_DIFF }],
          files_deleted: [],
          db_summary: { claims: { inserted: 1, updated: 0, deleted: 0 } },
          db_max_deleted: 0,
          external_outbox: [],
        },
        mutations_count: 2,
      },
      {
        thought:
          "Proactive audit ready (92% confidence): Recover EUR 175.00 in unclaimed credits across paid invoices INV-7702 & INV-7735.",
      }
    ),
  ];
}

function buildCallSequence(
  baseTs: number,
  startId: number,
  runId: string,
  claimId: string,
  claimAmount: number
): ServerEvent[] {
  const callId = `CALL-${claimId}`;
  const openAmt = Math.round(claimAmount * 70) / 100;
  const floorAmt = Math.round(claimAmount * 85) / 100;
  let id = startId;
  const mk = (
    dt: number,
    type: ServerEvent["type"],
    payload: Record<string, unknown>,
    step: number | null,
    thought: string
  ): ServerEvent => ({
    id: id++,
    run_id: runId,
    ts: baseTs + dt,
    type,
    step,
    thought,
    cost_eur: 0,
    latency_ms: 0,
    payload,
  });

  return [
    mk(
      0.0,
      "call_start",
      {
        call_id: callId,
        claim_id: claimId,
        counterparty: "Kappa Office Systems AR desk",
        claim_amount: claimAmount,
        opening_pct: 70,
        floor_pct: 85,
      },
      null,
      `Dialing Kappa Office Systems AR desk to settle \`${claimId}\` (EUR ${claimAmount.toFixed(2)}, floor 85%).`
    ),
    mk(
      0.35,
      "call_turn",
      {
        call_id: callId,
        speaker: "agent",
        text: `Hello, calling from Recoup procurement operations regarding credit claim ${claimId} for EUR ${claimAmount.toFixed(2)} backed by our stockroom inspection log and master contract terms.`,
        audio_url: "/api/voice/turn-audio",
        offer_pct: 100,
      },
      1,
      `Recoup Negotiator opened settlement call on \`${claimId}\` for EUR ${claimAmount.toFixed(2)}.`
    ),
    mk(
      0.7,
      "call_turn",
      {
        call_id: callId,
        speaker: "counterparty",
        text: `We see the receiving discrepancy on ${claimId}, and can offer an expedited 70% credit note of EUR ${openAmt.toFixed(2)} to close the dispute today.`,
        audio_url: "/api/voice/turn-audio",
        offer_pct: 70,
      },
      2,
      `Kappa Office Systems AR desk countered at 70% (EUR ${openAmt.toFixed(2)}).`
    ),
    mk(
      1.05,
      "call_turn",
      {
        call_id: callId,
        speaker: "agent",
        text: `Per procurement policy we cannot accept 70%. With verified short-shipped, DOA, and late SLA items, we can settle immediately at 85% (EUR ${floorAmt.toFixed(2)}) or maintain the full EUR ${claimAmount.toFixed(2)} invoice hold.`,
        audio_url: "/api/voice/turn-audio",
        offer_pct: 85,
      },
      3,
      `Recoup Negotiator enforced ≥85% governance floor (EUR ${floorAmt.toFixed(2)}).`
    ),
    mk(
      1.4,
      "call_turn",
      {
        call_id: callId,
        speaker: "counterparty",
        text: `Understood. To release the invoice hold, we can authorize 85% — a credit note of EUR ${floorAmt.toFixed(2)} on ${claimId} issued today.`,
        audio_url: "/api/voice/turn-audio",
        offer_pct: 85,
      },
      4,
      `Kappa Office Systems AR desk agreed to 85% (EUR ${floorAmt.toFixed(2)}).`
    ),
    mk(
      1.75,
      "call_turn",
      {
        call_id: callId,
        speaker: "agent",
        text: `Agreed at 85% (EUR ${floorAmt.toFixed(2)}), meeting our 85% policy threshold. Recording provisional settlement for ${claimId}.`,
        audio_url: "/api/voice/turn-audio",
        offer_pct: 85,
      },
      5,
      `Recoup Negotiator confirmed provisional settlement at 85% (EUR ${floorAmt.toFixed(2)}).`
    ),
    mk(
      2.1,
      "call_end",
      {
        call_id: callId,
        outcome: "accepted",
        agreed_amount: floorAmt,
        summary: `Settled ${claimId} at 85% (EUR ${floorAmt.toFixed(2)}).`,
      },
      null,
      `Settled ${claimId} at 85% (EUR ${floorAmt.toFixed(2)}).`
    ),
  ];
}

export function mockVendorCallEvents(claimId = "CLM-D-1042", claimAmount = 587.3): ServerEvent[] {
  return buildCallSequence(Date.now() / 1000, 500, `call_demo_${Date.now().toString(36).slice(-4)}`, claimId, claimAmount);
}
