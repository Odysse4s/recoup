import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Braces, CheckCircle2, Circle, Layers, Loader2, XCircle } from "lucide-react";
import type { ForgeSpecPayload, ForgeTestPayload, PlanPayload, VerifyPayload } from "../contracts";
import { anchorRef } from "../lib/anchors";
import type { Preset } from "../lib/types";
import { Chip, cx, Panel } from "./ui";

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
      title={plan ? "Plan & Verify" : "Audit presets"}
      icon={<Layers />}
      meta={plan ? <Chip>{plan.steps.length} steps</Chip> : null}
      bodyClassName="scroll-thin overflow-y-auto p-3"
    >
      {plan ? (
        <div className="space-y-3">
          <p className="line-clamp-2 px-0.5 text-[12.5px] leading-snug text-ink-2" title={plan.goal}>
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
                    "relative flex gap-2.5 rounded-lg border p-2.5 transition-colors duration-300",
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
                      <span className="font-mono text-[10px] text-ink-3">STEP {String(s.id).padStart(2, "0")}</span>
                      <Chip tone={missing ? "forge" : "neutral"}>{missing ? `forge · ${s.tool.slice(8)}` : s.tool}</Chip>
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
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Success criteria</span>
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
                      className="flex items-center gap-2 rounded-md px-1 py-1 text-[12px]"
                    >
                      {c.passed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />}
                      <span className="flex-1 text-ink-2">{c.criterion}</span>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((p, i) => (
            <button
              key={i}
              onClick={() => onRun(p.goal)}
              className="group block w-full rounded-lg border border-line bg-surface p-3 text-left transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-card"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <Chip tone={i === 0 ? "accent" : "neutral"}>{p.badge}</Chip>
                <ArrowUpRight className="h-3.5 w-3.5 text-ink-3 transition-colors group-hover:text-accent" />
              </div>
              <div className="text-[13px] font-semibold leading-snug tracking-tight text-ink">{p.title}</div>
              <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-3">{p.desc}</div>
            </button>
          ))}
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
  return (
    <Panel
      title="Synthesized Tools"
      icon={<Braces />}
      meta={<Chip tone="forge">Sandboxed</Chip>}
      anchor={anchorRef("vault")}
      pulseKey={pulseKey}
      pulseTone="forge"
      className="shrink-0"
      bodyClassName="p-3"
    >
      <div className="space-y-2">
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
                <span className="ml-auto text-[10px] text-ink-3">
                  {forgeTest ? `attempt ${forgeTest.attempt}` : `${forgeSpec.examples.length} examples`}
                </span>
              </div>
              <div className="mt-1 text-[11.5px] text-ink-3">{forgeSpec.purpose}</div>
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
              <span className="font-mono text-[12px] text-ink">
                <span className="text-forge">def</span> {t.name}
                <span className="text-ink-3">(args) → dict</span>
              </span>
              <Chip tone="ok" className="ml-auto">
                pass · {t.uses} use{t.uses === 1 ? "" : "s"}
              </Chip>
            </div>
            <div className="mt-1 line-clamp-2 text-[11.5px] text-ink-3">{t.description}</div>
          </motion.button>
        ))}
        {tools.length === 0 && !synthesizing && (
          <p className="text-[12px] leading-relaxed text-ink-3">
            When the planner encounters <code className="font-mono text-forge">MISSING:&lt;tool&gt;</code>, {brandName} synthesizes, AST-validates and unit-tests a
            pure Python tool — then registers it here.
          </p>
        )}
      </div>
    </Panel>
  );
}
