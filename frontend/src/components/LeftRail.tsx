import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ForgeSpecPayload, ForgeTestPayload, PlanPayload, VerifyPayload } from "../contracts";
import { anchorRef } from "../lib/anchors";
import type { Preset } from "../lib/types";
import { Chip, cx, Panel } from "./ui";

const SEVEN_LAYER_SEAL = [
  "AST allowlist",
  "python -I",
  "0 env secrets",
  "RLIMIT CPU/MEM",
  "FSIZE=0 no disk writes",
  "temp cwd",
  "SHA-256 hash-pinned",
] as const;

export function PlanPanel({
  plan,
  verify,
  presets,
  onRun,
}: {
  plan: PlanPayload | null;
  verify: VerifyPayload | null;
  presets: Preset[];
  onRun: (goal: string) => void;
}) {
  const [verifyOpen, setVerifyOpen] = useState(false);

  return (
    <Panel
      title={plan ? "Agent Plan" : "Audit Presets"}
      icon={<Layers />}
      meta={plan ? <Chip>{plan.steps.length} steps</Chip> : null}
      className="min-h-0 flex-1"
      bodyClassName="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5"
    >
      {plan ? (
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-2">
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
            <p className="line-clamp-1 px-1 text-[11.5px] font-medium text-ink-2" title={plan.goal}>
              {plan.goal.includes("Goal:") ? plan.goal.split("Goal:").pop()!.trim() : plan.goal}
            </p>
            <ol className="relative space-y-1">
              {plan.steps.map((s, i) => {
                const missing = s.tool.startsWith("MISSING:");
                const isRunning = s.status === "running";
                const isDone = s.status === "done";
                const isFailed = s.status === "failed";
                const isPending = s.status === "pending";

                const toolBadge = missing ? (
                  <Chip tone="forge" className="h-4 shrink-0 px-1 font-mono text-[9px]">
                    ⚒️ forge
                  </Chip>
                ) : s.tool ? (
                  <span
                    className="hidden max-w-[85px] shrink-0 truncate font-mono text-[10px] text-ink-3 sm:inline"
                    title={s.tool}
                  >
                    {s.tool}
                  </span>
                ) : null;

                return (
                  <motion.li
                    key={s.id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className={cx(
                      "relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors duration-200",
                      isRunning && "border-accent/50 bg-accent/[0.08] shadow-[0_0_12px_rgba(59,130,246,0.12)] ring-1 ring-accent/30",
                      isDone && "border-line bg-surface/85 text-ink-2",
                      isFailed && "border-danger/40 bg-danger/[0.06]",
                      isPending && "border-line/60 bg-sunken/40 text-ink-3 opacity-80"
                    )}
                  >
                    <span className="shrink-0">
                      {isDone ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
                      ) : isRunning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                      ) : isFailed ? (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      ) : (
                        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sunken font-mono text-[9px] font-semibold text-ink-3">
                          {s.id}
                        </span>
                      )}
                    </span>

                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span
                        className={cx(
                          "shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider",
                          isRunning ? "text-accent" : isDone ? "text-ink-2" : "text-ink-3"
                        )}
                      >
                        STEP {s.id}
                      </span>
                      <span className="shrink-0 text-ink-3/40">·</span>
                      <span
                        className={cx(
                          "truncate text-[12px] font-medium leading-tight",
                          isRunning ? "font-semibold text-ink" : isDone ? "text-ink-2" : isPending ? "text-ink-3" : "text-ink"
                        )}
                        title={s.intent}
                      >
                        {s.intent}
                      </span>
                    </div>

                    {toolBadge}
                  </motion.li>
                );
              })}
            </ol>
          </div>

          <AnimatePresence>
            {verify && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                className="mt-auto shrink-0 pt-1"
              >
                <button
                  type="button"
                  onClick={() => setVerifyOpen((v) => !v)}
                  className="flex w-full items-center justify-between rounded-lg border border-line bg-sunken/60 px-2.5 py-1.5 text-left transition-colors hover:border-line-strong hover:bg-sunken"
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-2">
                    {verifyOpen ? (
                      <ChevronDown className="h-3 w-3 text-ink-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-ink-3" />
                    )}
                    Verification Checks · {verify.criteria.filter((c) => c.passed).length}/{verify.criteria.length} Passed
                  </span>
                  <Chip tone={verify.passed ? "ok" : "danger"} className="h-4 px-1.5 text-[9px]">
                    {verify.passed ? "Verified" : "Failed"}
                  </Chip>
                </button>

                <AnimatePresence initial={false}>
                  {verifyOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-1 space-y-1 rounded-lg border border-line/60 bg-surface/50 p-1.5">
                        {verify.criteria.map((c, i) => (
                          <div
                            key={i}
                            title={c.detail}
                            className="flex items-center gap-2 rounded px-1.5 py-0.5 text-[11.5px]"
                          >
                            {c.passed ? (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
                            )}
                            <span className="line-clamp-1 flex-1 font-medium text-ink-2">{c.criterion}</span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((p, i) => {
            const isPreset1 = i === 0;
            const title = isPreset1
              ? "Check Delivery D-1042 — 22 Missing/Broken Hubs & Overcharged Invoice"
              : p.title;
            const desc = isPreset1
              ? "Compares delivery note vs contract, builds a safe Python calculator, freezes Invoice INV-7781 in a safe clone, and asks you before emailing the supplier."
              : p.desc;
            return (
              <button
                key={i}
                onClick={() => onRun(p.goal)}
                className="group block w-full rounded-lg border border-line bg-surface p-2.5 text-left transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-card"
              >
                <div className="mb-1 flex items-center justify-between">
                  <Chip tone={i === 0 ? "accent" : "neutral"}>{p.badge}</Chip>
                  <ArrowUpRight className="h-3.5 w-3.5 text-ink-3 transition-colors group-hover:text-accent" />
                </div>
                <div className="text-[13px] font-semibold leading-snug tracking-tight text-ink">{title}</div>
                {desc && <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-3">{desc}</div>}
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function ForgeVault({
  tools,
  forgeSpec,
  forgeTest,
  forgedCode,
  onInspect,
  pulseKey,
  brandName = "Recoup",
}: {
  tools: { name: string; description: string; uses: number }[];
  forgeSpec: ForgeSpecPayload | null;
  forgeTest: ForgeTestPayload | null;
  forgedCode: Record<string, ForgeTestPayload>;
  onInspect: (name: string) => void;
  pulseKey: number;
  brandName?: string;
}) {
  const synthesizing = forgeSpec && !tools.some((t) => t.name === forgeSpec.name);
  const prevCountRef = useRef(tools.length);
  const [showNewBadge, setShowNewBadge] = useState(false);
  const badgeTimerRef = useRef<number | null>(null);
  const [sealOpen, setSealOpen] = useState(false);

  useEffect(() => {
    if (tools.length > prevCountRef.current) {
      setShowNewBadge(true);
      if (badgeTimerRef.current) window.clearTimeout(badgeTimerRef.current);
      badgeTimerRef.current = window.setTimeout(() => {
        setShowNewBadge(false);
      }, 4500);
    }
    prevCountRef.current = tools.length;
  }, [tools.length]);

  useEffect(() => {
    return () => {
      if (badgeTimerRef.current) window.clearTimeout(badgeTimerRef.current);
    };
  }, []);

  return (
    <Panel
      title="⚒️ Agent Toolbox (Forged Live)"
      icon={<Braces />}
      meta={
        <div className="flex items-center gap-1.5">
          <AnimatePresence>
            {showNewBadge ? (
              <motion.span
                initial={{ scale: 0.6, opacity: 0, y: -2 }}
                animate={{ scale: [1, 1.08, 1], opacity: 1, y: 0 }}
                exit={{ scale: 0.8, opacity: 0 }}
                transition={{ duration: 0.35 }}
                className="inline-flex h-5 items-center gap-1 rounded-md border border-emerald-400 bg-emerald-500/20 px-2 font-mono text-[10px] font-bold tracking-wider text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.5)]"
              >
                <Sparkles className="h-3 w-3 animate-spin text-amber-300" />
                +1 NEW TOOL ADDED
              </motion.span>
            ) : (
              <Chip tone="forge">{tools.length} ready</Chip>
            )}
          </AnimatePresence>
        </div>
      }
      anchor={anchorRef("vault")}
      pulseKey={pulseKey}
      pulseTone="forge"
      className="shrink-0"
      bodyClassName="p-2.5"
    >
      <div className="space-y-2">
        {/* 1-line pull-down drawer toggle for 7-Layer Sandbox Security */}
        <div className="rounded-lg border border-forge/25 bg-forge/[0.04]">
          <button
            type="button"
            onClick={() => setSealOpen((o) => !o)}
            aria-label="Toggle 7-Layer Sandbox Security Seal"
            aria-expanded={sealOpen}
            className="flex w-full items-center justify-between px-2.5 py-1 text-left transition-colors hover:bg-forge/[0.06]"
          >
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-bold uppercase tracking-wider text-forge">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-ok" />
              🛡️ 7-Layer Sandbox Security
            </span>
            <div className="flex items-center gap-1.5">
              <Chip tone="ok" className="h-3.5 px-1 text-[8.5px]">
                enforced
              </Chip>
              <ChevronDown className={cx("h-3 w-3 text-forge transition-transform duration-200", sealOpen && "rotate-180")} />
            </div>
          </button>
          <AnimatePresence initial={false}>
            {sealOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden border-t border-forge/20 bg-surface/60 p-1.5"
              >
                <div className="flex flex-wrap gap-1">
                  {SEVEN_LAYER_SEAL.map((guarantee) => (
                    <span
                      key={guarantee}
                      className="inline-flex items-center rounded border border-forge/30 bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink"
                    >
                      {guarantee}
                    </span>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Currently synthesizing indicator */}
        <AnimatePresence initial={false}>
          {synthesizing && forgeSpec && (
            <motion.div
              key="synth"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden rounded-lg border border-dashed border-forge/50 bg-forge/[0.06] p-2"
            >
              <div className="flex items-center justify-between gap-1.5 font-mono text-[11px] text-forge">
                <div className="flex items-center gap-1.5 truncate">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-forge" />
                  <span className="truncate font-semibold">⚒️ Forging {forgeSpec.name}…</span>
                </div>
                <span className="shrink-0 text-[10px] text-ink-3">
                  {forgeTest ? `attempt ${forgeTest.attempt}` : `${forgeSpec.examples.length} tests`}
                </span>
              </div>
              <div className="mt-0.5 line-clamp-1 text-[11px] text-ink-3">{forgeSpec.purpose}</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Clean, glowing 2-line clickable tool pills */}
        {tools.map((t) => (
          <motion.button
            key={t.name}
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={() => onInspect(t.name)}
            disabled={!forgedCode[t.name]}
            title={forgedCode[t.name] ? "Inspect synthesized source" : undefined}
            className="group block w-full rounded-lg border border-forge/35 bg-forge/[0.05] p-2 text-left transition-all hover:border-forge/60 hover:bg-forge/[0.09] hover:shadow-[0_0_12px_rgba(168,85,247,0.18)] disabled:cursor-default"
          >
            <div className="flex items-center justify-between gap-1.5">
              <span className="truncate font-mono text-[12px] font-semibold text-ink">
                <span className="text-forge">⚒️</span> {t.name}
              </span>
              <Chip tone="ok" className="h-4 px-1 text-[9px] font-bold">
                PASS · {t.uses} use{t.uses === 1 ? "" : "s"}
              </Chip>
            </div>
            <div className="mt-0.5 flex items-center justify-between text-[11px] text-ink-3">
              <span className="truncate">{t.description || "Synthesized Python tool"}</span>
              <span className="ml-1.5 shrink-0 font-mono text-[10px] font-medium text-forge group-hover:underline">
                Click to inspect code →
              </span>
            </div>
          </motion.button>
        ))}

        {tools.length === 0 && !synthesizing && (
          <p className="text-[11px] text-ink-3">
            When {brandName} needs a missing calculator, it builds &amp; tests a safe Python tool live here.
          </p>
        )}
      </div>
    </Panel>
  );
}
