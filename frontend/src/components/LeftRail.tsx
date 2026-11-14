import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Braces, CheckCircle2, Circle, Layers, Loader2, ShieldCheck, Sparkles, XCircle } from "lucide-react";
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
  return (
    <Panel
      title={plan ? "Agent Plan" : "Audit Presets"}
      icon={<Layers />}
      meta={plan ? <Chip>{plan.steps.length} steps</Chip> : null}
      bodyClassName="scroll-thin overflow-y-auto p-3"
    >
      {plan ? (
        <div className="space-y-2.5">
          <p className="line-clamp-1 px-0.5 text-[12px] font-medium text-ink-2" title={plan.goal}>
            {plan.goal.includes("Goal:") ? plan.goal.split("Goal:").pop()!.trim() : plan.goal}
          </p>
          <ol className="relative space-y-1.5">
            {plan.steps.map((s, i) => {
              const missing = s.tool.startsWith("MISSING:");
              return (
                <motion.li
                  key={s.id}
                  layout
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                  className={cx(
                    "relative flex gap-2.5 rounded-lg border p-2 transition-colors duration-300",
                    s.status === "running" && "border-accent/40 bg-accent/[0.07]",
                    s.status === "done" && "border-line bg-surface",
                    s.status === "failed" && "border-danger/40 bg-danger/[0.06]",
                    s.status === "pending" && "border-line bg-sunken/60"
                  )}
                >
                  <span className="mt-px shrink-0">
                    {s.status === "done" ? (
                      <CheckCircle2 className="h-4 w-4 text-ok" />
                    ) : s.status === "running" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    ) : s.status === "failed" ? (
                      <XCircle className="h-4 w-4 text-danger" />
                    ) : (
                      <Circle className="h-4 w-4 text-ink-3" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium leading-snug text-ink">{s.intent}</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="font-mono text-[10.5px] font-semibold text-ink-3">STEP {String(s.id).padStart(2, "0")}</span>
                      <Chip tone={missing ? "forge" : "neutral"}>{missing ? `build · ${s.tool.slice(8)}` : s.tool}</Chip>
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </ol>

          <AnimatePresence>
            {verify && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="overflow-hidden"
              >
                <div className="mb-1.5 mt-1 flex items-center justify-between px-0.5">
                  <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Verification</span>
                  <Chip tone={verify.passed ? "ok" : "danger"}>{verify.passed ? "Verified" : "Failed"}</Chip>
                </div>
                <div className="space-y-1">
                  {verify.criteria.map((c, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.12 * i }}
                      title={c.detail}
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[12px]"
                    >
                      {c.passed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />}
                      <span className="line-clamp-1 flex-1 font-medium text-ink-2">{c.criterion}</span>
                    </motion.div>
                  ))}
                </div>
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
            {showNewBadge && (
              <motion.span
                initial={{ scale: 0.6, opacity: 0, y: -2 }}
                animate={{ scale: [1, 1.12, 1], opacity: 1, y: 0 }}
                exit={{ scale: 0.8, opacity: 0 }}
                transition={{ duration: 0.35 }}
                className="inline-flex h-5 items-center gap-1 rounded-md border border-emerald-400 bg-emerald-500/20 px-2 font-mono text-[10px] font-bold tracking-wider text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.5)]"
              >
                <Sparkles className="h-3 w-3 animate-spin text-amber-300" />
                +1 NEW TOOL ADDED
              </motion.span>
            )}
          </AnimatePresence>
          <Chip tone="forge">7-Layer Sandbox</Chip>
        </div>
      }
      anchor={anchorRef("vault")}
      pulseKey={pulseKey}
      pulseTone="forge"
      className="shrink-0"
      bodyClassName="p-3"
    >
      <div className="space-y-2.5">
        {/* +1 NEW TOOL ADDED banner flash */}
        <AnimatePresence>
          {showNewBadge && (
            <motion.div
              initial={{ opacity: 0, height: 0, scale: 0.95 }}
              animate={{ opacity: 1, height: "auto", scale: 1 }}
              exit={{ opacity: 0, height: 0, scale: 0.95 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden rounded-lg border border-emerald-500/50 bg-gradient-to-r from-emerald-950/70 via-slate-900 to-purple-950/70 p-2.5 text-emerald-300 shadow-[0_0_18px_rgba(16,185,129,0.3)]"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-emerald-300">
                  <span className="inline-block animate-bounce">⚒️</span> +1 NEW TOOL ADDED TO TOOLBOX
                </span>
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-emerald-200">
                  READY FOR EXECUTION
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 7-Layer Sandbox Security Seal */}
        <div
          aria-label="7-Layer Sandbox Security Seal"
          className="rounded-lg border border-forge/35 bg-forge/[0.06] p-2.5"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-forge">
              <ShieldCheck className="h-3.5 w-3.5 text-ok" />
              7-Layer Security Seal
            </span>
            <Chip tone="ok" className="h-4 px-1.5 text-[9.5px]">
              enforced
            </Chip>
          </div>
          <div className="flex flex-wrap gap-1">
            {SEVEN_LAYER_SEAL.map((guarantee) => (
              <span
                key={guarantee}
                className="inline-flex items-center rounded border border-forge/30 bg-surface/90 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-ink"
              >
                {guarantee}
              </span>
            ))}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {synthesizing && forgeSpec && (
            <motion.div
              key="synth"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden rounded-lg border border-dashed border-forge/40 bg-forge/[0.05] p-2.5"
            >
              <div className="flex items-center gap-2 font-mono text-[12px] text-forge">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                def {forgeSpec.name}(args)
                <span className="ml-auto text-[10.5px] text-ink-3">
                  {forgeTest ? `attempt ${forgeTest.attempt}` : `${forgeSpec.examples.length} tests`}
                </span>
              </div>
              <div className="mt-1 line-clamp-1 text-[12px] text-ink-3">{forgeSpec.purpose}</div>
            </motion.div>
          )}
        </AnimatePresence>
        {tools.map((t) => (
          <motion.button
            key={t.name}
            layout
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={() => onInspect(t.name)}
            disabled={!forgedCode[t.name]}
            title={forgedCode[t.name] ? "Inspect synthesized source" : undefined}
            className="group block w-full rounded-lg border border-line bg-surface p-2.5 text-left transition-colors enabled:hover:border-forge/40 disabled:cursor-default"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12.5px] font-medium text-ink">
                <span className="text-forge">def</span> {t.name}
                <span className="text-ink-3">(args) → dict</span>
              </span>
              <Chip tone="ok" className="ml-auto">
                pass · {t.uses} use{t.uses === 1 ? "" : "s"}
              </Chip>
            </div>
            <div className="mt-1 line-clamp-1 text-[12px] text-ink-3">{t.description}</div>
          </motion.button>
        ))}
        {tools.length === 0 && !synthesizing && (
          <p className="text-[12px] text-ink-3">
            On <code className="font-mono text-forge">MISSING:&lt;tool&gt;</code>, {brandName} builds &amp; verifies pure Python tools inside the 7-layer sandbox.
          </p>
        )}
      </div>
    </Panel>
  );
}
