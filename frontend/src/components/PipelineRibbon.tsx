import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { anchorRef } from "../lib/anchors";
import { InlineCode } from "../lib/highlight";
import { STAGES, type RunStatus, type StageId } from "../lib/types";
import { cx, Dot } from "./ui";

function useElapsed(since: number | null, running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since || !running) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [since, running]);
  if (!since) return null;
  const s = Math.max(0, (now - since) / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

export function PipelineRibbon({
  stage,
  stageDone,
  runStatus,
  narration,
  runStartedAt,
  danger,
  rewinding,
}: {
  stage: StageId | null;
  stageDone: boolean;
  runStatus: RunStatus;
  narration: string;
  runStartedAt: number | null;
  danger: boolean;
  rewinding: boolean;
}) {
  const activeIdx = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  const running = runStatus === "running" || runStatus === "awaiting" || runStatus === "committing";
  const elapsed = useElapsed(runStartedAt, running);
  const liveTone = rewinding ? "warn" : danger ? "danger" : running ? "accent" : runStatus === "committed" ? "ok" : "neutral";

  return (
    <div className="relative z-20 shrink-0 border-b border-line bg-surface/60 px-5 pb-3 pt-3 backdrop-blur-xl">
      <div className="flex items-center">
        {STAGES.map((st, idx) => {
          const isCurrent = idx === activeIdx && !(stageDone && idx === activeIdx && st.id !== "anticipate");
          const isPassed = idx < activeIdx || (stageDone && idx === activeIdx);
          const isGate = st.id === "gate" && isCurrent && danger;
          return (
            <Fragment key={st.id}>
              <motion.div
                ref={anchorRef(`stage:${st.id}`)}
                layout
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className={cx(
                  "relative flex shrink-0 items-center gap-2 rounded-full border transition-colors duration-300",
                  isCurrent ? "h-9 pl-1.5 pr-3.5" : "h-7 pl-1 pr-2.5",
                  isGate
                    ? "border-danger/50 bg-danger/10 text-danger"
                    : isCurrent
                    ? "border-accent/45 bg-accent/10 text-ink"
                    : isPassed
                    ? "border-ok/30 bg-ok/[0.06] text-ink-2"
                    : "border-line bg-surface text-ink-3"
                )}
              >
                {isCurrent && (
                  <motion.span
                    aria-hidden
                    className={cx("pointer-events-none absolute -inset-[3px] rounded-full border-2", isGate ? "border-danger/40" : "border-accent/35")}
                    animate={{ opacity: [0.2, 0.9, 0.2], scale: [1, 1.04, 1] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
                <span
                  className={cx(
                    "flex shrink-0 items-center justify-center rounded-full font-mono font-semibold tabular",
                    isCurrent ? "h-6 w-6 text-[10.5px]" : "h-5 w-5 text-[9.5px]",
                    isGate
                      ? "bg-danger text-white"
                      : isCurrent
                      ? "bg-accent text-white dark:text-on-solid"
                      : isPassed
                      ? "bg-ok text-on-solid"
                      : "bg-sunken text-ink-3"
                  )}
                >
                  {isPassed ? <Check className="h-3 w-3" strokeWidth={3} /> : st.num}
                </span>
                <span className={cx("whitespace-nowrap font-medium", isCurrent ? "text-[13px]" : "text-[12px]")}>{st.label}</span>
              </motion.div>
              {idx < STAGES.length - 1 && (
                <div className="relative mx-1.5 h-[2px] min-w-3 flex-1 overflow-hidden rounded-full bg-line">
                  {idx < activeIdx && <div className="beam absolute inset-0" />}
                  {idx === activeIdx && running && <div className="beam-live absolute inset-0 opacity-70" />}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
          <Dot tone={liveTone} live={running || rewinding} />
          {rewinding ? "Rewind" : running ? "Live" : runStatus === "committed" ? "Done" : "Idle"}
        </span>
        <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={narration}
              initial={{ y: 14, opacity: 0, filter: "blur(4px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: -14, opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
              className="absolute inset-0 truncate text-[13.5px] font-medium text-ink"
            >
              <InlineCode text={narration} />
            </motion.p>
          </AnimatePresence>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-3 tabular">
          {activeIdx >= 0 ? `Stage ${activeIdx + 1}/7` : "Stage —/7"}
          {elapsed && <span className="ml-2 text-ink-2">{elapsed}</span>}
        </span>
      </div>
    </div>
  );
}
