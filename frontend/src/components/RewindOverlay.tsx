import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, RotateCcw, TriangleAlert } from "lucide-react";
import type { RewindState } from "../lib/types";

/** Reversible checkpoint rewind: amber sweep across the HUD while receipts unwind (non-blocking). */
export function RewindOverlay({ rewind }: { rewind: RewindState | null }) {
  return (
    <AnimatePresence>
      {rewind && (
        <motion.div
          key={rewind.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
          className="pointer-events-none fixed inset-0 z-[60]"
        >
          {/* vignette */}
          <div
            className="absolute inset-0"
            style={{
              boxShadow:
                "inset 0 0 0 2px color-mix(in oklab, var(--warn) 55%, transparent), inset 0 0 160px -20px color-mix(in oklab, var(--warn) 35%, transparent)",
            }}
          />
          {/* sweeping band, right → left */}
          {rewind.phase === "rewinding" && (
            <motion.div
              className="absolute inset-y-0 w-[38vw]"
              style={{
                background:
                  "linear-gradient(90deg, transparent, color-mix(in oklab, var(--warn) 16%, transparent) 60%, color-mix(in oklab, var(--warn) 30%, transparent) 92%, transparent)",
              }}
              initial={{ x: "100vw" }}
              animate={{ x: "-40vw" }}
              transition={{ duration: rewind.duration / 1000, ease: [0.4, 0, 0.2, 1] }}
            />
          )}
          {/* progress rail */}
          <div className="absolute inset-x-0 top-0 h-[3px] bg-warn/15">
            <motion.div
              className="ml-auto h-full bg-warn"
              style={{ boxShadow: "0 0 18px var(--warn)" }}
              initial={{ width: "0%" }}
              animate={{ width: "100%" }}
              transition={{ duration: rewind.duration / 1000, ease: "linear" }}
            />
          </div>
          {/* banner */}
          <div className="absolute inset-x-0 top-[66px] flex justify-center">
            <motion.div
              initial={{ y: -16, opacity: 0, scale: 0.96 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              className="flex min-w-[420px] items-center gap-3 rounded-xl border border-warn/40 bg-raised/95 px-4 py-2.5 shadow-float backdrop-blur-xl"
            >
              {rewind.phase === "rewinding" ? (
                <RotateCcw className="h-4 w-4 animate-spin text-warn [animation-direction:reverse]" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-ok" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11.5px] font-semibold tracking-wide text-ink">
                  {rewind.phase === "rewinding" ? "REWINDING CHECKPOINT → RESTORING STATE HASH" : "STATE RESTORED · FINGERPRINT MATCH"}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1.5 font-mono text-[10.5px] text-ink-3">
                  {rewind.steps.length === 0 && rewind.phase === "rewinding" && <span>reverting selected steps…</span>}
                  {rewind.steps.map((s, i) => (
                    <motion.span key={i} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} className="inline-flex items-center gap-1 text-warn">
                      <RotateCcw className="h-2.5 w-2.5" />
                      Step #{s.step} {s.tool}
                    </motion.span>
                  ))}
                  {rewind.skipped.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1 text-danger">
                      <TriangleAlert className="h-2.5 w-2.5" />
                      {s} irreversible
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
