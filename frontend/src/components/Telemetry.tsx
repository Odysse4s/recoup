import { AnimatePresence, motion } from "framer-motion";
import { Activity, ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventType, ServerEvent } from "../contracts";
import { InlineCode } from "../lib/highlight";
import { soundFx } from "../lib/sound";
import { Chip, cx, Segmented, type Tone } from "./ui";

const toneOf = (t: EventType): Tone =>
  t.startsWith("forge")
    ? "forge"
    : t === "approval_needed" || t === "tool_error"
    ? "danger"
    : t === "approval_result" || t === "replay_step_done" || t === "run_done"
    ? "ok"
    : t === "offer" || t === "call_start" || t === "call_turn" || t === "call_end"
    ? "signal"
    : t === "undo_step" || t === "rehearse_start" || t === "rehearse_report"
    ? "warn"
    : "accent";

type Filter = "all" | "agent" | "forge" | "gate";
const matches = (f: Filter, t: EventType) =>
  f === "all" ||
  (f === "forge" && t.startsWith("forge")) ||
  (f === "gate" && ["approval_needed", "approval_result", "replay_step_done", "undo_step", "run_done", "call_start", "call_turn", "call_end"].includes(t)) ||
  (f === "agent" && ["plan", "replan", "evidence", "tool_call", "tool_done", "tool_error", "verify", "rehearse_start", "rehearse_report", "offer"].includes(t));

export function Telemetry({
  events,
  queued,
  connected,
  mode,
}: {
  events: ServerEvent[];
  queued: number;
  connected: boolean;
  mode: "live" | "demo";
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const list = useMemo(() => events.filter((e) => matches(filter, e.type)), [events, filter]);
  const t0 = events[0]?.ts ?? 0;
  const latest = events[events.length - 1];

  useEffect(() => {
    if (expanded && follow && ref.current) {
      ref.current.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
    }
  }, [expanded, list.length, follow]);

  const statusChip = (
    <Chip tone={connected ? "ok" : "neutral"}>{connected ? (mode === "demo" ? "demo trace" : "sse live") : "offline"}</Chip>
  );

  return (
    <section className="relative shrink-0 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      {!expanded ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => {
            soundFx.playUiClick();
            setExpanded(true);
          }}
          className="group flex h-10 w-full items-center justify-between gap-2.5 px-3.5 text-left transition-colors hover:bg-sunken/50"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Activity className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <span className="shrink-0 text-[12px] font-semibold tracking-tight text-ink">
              {`Live Event Trace · ${events.length} events`}
            </span>
            {statusChip}
            {queued > 0 && <Chip tone="accent">{queued} paced</Chip>}
            {latest && <Chip tone={toneOf(latest.type)}>{latest.type}</Chip>}
            {latest?.thought && (
              <span className="hidden min-w-0 truncate text-[11.5px] text-ink-3 xl:inline">
                {latest.thought.replace(/`/g, "")}
              </span>
            )}
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] font-medium text-ink-3 transition-colors group-hover:text-ink">
            Click to expand
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        </button>
      ) : (
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <h2 className="truncate text-[12px] font-semibold tracking-tight text-ink">
              {`Live Event Trace · ${events.length} events`}
            </h2>
            {statusChip}
            {queued > 0 && <Chip tone="accent">{queued} paced</Chip>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Segmented<Filter>
              ariaLabel="Telemetry filter"
              size="xs"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "agent", label: "Agent" },
                { value: "forge", label: "Forge" },
                { value: "gate", label: "Gate" },
              ]}
            />
            <button
              type="button"
              aria-expanded={true}
              onClick={() => {
                soundFx.playUiClick();
                setExpanded(false);
              }}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-sunken px-2 font-mono text-[11px] font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
            >
              Collapse
              <ChevronUp className="h-3 w-3" />
            </button>
          </div>
        </header>
      )}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="trace-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="relative overflow-hidden"
          >
            <div
              ref={ref}
              onScroll={(e) => {
                const el = e.currentTarget;
                setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
              }}
              className="scroll-thin max-h-[240px] min-h-[120px] overflow-y-auto"
            >
              {list.length === 0 ? (
                <div className="flex h-[120px] flex-col items-center justify-center gap-1 px-6 text-center">
                  <span className="text-[12.5px] font-medium text-ink-2">No events yet</span>
                  <span className="text-[11.5px] text-ink-3">Run an audit goal or Demo Replay to stream SSE events.</span>
                </div>
              ) : (
                <ol className="py-1">
                  {list.map((ev) => {
                    const tone = toneOf(ev.type);
                    const dt = Math.max(0, ev.ts - t0);
                    return (
                      <motion.li
                        key={ev.id}
                        initial={{ opacity: 0, x: -8, backgroundColor: "color-mix(in oklab, var(--accent) 8%, transparent)" }}
                        animate={{ opacity: 1, x: 0, backgroundColor: "rgba(0,0,0,0)" }}
                        transition={{ duration: 0.4, backgroundColor: { duration: 1.6 } }}
                        className="grid grid-cols-[52px_128px_1fr_auto] items-baseline gap-3 px-3.5 py-1.5 hover:bg-sunken/60"
                      >
                        <span className="font-mono text-[10.5px] text-ink-3 tabular">+{dt < 1000 ? dt.toFixed(2) : "—"}s</span>
                        <span>
                          <Chip tone={tone}>{ev.type}</Chip>
                        </span>
                        <span className="min-w-0 text-[12.5px] leading-snug text-ink-2">
                          {ev.step !== null && <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">#{ev.step}</span>}
                          {ev.thought ? <InlineCode text={ev.thought} /> : <span className="text-ink-3">—</span>}
                        </span>
                        <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-3 tabular">
                          {ev.latency_ms ? `${ev.latency_ms}ms` : ""}
                          {ev.cost_eur ? ` · €${ev.cost_eur.toFixed(4)}` : ""}
                        </span>
                      </motion.li>
                    );
                  })}
                </ol>
              )}
            </div>
            {!follow && list.length > 0 && (
              <button
                type="button"
                onClick={() => setFollow(true)}
                className={cx(
                  "absolute bottom-2.5 right-3 flex h-7 items-center gap-1 rounded-full border border-line bg-raised px-2.5 text-[11.5px] text-ink-2 shadow-card hover:text-ink"
                )}
              >
                <ArrowDown className="h-3 w-3" /> Follow
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
