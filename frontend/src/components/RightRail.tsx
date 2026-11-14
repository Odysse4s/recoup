import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Database,
  FileDiff,
  FileText,
  History,
  Mail,
  Maximize2,
  Phone,
  RotateCcw,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Undo2,
  Webhook,
  Wrench,
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

export function RiskGateCard({ approval, onDecide }: { approval: ApprovalNeededPayload; onDecide: (id: string, ok: boolean) => void }) {
  const counts = approval.report ? reportCounts(approval.report) : null;
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
      <div className="flex items-center gap-2.5 border-b border-danger/25 bg-danger/[0.07] px-4 py-2.5">
        <span className="relative flex h-6 w-6 items-center justify-center rounded-md bg-danger text-white">
          <span className="absolute inset-0 animate-ping rounded-md bg-danger/50" />
          <ShieldAlert className="relative h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">Risk Gate · Manager Authorization</div>
        </div>
        <Chip tone="danger">live ERP untouched</Chip>
        <span className="font-mono text-[10.5px] text-ink-3">{approval.req_id}</span>
      </div>
      <div className="space-y-3 p-3.5">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <span>Intercepted</span>
          <code className="rounded-md border border-line bg-sunken px-1.5 py-0.5 font-mono text-[12px] font-medium text-ink">{approval.tool_name}()</code>
          <span>—</span>
          <span className="font-medium text-danger">{approval.risk_reason}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-line">
          {approval.diff_preview ? (
            <DiffBlock diff={approval.diff_preview} max={150} />
          ) : (
            <pre className="bg-code p-3 font-mono text-[11.5px] text-ink-2">{JSON.stringify(approval.args, null, 2)}</pre>
          )}
        </div>
        {counts && (
          <div className="flex flex-wrap gap-1.5">
            <Chip>{counts.files} file change{counts.files === 1 ? "" : "s"}</Chip>
            <Chip tone={counts.outbox ? "warn" : "neutral"}>{counts.outbox} external</Chip>
            <Chip tone={counts.db ? "warn" : "neutral"}>{counts.db} ERP row changes</Chip>
          </div>
        )}
        <div className="flex items-center gap-2 pt-0.5">
          <button onClick={withClick(() => onDecide(approval.req_id, true))} className={cx(btn("ok", "lg"), "flex-1")}>
            Approve commit
          </button>
          <button onClick={withClick(() => onDecide(approval.req_id, false))} className={cx(btn("danger", "lg"), "flex-1")}>
            Reject &amp; rollback
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
          <Smartphone className="h-3 w-3" /> Mirrored live at <span className="font-mono">/mobile</span>
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
  if (e.summary) return e.summary;
  const a = e.args ?? {};
  if (e.tool === "upsert_row") {
    const row = (a.row ?? {}) as Record<string, unknown>;
    return `Staged ${String(a.table ?? "table")} id=${String(row[String(a.pk_col ?? "id")] ?? "?")}`;
  }
  if (e.tool === "write_file") return `Wrote ${String(a.path ?? "file")}`;
  return `Pre-image receipt for ${e.tool}`;
}

function toolBadge(tool: string): { label: string; tone: Tone; icon: LucideIcon } {
  if (tool === "upsert_row" || tool === "delete_rows") return { label: "sqlite", tone: "signal", icon: Database };
  if (tool === "write_file" || tool === "patch_file") return { label: "file", tone: "ok", icon: FileText };
  if (tool === "send_email") return { label: "email", tone: "warn", icon: Mail };
  if (tool === "place_call") return { label: "call", tone: "warn", icon: Phone };
  if (tool === "trigger_webhook") return { label: "webhook", tone: "warn", icon: Webhook };
  return { label: "forged", tone: "forge", icon: Wrench };
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
            No staged diffs yet — rehearsed files, SQLite rows &amp; outbox stage here.
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
                <Mail className="h-3.5 w-3.5 text-warn" /> Intercepted outbox
              </span>
              <Chip tone="warn">dry-run held</Chip>
            </div>
            {report.external_outbox.map((m, i) => {
              const isMail = "to" in m || m.tool === "send_email";
              const isCall = "phone" in m || m.tool === "place_call";
              return (
                <button
                  key={i}
                  ref={anchorRef(`outbox:${i}`)}
                  type="button"
                  onClick={() => onOpenOutbox(m, i)}
                  title={`Inspect the intercepted ${isMail ? "MIME message" : isCall ? "voice call brief" : "JSON payload"}`}
                  className="group block w-full space-y-0.5 border-b border-line px-3 py-2 text-left text-[12px] transition-colors last:border-b-0 hover:bg-warn/[0.05] focus-visible:bg-warn/[0.07] focus-visible:outline-none"
                >
                  <div className="flex items-center gap-2 text-ink">
                    {isMail ? (
                      <Mail className="h-3 w-3 text-ink-3" />
                    ) : isCall ? (
                      <Phone className="h-3 w-3 text-ink-3" />
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
            <span className="text-[12px] font-semibold text-ink">Anticipate</span>
            <Chip tone="signal">{offer.prediction.kind}</Chip>
            <span className="ml-auto font-mono text-[11px] text-ink-2 tabular">{Math.round(offer.prediction.confidence * 100)}%</span>
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
            <h3 className="text-[13px] font-semibold leading-snug tracking-tight text-ink">{offer.prediction.need}</h3>
            <p className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">
              <span className="font-medium text-ink-2">Evidence · </span>
              {offer.prediction.evidence}
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
            <button onClick={withClick(() => onAccept(offer.offer_id))} className={cx(btn("signal", "md"), "flex-1")}>
              1-click accept · {offer.mutations_count} mutation{offer.mutations_count === 1 ? "" : "s"}
            </button>
            <button onClick={withClick(() => onDismiss(offer.offer_id))} className={btn("outline", "md")}>
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
            <Sparkles className="h-3.5 w-3.5 text-signal" /> Anticipate
          </span>
          <span className="truncate text-[11.5px] text-ink-3">{brandName} sweeps paid AP post-commit</span>
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
