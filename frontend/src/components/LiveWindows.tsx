import { AnimatePresence, motion, useAnimate, useDragControls } from "framer-motion";
import { Activity, Braces, Check, CheckCircle2, Circle, Database, FileCode2, Pin, PinOff, SquareTerminal, XCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { anchorCenter } from "../lib/anchors";
import { highlightLine } from "../lib/highlight";
import { soundFx } from "../lib/sound";
import { PACE, type Speed } from "../lib/speed";
import type { DockTarget, LiveWin, WindowKind } from "../lib/types";
import { cx, TONE, type Tone } from "./ui";

const KIND_META: Record<WindowKind, { tone: Tone; icon: typeof Braces }> = {
  forge: { tone: "forge", icon: Braces },
  editor: { tone: "ok", icon: FileCode2 },
  sqlite: { tone: "signal", icon: Database },
  exec: { tone: "warn", icon: SquareTerminal },
};

type Phase = "pop" | "typing" | "hold" | "docking";

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
              {f}
            </span>
          ))}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-ink-3">
        <span className="shrink-0 pr-1 text-ink-3">stdout ›</span>
        {t.steps.map((step, i) => {
          const done = i < doneCount;
          const active = i === doneCount && typing;
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
              {step}
              {i < t.steps.length - 1 && <span className="pl-1 text-ink-3">→</span>}
            </span>
          );
        })}
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

  return (
    <motion.div drag dragListener={false} dragControls={dragControls} dragMomentum={false} className="pointer-events-auto">
      <div
        ref={scope}
        style={{
          opacity: 0,
          boxShadow: `var(--shadow-float), 0 0 0 1px color-mix(in oklab, var(--${meta.tone}) 45%, transparent), 0 0 48px -10px color-mix(in oklab, var(--${meta.tone}) 55%, transparent)`,
        }}
        className="relative w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-xl bg-raised"
      >
        {/* titlebar */}
        <div
          onPointerDown={(e) => dragControls.start(e)}
          className="relative flex h-10 cursor-grab touch-none items-center gap-3 border-b border-line bg-sunken/80 px-3 active:cursor-grabbing"
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
            <Icon className={cx("h-3.5 w-3.5 shrink-0", tone.text)} />
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

        {/* code body */}
        <div className="relative bg-code">
          {typing && (
            <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b to-transparent opacity-50 scanline", tone.soft)} />
          )}
          <div
            ref={bodyRef}
            className={cx(
              "scroll-thin overflow-y-auto py-3 font-mono text-[13px] leading-[1.8]",
              win.instant ? "max-h-[min(460px,52vh)]" : "max-h-[min(320px,30vh)]"
            )}
          >
            {lines.map((line, i) => {
              const active = i === lines.length - 1 && typing;
              return (
                <div key={i} className={cx("relative flex pr-4", active && tone.soft)}>
                  <span className={cx("absolute inset-y-0 left-0 w-[3px]", active ? tone.dot : "bg-transparent")} />
                  <span className={cx("w-11 shrink-0 select-none pr-3 text-right tabular", active ? tone.text : "text-ink-3")}>
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                    {highlightLine(line, win.lang)}
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

        {/* assertions */}
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
                {a.label}
                <span className="font-semibold">{st === "pending" ? "PENDING" : st === "pass" ? "PASS" : "FAIL"}</span>
              </motion.span>
            );
          })}
          <span className="ml-auto font-mono text-[10.5px] text-ink-3 tabular">
            {lines.length}/{allLines} ln · {pct}%
          </span>
        </div>

        <TelemetryStrip win={win} progress={progress} typing={typing} />

        {/* progress */}
        <div className="h-[3px] w-full bg-sunken">
          <div className={cx("h-full transition-[width] duration-75", tone.dot)} style={{ width: `${pct}%` }} />
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
