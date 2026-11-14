import { AnimatePresence, motion, useAnimate } from "framer-motion";
import {
  Activity,
  BadgeCheck,
  Braces,
  Check,
  CheckCircle2,
  Circle,
  Database,
  FileCode2,
  FileSpreadsheet,
  Lock,
  Pin,
  PinOff,
  Sparkles,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { anchorCenter } from "../lib/anchors";
import { highlightLine } from "../lib/highlight";
import { soundFx } from "../lib/sound";
import { PACE, type Speed } from "../lib/speed";
import type { DockTarget, LiveWin, WindowKind } from "../lib/types";
import { SANDBOX_SECURITY_SEAL } from "../lib/windows";
import { cx, TONE, type Tone } from "./ui";

const KIND_META: Record<
  WindowKind,
  {
    tone: Tone;
    icon: typeof Braces;
    hex: string;
    defaultCategory: string;
  }
> = {
  forge: {
    tone: "forge",
    icon: Braces,
    hex: "#A855F7",
    defaultCategory: "SANDBOX · FORGING PYTHON TOOL",
  },
  editor: {
    tone: "warn",
    icon: FileCode2,
    hex: "#F59E0B",
    defaultCategory: "WORKSPACE · WRITING STAGED FILE",
  },
  exec: {
    tone: "warn",
    icon: SquareTerminal,
    hex: "#F59E0B",
    defaultCategory: "WORKSPACE · WRITING STAGED FILE",
  },
  sqlite: {
    tone: "ok",
    icon: Database,
    hex: "#10B981",
    defaultCategory: "ERP & AADE · STAGING DB MUTATION",
  },
};

type Phase = "pop" | "typing" | "hold" | "docking";

/** Lightweight XML tag/attribute syntax highlighter for AADE myDATA & .xml artifacts. */
function highlightXmlLine(line: string): ReactNode {
  const trimmed = line.trim();
  if (trimmed.startsWith("<!--")) {
    return <span className="italic text-ink-3">{line}</span>;
  }
  if (trimmed.startsWith("<?xml")) {
    return <span className="font-medium text-signal">{line}</span>;
  }
  const out: ReactNode[] = [];
  const re = /(<\/?[\w:-]+)|(\/?>)|([\w:-]+)(=)("[^"]*"|'[^']*')/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1]) {
      out.push(
        <span key={k++} className="font-semibold text-signal">
          {m[1]}
        </span>
      );
    } else if (m[2]) {
      out.push(
        <span key={k++} className="font-semibold text-signal">
          {m[2]}
        </span>
      );
    } else if (m[3]) {
      out.push(
        <span key={k++}>
          <span className="text-warn">{m[3]}</span>
          <span className="text-ink-3">{m[4]}</span>
          <span className="text-ok">{m[5]}</span>
        </span>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out.length > 0 ? out : line;
}

function isXmlArtifact(win: LiveWin): boolean {
  if (win.lang === "diff") return false;
  const lowerPath = win.path.toLowerCase();
  if (lowerPath.endsWith(".xml")) return true;
  const trimmed = win.code.trimStart();
  return trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.includes("</"));
}

function extractSqliteTable(path: string): string {
  if (path.includes("›")) {
    return path.split("›").pop()!.trim() || "ledger";
  }
  return path.trim() || "ledger";
}

/** Extract clean basename / table target for high-contrast mono pill (<0.2s recognition). */
function extractTargetPill(win: LiveWin): { icon: string; label: string } {
  if (win.kind === "sqlite") {
    if (win.dbMutation) {
      return {
        icon: "🗄️",
        label: `${win.dbMutation.table} · ${win.dbMutation.pk}`,
      };
    }
    const t = extractSqliteTable(win.path);
    if (t.includes("invoice")) {
      return { icon: "🗄️", label: "invoices · INV-7781" };
    }
    if (t.includes("claim")) {
      return { icon: "🗄️", label: "claims · CLM-D-1042" };
    }
    return { icon: "🗄️", label: t };
  }

  if (win.kind === "forge") {
    const raw = win.toolName || win.path.split("/").pop()?.replace(/\.py$/, "") || "compute_supplier_claim";
    const name = raw.endsWith(".py") ? raw : `${raw}.py`;
    return {
      icon: "⚒️",
      label: name,
    };
  }

  if (win.kind === "exec") {
    if (win.path.includes("@") || win.path.includes("send_email")) {
      const match = win.path.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      const email = match ? match[0] : "accounts@kappaoffice.example";
      return {
        icon: "📧",
        label: email,
      };
    }
    if (win.path.includes("place_call")) {
      return {
        icon: "📞",
        label: win.path.split("→").pop()?.trim() || "supplier",
      };
    }
    const raw = win.toolName || win.path.replace(/^staged:\/\//, "").replace(/^workspace\//, "");
    if (raw.endsWith("()") || raw.startsWith("compute_")) {
      const fn = raw.endsWith("()") ? raw : `${raw}()`;
      return {
        icon: "🧮",
        label: fn,
      };
    }
    return {
      icon: "⚡",
      label: raw,
    };
  }

  // editor
  let clean = win.path.replace(/^staged:\/\//, "").replace(/^workspace\//, "");
  const base = clean.split("/").pop() || clean;
  return {
    icon: "📄",
    label: base,
  };
}

/** Two-line live rehearsal telemetry: static facts + measured latency, then lifecycle steps revealed with progress. */
function TelemetryStrip({ win, progress, typing }: { win: LiveWin; progress: number; typing: boolean }) {
  const t = win.telemetry;
  if (!t) return null;
  const tone = TONE[KIND_META[win.kind].tone];
  const latency =
    win.latencyMs && win.latencyMs > 0 ? `exec ${win.latencyMs}ms` : typing ? "exec timing…" : "exec latency ok";
  const doneCount = progress >= 1 ? t.steps.length : Math.floor(progress * t.steps.length);
  return (
    <div className="space-y-0.5 border-t border-line bg-sunken/70 px-2.5 py-1.5 font-mono text-[10px] leading-[1.4]" aria-label="Live rehearsal telemetry">
      <div className="flex min-w-0 items-center gap-1.5 text-ink-2">
        <Activity className={cx("h-2.5 w-2.5 shrink-0", tone.text, typing && "animate-pulse")} />
        <span className="truncate">
          {[...t.facts, latency].map((f, i) => (
            <span key={i}>
              {i > 0 && <span className="px-1 text-ink-3">·</span>}
              {f.replace(/\bpk_col\b/g, "Record ID")}
            </span>
          ))}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-ink-3">
        <span className="shrink-0 pr-0.5 text-ink-3">stdout ›</span>
        {t.steps.map((step, i) => {
          const done = i < doneCount;
          const active = i === doneCount && typing;
          const label = step.replace(/\bpk_col\b/g, "Record ID");
          return (
            <span
              key={step}
              className={cx(
                "inline-flex shrink-0 items-center gap-0.5 transition-colors duration-300",
                done ? "text-ink-2" : active ? tone.text : "opacity-45"
              )}
            >
              {done ? (
                <Check className="h-2.5 w-2.5 text-ok" />
              ) : (
                <span className={cx("h-1 w-1 rounded-full", active ? cx(tone.dot, "animate-pulse") : "bg-ink-3")} />
              )}
              {label}
              {i < t.steps.length - 1 && <span className="pl-0.5 text-ink-3">→</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DatabaseRowMorphVisual({
  mutation,
  progress,
  typing,
}: {
  mutation: NonNullable<LiveWin["dbMutation"]>;
  progress: number;
  typing: boolean;
}) {
  const isCommit = mutation.mode === "LIVE ERP COMMIT";
  const scanProgress = Math.min(1, progress / 0.55);
  const morphed = progress >= 0.45;

  return (
    <div className="border-b border-line bg-surface/95 p-2 font-mono text-[10.5px]">
      <div className="mb-1 flex items-center justify-between gap-1.5 border-b border-line/60 pb-1">
        <div className="flex items-center gap-1 font-bold text-ink">
          <Database className="h-3 w-3 text-ok" />
          <span>
            SQLite ERP · <span className="text-signal">{mutation.table}</span>
          </span>
        </div>
        <span
          className={cx(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.2 text-[9px] font-bold tracking-wider transition-all duration-300",
            isCommit
              ? "border border-emerald-400/80 bg-emerald-950/80 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.35)] animate-pulse"
              : "border border-cyan-400/50 bg-cyan-950/60 text-cyan-300"
          )}
        >
          {isCommit ? "⚡ LIVE ERP COMMIT" : "STAGE IN CLONE"}
        </span>
      </div>

      <div className="relative overflow-hidden rounded-md border border-line bg-sunken/80 p-2 shadow-inner">
        {typing && scanProgress < 1 && (
          <motion.div
            className="pointer-events-none absolute inset-y-0 w-8 bg-gradient-to-r from-transparent via-emerald-400/35 to-transparent blur-sm"
            style={{ left: `${scanProgress * 100}%` }}
          />
        )}

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 items-center">
          <div>
            <div className="text-[9px] uppercase text-ink-3">Record ID</div>
            <div className="font-bold text-ink truncate text-[10px]">{mutation.pk}</div>
          </div>

          {mutation.summaryCols.slice(0, 2).map((col, idx) => (
            <div key={idx} className="min-w-0">
              <div className="text-[9px] uppercase text-ink-3 truncate">{col.label}</div>
              <div className="text-ink truncate text-[10px]">{col.value}</div>
            </div>
          ))}

          <div>
            <div className="text-[9px] uppercase text-ink-3">Status Mutation</div>
            <div className="flex items-center gap-1">
              {!morphed ? (
                <span className="inline-flex items-center rounded border border-slate-700 bg-slate-800/90 px-1 py-0.2 text-[9px] font-medium text-slate-300">
                  {mutation.beforeStatus ?? "active"}
                </span>
              ) : (
                <div className="flex items-center gap-1">
                  {mutation.beforeStatus && (
                    <span className="text-[9px] text-rose-400/70 line-through">
                      {mutation.beforeStatus}
                    </span>
                  )}
                  <span
                    className={cx(
                      "inline-flex items-center gap-1 rounded border px-1 py-0.2 text-[9.5px] font-bold shadow-sm transition-all duration-300",
                      isCommit
                        ? "border-emerald-500/80 bg-emerald-500/20 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                        : "border-amber-500/80 bg-amber-500/20 text-amber-300"
                    )}
                  >
                    {mutation.afterStatus}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {mutation.amount && (
          <div className="mt-1 flex items-center justify-between border-t border-line/40 pt-1 text-[9.5px]">
            <span className="text-ink-3">Mutation Ledger Impact:</span>
            <span className="font-bold text-emerald-400">{mutation.amount}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ForgeAnvilRightPane({ win, progress }: { win: LiveWin; progress: number; typing: boolean }) {
  const isRegistered = (win.forgeStage === "verified" || win.doneLabel === "REGISTERED") && progress >= 1;
  const totalTests = win.assertions?.length ? win.assertions.length : 3;
  const passedCount = win.assertions?.length ? win.assertions.filter((a) => a.ok).length : 3;
  const testRatio = `${passedCount}/${totalTests} TESTS PASSED`;

  return (
    <div
      aria-label="Forge Blacksmith Anvil & Hammer"
      className={cx(
        "relative flex h-full min-h-[170px] flex-col justify-between overflow-hidden rounded-lg border p-2 transition-colors duration-500",
        isRegistered
          ? "border-emerald-500/50 bg-gradient-to-b from-slate-950 via-emerald-950/40 to-slate-950 text-emerald-200"
          : "border-purple-500/40 bg-gradient-to-b from-slate-950 via-[#241242] to-slate-950 text-purple-200"
      )}
    >
      {/* Background ambient forge glow */}
      <div
        className={cx(
          "pointer-events-none absolute -left-6 top-1/2 h-20 w-36 -translate-y-1/2 rounded-full blur-xl transition-colors duration-500",
          isRegistered ? "bg-emerald-500/25" : "bg-amber-500/20"
        )}
      />

      {/* Hammer-on-Anvil SVG */}
      <div className="relative flex shrink-0 items-center justify-center py-0.5">
        <svg viewBox="0 0 190 90" className="h-16 w-32 drop-shadow-md" aria-hidden="true">
          <defs>
            <linearGradient id="anvilBodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#64748b" />
              <stop offset="40%" stopColor="#334155" />
              <stop offset="100%" stopColor="#0f172a" />
            </linearGradient>
            <linearGradient id="hammerHeadGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#f1f5f9" />
              <stop offset="50%" stopColor="#94a3b8" />
              <stop offset="100%" stopColor="#475569" />
            </linearGradient>
            <radialGradient id="strikeFlashGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#fef08a" />
              <stop offset="70%" stopColor="#f97316" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
            </radialGradient>
            <filter id="forgeGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3.5" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Anvil Base */}
          <path d="M 28 82 L 136 82 L 122 68 L 42 68 Z" fill="#1e293b" stroke="#475569" strokeWidth="1.2" />
          {/* Anvil Waist */}
          <path d="M 52 68 C 52 56, 60 50, 60 44 L 106 44 C 106 50, 114 56, 114 68 Z" fill="url(#anvilBodyGrad)" />
          {/* Anvil Horn and Face */}
          <path
            d="M 14 44 C 28 44, 42 41, 56 41 L 146 41 L 146 50 L 128 50 C 122 50, 116 54, 110 54 L 56 54 C 42 54, 28 48, 14 44 Z"
            fill="url(#anvilBodyGrad)"
            stroke="#64748b"
            strokeWidth="1.2"
          />
          <line x1="56" y1="41" x2="146" y2="41" stroke="#e2e8f0" strokeWidth="2.5" strokeLinecap="round" />

          {!isRegistered ? (
            <>
              <circle cx="102" cy="41" r="7" fill="#f59e0b" opacity="0.65" filter="url(#forgeGlow)" />
              <circle cx="102" cy="41" r="3" fill="#fef08a" />

              {/* Steel Hammer swinging rhythmically */}
              <motion.g
                animate={{
                  rotate: [0, -42, -42, 6, 0],
                }}
                transition={{
                  repeat: Infinity,
                  duration: 0.65,
                  times: [0, 0.25, 0.45, 0.62, 0.65],
                  ease: "easeInOut",
                }}
                style={{ transformOrigin: "90px 14px" }}
              >
                <rect x="87" y="10" width="6" height="34" rx="3" fill="#d97706" stroke="#78350f" strokeWidth="1" />
                <rect x="74" y="34" width="30" height="13" rx="2.5" fill="url(#hammerHeadGrad)" stroke="#cbd5e1" strokeWidth="1" />
                <line x1="76" y1="36" x2="102" y2="36" stroke="#ffffff" strokeWidth="1" opacity="0.8" />
              </motion.g>

              {/* Impact flash */}
              <motion.ellipse
                cx="102"
                cy="41"
                rx="18"
                ry="10"
                fill="url(#strikeFlashGrad)"
                filter="url(#forgeGlow)"
                animate={{
                  opacity: [0, 0, 1, 0],
                  scale: [0.3, 0.3, 1.4, 0],
                }}
                transition={{
                  repeat: Infinity,
                  duration: 0.65,
                  times: [0, 0.58, 0.63, 0.75],
                  ease: "easeOut",
                }}
              />

              {/* Sparks erupting on each strike */}
              <g transform="translate(102, 41)">
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2.2}
                  fill="#fde047"
                  animate={{ x: [0, 24, 38], y: [0, -18, -26], opacity: [0, 1, 0], scale: [0.6, 1.4, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.65, 0.88], ease: "easeOut" }}
                />
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2}
                  fill="#f97316"
                  animate={{ x: [0, -22, -34], y: [0, -16, -24], opacity: [0, 1, 0], scale: [0.6, 1.3, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.64, 0.86], ease: "easeOut" }}
                />
                <motion.circle
                  cx={0}
                  cy={0}
                  r={1.8}
                  fill="#ffffff"
                  animate={{ x: [0, 8, 14], y: [0, -28, -38], opacity: [0, 1, 0], scale: [0.5, 1.3, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.66, 0.9], ease: "easeOut" }}
                />
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2.4}
                  fill="#f59e0b"
                  animate={{ x: [0, 32, 48], y: [0, -8, -14], opacity: [0, 1, 0], scale: [0.6, 1.5, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.66, 0.92], ease: "easeOut" }}
                />
              </g>
            </>
          ) : (
            <>
              {/* Resting Hammer */}
              <g transform="translate(18, 22) rotate(36 80 34)">
                <rect x="77" y="10" width="6" height="34" rx="3" fill="#78350f" opacity="0.85" />
                <rect x="64" y="34" width="30" height="13" rx="2.5" fill="url(#hammerHeadGrad)" stroke="#64748b" strokeWidth="1" />
              </g>
              {/* Starburst Checkmark */}
              <g transform="translate(102, 30)">
                <circle cx="0" cy="0" r="14" fill="#10b981" filter="url(#forgeGlow)" opacity="0.95" />
                <path d="M -5.5 0 L -1.5 4 L 6 -3.5" fill="none" stroke="#ffffff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="0" y1="-18" x2="0" y2="-23" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
                <line x1="15" y1="-10" x2="20" y2="-13" stroke="#34d399" strokeWidth="2" strokeLinecap="round" />
                <line x1="15" y1="10" x2="20" y2="13" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
                <line x1="-15" y1="-10" x2="-20" y2="-13" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
                <line x1="-15" y1="10" x2="-20" y2="13" stroke="#34d399" strokeWidth="2" strokeLinecap="round" />
              </g>
            </>
          )}
        </svg>
      </div>

      {/* Status banner underneath anvil */}
      {!isRegistered ? (
        <div className="space-y-0.5 text-center">
          <div className="flex items-center justify-center gap-1 font-mono text-[10px] font-bold tracking-wide text-amber-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
            </span>
            <span>HAMMERING PYTHON AST</span>
          </div>
          <div className="text-[9.5px] text-purple-200/90 leading-tight">
            Synthesizing pure-stdlib tool in sandbox
          </div>
        </div>
      ) : (
        <div className="space-y-1 text-center">
          <div className="rounded border border-emerald-500/70 bg-emerald-950/70 p-1 shadow-[0_0_12px_rgba(16,185,129,0.35)]">
            <div className="flex items-center justify-center gap-1 font-mono text-[10px] font-bold text-emerald-300">
              <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
              <span>✅ 3/3 TESTS PASSED</span>
            </div>
            <div className="text-[9px] font-mono text-emerald-200/80">
              7-LAYER SEALED · {testRatio}
            </div>
          </div>
          <div className="text-[9.5px] font-medium text-emerald-300 flex items-center justify-center gap-1">
            <Sparkles className="h-2.5 w-2.5 text-amber-300 animate-pulse" />
            <span>Pulling into Agent Toolbox ↙</span>
          </div>
        </div>
      )}
    </div>
  );
}

function LiveWindowCard({
  win,
  speed,
  stackIndex,
  isFocusLocked,
  countdownSec,
  onDocked,
  onTogglePin,
  onBringToFront,
}: {
  win: LiveWin;
  speed: Speed;
  stackIndex: number;
  isFocusLocked: boolean;
  countdownSec: number;
  onDocked: (id: string, target: DockTarget | null) => void;
  onTogglePin: (id: string) => void;
  onBringToFront: (id: string) => void;
}) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [phase, setPhase] = useState<Phase>("pop");
  const [progress, setProgress] = useState(win.instant ? 1 : 0);

  const pinnedRef = useRef(win.pinned);
  pinnedRef.current = win.pinned;
  const paceRef = useRef(PACE[speed]);
  paceRef.current = PACE[speed];
  const dockingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const meta = KIND_META[win.kind];
  const tone = TONE[meta.tone];
  const Icon = meta.icon;

  // Defensive guard: release skipAutoPop immediately if un-manual
  useEffect(() => {
    if (win.skipAutoPop && !win.manual && !dockingRef.current) {
      dockingRef.current = true;
      onDocked(win.id, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background tabs pause requestAnimationFrame; never let a hidden tab stall
  useEffect(() => {
    const finishIfHidden = () => {
      if (document.hidden && !pinnedRef.current && !dockingRef.current) {
        dockingRef.current = true;
        onDocked(win.id, win.target);
      }
    };
    const t = window.setTimeout(finishIfHidden, 0);
    document.addEventListener("visibilitychange", finishIfHidden);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", finishIfHidden);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track code/stage signature to detect when forge transitions from spec to verified Python code
  const prevSigRef = useRef<string>("");
  useEffect(() => {
    const isRealPython = win.code.includes("def ") && win.code.length > 80;
    const sig = `${win.id}:${win.forgeStage ?? ""}:${win.code.length}`;
    if (prevSigRef.current && prevSigRef.current !== sig) {
      if (win.kind === "forge" && (win.forgeStage === "verified" || isRealPython)) {
        dockingRef.current = false;
        setProgress(0);
        setPhase("typing");
      }
    }
    prevSigRef.current = sig;
  }, [win.id, win.forgeStage, win.code, win.kind]);

  // Stage 1 — origin pop: spring into the deck position
  useLayoutEffect(() => {
    if (win.skipAutoPop && !win.manual) return;
    const el = scope.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const origin = anchorCenter(win.origin) ?? { x: r.left + r.width / 2, y: window.innerHeight };
    const dx = origin.x - (r.left + r.width / 2);
    const dy = origin.y - (r.top + r.height / 2);
    const pop = paceRef.current.pop / 1000;
    (async () => {
      await animate(el, { x: dx, y: dy, scale: 0.1, opacity: 0, filter: "blur(8px)" }, { duration: 0 });
      await animate(
        el,
        { x: 0, y: 0, scale: 1, opacity: 1, filter: "blur(0px)" },
        { type: "spring", duration: pop, bounce: 0.2, opacity: { duration: pop * 0.5 }, filter: { duration: pop * 0.7 } }
      );
      setPhase(win.instant ? "hold" : "typing");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stage 2 — typewriter. Pinning pauses it.
  useEffect(() => {
    if (phase !== "typing") return;
    let raf = 0;
    let last = performance.now();
    let p = progress;
    const isForgeTyping = win.kind === "forge" && win.code.includes("def ");
    const typeDur = isForgeTyping
      ? (paceRef.current.forgeTypeMs ?? 1700)
      : (paceRef.current.typeMs ?? paceRef.current.type);

    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (!pinnedRef.current) p = Math.min(1, p + dt / typeDur);
      setProgress(p);
      if (p >= 1) setPhase("hold");
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, win.kind, win.code]);

  // Anvil clangs during forge typing
  const lastClangStrikeRef = useRef(0);
  useEffect(() => {
    if (phase === "typing" && win.kind === "forge") {
      const currentStrike = progress >= 0.82 ? 3 : progress >= 0.52 ? 2 : progress >= 0.22 ? 1 : 0;
      if (currentStrike > lastClangStrikeRef.current) {
        lastClangStrikeRef.current = currentStrike;
        soundFx.playForgeAnvilClang();
      }
    } else if (phase === "pop" || progress === 0) {
      lastClangStrikeRef.current = 0;
    }
  }, [progress, phase, win.kind]);

  // Stage 3 — hold: auto-dock into destination unless pinned OR focus-locked
  useEffect(() => {
    if (phase !== "hold" || win.pinned || isFocusLocked) return;
    const isForge = win.kind === "forge";
    const holdDuration = isForge
      ? (paceRef.current.forgeHoldMs ?? 2200)
      : (paceRef.current.holdMs ?? paceRef.current.hold);
    const t = window.setTimeout(() => dock(), holdDuration);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, win.pinned, isFocusLocked, win.kind]);

  // Scroll to bottom while typing
  useEffect(() => {
    const b = bodyRef.current;
    if (b && phase === "typing") b.scrollTop = b.scrollHeight;
  }, [progress, phase]);

  const dock = async () => {
    if (dockingRef.current) return;
    dockingRef.current = true;
    setPhase("docking");
    const el = scope.current;
    if (!el) {
      onDocked(win.id, win.target);
      return;
    }
    const r = el.getBoundingClientRect();
    const target = anchorCenter(win.target);
    const dur = win.kind === "forge" ? 0.48 : paceRef.current.dock / 1000;
    if (target) {
      const dx = target.x - (r.left + r.width / 2);
      const dy = target.y - (r.top + r.height / 2);
      await animate(
        el,
        {
          x: [0, dx * 0.12, dx * 0.6, dx],
          y: [0, dy * 0.04 - 36, dy * 0.55, dy],
          scaleX: [1, 0.9, 0.32, 0.04],
          scaleY: [1, 0.94, 0.22, 0.03],
          opacity: [1, 1, 0.9, 0],
          filter: ["blur(0px)", "blur(0px)", "blur(2px)", "blur(6px)"],
        },
        { duration: dur, ease: [0.5, 0, 0.75, 0.15], times: [0, 0.25, 0.7, 1] }
      );
    } else {
      await animate(el, { opacity: 0, scale: 0.9 }, { duration: dur * 0.6 });
    }
    onDocked(win.id, target ? win.target : null);
  };

  if (win.skipAutoPop && !win.manual) return null;

  const total = win.code.length;
  const shownChars = Math.floor(total * progress);
  const shown = win.code.slice(0, shownChars);
  const lines = shown.split("\n");
  const allLines = win.code.split("\n").length;
  const typing = phase === "typing" || phase === "pop";

  // Key clicks
  const typedLines = lines.length;
  useEffect(() => {
    if (phase === "typing" && !win.pinned && typedLines > 1) soundFx.playKeyTick(typedLines);
  }, [typedLines, phase, win.pinned]);

  const pct = Math.round(progress * 100);
  const n = win.assertions.length;
  const resolved = win.assertions.map((_, i) => progress >= 0.4 + (0.6 * (i + 1)) / n - 0.001);
  const allOk = win.assertions.every((a) => a.ok);

  const status = win.pinned
    ? { label: "PINNED", tone: "neutral" as Tone }
    : phase === "docking"
    ? { label: "DOCKING…", tone: meta.tone }
    : phase === "hold"
    ? { label: win.doneLabel, tone: allOk ? ("ok" as Tone) : ("danger" as Tone) }
    : { label: win.liveLabel, tone: meta.tone };

  const isForge = win.kind === "forge";
  const isForgeRegistered = isForge && win.doneLabel === "REGISTERED";
  const forgeBannerTitle = isForgeRegistered
    ? "⚒️ FORGED & VERIFIED — TOOLBOX ↘"
    : "⚒️ THE FORGE — SYNTHESIZING";
  const bannerTitle = isForge ? forgeBannerTitle : (win.categoryBadge ?? meta.defaultCategory);
  const isSqlite = win.kind === "sqlite";
  const isWorkspaceFile = win.kind === "editor" || win.kind === "exec";
  const securityPills = isForge ? (win.securitySeal?.length ? win.securitySeal : [...SANDBOX_SECURITY_SEAL]) : null;
  const renderAsXml = isXmlArtifact(win);
  const targetPill = extractTargetPill(win);

  return (
    <div
      ref={scope}
      style={{
        boxShadow:
          stackIndex === 0
            ? isForgeRegistered
              ? "var(--shadow-float), 0 0 0 2px #10B981, 0 0 38px -4px rgba(16, 185, 129, 0.55), 0 0 20px rgba(245, 158, 11, 0.35)"
              : isForge
              ? "var(--shadow-float), 0 0 0 1.5px #A855F7, 0 0 38px -6px rgba(168, 85, 247, 0.45)"
              : `var(--shadow-float), 0 0 0 1.5px color-mix(in oklab, ${meta.hex} 65%, transparent), 0 0 38px -8px color-mix(in oklab, ${meta.hex} 60%, transparent)`
            : "0 8px 26px -4px rgba(0, 0, 0, 0.65), 0 0 14px rgba(56, 189, 248, 0.28)",
      }}
      className={cx(
        "group relative overflow-hidden rounded-xl bg-raised transition-all duration-300",
        isForge ? "w-[min(560px,92vw)]" : "w-[min(450px,88vw)]",
        stackIndex > 0 && "cursor-pointer ring-1 ring-sky-400/40 hover:ring-sky-400/80"
      )}
    >
      {/* Top Banner: Archetype Banner + Prominent 13px High-Contrast Mono Pill */}
      <div
        onClick={() => {
          if (stackIndex > 0) onBringToFront(win.id);
        }}
        className={cx(
          "flex min-h-[36px] items-center justify-between gap-2 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] transition-all duration-300",
          isForge &&
            (isForgeRegistered
              ? "bg-gradient-to-r from-emerald-600 via-teal-600 to-amber-500 text-white shadow-[0_0_24px_rgba(16,185,129,0.45)]"
              : "bg-gradient-to-r from-[#581c87] via-[#7e22ce] to-[#9333ea] text-white shadow-[0_0_20px_rgba(168,85,247,0.35)]"),
          isWorkspaceFile && "bg-[#F59E0B] text-slate-950",
          isSqlite && "bg-[#10B981] text-slate-950"
        )}
      >
        {/* Left: Archetype Icon + Category / Badge */}
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0 stroke-[2.4]" />
          <span className="truncate max-w-[120px] sm:max-w-[155px]">{bannerTitle}</span>
        </div>

        {/* Right: Focus Lock pill (if front) + Bold 13px Filename / Table Pill */}
        <div className="flex shrink-0 items-center gap-1.5">
          {isFocusLocked && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/90 bg-amber-950/80 px-2 py-0.5 font-mono text-[10.5px] font-bold text-amber-300 shadow-sm animate-pulse">
              <Lock className="h-2.5 w-2.5 text-amber-300" />
              <span>🔒 Viewing · {countdownSec}s</span>
            </span>
          )}

          {/* Prominent High-Contrast Filename/Table Pill */}
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-900/60 bg-slate-950/95 px-2.5 py-0.5 font-mono text-[13px] font-bold tracking-tight text-white shadow-md">
            <span>{targetPill.icon}</span>
            <span className="text-white">{targetPill.label}</span>
          </span>

          {stackIndex > 0 && !isFocusLocked && (
            <span className="hidden sm:inline-flex shrink-0 items-center rounded border border-black/30 bg-black/40 px-1.5 py-0.5 text-[9.5px] font-semibold text-white/90">
              Peek
            </span>
          )}
        </div>
      </div>

      {/* Dimming overlay on body for background cards */}
      {stackIndex > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[36px] z-20 bg-slate-950/45 backdrop-blur-[0.5px] transition-opacity duration-200" />
      )}

      {/* Titlebar */}
      <div className="relative flex h-8 items-center gap-2 border-b border-line bg-sunken/85 px-3">
        <div className="flex items-center gap-1.5">
          <button
            aria-label="Dock window now"
            title="Dock window now"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              dock();
            }}
            className="flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f57] ring-1 ring-black/10 hover:brightness-110 active:scale-90 text-[8px] font-bold text-black/60 leading-none"
          >
            ×
          </button>
          <span className="h-3 w-3 rounded-full bg-[#febc2e] ring-1 ring-black/10" />
          <span className="h-3 w-3 rounded-full bg-[#28c840] ring-1 ring-black/10" />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-[11px] font-semibold text-ink">{win.title}</span>
        </div>

        <span
          className={cx(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 font-mono text-[9.5px] font-medium",
            TONE[status.tone].soft,
            TONE[status.tone].border,
            TONE[status.tone].text
          )}
        >
          {typing && !win.pinned && <span className={cx("h-1.5 w-1.5 rounded-full animate-pulse", TONE[status.tone].dot)} />}
          {status.label}
        </span>

        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            soundFx.playUiClick();
            onTogglePin(win.id);
          }}
          aria-pressed={win.pinned}
          title={win.pinned ? "Resume (unpin)" : "Pause & pin window open"}
          className={cx(
            "inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors",
            win.pinned ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink-3 hover:text-ink"
          )}
        >
          {win.pinned ? <PinOff className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5" />}
          {win.pinned ? "Resume" : "Pin"}
        </button>
      </div>

      {/* Security seal strip for Forged Python Tools */}
      {securityPills && (
        <div
          aria-label="Sandbox security seal"
          className="flex flex-wrap items-center gap-1.5 border-b border-[#A855F7]/30 bg-[#A855F7]/[0.09] px-3 py-1"
        >
          <span className="inline-flex items-center gap-1 pr-1 font-mono text-[9.5px] font-bold uppercase tracking-wider text-forge">
            <BadgeCheck className="h-3 w-3 text-ok" />
            SEAL
          </span>
          {securityPills.map((pill, idx) => (
            <span
              key={pill}
              className={cx(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.2 font-mono text-[9.5px] font-semibold tracking-wide",
                idx === securityPills.length - 1
                  ? "border-ok/40 bg-ok/12 text-ok"
                  : "border-[#A855F7]/40 bg-surface/80 text-ink"
              )}
            >
              {pill}
            </span>
          ))}
        </div>
      )}

      {/* Body: Forge Dual-Pane vs Standard Single Pane */}
      {isForge ? (
        <div className="grid grid-cols-1 md:grid-cols-[64%_36%] border-b border-line">
          {/* Left IDE Code Editor (64%) */}
          <div className="relative flex flex-col bg-code border-b md:border-b-0 md:border-r border-line">
            <div className="flex items-center justify-between border-b border-line/60 bg-sunken/60 px-2.5 py-1 font-mono text-[10px] text-ink-3">
              <span className="flex items-center gap-1 text-purple-300 font-semibold truncate">
                <FileCode2 className="h-3 w-3 text-purple-400 shrink-0" />
                tools/{win.toolName || "compute_supplier_claim"}.py
              </span>
              <span className="text-[9.5px] text-ink-3 shrink-0">{pct}%</span>
            </div>
            {typing && (
              <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 top-6 h-10 bg-gradient-to-b to-transparent opacity-50 scanline", tone.soft)} />
            )}
            <div
              ref={bodyRef}
              className="scroll-thin overflow-y-auto max-h-[170px] py-2 font-mono text-[12px] leading-[1.6]"
            >
              {lines.map((line, i) => {
                const active = i === lines.length - 1 && typing;
                return (
                  <div key={i} className={cx("relative flex pr-3", active && tone.soft)}>
                    <span className={cx("absolute inset-y-0 left-0 w-[2.5px]", active ? tone.dot : "bg-transparent")} />
                    <span className={cx("w-8 shrink-0 select-none pr-2 text-right tabular text-[10px]", active ? tone.text : "text-ink-3")}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                      {highlightLine(line, win.lang)}
                      {active && <span className={cx("ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[2px] cursor-blink", tone.dot)} />}
                    </span>
                  </div>
                );
              })}
              {typing && lines.length < allLines && (
                <div className="flex pr-3 opacity-30">
                  <span className="w-8 shrink-0 pr-2 text-right text-ink-3 tabular text-[10px]">{lines.length + 1}</span>
                  <span className="text-ink-3">…</span>
                </div>
              )}
            </div>
          </div>

          {/* Right Pane: Blacksmith Anvil & Hammer (36%) */}
          <div className="flex flex-col justify-between bg-surface/90 p-2">
            <ForgeAnvilRightPane win={win} progress={progress} typing={typing} />
          </div>
        </div>
      ) : (
        <>
          {/* SQLite Row Morph Grid */}
          {win.dbMutation && (
            <DatabaseRowMorphVisual mutation={win.dbMutation} progress={progress} typing={typing} />
          )}

          {/* Code Body */}
          <div className="relative bg-code">
            {typing && (
              <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b to-transparent opacity-50 scanline", tone.soft)} />
            )}
            <div
              ref={bodyRef}
              className={cx(
                "scroll-thin overflow-y-auto py-2 font-mono text-[12px] leading-[1.6]",
                win.dbMutation ? "max-h-[85px]" : "max-h-[135px]"
              )}
            >
              {lines.map((line, i) => {
                const active = i === lines.length - 1 && typing;
                const displayLine = line.replace(/\bpk_col\b/g, "record_id");
                return (
                  <div key={i} className={cx("relative flex pr-3", active && tone.soft)}>
                    <span className={cx("absolute inset-y-0 left-0 w-[2.5px]", active ? tone.dot : "bg-transparent")} />
                    <span className={cx("w-9 shrink-0 select-none pr-2 text-right tabular text-[10.5px]", active ? tone.text : "text-ink-3")}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                      {renderAsXml ? highlightXmlLine(displayLine) : highlightLine(displayLine, win.lang)}
                      {active && <span className={cx("ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[2px] cursor-blink", tone.dot)} />}
                    </span>
                  </div>
                );
              })}
              {typing && lines.length < allLines && (
                <div className="flex pr-3 opacity-30">
                  <span className="w-9 shrink-0 pr-2 text-right text-ink-3 tabular text-[10.5px]">{lines.length + 1}</span>
                  <span className="text-ink-3">…</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Assertions */}
      <div className="flex flex-wrap items-center gap-1 border-t border-line bg-surface px-2.5 py-1.5">
        {win.assertions.map((a, i) => {
          const done = resolved[i];
          const st = !done ? "pending" : a.ok ? "pass" : "fail";
          return (
            <motion.span
              key={a.label}
              animate={done ? { scale: [1, 1.08, 1] } : {}}
              transition={{ duration: 0.35 }}
              className={cx(
                "inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[9.5px]",
                st === "pending" && "border-line bg-sunken text-ink-3",
                st === "pass" && "border-ok/35 bg-ok/10 text-ok",
                st === "fail" && "border-danger/35 bg-danger/10 text-danger"
              )}
            >
              {st === "pending" ? (
                <Circle className="h-2.5 w-2.5 animate-pulse" />
              ) : st === "pass" ? (
                <CheckCircle2 className="h-2.5 w-2.5" />
              ) : (
                <XCircle className="h-2.5 w-2.5" />
              )}
              {a.label.replace(/\bpk_col\b/g, "Record ID")}
              <span className="font-semibold">{st === "pending" ? "PENDING" : st === "pass" ? "PASS" : "FAIL"}</span>
            </motion.span>
          );
        })}
        <span className="ml-auto font-mono text-[9.5px] text-ink-3 tabular">
          {lines.length}/{allLines} ln · {pct}%
        </span>
      </div>

      <TelemetryStrip win={win} progress={progress} typing={typing} />

      {/* Accent progress bar */}
      <div className="h-[2.5px] w-full bg-sunken">
        <div className="h-full transition-[width] duration-75" style={{ width: `${pct}%`, backgroundColor: meta.hex }} />
      </div>
    </div>
  );
}

/**
 * Fixed Bottom-Right Cascading Card Deck with Click-to-Front 8s Focus Lock.
 * Up to 4 windows peek cleanly without pushing off-screen.
 */
export function LiveWindowLayer({
  windows,
  speed,
  onDocked,
  onTogglePin,
}: {
  windows: LiveWin[];
  speed: Speed;
  onDocked: (id: string, target: DockTarget | null) => void;
  onTogglePin: (id: string) => void;
}) {
  const [focusedWinId, setFocusedWinId] = useState<string | null>(null);
  const [focusLockedUntil, setFocusLockedUntil] = useState<number>(0);
  const [, setTick] = useState(0);

  // 1-second countdown tick while focus lock is active
  useEffect(() => {
    if (focusLockedUntil <= Date.now()) return;
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 250);
    return () => clearInterval(interval);
  }, [focusLockedUntil]);

  // Keep up to 4 windows in the deck simultaneously
  const currentDeck = windows.slice(-4);

  const now = Date.now();
  const hasActiveFocus =
    focusedWinId !== null && now < focusLockedUntil && currentDeck.some((w) => w.id === focusedWinId);
  const activeFocusId = hasActiveFocus ? focusedWinId : null;

  const handleBringToFront = (id: string) => {
    soundFx.playUiClick();
    setFocusedWinId(id);
    setFocusLockedUntil(Date.now() + 8000);
  };

  const handleClose = (id: string, target: DockTarget | null) => {
    if (focusedWinId === id) {
      setFocusedWinId(null);
      setFocusLockedUntil(0);
    }
    onDocked(id, target);
  };

  return (
    <div className="fixed right-5 bottom-5 z-40 w-[min(560px,92vw)] h-[340px] pointer-events-none">
      <AnimatePresence initial={false}>
        {currentDeck.map((w) => {
          let stackIndex = 0;
          if (activeFocusId) {
            if (w.id === activeFocusId) {
              stackIndex = 0;
            } else {
              const otherWins = currentDeck.filter((x) => x.id !== activeFocusId);
              const otherPos = otherWins.findIndex((x) => x.id === w.id);
              stackIndex = 1 + (otherWins.length - 1 - otherPos);
            }
          } else {
            const pos = currentDeck.findIndex((x) => x.id === w.id);
            stackIndex = currentDeck.length - 1 - pos;
          }

          const isFocusLocked = activeFocusId === w.id;
          const remainingSec = isFocusLocked ? Math.max(1, Math.ceil((focusLockedUntil - now) / 1000)) : 0;

          return (
            <motion.div
              key={w.id}
              initial={{ opacity: 0, scale: 0.88, y: 30 }}
              animate={{
                opacity: stackIndex === 0 ? 1 : 0.92,
                scale: 1 - stackIndex * 0.035,
                y: -stackIndex * 38,
                zIndex: stackIndex === 0 ? (isFocusLocked ? 60 : 50) : 50 - stackIndex,
              }}
              exit={{ opacity: 0, scale: 0.8, y: 40 }}
              transition={{ type: "spring", stiffness: 340, damping: 28 }}
              className="absolute right-0 bottom-0 pointer-events-auto"
              onClick={() => {
                if (stackIndex > 0) {
                  handleBringToFront(w.id);
                }
              }}
            >
              <LiveWindowCard
                win={w}
                speed={speed}
                stackIndex={stackIndex}
                isFocusLocked={isFocusLocked}
                countdownSec={remainingSec}
                onDocked={handleClose}
                onTogglePin={onTogglePin}
                onBringToFront={handleBringToFront}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export { LiveWindowLayer as LiveWindows };
