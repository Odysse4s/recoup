import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  BrainCircuit,
  Check,
  ChevronDown,
  DatabaseZap,
  FileDiff,
  Fingerprint,
  FlaskConical,
  Hammer,
  Layers,
  Mail,
  Maximize,
  Minus,
  Phone,
  Plus,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Vault,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { anchorRef } from "../lib/anchors";
import { connectedTo, STAGE_COLOR, type GEdge, type GNode, type NodeKind, type NodeStatus, type ThoughtGraph } from "../lib/graph";
import { soundFx } from "../lib/sound";
import { btn, Chip, cx, Panel, type Tone } from "./ui";

const MIN_K = 0.45;
const FIT_MIN_K = 0.85;
const FIT_MAX_K = 1.12;
const MAX_K = 2.2;
const INSPECTOR_W = 296;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const KIND_ICON: Record<NodeKind, LucideIcon> = {
  root: ScanSearch,
  step: Layers,
  ast: ShieldCheck,
  tests: FlaskConical,
  vault: Vault,
  mutation: DatabaseZap,
  diff: FileDiff,
  outbox: Mail,
  gate: Radar,
  commit: Fingerprint,
  anticipate: Sparkles,
};

function iconOf(n: GNode): LucideIcon {
  if (n.kind === "outbox") {
    const toolVal = n.detail.facts.find((f) => f.label === "Tool")?.value;
    if (toolVal === "trigger_webhook") return Webhook;
    if (toolVal === "place_call") return Phone;
    return Mail;
  }
  if (n.kind === "step") {
    if (n.stage === "forge") return Hammer;
    if (n.stage === "gate") {
      if (n.label === "trigger_webhook") return Webhook;
      if (n.label === "place_call") return Phone;
      return Mail;
    }
    return Layers;
  }
  return KIND_ICON[n.kind];
}

function colorOf(status: NodeStatus, stage: GNode["stage"]): string {
  if (status === "failed" || status === "rejected") return "var(--danger)";
  if (status === "held") return STAGE_COLOR.hold;
  if (status === "approved") return STAGE_COLOR.commit;
  if (status === "ghost") return STAGE_COLOR.anticipate;
  return STAGE_COLOR[stage];
}

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  held: "held",
  approved: "approved",
  rejected: "rejected",
  ghost: "speculative",
};

const STATUS_TONE: Record<NodeStatus, Tone> = {
  pending: "neutral",
  running: "accent",
  done: "ok",
  failed: "danger",
  held: "danger",
  approved: "ok",
  rejected: "danger",
  ghost: "signal",
};

function findActiveFocusNode(g: ThoughtGraph): GNode | null {
  const byId = (id: string) => g.nodes.find((n) => n.id === id);
  const gate = byId("gate");
  if (gate?.status === "held") {
    const heldBranch = g.nodes.find((n) => n.id !== "gate" && n.status === "held");
    return heldBranch ?? gate;
  }
  const runningSub = [...g.nodes].reverse().find((n) => n.size === "sm" && n.status === "running");
  if (runningSub) return runningSub;
  const runningStep = [...g.nodes].reverse().find((n) => n.size === "md" && n.status === "running");
  if (runningStep) return runningStep;
  const runningAny = g.nodes.find((n) => n.status === "running");
  if (runningAny) return runningAny;
  const ant = byId("anticipate");
  if (ant?.status === "ghost") return ant;
  const commit = byId("commit");
  if (commit?.status === "done" || commit?.status === "failed") return commit;
  if (gate?.status === "approved" || gate?.status === "rejected") return gate;
  return byId("root") ?? g.nodes[0] ?? null;
}

// ---------------------------------------------------------------- node
function nodeSurface(n: GNode, c: string): CSSProperties {
  const tint = (pct: number, base = "var(--raised)") => `color-mix(in oklab, ${c} ${pct}%, ${base})`;
  switch (n.status) {
    case "pending":
      return { background: "var(--surface)", borderColor: "var(--line-strong)" };
    case "running":
      return {
        background: `linear-gradient(180deg, ${tint(14)}, var(--raised))`,
        borderColor: tint(78, "transparent"),
        boxShadow: `0 0 0 1px ${tint(34, "transparent")}, 0 12px 30px -10px ${tint(85, "transparent")}`,
      };
    case "held":
      return {
        background: `linear-gradient(180deg, ${tint(18)}, var(--raised))`,
        borderColor: c,
        boxShadow: `0 0 0 1.5px ${tint(45, "transparent")}, 0 14px 36px -10px ${tint(88, "transparent")}`,
      };
    case "ghost":
      return { background: tint(9, "var(--surface)"), borderColor: tint(75, "transparent"), borderStyle: "dashed" };
    case "failed":
    case "rejected":
      return { background: tint(8), borderColor: tint(60, "transparent") };
    default:
      return { background: `linear-gradient(180deg, ${tint(8)}, var(--raised))`, borderColor: tint(48, "var(--line)") };
  }
}

function StatusGlyph({ status }: { status: NodeStatus }) {
  if (status === "done" || status === "approved") return <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--c)" }} strokeWidth={2.7} />;
  if (status === "failed" || status === "rejected") return <X className="h-3.5 w-3.5 shrink-0 text-danger" strokeWidth={2.7} />;
  if (status === "ghost") return <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--c)" }} />;
  if (status === "running" || status === "held")
    return (
      <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full opacity-65" style={{ background: "var(--c)" }} />
        <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: "var(--c)" }} />
      </span>
    );
  return <span className="h-2 w-2 shrink-0 rounded-full border border-line-strong" />;
}

const inkMix = "color-mix(in oklab, var(--c) 76%, var(--ink))";

function SecuritySealGrid({ seals, compact = false }: { seals: string[]; compact?: boolean }) {
  return (
    <span className={cx("grid grid-cols-2 gap-1", compact ? "mt-1 border-t border-line/70 pt-1" : "mt-1")}>
      {seals.map((seal, idx) => {
        const emerald = idx === 1 || idx === 2;
        return (
          <span
            key={seal}
            className={cx(
              "truncate rounded border text-center font-mono font-semibold leading-tight",
              compact ? "px-1 py-[1.5px] text-[8.5px]" : "px-1.5 py-0.5 text-[10px]",
              emerald ? "border-ok/40 bg-ok/12 text-ok" : "border-forge/40 bg-forge/12 text-forge"
            )}
            title={`Sandbox security guarantee: ${seal}`}
          >
            {seal}
          </span>
        );
      })}
    </span>
  );
}

function GraphNode({
  n,
  selected,
  dimmed,
  reduce,
  register,
  onSelect,
  onHover,
  onKey,
}: {
  n: GNode;
  selected: boolean;
  dimmed: boolean;
  reduce: boolean;
  register: (id: string, el: HTMLButtonElement | null) => void;
  onSelect: (n: GNode) => void;
  onHover: (id: string | null) => void;
  onKey: (e: ReactKeyboardEvent, n: GNode) => void;
}) {
  const c = colorOf(n.status, n.stage);
  const Icon = iconOf(n);
  const left = n.x - n.w / 2;
  const top = n.y - n.h / 2;
  const style = {
    "--c": c,
    width: n.w,
    height: n.h,
    ...nodeSurface(n, c),
    ...(selected ? { outline: `2px solid ${c}`, outlineOffset: 3 } : null),
  } as CSSProperties;

  return (
    <motion.button
      type="button"
      data-graph-node
      ref={(el) => register(n.id, el)}
      aria-pressed={selected}
      aria-label={`${n.eyebrow ? `${n.eyebrow} ` : ""}${n.label}${n.sub ? `, ${n.sub}` : ""}: ${STATUS_LABEL[n.status]}${n.badge ? `, ${n.badge}` : ""}`}
      onClick={() => onSelect(n)}
      onKeyDown={(e) => onKey(e, n)}
      onPointerEnter={() => onHover(n.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(n.id)}
      onBlur={() => onHover(null)}
      initial={{ opacity: 0, scale: 0.92, x: left, y: top }}
      animate={{ opacity: dimmed ? 0.3 : n.status === "pending" ? 0.84 : 1, scale: 1, x: left, y: top }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 30, opacity: { duration: 0.25 } }}
      style={style}
      className="absolute left-0 top-0 rounded-[11px] border text-left transition-[box-shadow,border-color,background] duration-300"
    >
      {n.status === "held" && (
        <>
          <span aria-hidden className="graph-radar pointer-events-none absolute -inset-px rounded-[12px] border-[1.5px]" style={{ borderColor: STAGE_COLOR.hold }} />
          <span
            aria-hidden
            className="graph-radar pointer-events-none absolute -inset-px rounded-[12px] border-[1.5px] [animation-delay:0.9s]"
            style={{ borderColor: STAGE_COLOR.gate }}
          />
        </>
      )}

      {n.badge && n.size !== "sm" && (
        <span
          className="absolute -top-2.5 right-2.5 inline-flex h-[18px] max-w-[74%] items-center truncate rounded-[5px] border bg-raised px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide"
          style={{ color: inkMix, borderColor: "color-mix(in oklab, var(--c) 48%, var(--line))" }}
        >
          {n.badge}
        </span>
      )}

      {n.size === "lg" && (
        <span className="flex h-full items-center gap-2.5 px-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "color-mix(in oklab, var(--c) 16%, transparent)", color: inkMix }}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold tracking-tight text-ink">{n.label}</span>
              <StatusGlyph status={n.status} />
            </span>
            {n.sub && <span className="mt-0.5 line-clamp-2 text-[11px] leading-[1.25] text-ink-2">{n.sub}</span>}
          </span>
        </span>
      )}

      {n.size === "md" && (
        <span className="flex h-full flex-col justify-center gap-[3px] px-2.5 py-1.5">
          <span className="flex items-center justify-between gap-1.5">
            <span className="font-mono text-[9.5px] font-semibold tracking-[0.12em] text-ink-3">{n.eyebrow}</span>
            <StatusGlyph status={n.status} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: inkMix }} />
            <span className="truncate font-mono text-[13px] font-semibold tracking-tight text-ink">{n.label}</span>
          </span>
          {n.sub && <span className="line-clamp-2 text-[11px] leading-[1.26] text-ink-2">{n.sub}</span>}
        </span>
      )}

      {n.size === "sm" && (
        <span className="flex h-full flex-col justify-center gap-[2px] px-2.5 py-1.5">
          <span className="flex min-w-0 items-center justify-between gap-1.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: inkMix }} />
              <span className="truncate text-[12px] font-semibold tracking-tight text-ink">{n.label}</span>
            </span>
            <StatusGlyph status={n.status} />
          </span>
          <span className="truncate pl-[20px] font-mono text-[10.5px] leading-tight" style={{ color: n.badge ? inkMix : "var(--ink-2)" }}>
            {n.badge ?? n.sub ?? STATUS_LABEL[n.status]}
          </span>
          {n.securityBadges && n.securityBadges.length > 0 && <SecuritySealGrid seals={n.securityBadges} compact />}
        </span>
      )}
    </motion.button>
  );
}

// ---------------------------------------------------------------- edges
const BASE_OPACITY: Record<GEdge["state"], number> = {
  idle: 0.78,
  ready: 0.52,
  active: 0.94,
  done: 0.86,
  held: 0.98,
  failed: 0.85,
  ghost: 1,
};

function GraphEdge({ e, highlight, dimmed, gradientId }: { e: GEdge; highlight: boolean; dimmed: boolean; gradientId: string; reduce: boolean }) {
  const color =
    e.state === "failed"
      ? "var(--danger)"
      : e.state === "idle"
      ? "var(--line-strong)"
      : e.state === "held"
      ? STAGE_COLOR.hold
      : STAGE_COLOR[e.stage];
  const energized = e.state === "active" || e.state === "done" || e.state === "held";
  const width = highlight ? 2.85 : energized ? 2.25 : 1.85;
  const opacity = dimmed ? 0.16 : highlight ? 1 : BASE_OPACITY[e.state];

  if (!e.d) return null;

  if (e.state === "ghost" || e.state === "held") {
    return (
      <path
        d={e.d}
        className={e.state === "ghost" ? "graph-ghost" : "graph-held"}
        fill="none"
        stroke={e.state === "ghost" ? `url(#${gradientId})` : color}
        strokeWidth={width + 0.45}
        strokeLinecap="round"
        style={{
          opacity,
          transition: "opacity 240ms ease",
          filter: `drop-shadow(0 0 6px ${e.state === "ghost" ? STAGE_COLOR.anticipate : color})`,
        }}
      />
    );
  }

  const packet = e.state === "active" ? "graph-packet" : e.state === "done" ? "graph-packet-slow" : null;
  const glowFilter =
    highlight || e.state === "active"
      ? `drop-shadow(0 0 6px ${color})`
      : e.state === "done"
      ? `drop-shadow(0 0 3px ${color})`
      : undefined;

  return (
    <g>
      <path
        d={e.d}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        style={{
          opacity,
          transition: "opacity 240ms ease, stroke 240ms ease",
          ...(glowFilter ? { filter: glowFilter } : {}),
        }}
      />
      {packet && !dimmed && (
        <path
          d={e.d}
          className={packet}
          fill="none"
          stroke={color}
          strokeWidth={e.state === "active" ? width + 1.5 : width + 0.8}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 ${e.state === "active" ? 8 : 4}px ${color})` }}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------- inspector
function useSha256(value: unknown): string | null {
  const text = value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    setHash(null);
    if (text === null) return;
    const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
    if (!subtle) {
      setHash("unavailable");
      return;
    }
    let live = true;
    subtle
      .digest("SHA-256", new TextEncoder().encode(text))
      .then((buf) => {
        if (live) setHash([...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
      })
      .catch(() => live && setHash("unavailable"));
    return () => {
      live = false;
    };
  }, [text]);
  return hash;
}

function Metric({ label, value, mono = true, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-sunken/70 px-2 py-1" title={title}>
      <div className="text-[9px] font-medium uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx("truncate text-[11px] text-ink tabular", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function NodeInspector({
  node,
  onClose,
  onDecide,
  onAcceptOffer,
  onDismissOffer,
  onSwitchToStudio,
}: {
  node: GNode;
  onClose: () => void;
  onDecide: (reqId: string, ok: boolean) => void;
  onAcceptOffer: (id: string) => void;
  onDismissOffer: (id: string) => void;
  onSwitchToStudio?: () => void;
}) {
  const d = node.detail;
  const c = colorOf(node.status, node.stage);
  const Icon = iconOf(node);
  const sha = useSha256(d.receipt);
  const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const act = (fn: () => void) => () => {
    soundFx.playUiClick();
    fn();
  };
  const canInspectInStudio = onSwitchToStudio && (node.kind === "mutation" || node.kind === "diff" || node.kind === "root");

  return (
    <motion.aside
      data-graph-ui
      key={node.id}
      initial={{ opacity: 0, x: 14, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 10, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      aria-label={`${d.title} inspector`}
      className="absolute right-2 top-2 z-20 flex max-h-[calc(100%-16px)] flex-col overflow-hidden rounded-xl border border-line bg-raised/95 shadow-float backdrop-blur-md"
      style={{ width: `min(${INSPECTOR_W}px, calc(100% - 16px))`, "--c": c } as CSSProperties}
    >
      {/* Node Inspector Header */}
      <div className="flex shrink-0 items-start gap-2.5 border-b border-line px-3 py-2.5">
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: "color-mix(in oklab, var(--c) 15%, transparent)", color: inkMix }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug tracking-tight text-ink">{d.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={STATUS_TONE[node.status]}>{STATUS_LABEL[node.status]}</Chip>
            {canInspectInStudio && (
              <button
                type="button"
                onClick={act(() => onSwitchToStudio?.())}
                className="inline-flex h-5 items-center gap-1 rounded-md border border-signal/35 bg-signal/10 px-1.5 font-mono text-[9.5px] font-semibold text-signal hover:bg-signal/20"
              >
                Open Ledger / Files →
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={act(onClose)}
          aria-label="Close inspector (Esc)"
          title="Close (Esc)"
          className={cx(btn("ghost", "sm"), "h-6 w-6 px-0 text-ink-3 hover:text-ink")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* TOP PRIMARY ACTIONS — Pinned at top right under header so they can NEVER move off-screen */}
      {d.action?.kind === "approval" && (
        <div className="shrink-0 border-b border-line bg-surface/90 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-danger">
              <Radar className="h-3 w-3 animate-pulse text-danger" />
              Action Required
            </span>
            <span className="font-mono text-[9.5px] text-ink-3">
              req: {(d.action as { reqId: string }).reqId.slice(0, 8)}
            </span>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={act(() => onDecide((d.action as { reqId: string }).reqId, true))}
              className={cx(btn("ok", "sm"), "flex-1 font-semibold shadow-sm")}
            >
              <Check className="h-3.5 w-3.5" /> Approve
            </button>
            <button
              type="button"
              onClick={act(() => onDecide((d.action as { reqId: string }).reqId, false))}
              className={cx(btn("danger", "sm"), "flex-1 font-semibold")}
            >
              <X className="h-3.5 w-3.5" /> Reject
            </button>
          </div>
        </div>
      )}

      {d.action?.kind === "offer" && (
        <div className="shrink-0 border-b border-line bg-surface/90 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-signal">
              <Sparkles className="h-3 w-3 text-signal" />
              Agent Offer
            </span>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={act(() => onAcceptOffer((d.action as { offerId: string }).offerId))}
              className={cx(btn("signal", "sm"), "flex-1 font-semibold")}
            >
              Accept Offer
            </button>
            <button
              type="button"
              onClick={act(() => onDismissOffer((d.action as { offerId: string }).offerId))}
              className={cx(btn("outline", "sm"))}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Scrollable Inspector Body — Compact & Human-friendly with collapsible technical details */}
      <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
        {d.summary && <p className="text-[12px] leading-relaxed text-ink-2">{d.summary}</p>}

        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="Latency" value={d.latencyMs ? `${d.latencyMs} ms` : "—"} />
          <Metric label="Cost" value={d.costEur ? `€${d.costEur.toFixed(4)}` : "—"} />
          <Metric
            label="Receipt"
            value={sha ? (sha === "unavailable" ? "n/a" : sha.slice(0, 8)) : "—"}
            title={sha ? `sha256 ${sha}` : "No reversible receipt yet"}
          />
        </div>

        {d.facts.length > 0 && (
          <dl className="space-y-1 rounded-md border border-line bg-sunken/40 p-1.5">
            {d.facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="grid grid-cols-[74px_1fr] gap-2 text-[11px] leading-snug">
                <dt className="pt-px text-[9.5px] font-medium uppercase tracking-wider text-ink-3">{f.label}</dt>
                <dd className={cx("min-w-0 break-words text-ink", f.mono && "font-mono text-[10px]")}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* Collapsible Sandbox Security Seal */}
        {node.securityBadges && node.securityBadges.length > 0 && (
          <details className="group rounded-lg border border-forge/30 bg-forge/[0.04]">
            <summary className="flex cursor-pointer select-none items-center justify-between px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-forge hover:bg-forge/[0.06]">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-ok" /> Sandbox Security Seal ({node.securityBadges.length})
              </span>
              <ChevronDown className="h-3 w-3 text-forge transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="border-t border-forge/20 p-2">
              <SecuritySealGrid seals={node.securityBadges} />
            </div>
          </details>
        )}

        {/* Collapsible Arguments */}
        {d.args !== undefined && (
          <details className="group rounded-md border border-line bg-sunken/40">
            <summary className="flex cursor-pointer select-none items-center justify-between px-2.5 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-ink-3 hover:bg-sunken/70 hover:text-ink">
              <span>{d.argsLabel ?? "Arguments"}</span>
              <ChevronDown className="h-3 w-3 text-ink-3 transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="border-t border-line/60 p-1.5">
              <pre className="scroll-thin max-h-32 overflow-auto rounded bg-code p-1.5 font-mono text-[10px] leading-relaxed text-ink-2">
                {json(d.args)}
              </pre>
            </div>
          </details>
        )}

        {/* Collapsible Source Code */}
        {d.code && (
          <details className="group rounded-md border border-line bg-sunken/40">
            <summary className="flex cursor-pointer select-none items-center justify-between px-2.5 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-ink-3 hover:bg-sunken/70 hover:text-ink">
              <span>Source Code</span>
              <ChevronDown className="h-3 w-3 text-ink-3 transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="border-t border-line/60 p-1.5">
              <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre rounded bg-code p-2 font-mono text-[10.5px] leading-relaxed text-ink-2">
                {d.code}
              </pre>
            </div>
          </details>
        )}

        {/* Collapsible SHA-256 Receipt */}
        {sha && sha !== "unavailable" && (
          <details className="group rounded-md border border-dashed border-line bg-sunken/30">
            <summary className="flex cursor-pointer select-none items-center justify-between px-2 py-1 font-mono text-[9px] text-ink-3 hover:text-ink">
              <span className="truncate">sha256 · {sha.slice(0, 14)}…</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-ink-3 transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="break-all border-t border-dashed border-line/60 p-1.5 font-mono text-[9px] text-ink-3 select-all">
              {sha}
            </div>
          </details>
        )}
      </div>
    </motion.aside>
  );
}

// ---------------------------------------------------------------- graph
const LEGEND: { label: string; color: string; dashed?: boolean }[] = [
  { label: "Rehearse", color: STAGE_COLOR.rehearse },
  { label: "Forge", color: STAGE_COLOR.forge },
  { label: "Gate", color: STAGE_COLOR.gate },
  { label: "Hold", color: STAGE_COLOR.hold },
  { label: "Commit", color: STAGE_COLOR.commit },
  { label: "Anticipate", color: STAGE_COLOR.anticipate, dashed: true },
];

function graphStatus(g: ThoughtGraph): { label: string; tone: Tone } {
  const by = (id: string) => g.nodes.find((n) => n.id === id);
  if (by("gate")?.status === "held") return { label: "risk hold", tone: "danger" };
  if (by("anticipate")?.status === "ghost") return { label: "speculating", tone: "signal" };
  if (by("commit")?.status === "done") return { label: "committed", tone: "ok" };
  if (by("commit")?.status === "failed") return { label: "rolled back", tone: "warn" };
  if (g.nodes.some((n) => n.status === "running")) return { label: "thinking", tone: "accent" };
  return { label: g.empty ? "standby" : "ready", tone: "neutral" };
}

export function NeuralGraph({
  graph,
  onDecide,
  onAcceptOffer,
  onDismissOffer,
  onSwitchToStudio,
  dockAnchor = false,
  className,
}: {
  graph: ThoughtGraph;
  onDecide: (reqId: string, ok: boolean) => void;
  onAcceptOffer: (id: string) => void;
  onDismissOffer: (id: string) => void;
  onSwitchToStudio?: () => void;
  /** Receive docking live windows (SQLite) while SQLite Studio is hidden. */
  dockAnchor?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const uid = useId().replace(/:/g, "");
  const vpRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLButtonElement>());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const userMovedRef = useRef(false);
  const prevEmptyRef = useRef(graph.empty);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const focusId = selected?.id ?? hoverId;
  const path = useMemo(() => (focusId ? connectedTo(focusId, graph.edges) : null), [focusId, graph.edges]);
  const status = graphStatus(graph);
  const activeFocusNode = useMemo(() => findActiveFocusNode(graph), [graph]);

  useEffect(() => {
    if (prevEmptyRef.current !== graph.empty) {
      userMovedRef.current = false;
      prevEmptyRef.current = graph.empty;
    }
  }, [graph.empty]);

  useLayoutEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!size.w || !size.h) return;
    const pad = 28;
    const rawK = Math.min((size.w - pad) / graph.width, (size.h - pad) / graph.height);
    const k = clamp(rawK, FIT_MIN_K, FIT_MAX_K);
    const gw = graph.width * k;
    const gh = graph.height * k;

    let x = (size.w - gw) / 2;
    if (gw > size.w - 24 && activeFocusNode) {
      x = clamp(size.w / 2 - activeFocusNode.x * k, size.w - gw - 16, 16);
    }

    let y = (size.h - gh) / 2;
    if (gh > size.h - 24 && activeFocusNode) {
      y = clamp(size.h / 2 - activeFocusNode.y * k, size.h - gh - 16, 16);
    }

    setView({ k, x, y });
  }, [size.w, size.h, graph.width, graph.height, activeFocusNode]);

  useLayoutEffect(() => {
    if (!userMovedRef.current) fit();
  }, [fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    userMovedRef.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const px = cx ?? (vpRef.current?.clientWidth ?? 0) / 2;
      const py = cy ?? (vpRef.current?.clientHeight ?? 0) / 2;
      return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
    });
  }, []);

  const refit = () => {
    soundFx.playUiClick();
    userMovedRef.current = false;
    fit();
  };

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Clean up selectedId if the node was removed from the graph
  useEffect(() => {
    if (selectedId && !graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [graph.nodes, selectedId]);

  // Global Escape key listener to close NodeInspector smoothly
  useEffect(() => {
    if (!selectedId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

  const ensureVisible = useCallback(
    (n: GNode, withInspector: boolean) => {
      const v = viewRef.current;
      const right = size.w - (withInspector && size.w > INSPECTOR_W + 160 ? INSPECTOR_W + 16 : 0) - 12;
      const sx0 = v.x + (n.x - n.w / 2) * v.k;
      const sx1 = v.x + (n.x + n.w / 2) * v.k;
      const sy0 = v.y + (n.y - n.h / 2) * v.k;
      const sy1 = v.y + (n.y + n.h / 2) * v.k;
      let dx = 0;
      let dy = 0;
      if (sx1 > right) dx = right - sx1;
      if (sx0 + dx < 12) dx = 12 - sx0;
      if (sy1 > size.h - 12) dy = size.h - 12 - sy1;
      if (sy0 + dy < 12) dy = 12 - sy0;
      if (dx || dy) {
        userMovedRef.current = true;
        setView({ ...v, x: v.x + dx, y: v.y + dy });
      }
    },
    [size.w, size.h]
  );

  const select = (n: GNode) => {
    soundFx.playUiClick();
    const next = selectedId === n.id ? null : n.id;
    setSelectedId(next);
    if (next) ensureVisible(n, true);
  };

  const onNodeKey = (e: ReactKeyboardEvent, n: GNode) => {
    const dirs: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    const dir = dirs[e.key];
    if (!dir) return;
    e.preventDefault();
    let best: GNode | null = null;
    let bestScore = Infinity;
    for (const m of graph.nodes) {
      if (m.id === n.id) continue;
      const dx = m.x - n.x;
      const dy = m.y - n.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 4) continue;
      const score = along + (Math.abs(dx * dir[1]) + Math.abs(dy * dir[0])) * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (best) {
      nodeEls.current.get(best.id)?.focus({ preventScroll: true });
      ensureVisible(best, !!selectedId);
    }
  };

  const onViewportKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && selectedId) {
      e.preventDefault();
      setSelectedId(null);
    } else if (e.key === "+" || e.key === "=") zoomAt(1.2);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.2);
    else if (e.key === "0") refit();
  };

  const register = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-graph-node],[data-graph-ui]")) return;
    dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      userMovedRef.current = true;
    }
    setView((v) => ({ ...v, x: d.x + dx, y: d.y + dy }));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved && e.type === "pointerup") setSelectedId(null);
  };

  const ghostEdge = graph.edges.find((e) => e.state === "ghost");
  const from = ghostEdge && graph.nodes.find((n) => n.id === ghostEdge.from);
  const to = ghostEdge && graph.nodes.find((n) => n.id === ghostEdge.to);
  const gradientId = `ghost-${uid}`;

  const ctl = cx(btn("outline", "sm"), "h-6 w-6 px-0");

  return (
    <Panel
      title="Decision & Thought Graph"
      icon={<BrainCircuit />}
      meta={<Chip tone={status.tone}>{status.label}</Chip>}
      actions={
        <div data-graph-ui className="flex items-center gap-1">
          <button type="button" className={ctl} onClick={() => zoomAt(1 / 1.18)} aria-label="Zoom out" title="Zoom out (−)">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-10 text-center font-mono text-[11px] font-medium text-ink-2 tabular">{Math.round(view.k * 100)}%</span>
          <button type="button" className={ctl} onClick={() => zoomAt(1.18)} aria-label="Zoom in" title="Zoom in (+)">
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={cx(btn("outline", "sm"), "h-6 gap-1 px-2 text-[11px] font-semibold")}
            onClick={refit}
            aria-label="Fit graph to view"
            title="Fit & follow active stage (0)"
          >
            <Maximize className="h-3 w-3" />
            Fit
          </button>
        </div>
      }
      anchor={dockAnchor ? anchorRef("db") : undefined}
      className={className}
      bodyClassName="flex flex-col"
    >
      <div
        ref={vpRef}
        role="group"
        aria-label="Thought Graph — arrow keys move between nodes, Enter inspects, plus and minus zoom, 0 fits"
        onKeyDown={onViewportKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-graph-node],[data-graph-ui]")) refit();
        }}
        className={cx(
          "graph-grid relative min-h-0 flex-1 touch-pan-y select-none overflow-hidden lg:touch-none",
          dragging ? "cursor-grabbing" : "cursor-grab"
        )}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: graph.width,
            height: graph.height,
            transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})`,
            transition: dragging || reduce ? "none" : "transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          }}
        >
          <svg width={graph.width} height={graph.height} className="pointer-events-none absolute left-0 top-0 overflow-visible" aria-hidden>
            <defs>
              <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={from ? from.x : 0} y1={from ? from.y : 0} x2={to ? to.x : 1} y2={to ? to.y : 0}>
                <stop offset="0" stopColor={STAGE_COLOR.anticipate} />
                <stop offset="1" stopColor={STAGE_COLOR.forge} />
              </linearGradient>
            </defs>
            {graph.edges.map((e) => {
              const on = !!path && path.has(e.from) && path.has(e.to);
              return <GraphEdge key={e.id} e={e} highlight={on} dimmed={!!selected && !on} gradientId={gradientId} reduce={reduce} />;
            })}
          </svg>
          {graph.nodes.map((n) => (
            <GraphNode
              key={n.id}
              n={n}
              selected={n.id === selectedId}
              dimmed={!!selected && !!path && !path.has(n.id)}
              reduce={reduce}
              register={register}
              onSelect={select}
              onHover={setHoverId}
              onKey={onNodeKey}
            />
          ))}
        </div>

        <AnimatePresence>
          {selected && (
            <NodeInspector
              key={selected.id}
              node={selected}
              onClose={() => setSelectedId(null)}
              onDecide={onDecide}
              onAcceptOffer={onAcceptOffer}
              onDismissOffer={onDismissOffer}
              onSwitchToStudio={onSwitchToStudio}
            />
          )}
        </AnimatePresence>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-line px-3">
        <span className="min-w-0 truncate text-[11px] text-ink-3">
          {graph.empty ? "Assign a goal — live chain-of-thought branches here." : "Drag to pan · ⌘/Ctrl + scroll to zoom · click any node to inspect receipt"}
        </span>
        <span className="hidden shrink-0 items-center gap-2.5 sm:flex" aria-label="Legend">
          {LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1 text-[10.5px] font-medium text-ink-2">
              <svg width="14" height="4" aria-hidden>
                <line x1="1" y1="2" x2="13" y2="2" stroke={l.color} strokeWidth="2.4" strokeLinecap="round" strokeDasharray={l.dashed ? "3 2" : undefined} />
              </svg>
              {l.label}
            </span>
          ))}
        </span>
      </div>
    </Panel>
  );
}
