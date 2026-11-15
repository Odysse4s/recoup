import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { anchorRef } from "../lib/anchors";
import { InlineCode } from "../lib/highlight";
import type { RunStatus, StageId } from "../lib/types";
import { cx, Dot } from "./ui";

interface RibbonStep {
  id: string;
  num: string;
  label: string;
  stages: StageId[];
  anchorKeys: string[];
}

const STEPS: RibbonStep[] = [
  { id: "plan", num: "1", label: "Plan", stages: ["plan"], anchorKeys: ["stage:plan"] },
  { id: "forge", num: "2", label: "Safe Tool", stages: ["forge"], anchorKeys: ["stage:forge"] },
  { id: "rehearse", num: "3", label: "Rehearse", stages: ["rehearse", "verify"], anchorKeys: ["stage:rehearse", "stage:verify"] },
  { id: "gate", num: "4", label: "Gate", stages: ["gate"], anchorKeys: ["stage:gate"] },
  { id: "commit", num: "5", label: "Commit", stages: ["commit"], anchorKeys: ["stage:commit"] },
  { id: "anticipate", num: "6", label: "Next", stages: ["anticipate"], anchorKeys: ["stage:anticipate"] },
];

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
  const activeIdx = stage ? STEPS.findIndex((s) => s.stages.includes(stage)) : -1;
  const running = runStatus === "running" || runStatus === "awaiting" || runStatus === "committing";
  const elapsed = useElapsed(runStartedAt, running);
  const liveTone = rewinding ? "warn" : danger ? "danger" : running ? "accent" : runStatus === "committed" ? "ok" : "neutral";

  const attachAnchors = (keys: string[]) => (el: HTMLElement | null) => {
    for (const k of keys) {
      anchorRef(k)(el);
    }
  };

  return (
    <div className="relative z-20 flex h-[42px] shrink-0 items-center justify-between border-b border-line bg-surface/60 px-4 backdrop-blur-xl gap-3">
      {/* Stage Pills */}
      <div className="flex shrink-0 items-center gap-1">
        {STEPS.map((st, idx) => {
          const isCurrent = idx === activeIdx && !(stageDone && idx === activeIdx && st.id !== "anticipate");
          const isPassed = idx < activeIdx || (stageDone && idx === activeIdx && (st.id !== "rehearse" || stage === "verify") && st.id !== "anticipate");
          const isGate = st.id === "gate" && isCurrent && danger;
          return (
            <Fragment key={st.id}>
              <motion.div
                ref={attachAnchors(st.anchorKeys)}
                layout
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                title={`${st.num}. ${st.label}`}
                aria-label={`${st.num}. ${st.label}`}
                className={cx(
                  "relative flex shrink-0 items-center gap-1.5 rounded-full border transition-colors duration-300",
                  isCurrent ? "h-7 pl-1 pr-2.5" : "h-6 pl-1 pr-2",
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
                    className={cx("pointer-events-none absolute -inset-[2px] rounded-full border-2", isGate ? "border-danger/40" : "border-accent/35")}
                    animate={{ opacity: [0.2, 0.9, 0.2], scale: [1, 1.04, 1] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
                <span
                  className={cx(
                    "flex shrink-0 items-center justify-center rounded-full font-mono font-semibold tabular",
                    isCurrent ? "h-4.5 w-4.5 text-[9.5px]" : "h-4 w-4 text-[9px]",
                    isGate
                      ? "bg-danger text-white"
                      : isCurrent
                      ? "bg-accent text-white dark:text-on-solid"
                      : isPassed
                      ? "bg-ok text-on-solid"
                      : "bg-sunken text-ink-3"
                  )}
                >
                  {isPassed ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : st.num}
                </span>
                <span className={cx("whitespace-nowrap font-medium", isCurrent ? "text-[12px]" : "text-[11px]")}>
                  <span className="sr-only">{st.num}. </span>
                  {st.label}
                </span>
              </motion.div>
              {idx < STEPS.length - 1 && (
                <div className={cx("h-[2px] w-1.5 shrink-0 rounded-full", idx < activeIdx ? "bg-ok/50" : "bg-line")} />
              )}
            </Fragment>
          );
        })}
      </div>

      {/* Divider */}
      <div className="h-4 w-[1px] shrink-0 bg-line" />

      {/* Live Narration & Timer */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {runStatus === "committed" && !running && !rewinding ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-ok/50 bg-ok/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ok shadow-[0_0_10px_rgba(16,185,129,0.2)]">
            <Check className="h-3 w-3" strokeWidth={3} />
            <span>Committed · All Done</span>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
            <Dot tone={liveTone} live={running || rewinding} />
            <span>{rewinding ? "Rewind" : running ? "Live" : runStatus === "committed" ? "Done" : "Idle"}</span>
          </span>
        )}
        <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={narration}
              initial={{ y: 10, opacity: 0, filter: "blur(4px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: -10, opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
              className="absolute inset-0 truncate text-[12.5px] font-medium text-ink"
            >
              <InlineCode text={narration} />
            </motion.p>
          </AnimatePresence>
        </div>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-3 tabular">
          <span>{activeIdx >= 0 ? `Step ${activeIdx + 1}/6` : "Step —/6"}</span>
          {elapsed && <span className="font-semibold text-ink-2">{elapsed}</span>}
        </span>
      </div>
    </div>
  );
}
