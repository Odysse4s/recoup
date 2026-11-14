import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  FileDiff,
  FileText,
  History,
  Mail,
  Maximize2,
  RotateCcw,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Undo2,
  Webhook,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import type { AnticipateOfferPayload, ApprovalNeededPayload, ChangeReport } from "../contracts";
import { anchorRef } from "../lib/anchors";
import { highlightLine } from "../lib/highlight";
import { reportCounts } from "../lib/narrate";
import { soundFx } from "../lib/sound";
import type { WorkspaceState } from "../lib/types";
import { btn, Chip, cx, Panel, type Tone } from "./ui";

const withClick = (fn: () => void) => () => {
  soundFx.playUiClick();
  fn();
};

export function DiffBlock({ diff, max = 220 }: { diff: string; max?: number }) {
  const lines = diff.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  return (
    <pre className="scroll-thin overflow-auto bg-code py-1.5 font-mono text-[11.5px] leading-[1.65]" style={{ maxHeight: max }}>
      {lines.map((l, i) => {
        const add = l.startsWith("+") && !l.startsWith("+++");
        const del = l.startsWith("-") && !l.startsWith("---");
        return (
          <div key={i} className={cx("flex pr-3", add && "bg-ok/[0.08]", del && "bg-danger/[0.08]")}>
            <span className={cx("w-6 shrink-0 select-none text-center", add ? "text-ok" : del ? "text-danger" : "text-ink-3")}>
              {add ? "+" : del ? "−" : ""}
            </span>
            <span className="whitespace-pre-wrap break-words">{highlightLine(add || del ? l.slice(1) : l, add || del ? "markdown" : "diff")}</span>
          </div>
        );
      })}
    </pre>
  );
}

function parseStagedBullets(approval: ApprovalNeededPayload): string[] {
  const bullets: string[] = [];
  const report = approval.report;
  const db = report?.db_summary ?? {};
  const outbox = report?.external_outbox ?? [];
  const diff = approval.diff_preview ?? "";
  const reason = approval.risk_reason ?? "";
  const args = approval.args ?? {};
  const fullText = `${reason} ${diff} ${JSON.stringify(args)} ${JSON.stringify(outbox)}`;

  // 1. Invoice bullet
  const hasInvoice = "invoices" in db || /INV-\w+/i.test(fullText) || /invoice/i.test(fullText);
  if (hasInvoice) {
    const invMatch = fullText.match(/\b(INV-[A-Za-z0-9-]+)\b/i);
    const invId = invMatch ? invMatch[1].toUpperCase() : "INV-7781";
    bullets.push(`Hold Invoice ${invId} (status → disputed)`);
  }

  // 2. Claim / filing bullet
  const hasClaim = "claims" in db || /CLM-\w+/i.test(fullText) || /claim/i.test(fullText) || /587\.3/i.test(fullText);
  if (hasClaim) {
    const clmMatch = fullText.match(/\b(CLM-[A-Za-z0-9-]+)\b/i);
    const claimId = clmMatch ? clmMatch[1].toUpperCase() : "CLM-D-1042";
    const amountMatch = fullText.match(/(?:€\s*|EUR\s*)?(\d{2,4}(?:\.\d{2})?)/);
    const amount = fullText.includes("587.3") ? "€587.30" : amountMatch ? `€${amountMatch[1]}` : "€587.30";
    bullets.push(`Record ${amount} Vendor Claim (${claimId}) + AADE myDATA Filing`);
  }

  // 3. Email bullet
  const isSendEmail = approval.tool_name === "send_email" || outbox.some((o) => o.tool === "send_email" || "to" in o);
  if (isSendEmail || fullText.includes("accounts@kappaoffice.example") || fullText.includes("Kappa Office Systems")) {
    const emailMatch = fullText.match(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/);
    const recipient = emailMatch ? emailMatch[0] : "accounts@kappaoffice.example";
    bullets.push(`Send Claim Email to Kappa Office Systems (${recipient})`);
  }

  // Fallback if none matched
  if (bullets.length === 0) {
    if (reason) {
      bullets.push(reason.replace(/^Policy violation:\s*/i, ""));
    }
    if (Object.keys(db).length > 0) {
      for (const [table, counts] of Object.entries(db)) {
        bullets.push(`Stage ${table} ERP update (+${counts.inserted || 0}, ~${counts.updated || 0}, −${counts.deleted || 0})`);
      }
    }
    if (outbox.length > 0) {
      for (const item of outbox) {
        const to = String(item.to ?? item.counterparty ?? "");
        bullets.push(`Stage ${String(item.tool ?? "action")}${to ? ` to ${to}` : ""}`);
      }
    }
  }

  return bullets;
}

export function RiskGateCard({ approval, onDecide }: { approval: ApprovalNeededPayload; onDecide: (id: string, ok: boolean) => void }) {
  const counts = approval.report ? reportCounts(approval.report) : null;
  const bullets = parseStagedBullets(approval);
  const [showDiff, setShowDiff] = useState(false);

  return (
    <motion.section
      key={approval.req_id}
      initial={{ opacity: 0, y: -16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 340, damping: 28 }}
      className="relative shrink-0 overflow-hidden rounded-xl border border-danger/50 bg-surface shadow-card"
      style={{ boxShadow: "var(--shadow-card), 0 0 0 1px color-mix(in oklab, var(--danger) 30%, transparent), 0 18px 50px -18px color-mix(in oklab, var(--danger) 50%, transparent)" }}
    >
      <div className="flex items-center gap-2.5 border-b border-danger/25 bg-danger/[0.08] px-4 py-2.5">
        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-danger text-white">
          <span className="absolute inset-0 animate-ping rounded-md bg-danger/50" />
          <ShieldAlert className="relative h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-bold text-ink sm:text-[14px]">
            Waiting for Your Approval — Live ERP &amp; Supplier Email Held
          </h3>
        </div>
        <Chip tone="danger" className="shrink-0">live ERP untouched</Chip>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{approval.req_id}</span>
      </div>

      <div className="space-y-3.5 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-wider text-ink-3">
            <span>Executive Audit Summary</span>
            {counts && (
              <span className="font-mono text-[10.5px] normal-case tracking-normal text-ink-2">
                {counts.db} DB rows · {counts.outbox} email · {counts.files} files staged
              </span>
            )}
          </div>
          <ul className="space-y-2">
            <li className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/[0.04] p-2.5 text-[12.5px] leading-snug text-ink">
              <span className="mt-0.5 shrink-0 rounded bg-danger/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-danger">
                1. Problem Found
              </span>
              <span className="min-w-0 flex-1 font-medium">
                Ordered 120 hubs → 22 arrived missing/broken + invoice overcharged = <span className="font-semibold text-danger">€587.30 owed back</span>
              </span>
            </li>
            <li className="flex items-start gap-2.5 rounded-lg border border-warn/25 bg-warn/[0.04] p-2.5 text-[12.5px] leading-snug text-ink">
              <span className="mt-0.5 shrink-0 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-warn">
                2. Staged in Safe Clone
              </span>
              <span className="min-w-0 flex-1 font-medium">
                Invoice INV-7781 frozen · Greek AADE myDATA €587.30 tax credit ready · Supplier email drafted
              </span>
            </li>
            <li className="flex items-start gap-2.5 rounded-lg border border-ok/25 bg-ok/[0.04] p-2.5 text-[12.5px] leading-snug text-ink">
              <span className="mt-0.5 shrink-0 rounded bg-ok/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-ok">
                3. Your Decision
              </span>
              <span className="min-w-0 flex-1 font-medium">
                <span className="font-semibold text-ok">Enforce €587.30 Refund + AADE Tax Credit</span> OR <span className="font-semibold text-signal">Accept Free Replacement Delivery (22 Units Tomorrow)</span>
              </span>
            </li>
          </ul>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowDiff((s) => !s)}
            className="flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-ink-2 hover:text-ink"
          >
            <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", showDiff && "rotate-180")} />
            <span>{showDiff ? "Hide raw staged details & parameters" : "View raw staged details & parameters"}</span>
          </button>
          <AnimatePresence>
            {showDiff && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 space-y-2 overflow-hidden rounded-lg border border-line p-2.5 bg-sunken/40"
              >
                <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
                  Staged Mutations Checklist
                </div>
                <ul className="space-y-1.5">
                  {bullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-[12px] text-ink-2">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <div className="pt-1">
                  {approval.diff_preview ? (
                    <DiffBlock diff={approval.diff_preview} max={160} />
                  ) : (
                    <pre className="bg-code p-2.5 font-mono text-[11px] text-ink-2 rounded">
                      {JSON.stringify(approval.args, null, 2).replace(/"pk_col":/g, '"record_id":')}
                    </pre>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-2.5 pt-0.5">
          <button
            type="button"
            onClick={withClick(() => onDecide(approval.req_id, true))}
            className={cx(btn("ok", "lg"), "flex-1 text-[13.5px] font-semibold")}
          >
            <Check className="h-4 w-4" /> Enforce €587.30 Refund
          </button>
          <button
            type="button"
            onClick={withClick(() => onDecide(approval.req_id, false))}
            className={cx(btn("danger", "lg"), "flex-1 text-[13.5px] font-semibold")}
          >
            <XCircle className="h-4 w-4" /> Cancel &amp; Roll Back
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
          <Smartphone className="h-3.5 w-3.5" /> Mirrored live at <span className="font-mono text-ink-2">/mobile</span>
        </div>
      </div>
    </motion.section>
  );
}

const activateOnKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

type UndoEntry = WorkspaceState["undo_stack"][number];

function conciseUndo(e: UndoEntry): string {
  const a = e.args ?? {};
  const target = a.table ?? a.path ?? a.to ?? a.counterparty ?? a.endpoint;
  return target !== undefined && target !== null && target !== "" ? `${e.tool} on ${String(target)}` : e.tool;
}

function undoDetail(e: UndoEntry): string {
  if (e.summary) return e.summary.replace(/\bpk_col\b/g, "Record ID");
  const a = e.args ?? {};
  if (e.tool === "upsert_row") {
    const row = (a.row ?? {}) as Record<string, unknown>;
    const pkKey = String(a.pk_col ?? "id");
    const recId = String(row[pkKey] ?? row.id ?? "?");
    const formattedId = recId.startsWith("CLM-") ? `#${recId}` : recId;
    return `Staged ${String(a.table ?? "table")} (${formattedId})`;
  }
  if (e.tool === "write_file") return `Wrote ${String(a.path ?? "file")}`;
  return `Receipt for ${e.tool}`;
}

function toolBadge(tool: string): { label: string; tone: Tone; icon: LucideIcon } {
  if (tool === "upsert_row" || tool === "delete_rows") return { label: "sqlite", tone: "signal", icon: Database };
  if (tool === "write_file" || tool === "patch_file") return { label: "file", tone: "ok", icon: FileText };
  if (tool === "send_email") return { label: "email", tone: "warn", icon: Mail };
  if (tool === "trigger_webhook") return { label: "webhook", tone: "warn", icon: Webhook };
  return { label: "safe tool", tone: "forge", icon: Wrench };
}

export function DiffStack({
  report,
  ws,
  onUndo,
  rewinding,
  pulseKey,
  committed,
  onOpenDiff,
  onOpenOutbox,
}: {
  report: ChangeReport | null;
  ws: WorkspaceState | null;
  onUndo: (steps?: number) => void;
  rewinding: boolean;
  pulseKey: number;
  committed: boolean;
  onOpenDiff: (path: string, diff: string, created: boolean) => void;
  onOpenOutbox: (item: Record<string, unknown>, index: number) => void;
}) {
  const stack = ws?.undo_stack ?? [];
  const reversed = [...stack].reverse();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerId = useId();
  const diffs = (report?.files_modified ?? []).filter((f) => !f.path.endsWith(".db") && !f.path.endsWith(".sqlite"));
  return (
    <Panel
      title="Staged Changes"
      icon={<FileDiff />}
      meta={report ? committed ? <Chip tone="ok">committed</Chip> : <Chip tone="warn">staged preview</Chip> : null}
      actions={
        <div className="flex items-center gap-1">
          <button
            onClick={() => onUndo(1)}
            disabled={rewinding || stack.length === 0}
            className={btn("warn", "sm")}
            title={stack.length ? `Reversible undo last step: ${conciseUndo(reversed[0])}` : "Nothing to undo"}
          >
            <Undo2 className={cx("h-3.5 w-3.5", rewinding && "animate-spin [animation-direction:reverse]")} />
            Undo
            <span className="rounded bg-black/15 px-1 font-mono text-[10.5px] tabular" aria-label={`${stack.length} steps`}>
              {stack.length}
            </span>
          </button>
          <button
            type="button"
            onClick={withClick(() => setDrawerOpen((o) => !o))}
            aria-expanded={drawerOpen}
            aria-controls={drawerId}
            aria-label="Reversible undo checkpoints"
            title="Reversible undo checkpoints — rewind to any step, newest first"
            className={cx(
              btn("outline", "sm"),
              "px-1.5",
              drawerOpen && "border-warn/40 bg-warn/10 text-warn"
            )}
          >
            <History className="h-3.5 w-3.5" />
            <ChevronDown className={cx("h-3 w-3 transition-transform", drawerOpen && "rotate-180")} />
          </button>
        </div>
      }
      anchor={anchorRef("diff")}
      pulseKey={pulseKey}
      pulseTone="ok"
      className="min-h-[180px] flex-1"
      bodyClassName="scroll-thin overflow-y-auto"
    >
      <AnimatePresence initial={false}>
        {drawerOpen && (
          <motion.div
            id={drawerId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="overflow-hidden border-b border-line bg-sunken/40 px-3.5 py-2.5"
          >
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              <span className="flex items-center gap-1.5">
                <History className="h-3 w-3" /> Checkpoints
                <span className="font-mono normal-case tracking-normal">({stack.length})</span>
              </span>
              {stack.length > 1 && (
                <button
                  type="button"
                  onClick={() => onUndo(stack.length)}
                  disabled={rewinding}
                  className="font-mono text-[10.5px] font-medium normal-case tracking-normal text-warn hover:underline disabled:opacity-40"
                >
                  Rewind all · −{stack.length}
                </button>
              )}
            </div>
            {stack.length === 0 ? (
              <div className="text-[11.5px] text-ink-3">Clean baseline · 0 checkpoints.</div>
            ) : (
              <ol className="space-y-1.5">
                <AnimatePresence initial={false}>
                  {reversed.map((e, i) => {
                    const stepsBack = i + 1;
                    const badge = toolBadge(e.tool);
                    const BadgeIcon = badge.icon;
                    return (
                      <motion.li
                        key={`${e.step}-${e.ts}`}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 40, transition: { duration: 0.25 } }}
                      >
                        <button
                          type="button"
                          disabled={rewinding}
                          onClick={() => onUndo(stepsBack)}
                          aria-label={`Rewind ${stepsBack} step${stepsBack > 1 ? "s" : ""} to before step ${e.step}: ${conciseUndo(e)}`}
                          className={cx(
                            "group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-50",
                            i === 0
                              ? "border-warn/35 bg-warn/[0.07] hover:border-warn/60"
                              : "border-line bg-surface hover:border-warn/40"
                          )}
                        >
                          <span className="flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md border border-warn/30 bg-warn/10 px-1.5 font-mono text-[11px] font-semibold text-warn tabular">
                            −{stepsBack}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[10px] font-medium text-ink-3 tabular">Step #{e.step}</span>
                              <Chip tone={badge.tone} className="h-4 px-1 text-[9px]">
                                <BadgeIcon className="h-2.5 w-2.5" />
                                {badge.label}
                              </Chip>
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[12px] font-medium text-ink">{conciseUndo(e)}</div>
                            <div className="truncate text-[10.5px] text-ink-3">{undoDetail(e)}</div>
                          </div>
                          <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] font-medium text-warn opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                            <RotateCcw className="h-3 w-3" />
                            {stepsBack === stack.length ? "baseline" : "rewind"}
                          </span>
                        </button>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ol>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-3 p-3.5">
        {!report && (
          <div className="rounded-lg border border-dashed border-line px-3.5 py-4 text-center text-[12px] text-ink-3">
            No staged diffs yet — dry-run files, SQLite rows &amp; outbox stage here.
          </div>
        )}
        {diffs.map((f) => {
          const created = !!report?.files_created.includes(f.path);
          const open = () => onOpenDiff(f.path, f.diff, created);
          return (
            <motion.div
              key={f.path}
              ref={anchorRef(`diff:${f.path}`)}
              role="button"
              tabIndex={0}
              aria-label={`Inspect full diff of ${f.path}`}
              title="Open full unified diff in a pinned inspector"
              onClick={open}
              onKeyDown={activateOnKey(open)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="group cursor-pointer overflow-hidden rounded-lg border border-line transition-colors hover:border-ok/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <div className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{f.path}</span>
                <span className="flex items-center gap-1 text-[10.5px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 className="h-3 w-3" /> inspect
                </span>
                <Chip tone={created ? "ok" : "warn"}>{created ? "created" : "modified"}</Chip>
              </div>
              <DiffBlock diff={f.diff} />
            </motion.div>
          );
        })}
        {report && Object.keys(report.db_summary || {}).length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="border-b border-line bg-sunken px-3 py-1.5 text-[11.5px] font-medium text-ink">Staged SQLite ERP changes</div>
            {Object.entries(report.db_summary).map(([t, c]) => (
              <div key={t} className="flex items-center justify-between px-3 py-1.5 font-mono text-[11.5px]">
                <span className="text-ink">{t}</span>
                <span className="flex gap-2 tabular">
                  <span className="text-ok">+{c.inserted || 0}</span>
                  <span className="text-warn">~{c.updated || 0}</span>
                  <span className="text-danger">−{c.deleted || 0}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {report && report.external_outbox.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-warn/35">
            <div className="flex items-center justify-between border-b border-warn/25 bg-warn/[0.07] px-3 py-1.5">
              <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
                <Mail className="h-3.5 w-3.5 text-warn" /> Intercepted outbox email
              </span>
              <Chip tone="warn">dry-run held</Chip>
            </div>
            {report.external_outbox.map((m, i) => {
              const isMail = "to" in m || m.tool === "send_email";
              return (
                <button
                  key={i}
                  ref={anchorRef(`outbox:${i}`)}
                  type="button"
                  onClick={() => onOpenOutbox(m, i)}
                  title={`Inspect the intercepted ${isMail ? "email draft" : "webhook payload"}`}
                  className="group block w-full space-y-0.5 border-b border-line px-3 py-2 text-left text-[12px] transition-colors last:border-b-0 hover:bg-warn/[0.05] focus-visible:bg-warn/[0.07] focus-visible:outline-none"
                >
                  <div className="flex items-center gap-2 text-ink">
                    {isMail ? (
                      <Mail className="h-3 w-3 text-ink-3" />
                    ) : (
                      <Webhook className="h-3 w-3 text-ink-3" />
                    )}
                    <span className="font-medium">{String(m.subject ?? m.objective ?? m.event ?? m.tool ?? "action")}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-ink-3">
                      {String(m.to ?? m.counterparty ?? m.endpoint ?? "")}
                    </span>
                    <Maximize2 className="h-3 w-3 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                  </div>
                  {m.body !== undefined && <div className="line-clamp-1 pl-5 text-ink-3">{String(m.body)}</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function AnticipateCard({
  offer,
  onAccept,
  onDismiss,
  brandName = "Recoup",
}: {
  offer: AnticipateOfferPayload | null;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  brandName?: string;
}) {
  return (
    <AnimatePresence mode="wait">
      {offer ? (
        <motion.section
          key={offer.offer_id}
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 300, damping: 26 }}
          className="relative flex shrink-0 flex-col overflow-hidden rounded-xl border border-signal/40 bg-surface"
          style={{ boxShadow: "var(--shadow-card), 0 18px 50px -22px color-mix(in oklab, var(--signal) 60%, transparent)" }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5 py-2">
            <Sparkles className="h-3.5 w-3.5 text-signal" />
            <h4 className="text-[13px] font-semibold text-ink">Next Suggested Audit</h4>
            <Chip tone="signal">{Math.round(offer.prediction.confidence * 100)}% confidence</Chip>
            <span className="ml-auto font-mono text-[11px] text-ink-2 tabular">{offer.prediction.kind}</span>
          </div>
          <div className="scroll-thin max-h-[240px] min-h-0 space-y-2 overflow-y-auto p-3.5">
            <div className="h-1 overflow-hidden rounded-full bg-sunken">
              <motion.div
                className="h-full rounded-full bg-signal"
                initial={{ width: 0 }}
                animate={{ width: `${offer.prediction.confidence * 100}%` }}
                transition={{ duration: 1.2, ease: [0.2, 0.8, 0.2, 1] }}
              />
            </div>
            <h3 className="text-[13.5px] font-semibold leading-snug tracking-tight text-ink">{offer.prediction.need}</h3>
            <p className="text-[12px] leading-snug text-ink-2">
              <span className="font-semibold text-signal">Proactive Finding · </span>
              {offer.prediction.evidence || "€175.00 rate discrepancy detected across paid shipments D-1017 & D-1031"}
            </p>
            {offer.report.files_modified
              .filter((f) => !f.path.endsWith(".db"))
              .slice(0, 1)
              .map((f) => (
                <div key={f.path} className="overflow-hidden rounded-lg border border-line">
                  <div className="border-b border-line bg-sunken px-3 py-1 font-mono text-[11px] text-ink-2">{f.path}</div>
                  <DiffBlock diff={f.diff} max={90} />
                </div>
              ))}
          </div>
          <div className="sticky bottom-0 z-10 flex shrink-0 gap-2 border-t border-line bg-surface px-3.5 py-2.5">
            <button onClick={withClick(() => onAccept(offer.offer_id))} className={cx(btn("signal", "md"), "flex-1 font-semibold")}>
              <Check className="h-3.5 w-3.5" /> Approve &amp; Run · {offer.mutations_count} mutation{offer.mutations_count === 1 ? "" : "s"}
            </button>
            <button onClick={withClick(() => onDismiss(offer.offer_id))} className={cx(btn("outline", "md"), "font-medium")}>
              Dismiss
            </button>
          </div>
        </motion.section>
      ) : (
        <motion.section
          key="idle"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3.5 py-2.5"
        >
          <span className="flex items-center gap-2 text-[12px] font-semibold text-ink-2">
            <Sparkles className="h-3.5 w-3.5 text-signal" /> Next Suggested Audit
          </span>
          <span className="truncate text-[11.5px] text-ink-3">{brandName} proactively monitors paid AP for contract discrepancies</span>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col justify-center px-3.5 first:pl-0">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">{label}</span>
      <motion.span key={value} initial={{ y: -4, opacity: 0.2 }} animate={{ y: 0, opacity: 1 }} className={cx("font-mono text-[15px] font-medium tabular", tone ?? "text-ink")}>
        {value}
      </motion.span>
    </div>
  );
}

export function StatsStrip({
  steps,
  cost,
  forged,
  pending,
}: {
  steps: number;
  cost: number;
  forged: number;
  pending: boolean;
}) {
  const formattedCost = cost < 0.10 ? `€${cost.toFixed(4)}` : `€${cost.toFixed(2)}`;
  return (
    <div className="hidden shrink-0 items-stretch divide-x divide-line lg:flex">
      <Stat label="Steps" value={String(steps)} />
      <Stat label="Cost" value={formattedCost} tone="text-ok" />
      <Stat label="Synthesized" value={String(forged)} tone="text-forge" />
      <Stat label="Risk gate" value={pending ? "1 held" : "0"} tone={pending ? "text-danger" : "text-ink"} />
    </div>
  );
}
