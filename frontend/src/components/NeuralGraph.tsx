import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  BrainCircuit,
  Check,
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

const MIN_K = 0.35;
const MAX_K = 2.2;
const INSPECTOR_W = 276;
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

// ---------------------------------------------------------------- node
function nodeSurface(n: GNode, c: string): CSSProperties {
  const tint = (pct: number, base = "var(--raised)") => `color-mix(in oklab, ${c} ${pct}%, ${base})`;
  switch (n.status) {
    case "pending":
      return { background: "var(--surface)", borderColor: "var(--line-strong)" };
    case "running":
      return {
        background: `linear-gradient(180deg, ${tint(12)}, var(--raised))`,
        borderColor: tint(72, "transparent"),
        boxShadow: `0 0 0 1px ${tint(28, "transparent")}, 0 10px 28px -12px ${tint(80, "transparent")}`,
      };
    case "held":
      return {
        background: `linear-gradient(180deg, ${tint(16)}, var(--raised))`,
        borderColor: c,
        boxShadow: `0 0 0 1px ${tint(40, "transparent")}, 0 12px 34px -10px ${tint(85, "transparent")}`,
      };
    case "ghost":
      return { background: tint(7, "transparent"), borderColor: tint(70, "transparent"), borderStyle: "dashed" };
    case "failed":
    case "rejected":
      return { background: tint(6), borderColor: tint(55, "transparent") };
    default:
      return { background: `linear-gradient(180deg, ${tint(6)}, var(--raised))`, borderColor: tint(40, "var(--line)") };
  }
}

function StatusGlyph({ status }: { status: NodeStatus }) {
  if (status === "done" || status === "approved") return <Check className="h-3 w-3 shrink-0" style={{ color: "var(--c)" }} strokeWidth={2.6} />;
  if (status === "failed" || status === "rejected") return <X className="h-3 w-3 shrink-0 text-danger" strokeWidth={2.6} />;
  if (status === "ghost") return <Sparkles className="h-3 w-3 shrink-0" style={{ color: "var(--c)" }} />;
  if (status === "running" || status === "held")
    return (
      <span className="relative inline-flex h-2 w-2 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: "var(--c)" }} />
        <span className="relative h-2 w-2 rounded-full" style={{ background: "var(--c)" }} />
      </span>
    );
  return <span className="h-2 w-2 shrink-0 rounded-full border border-line-strong" />;
}

const inkMix = "color-mix(in oklab, var(--c) 72%, var(--ink))";

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
      initial={{ opacity: 0, scale: 0.9, x: left, y: top }}
      animate={{ opacity: dimmed ? 0.3 : n.status === "pending" ? 0.78 : 1, scale: 1, x: left, y: top }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 30, opacity: { duration: 0.25 } }}
      style={style}
      className="absolute left-0 top-0 rounded-[10px] border text-left transition-[box-shadow,border-color,background] duration-300"
    >
      {n.status === "held" && (
        <>
          <span aria-hidden className="graph-radar pointer-events-none absolute -inset-px rounded-[11px] border-[1.5px]" style={{ borderColor: STAGE_COLOR.hold }} />
          <span
            aria-hidden
            className="graph-radar pointer-events-none absolute -inset-px rounded-[11px] border-[1.5px] [animation-delay:0.9s]"
            style={{ borderColor: STAGE_COLOR.gate }}
          />
        </>
      )}

      {n.badge && n.size !== "sm" && (
        <span
          className="absolute -top-2 right-2.5 inline-flex h-4 max-w-[70%] items-center truncate rounded-[5px] border bg-raised px-1.5 font-mono text-[9px] font-semibold uppercase tracking-wide"
          style={{ color: inkMix, borderColor: "color-mix(in oklab, var(--c) 45%, var(--line))" }}
        >
          {n.badge}
        </span>
      )}

      {n.size === "lg" && (
        <span className="flex h-full items-center gap-2.5 px-2.5">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
            style={{ background: "color-mix(in oklab, var(--c) 15%, transparent)", color: inkMix }}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12px] font-semibold tracking-tight text-ink">{n.label}</span>
              <StatusGlyph status={n.status} />
            </span>
            {n.sub && <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-3">{n.sub}</span>}
          </span>
        </span>
      )}

      {n.size === "md" && (
        <span className="flex h-full flex-col justify-center gap-[3px] px-2.5">
          <span className="flex items-center justify-between gap-1.5">
            <span className="font-mono text-[9px] font-medium tracking-[0.12em] text-ink-3">{n.eyebrow}</span>
            <StatusGlyph status={n.status} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="h-3 w-3 shrink-0" style={{ color: inkMix }} />
            <span className="truncate font-mono text-[11px] font-semibold text-ink">{n.label}</span>
          </span>
          {n.sub && <span className="truncate text-[10px] leading-tight text-ink-3">{n.sub}</span>}
        </span>
      )}

      {n.size === "sm" && (
        <span className="flex h-full flex-col justify-center gap-[2px] px-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="h-3 w-3 shrink-0" style={{ color: inkMix }} />
            <span className="truncate text-[10.5px] font-medium text-ink">{n.label}</span>
          </span>
          <span className="truncate pl-[18px] font-mono text-[9.5px] leading-tight" style={{ color: n.badge ? inkMix : "var(--ink-3)" }}>
            {n.badge ?? n.sub ?? STATUS_LABEL[n.status]}
          </span>
        </span>
      )}
    </motion.button>
  );
}

// ---------------------------------------------------------------- edges
const BASE_OPACITY: Record<GEdge["state"], number> = {
  idle: 0.9,
  ready: 0.38,
  active: 0.5,
  done: 0.72,
  held: 0.95,
  failed: 0.7,
  ghost: 1,
};

function GraphEdge({ e, highlight, dimmed, gradientId, reduce }: { e: GEdge; highlight: boolean; dimmed: boolean; gradientId: string; reduce: boolean }) {
  const color =
    e.state === "failed"
      ? "var(--danger)"
      : e.state === "idle"
      ? "var(--line-strong)"
      : e.state === "held"
      ? STAGE_COLOR.hold
      : STAGE_COLOR[e.stage];
  const width = highlight ? 2.4 : 1.6;
  const opacity = dimmed ? 0.14 : highlight ? 1 : BASE_OPACITY[e.state];
  const t = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 260, damping: 30 };

  if (e.state === "ghost" || e.state === "held") {
    return (
      <motion.path
        initial={false}
        animate={{ d: e.d, opacity }}
        transition={t}
        className={e.state === "ghost" ? "graph-ghost" : "graph-held"}
        fill="none"
        stroke={e.state === "ghost" ? `url(#${gradientId})` : color}
        strokeWidth={width + 0.4}
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 4px ${e.state === "ghost" ? STAGE_COLOR.anticipate : color})` }}
      />
    );
  }

  const packet = e.state === "active" ? "graph-packet" : e.state === "done" ? "graph-packet-slow" : null;
  return (
    <g>
      <motion.path
        initial={reduce ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, d: e.d, opacity }}
        transition={{ ...t, pathLength: reduce ? { duration: 0 } : { duration: 0.6, ease: [0.2, 0.8, 0.2, 1] } }}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
      />
      {packet && !dimmed && (
        <motion.path
          initial={false}
          animate={{ d: e.d }}
          transition={t}
          className={packet}
          fill="none"
          stroke={color}
          strokeWidth={e.state === "active" ? width + 1.2 : width + 0.6}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 ${e.state === "active" ? 5 : 3}px ${color})` }}
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
    <div className="min-w-0 rounded-md border border-line bg-sunken/70 px-2 py-1.5" title={title}>
      <div className="text-[9px] font-medium uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx("truncate text-[11.5px] text-ink tabular", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function NodeInspector({
  node,
  onClose,
  onDecide,
  onAcceptOffer,
  onDismissOffer,
}: {
  node: GNode;
  onClose: () => void;
  onDecide: (reqId: string, ok: boolean) => void;
  onAcceptOffer: (id: string) => void;
  onDismissOffer: (id: string) => void;
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

  return (
    <motion.aside
      data-graph-ui
      key={node.id}
      initial={{ opacity: 0, x: 14, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 10, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      aria-label={`${d.title} inspector`}
      className="absolute right-2 top-2 z-20 flex max-h-[calc(100%-16px)] flex-col overflow-hidden rounded-xl border border-line bg-raised/90 shadow-float backdrop-blur-md"
      style={{ width: `min(${INSPECTOR_W}px, calc(100% - 16px))`, "--c": c } as CSSProperties}
    >
      <div className="flex shrink-0 items-start gap-2.5 border-b border-line px-3 py-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: "color-mix(in oklab, var(--c) 15%, transparent)", color: inkMix }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold leading-snug tracking-tight text-ink">{d.title}</div>
          <div className="mt-1">
            <Chip tone={STATUS_TONE[node.status]}>{STATUS_LABEL[node.status]}</Chip>
          </div>
        </div>
        <button type="button" onClick={act(onClose)} aria-label="Close inspector" className={cx(btn("ghost", "sm"), "h-6 w-6 px-0")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {d.summary && <p className="text-[11.5px] leading-relaxed text-ink-2">{d.summary}</p>}

        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="Latency" value={d.latencyMs ? `${d.latencyMs} ms` : "—"} />
          <Metric label="Cost" value={d.costEur ? `€${d.costEur.toFixed(4)}` : "—"} />
          <Metric label="Receipt" value={sha ? (sha === "unavailable" ? "n/a" : sha.slice(0, 10)) : "—"} title={sha ? `sha256 ${sha}` : "No reversible receipt yet"} />
        </div>

        {d.facts.length > 0 && (
          <dl className="space-y-1.5">
            {d.facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="grid grid-cols-[76px_1fr] gap-2 text-[11px] leading-snug">
                <dt className="pt-px text-[9.5px] font-medium uppercase tracking-wider text-ink-3">{f.label}</dt>
                <dd className={cx("min-w-0 break-words text-ink", f.mono && "font-mono text-[10.5px]")}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {d.args !== undefined && (
          <div>
            <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wider text-ink-3">{d.argsLabel ?? "Arguments"}</div>
            <pre className="scroll-thin max-h-36 overflow-auto rounded-md border border-line bg-code p-2 font-mono text-[10.5px] leading-relaxed text-ink-2">{json(d.args)}</pre>
          </div>
        )}

        {d.code && (
          <div>
            <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wider text-ink-3">Source</div>
            <pre className="scroll-thin max-h-44 overflow-auto whitespace-pre rounded-md border border-line bg-code p-2 font-mono text-[10.5px] leading-relaxed text-ink-2">{d.code}</pre>
          </div>
        )}

        {sha && sha !== "unavailable" && (
          <div className="break-all rounded-md border border-dashed border-line px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-ink-3">sha256 · {sha}</div>
        )}
      </div>

      {d.action?.kind === "approval" && (
        <div className="flex shrink-0 gap-1.5 border-t border-line bg-surface/80 px-3 py-2.5">
          <button type="button" onClick={act(() => onDecide((d.action as { reqId: string }).reqId, true))} className={cx(btn("ok", "md"), "flex-1")}>
            Approve
          </button>
          <button type="button" onClick={act(() => onDecide((d.action as { reqId: string }).reqId, false))} className={cx(btn("danger", "md"), "flex-1")}>
            Reject
          </button>
        </div>
      )}
      {d.action?.kind === "offer" && (
        <div className="flex shrink-0 gap-1.5 border-t border-line bg-surface/80 px-3 py-2.5">
          <button type="button" onClick={act(() => onAcceptOffer((d.action as { offerId: string }).offerId))} className={cx(btn("signal", "md"), "flex-1")}>
            Accept
          </button>
          <button type="button" onClick={act(() => onDismissOffer((d.action as { offerId: string }).offerId))} className={btn("outline", "md")}>
            Dismiss
          </button>
        </div>
      )}
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
  dockAnchor = false,
  className,
}: {
  graph: ThoughtGraph;
  onDecide: (reqId: string, ok: boolean) => void;
  onAcceptOffer: (id: string) => void;
  onDismissOffer: (id: string) => void;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const focusId = selected?.id ?? hoverId;
  const path = useMemo(() => (focusId ? connectedTo(focusId, graph.edges) : null), [focusId, graph.edges]);
  const status = graphStatus(graph);

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
    const k = clamp(Math.min((size.w - 24) / graph.width, (size.h - 24) / graph.height), MIN_K, 1.15);
    setView({ k, x: (size.w - graph.width * k) / 2, y: (size.h - graph.height * k) / 2 });
  }, [size.w, size.h, graph.width, graph.height]);

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

  const gateHeld = graph.nodes.some((n) => n.id === "gate" && n.status === "held");
  useEffect(() => {
    if (gateHeld) setSelectedId((s) => s ?? "gate");
  }, [gateHeld]);

  useEffect(() => {
    if (selectedId && !graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [graph.nodes, selectedId]);

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

  const ctl = cx(btn("ghost", "sm"), "h-6 w-6 px-0");

  return (
    <Panel
      title="Thought Graph"
      icon={<BrainCircuit />}
      meta={<Chip tone={status.tone}>{status.label}</Chip>}
      actions={
        <div data-graph-ui className="flex items-center gap-0.5">
          <button type="button" className={ctl} onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-9 text-center font-mono text-[10.5px] text-ink-3 tabular">{Math.round(view.k * 100)}%</span>
          <button type="button" className={ctl} onClick={() => zoomAt(1.2)} aria-label="Zoom in" title="Zoom in (+)">
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={ctl} onClick={refit} aria-label="Fit graph to view" title="Fit to view (0)">
            <Maximize className="h-3.5 w-3.5" />
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
            />
          )}
        </AnimatePresence>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-line px-3">
        <span className="min-w-0 truncate text-[10.5px] text-ink-3">
          {graph.empty ? "Assign a goal — the plan branches here live." : "Drag to pan · ⌘/Ctrl + scroll to zoom · arrows to traverse"}
        </span>
        <span className="hidden shrink-0 items-center gap-2.5 sm:flex" aria-label="Legend">
          {LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1 text-[10px] text-ink-3">
              <svg width="12" height="4" aria-hidden>
                <line x1="1" y1="2" x2="11" y2="2" stroke={l.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={l.dashed ? "3 2" : undefined} />
              </svg>
              {l.label}
            </span>
          ))}
        </span>
      </div>
    </Panel>
  );
}
