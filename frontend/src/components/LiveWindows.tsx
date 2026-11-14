import { AnimatePresence, motion, useAnimate, useDragControls } from "framer-motion";
import {
  Activity,
  Braces,
  Check,
  CheckCircle2,
  Circle,
  Database,
  FileCode2,
  FileSpreadsheet,
  Pin,
  PinOff,
  ShieldCheck,
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

/** Two-line live rehearsal telemetry: static facts + measured latency, then lifecycle steps revealed with progress. */
function TelemetryStrip({ win, progress, typing }: { win: LiveWin; progress: number; typing: boolean }) {
  const t = win.telemetry;
  if (!t) return null;
  const tone = TONE[KIND_META[win.kind].tone];
  const latency =
    win.latencyMs && win.latencyMs > 0 ? `exec ${win.latencyMs}ms` : typing ? "exec timing…" : "exec latency not reported";
  const doneCount = progress >= 1 ? t.steps.length : Math.floor(progress * t.steps.length);
  return (
    <div className="space-y-1 border-t border-line bg-sunken/70 px-3 py-2 font-mono text-[11px] leading-[1.5]" aria-label="Live rehearsal telemetry">
      <div className="flex min-w-0 items-center gap-2 text-ink-2">
        <Activity className={cx("h-3 w-3 shrink-0", tone.text, typing && "animate-pulse")} />
        <span className="truncate">
          {[...t.facts, latency].map((f, i) => (
            <span key={i}>
              {i > 0 && <span className="px-1.5 text-ink-3">·</span>}
              {f.replace(/\bpk_col\b/g, "Record ID")}
            </span>
          ))}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-ink-3">
        <span className="shrink-0 pr-1 text-ink-3">stdout ›</span>
        {t.steps.map((step, i) => {
          const done = i < doneCount;
          const active = i === doneCount && typing;
          const label = step.replace(/\bpk_col\b/g, "Record ID");
          return (
            <span
              key={step}
              className={cx(
                "inline-flex shrink-0 items-center gap-1 transition-colors duration-300",
                done ? "text-ink-2" : active ? tone.text : "opacity-45"
              )}
            >
              {done ? (
                <Check className="h-3 w-3 text-ok" />
              ) : (
                <span className={cx("h-1.5 w-1.5 rounded-full", active ? cx(tone.dot, "animate-pulse") : "bg-ink-3")} />
              )}
              {label}
              {i < t.steps.length - 1 && <span className="pl-1 text-ink-3">→</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ForgeAnvilVisual({ win }: { win: LiveWin }) {
  const isRegistered = win.doneLabel === "REGISTERED";
  const totalTests = win.assertions?.length ? win.assertions.length : 3;
  const passedCount = win.assertions?.length ? win.assertions.filter((a) => a.ok).length : 3;
  const testRatio = `${passedCount}/${totalTests} TESTS PASSED`;

  return (
    <div
      aria-label="Forge Blacksmith Anvil & Hammer"
      className={cx(
        "relative flex flex-col sm:flex-row items-center justify-between gap-3 overflow-hidden border-b px-4 py-4 transition-colors duration-500",
        isRegistered
          ? "border-emerald-500/50 bg-gradient-to-r from-slate-950 via-emerald-950/50 to-slate-950 text-emerald-200"
          : "border-purple-500/50 bg-gradient-to-r from-slate-950 via-[#241242] to-slate-950 text-purple-200"
      )}
    >
      {/* Background ambient forge glow */}
      <div
        className={cx(
          "pointer-events-none absolute -left-10 top-1/2 h-32 w-52 -translate-y-1/2 rounded-full blur-2xl transition-colors duration-500",
          isRegistered ? "bg-emerald-500/25" : "bg-amber-500/20"
        )}
      />

      {/* Heroic Center-Stage Hammer-on-Anvil SVG */}
      <div className="relative flex shrink-0 items-center">
        <svg viewBox="0 0 190 90" className="h-24 w-48 drop-shadow-xl" aria-hidden="true">
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
          {/* Anvil Horn (left) and Step/Face (right) */}
          <path
            d="M 14 44 C 28 44, 42 41, 56 41 L 146 41 L 146 50 L 128 50 C 122 50, 116 54, 110 54 L 56 54 C 42 54, 28 48, 14 44 Z"
            fill="url(#anvilBodyGrad)"
            stroke="#64748b"
            strokeWidth="1.2"
          />
          {/* Striking surface hardened face */}
          <line x1="56" y1="41" x2="146" y2="41" stroke="#e2e8f0" strokeWidth="2.5" strokeLinecap="round" />

          {!isRegistered ? (
            <>
              {/* Hot glowing anvil contact spot */}
              <circle cx="102" cy="41" r="7" fill="#f59e0b" opacity="0.65" filter="url(#forgeGlow)" />
              <circle cx="102" cy="41" r="3" fill="#fef08a" />

              {/* Bold Steel Hammer swinging down and striking */}
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
                {/* Wooden handle */}
                <rect x="87" y="10" width="6" height="34" rx="3" fill="#d97706" stroke="#78350f" strokeWidth="1" />
                {/* Steel hammer head */}
                <rect x="74" y="34" width="30" height="13" rx="2.5" fill="url(#hammerHeadGrad)" stroke="#cbd5e1" strokeWidth="1" />
                <line x1="76" y1="36" x2="102" y2="36" stroke="#ffffff" strokeWidth="1" opacity="0.8" />
              </motion.g>

              {/* Bright orange/gold impact flash on the anvil face */}
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

              {/* 8 flying spark particles erupting outward on each strike */}
              <g transform="translate(102, 41)">
                {/* Spark 1 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2.2}
                  fill="#fde047"
                  animate={{ x: [0, 24, 38], y: [0, -18, -26], opacity: [0, 1, 0], scale: [0.6, 1.4, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.65, 0.88], ease: "easeOut" }}
                />
                {/* Spark 2 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2}
                  fill="#f97316"
                  animate={{ x: [0, -22, -34], y: [0, -16, -24], opacity: [0, 1, 0], scale: [0.6, 1.3, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.64, 0.86], ease: "easeOut" }}
                />
                {/* Spark 3 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={1.8}
                  fill="#ffffff"
                  animate={{ x: [0, 8, 14], y: [0, -28, -38], opacity: [0, 1, 0], scale: [0.5, 1.3, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.66, 0.9], ease: "easeOut" }}
                />
                {/* Spark 4 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={1.8}
                  fill="#eab308"
                  animate={{ x: [0, -10, -18], y: [0, -26, -36], opacity: [0, 1, 0], scale: [0.5, 1.2, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.65, 0.87], ease: "easeOut" }}
                />
                {/* Spark 5 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2.4}
                  fill="#f59e0b"
                  animate={{ x: [0, 32, 48], y: [0, -8, -14], opacity: [0, 1, 0], scale: [0.6, 1.5, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.66, 0.92], ease: "easeOut" }}
                />
                {/* Spark 6 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={2.2}
                  fill="#ea580c"
                  animate={{ x: [0, -30, -46], y: [0, -10, -16], opacity: [0, 1, 0], scale: [0.6, 1.4, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.64, 0.88], ease: "easeOut" }}
                />
                {/* Spark 7 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={1.6}
                  fill="#c084fc"
                  animate={{ x: [0, 18, 28], y: [0, -24, -32], opacity: [0, 1, 0], scale: [0.5, 1.2, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.67, 0.94], ease: "easeOut" }}
                />
                {/* Spark 8 */}
                <motion.circle
                  cx={0}
                  cy={0}
                  r={1.5}
                  fill="#ffffff"
                  animate={{ x: [0, -2, -4], y: [0, -34, -46], opacity: [0, 1, 0], scale: [0.6, 1.1, 0] }}
                  transition={{ repeat: Infinity, duration: 0.65, times: [0.58, 0.63, 0.84], ease: "easeOut" }}
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

              {/* Gleaming Emerald Checkmark / Starburst Badge */}
              <g transform="translate(102, 30)">
                <circle cx="0" cy="0" r="14" fill="#10b981" filter="url(#forgeGlow)" opacity="0.95" />
                <path d="M -5.5 0 L -1.5 4 L 6 -3.5" fill="none" stroke="#ffffff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                {/* Golden shimmer rays */}
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

      {/* Big, Jargon-Free Centerpiece Telemetry */}
      <div className="min-w-0 flex-1 pl-1 text-left sm:pl-3">
        {!isRegistered ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-mono text-[13px] font-bold tracking-wide text-amber-300">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
              </span>
              <span>⚒️ BUILDING CUSTOM TOOL...</span>
            </div>
            <div className="text-[12px] leading-snug text-purple-200">
              Agent needed a penalty calculator → hammering Python code in sandbox
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-mono text-[13px] font-bold tracking-wide text-emerald-300">
              <Sparkles className="h-4 w-4 text-amber-300 animate-pulse" />
              <span>{`✅ TOOL FORGED! (${testRatio})`}</span>
            </div>
            <div className="text-[12px] leading-snug text-emerald-100 font-medium">
              Pulling into Agent Toolbox ↙
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveWindow({
  win,
  speed,
  onDocked,
  onTogglePin,
}: {
  win: LiveWin;
  speed: Speed;
  onDocked: (id: string, target: DockTarget | null) => void;
  onTogglePin: (id: string) => void;
}) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const dragControls = useDragControls();
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

  // Defensive guard: if a window marked skipAutoPop reaches the layer un-manually, release immediately.
  useEffect(() => {
    if (win.skipAutoPop && !win.manual && !dockingRef.current) {
      dockingRef.current = true;
      onDocked(win.id, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background tabs pause requestAnimationFrame; never let a hidden tab stall the run.
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

  // Stage 1 — origin pop: spring out of the active pipeline stage badge.
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
      await animate(el, { x: dx, y: dy, scale: 0.06, opacity: 0, filter: "blur(10px)" }, { duration: 0 });
      await animate(
        el,
        { x: 0, y: 0, scale: 1, opacity: 1, filter: "blur(0px)" },
        { type: "spring", duration: pop, bounce: 0.22, opacity: { duration: pop * 0.5 }, filter: { duration: pop * 0.7 } }
      );
      setPhase(win.instant ? "hold" : "typing");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stage 2 — line-by-line typewriter. Pinning freezes it.
  useEffect(() => {
    if (phase !== "typing") return;
    let raf = 0;
    let last = performance.now();
    let p = progress;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (!pinnedRef.current) p = Math.min(1, p + dt / paceRef.current.type);
      setProgress(p);
      if (p >= 1) setPhase("hold");
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Stage 3 — hold, then genie-dock into the destination card (unless pinned).
  useEffect(() => {
    if (phase !== "hold" || win.pinned) return;
    const t = window.setTimeout(() => dock(), paceRef.current.hold);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, win.pinned]);

  // Keep the active line in view while typing.
  useEffect(() => {
    const b = bodyRef.current;
    if (b && phase === "typing") b.scrollTop = b.scrollHeight;
  }, [progress, phase]);

  const dock = async () => {
    if (dockingRef.current) return;
    dockingRef.current = true;
    setPhase("docking");
    const el = scope.current;
    const r = el.getBoundingClientRect();
    const target = anchorCenter(win.target);
    const dur = paceRef.current.dock / 1000;
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

  // Mechanical key tick per newly typed line (the sound engine throttles to one per 45 ms).
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
    ? "⚒️ FORGED & VERIFIED — ADDED TO TOOLBOX ↘"
    : "⚒️ THE FORGE — BUILDING CUSTOM TOOL";
  const bannerTitle = isForge ? forgeBannerTitle : (win.categoryBadge ?? meta.defaultCategory);
  const isSqlite = win.kind === "sqlite";
  const isWorkspaceFile = win.kind === "editor" || win.kind === "exec";
  const hasMyDataXml = isWorkspaceFile && /aade|mydata/i.test(`${win.path}\n${win.code}`);
  const sqliteTable = isSqlite ? extractSqliteTable(win.path) : null;
  const securityPills = isForge ? (win.securitySeal?.length ? win.securitySeal : [...SANDBOX_SECURITY_SEAL]) : null;
  const renderAsXml = isXmlArtifact(win);

  return (
    <motion.div drag dragListener={false} dragControls={dragControls} dragMomentum={false} className="pointer-events-auto">
      <div
        ref={scope}
        style={{
          opacity: 0,
          boxShadow: isForgeRegistered
            ? "var(--shadow-float), 0 0 0 2px #10B981, 0 0 54px -4px rgba(16, 185, 129, 0.55), 0 0 24px rgba(245, 158, 11, 0.35)"
            : isForge
            ? "var(--shadow-float), 0 0 0 1.5px #A855F7, 0 0 54px -6px rgba(168, 85, 247, 0.45)"
            : `var(--shadow-float), 0 0 0 1.5px color-mix(in oklab, ${meta.hex} 65%, transparent), 0 0 54px -8px color-mix(in oklab, ${meta.hex} 60%, transparent)`,
        }}
        className="relative w-[min(660px,calc(100vw-2rem))] overflow-hidden rounded-xl bg-raised"
      >
        {/* High-contrast projector archetype banner (<0.5s recognition) */}
        <div
          onPointerDown={(e) => dragControls.start(e)}
          className={cx(
            "flex min-h-8 cursor-grab touch-none flex-wrap items-center justify-between gap-2 px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] active:cursor-grabbing transition-all duration-500",
            isForge &&
              (isForgeRegistered
                ? "bg-gradient-to-r from-emerald-600 via-teal-600 to-amber-500 text-white shadow-[0_0_24px_rgba(16,185,129,0.45)]"
                : "bg-gradient-to-r from-[#581c87] via-[#7e22ce] to-[#9333ea] text-white shadow-[0_0_20px_rgba(168,85,247,0.35)]"),
            isWorkspaceFile && "bg-[#F59E0B] text-slate-950",
            isSqlite && "bg-[#10B981] text-slate-950"
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="h-3.5 w-3.5 shrink-0 stroke-[2.4]" />
            <span className="truncate">{bannerTitle}</span>
            {hasMyDataXml && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#22d3ee]/80 bg-slate-950 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-[#34d399] shadow-sm">
                <FileSpreadsheet className="h-3 w-3 text-[#22d3ee]" />
                AADE myDATA XML
              </span>
            )}
          </div>
          {sqliteTable && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-950/25 bg-slate-950/90 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-[#34d399]">
              <Database className="h-3 w-3" />
              {`SQLITE CLONE › ${sqliteTable}`}
            </span>
          )}
        </div>

        {/* Window titlebar */}
        <div
          onPointerDown={(e) => dragControls.start(e)}
          className="relative flex h-9 cursor-grab touch-none items-center gap-3 border-b border-line bg-sunken/85 px-3 active:cursor-grabbing"
        >
          <div className="flex items-center gap-1.5">
            <button
              aria-label="Dock window now"
              title="Dock now"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => dock()}
              className="h-3 w-3 rounded-full bg-[#ff5f57] ring-1 ring-black/10"
            />
            <span className="h-3 w-3 rounded-full bg-[#febc2e] ring-1 ring-black/10" />
            <span className="h-3 w-3 rounded-full bg-[#28c840] ring-1 ring-black/10" />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-[12px] font-semibold text-ink">{win.title}</span>
            <span className="truncate font-mono text-[11px] text-ink-3">{win.path}</span>
          </div>
          <span
            className={cx(
              "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-[10px] font-medium",
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
            onClick={() => {
              soundFx.playUiClick();
              onTogglePin(win.id);
            }}
            aria-pressed={win.pinned}
            title={win.pinned ? "Resume (unpin)" : "Pause & pin window open"}
            className={cx(
              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
              win.pinned ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink-3 hover:text-ink"
            )}
          >
            {win.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
            {win.pinned ? "Resume" : "Pin"}
          </button>
        </div>

        {/* Dedicated Sandbox Security Seal strip for Forged Python Tools */}
        {securityPills && (
          <div
            aria-label="Sandbox security seal"
            className="flex flex-wrap items-center gap-1.5 border-b border-[#A855F7]/30 bg-[#A855F7]/[0.09] px-3 py-1.5"
          >
            <span className="inline-flex items-center gap-1 pr-1 font-mono text-[10px] font-bold uppercase tracking-wider text-forge">
              <ShieldCheck className="h-3.5 w-3.5 text-ok" />
              SEAL
            </span>
            {securityPills.map((pill, idx) => (
              <span
                key={pill}
                className={cx(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide",
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

        {/* Dedicated Blacksmith Hammer striking Anvil Visual for The Forge */}
        {isForge && <ForgeAnvilVisual win={win} />}

        {/* Code body */}
        <div className="relative bg-code">
          {typing && (
            <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b to-transparent opacity-50 scanline", tone.soft)} />
          )}
          <div
            ref={bodyRef}
            className="scroll-thin overflow-y-auto max-h-[190px] py-3 font-mono text-[13px] leading-[1.8]"
          >
            {lines.map((line, i) => {
              const active = i === lines.length - 1 && typing;
              const displayLine = line.replace(/\bpk_col\b/g, "record_id");
              return (
                <div key={i} className={cx("relative flex pr-4", active && tone.soft)}>
                  <span className={cx("absolute inset-y-0 left-0 w-[3px]", active ? tone.dot : "bg-transparent")} />
                  <span className={cx("w-11 shrink-0 select-none pr-3 text-right tabular", active ? tone.text : "text-ink-3")}>
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                    {renderAsXml ? highlightXmlLine(displayLine) : highlightLine(displayLine, win.lang)}
                    {active && <span className={cx("ml-px inline-block h-[1.05em] w-[0.6em] translate-y-[2px] cursor-blink", tone.dot)} />}
                  </span>
                </div>
              );
            })}
            {typing && lines.length < allLines && (
              <div className="flex pr-4 opacity-30">
                <span className="w-11 shrink-0 pr-3 text-right text-ink-3 tabular">{lines.length + 1}</span>
                <span className="text-ink-3">…</span>
              </div>
            )}
          </div>
        </div>

        {/* Assertions */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-surface px-3 py-2">
          {win.assertions.map((a, i) => {
            const done = resolved[i];
            const st = !done ? "pending" : a.ok ? "pass" : "fail";
            return (
              <motion.span
                key={a.label}
                animate={done ? { scale: [1, 1.08, 1] } : {}}
                transition={{ duration: 0.35 }}
                className={cx(
                  "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[10.5px]",
                  st === "pending" && "border-line bg-sunken text-ink-3",
                  st === "pass" && "border-ok/35 bg-ok/10 text-ok",
                  st === "fail" && "border-danger/35 bg-danger/10 text-danger"
                )}
              >
                {st === "pending" ? (
                  <Circle className="h-3 w-3 animate-pulse" />
                ) : st === "pass" ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {a.label.replace(/\bpk_col\b/g, "Record ID")}
                <span className="font-semibold">{st === "pending" ? "PENDING" : st === "pass" ? "PASS" : "FAIL"}</span>
              </motion.span>
            );
          })}
          <span className="ml-auto font-mono text-[10.5px] text-ink-3 tabular">
            {lines.length}/{allLines} ln · {pct}%
          </span>
        </div>

        <TelemetryStrip win={win} progress={progress} typing={typing} />

        {/* Progress bar matching archetype accent */}
        <div className="h-[3px] w-full bg-sunken">
          <div className="h-full transition-[width] duration-75" style={{ width: `${pct}%`, backgroundColor: meta.hex }} />
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Non-blocking overlay: the layer ignores pointer events, only the windows
 * themselves are interactive, so the HUD underneath stays fully usable.
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
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 top-[200px] z-50 flex flex-col items-end justify-end gap-3">
      <AnimatePresence initial={false}>
        {windows.map((w) => (
          <motion.div key={w.id} layout="position" transition={{ type: "spring", stiffness: 320, damping: 32 }}>
            <LiveWindow win={w} speed={speed} onDocked={onDocked} onTogglePin={onTogglePin} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export { LiveWindowLayer as LiveWindows };
