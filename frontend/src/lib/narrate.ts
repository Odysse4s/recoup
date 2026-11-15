import type {
  AnticipateOfferPayload,
  ApprovalNeededPayload,
  CallEndPayload,
  CallTurnPayload,
  ChangeReport,
  EvidencePayload,
  ForgeSpecPayload,
  ForgeTestPayload,
  PlanPayload,
  ServerEvent,
  VerifyPayload,
} from "../contracts";

export const IDLE_NARRATION =
  "Ready. Assign a vendor audit goal to Recoup — every ERP write and claim is rehearsed in an isolated copy before touching live ledgers.";

export const idleNarration = (brandName = "Recoup") =>
  `Ready. Assign a vendor audit goal to ${brandName} — every ERP write and claim is rehearsed in an isolated copy before touching live ledgers.`;

type Call = { id?: string; name?: string; args?: Record<string, unknown> };

export function callOf(ev: ServerEvent): Call | undefined {
  return (ev.payload as { call?: Call }).call;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function reportCounts(rep: ChangeReport) {
  const files = rep.files_created.length + rep.files_modified.length + rep.files_deleted.length;
  const db = Object.values(rep.db_summary || {}).reduce(
    (acc, c) => acc + (c.inserted || 0) + (c.updated || 0) + (c.deleted || 0),
    0
  );
  return { files, db, outbox: rep.external_outbox.length };
}

/** Plain-language subtitle describing what the runtime is doing right now. */
export function narrate(ev: ServerEvent, brandName = "Recoup"): string {
  switch (ev.type) {
    case "rehearse_start":
      return "Cloning workspace and SQLite ledger into an isolated rehearsal copy…";
    case "evidence": {
      const e = ev.payload as unknown as EvidencePayload;
      return `Extracted ${plural(e.findings?.length ?? 1, "audit finding")} from \`${e.source}\`.`;
    }
    case "plan":
    case "replan": {
      const p = ev.payload as unknown as PlanPayload;
      const missing = p.steps.find((s) => s.tool.startsWith("MISSING:"));
      return missing
        ? `Planned ${plural(p.steps.length, "step")}. Tool \`${missing.tool.slice(8)}\` is missing — ${brandName} will synthesize and sandbox-test it.`
        : `Planned ${plural(p.steps.length, "step")} with ${plural(p.success_criteria.length, "success criterion")}.`;
    }
    case "forge_spec": {
      const s = ev.payload as unknown as ForgeSpecPayload;
      return `Writing a test-first spec for missing tool \`${s.name}\` with ${plural(s.examples.length, "unit test example")}…`;
    }
    case "forge_test": {
      const t = ev.payload as unknown as ForgeTestPayload;
      return `Synthesizing pure Python tool \`${t.name}\` & running ${plural(t.test_results.length, "sandbox unit test")} (attempt ${t.attempt})…`;
    }
    case "forge_registered": {
      const name = String((ev.payload as { name?: string }).name ?? "tool");
      return `\`${name}\` passed AST static checks and all unit tests — registered in Synthesized Tools.`;
    }
    case "tool_call": {
      const c = callOf(ev);
      const name = c?.name ?? "tool";
      const a = c?.args ?? {};
      if (name === "read_file") return `Inspecting workspace document \`${String(a.path ?? "file")}\` in rehearsal…`;
      if (name === "write_file" || name === "patch_file")
        return `Staging \`${String(a.path ?? "file")}\` in rehearsal — live ERP files remain untouched.`;
      if (name === "send_email")
        return `Staging credit claim email to ${String(a.to ?? "vendor")} — held safely until your approval.`;
      if (name === "place_call")
        return "Preparing operator iPhone escalation if away from desk…";
      if (name === "trigger_webhook")
        return `Staging webhook \`${String(a.endpoint ?? "")}\` — held safely until your approval.`;
      if (name === "upsert_row" || name === "delete_rows" || name === "query_db")
        return `Running \`${name}\` against the rehearsal copy of \`${String(a.table ?? "sqlite")}\`…`;
      return `Executing \`${name}\` inside the isolated rehearsal environment…`;
    }
    case "tool_done":
      return `\`${callOf(ev)?.name ?? "tool"}\` finished in rehearsal; pre-image receipt captured for reversible undo.`;
    case "tool_error":
      return `\`${callOf(ev)?.name ?? "tool"}\` failed in rehearsal — ${brandName} is adapting its plan.`;
    case "verify": {
      const v = ev.payload as unknown as VerifyPayload;
      return `Verifying ${plural(v.criteria.length, "audit criterion")} — ${v.passed ? "all passed" : "attention needed"}.`;
    }
    case "rehearse_report": {
      const rep = (ev.payload as { report: ChangeReport }).report;
      const c = reportCounts(rep);
      return `Rehearsal complete: ${plural(c.db, "ERP row change")}, ${plural(c.files, "file diff")}, ${plural(c.outbox, "outbound action")} staged. Live ledger untouched.`;
    }
    case "approval_needed": {
      const a = ev.payload as unknown as ApprovalNeededPayload;
      return `Risk Gate paused \`${a.tool_name}\` — ${a.risk_reason}. Awaiting manager authorization.`;
    }
    case "approval_result": {
      const r = ev.payload as { approved?: boolean; tool?: string };
      return r.approved
        ? `Authorized. Committing staged changes atomically to live workspace…`
        : `Rejected. Rolling back staged changes from pre-image receipts…`;
    }
    case "replay_step_done": {
      const r = ev.payload as { tool?: string };
      return `Committed \`${r.tool ?? "step"}\` to live ledger with reversible undo receipt.`;
    }
    case "undo_step": {
      const r = ev.payload as { tool?: string };
      return `Reversible undo restored \`${r.tool ?? "step"}\` from its pre-image receipt.`;
    }
    case "call_start": {
      const p = ev.payload as { claim_id?: string; channel?: string };
      const cid = p.claim_id || "active claim";
      if (p.channel === "desktop_voice") {
        return `Opened live Laptop Voice consult for ${cid}…`;
      }
      return `Ringing your iPhone to resolve ${cid} while away from desk…`;
    }
    case "call_turn": {
      const t = ev.payload as unknown as CallTurnPayload;
      const isDesktop = (t as { channel?: string }).channel === "desktop_voice";
      const who = t.speaker === "agent" ? brandName : isDesktop ? "You" : "You (iPhone)";
      return `${who}: “${t.text}”`;
    }
    case "call_end": {
      const c = ev.payload as unknown as CallEndPayload & { channel?: string };
      if (c.outcome === "accepted") {
        return "✓ Audit & voice session finished cleanly — all changes committed to live ERP & one-click undo ready.";
      }
      const label = c.channel === "desktop_voice" ? "Voice consult" : "Decision call";
      return `${label} completed (${c.outcome}): ${c.summary}`;
    }
    case "run_done": {
      const r = ev.payload as {
        status?: string;
        outcome?: string;
        fingerprint?: string;
        summary?: string;
        clean_audit?: boolean;
      };
      const st = r.status ?? r.outcome;
      if (st === "committed" || st === "done") {
        if (r.clean_audit) {
          return r.fingerprint
            ? `✓ Clean shipment verified (SHA-256 ${r.fingerprint}) — €0.00 discrepancy, zero claims filed, live ledger untouched.`
            : "✓ Clean shipment verified — €0.00 discrepancy, zero claims filed, live ledger untouched.";
        }
        if (r.fingerprint) {
          return `✓ Settlement committed to live ERP (SHA-256 ${r.fingerprint}) — one-click undo ready.`;
        }
        return "✓ Settlement committed to live ERP — invoice frozen, AADE tax credit filed & one-click undo ready.";
      }
      if (st === "aborted_by_human" || st === "rejected" || st === "aborted") {
        return "Run aborted by manager. Live workspace preserved at its exact prior state.";
      }
      if (st === "timed_out") return "Risk Gate approval timed out before a decision arrived. Live workspace preserved unchanged.";
      if (st === "blocked") return "Run blocked by deterministic governance policy. Zero live changes made.";
      return "✓ Audit execution completed cleanly.";
    }
    case "offer": {
      const o = ev.payload as unknown as AnticipateOfferPayload;
      return `Proactive AP sweep complete: ${brandName} pre-rehearsed ${o.prediction.need}.`;
    }
    default:
      return ev.thought ?? "";
  }
}

export function briefingFor(ev: ServerEvent, brandName = "Recoup"): string | null {
  if (ev.type === "rehearse_report") {
    // Keep subtitle narration silent here so it never overlaps with immediately-following approval_needed or run_done voice clips
    return null;
  }
  if (ev.type === "approval_needed") {
    const a = ev.payload as unknown as ApprovalNeededPayload;
    if (a.spoken_summary && a.spoken_summary.trim()) return a.spoken_summary.trim();
    return `Rehearsal complete. Risk gate active: ${brandName} is holding ${a.tool_name.replace(/_/g, " ")}. Reason: ${a.risk_reason}. Approve to commit staged changes, or reject to roll back.`;
  }
  if (ev.type === "run_done") {
    const r = ev.payload as {
      status?: string;
      outcome?: string;
      spoken_summary?: string;
      summary?: string;
      clean_audit?: boolean;
    };
    const status = String(r.status ?? r.outcome ?? "");
    if (status === "committed" || status === "done") {
      if (r.spoken_summary && r.spoken_summary.trim()) return r.spoken_summary.trim();
      if (r.clean_audit) {
        return "Audit complete. Shipment verified clean with zero discrepancies—no claims filed and live ledger untouched.";
      }
      if (r.summary && r.summary.trim()) return r.summary.trim();
      return "Audit complete and committed to the live ledger. Claim drafted, invoice placed on dispute hold, and vendor notification sent with one-click undo ready.";
    }
  }
  if (ev.type === "offer") {
    const o = ev.payload as unknown as AnticipateOfferPayload;
    return `Proactive ledger scan complete. ${brandName} prepared a follow-up recovery: ${o.prediction.need}. ${Math.round(o.prediction.confidence * 100)} percent confidence. Ready for one-click apply.`;
  }
  return null;
}
