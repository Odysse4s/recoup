import { animate, AnimatePresence, motion, useMotionValue, useTransform } from "framer-motion";
import {
  ChevronRight,
  ChevronsRight,
  Monitor,
  Moon,
  PhoneOff,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Undo2,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApprovalNeededPayload } from "../contracts";
import type { RecoupRuntime } from "../hooks/useRecoup";
import { InlineCode } from "../lib/highlight";
import { narrate } from "../lib/narrate";
import { soundFx } from "../lib/sound";
import type { Theme } from "../lib/theme";
import { DiffBlock } from "./RightRail";
import { RecoupMark, VoicePill } from "./TopBar";
import { btn, Chip, cx, Dot } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

const buzz = (p: number | number[]) => {
  try {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (ua && !ua.hasBeenActive) return;
    navigator.vibrate?.(p);
  } catch {
    // unsupported
  }
};

function useClock() {
  const [d, setD] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setD(new Date()), 15000);
    return () => window.clearInterval(t);
  }, []);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, "");
}

function StatusBar() {
  const time = useClock();
  return (
    <div className="relative z-30 flex h-[54px] shrink-0 items-center justify-between px-8 pt-1 text-[15px] font-semibold text-ink">
      <span className="w-16 tabular">{time}</span>
      <span className="flex w-16 items-center justify-end gap-1.5">
        <svg width="18" height="11" viewBox="0 0 18 11" aria-hidden className="fill-current">
          <rect x="0" y="7" width="3" height="4" rx="0.8" />
          <rect x="5" y="5" width="3" height="6" rx="0.8" />
          <rect x="10" y="2.5" width="3" height="8.5" rx="0.8" />
          <rect x="15" y="0" width="3" height="11" rx="0.8" />
        </svg>
        <svg width="25" height="12" viewBox="0 0 25 12" aria-hidden>
          <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" className="fill-none stroke-current opacity-40" />
          <rect x="2" y="2" width="16" height="8" rx="2" className="fill-current" />
          <rect x="23" y="4" width="1.6" height="4" rx="0.8" className="fill-current opacity-40" />
        </svg>
      </span>
    </div>
  );
}

function SlideToApprove({ onApprove }: { onApprove: () => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [max, setMax] = useState(260);
  const fill = useTransform(x, (v) => v + 64);
  const hint = useTransform(x, [0, max * 0.6], [1, 0]);
  useEffect(() => {
    if (trackRef.current) setMax(trackRef.current.offsetWidth - 64 - 8);
  }, []);
  return (
    <div ref={trackRef} className="relative h-[72px] overflow-hidden rounded-full border border-ok/30 bg-ok/10 p-1">
      <motion.div className="absolute inset-y-1 left-1 rounded-full bg-ok/25" style={{ width: fill }} />
      <motion.div style={{ opacity: hint }} className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 pl-12 text-[15px] font-semibold text-ok">
        slide to approve commit <ChevronsRight className="h-4 w-4 animate-pulse" />
      </motion.div>
      <motion.button
        aria-label="Approve commit"
        drag="x"
        dragConstraints={{ left: 0, right: max }}
        dragElastic={0.02}
        dragMomentum={false}
        style={{ x }}
        onDragEnd={() => {
          if (x.get() > max * 0.82) {
            animate(x, max, { duration: 0.15 });
            buzz([20, 40, 20]);
            soundFx.playUiClick();
            onApprove();
          } else animate(x, 0, { type: "spring", stiffness: 500, damping: 30 });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            soundFx.playUiClick();
            onApprove();
          }
        }}
        className="relative z-10 flex h-16 w-16 cursor-grab items-center justify-center rounded-full bg-ok text-on-solid shadow-lg active:cursor-grabbing"
      >
        <ChevronRight className="h-7 w-7" strokeWidth={2.5} />
      </motion.button>
    </div>
  );
}

function IncomingCall({ approval, r }: { approval: ApprovalNeededPayload; r: RecoupRuntime }) {
  const [secs, setSecs] = useState(0);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    buzz([200, 120, 200]);
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [approval.req_id]);

  return (
    <motion.div
      key={approval.req_id}
      initial={{ opacity: 0, scale: 1.04 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.35 }}
      className="absolute inset-0 z-20 flex flex-col"
      style={{
        background:
          "radial-gradient(120% 60% at 50% 0%, color-mix(in oklab, var(--danger) 22%, var(--canvas)), var(--canvas) 70%)",
      }}
    >
      <StatusBar />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-8">
        <div className="mt-6 flex flex-col items-center text-center">
          <span className="text-[13px] font-medium text-ink-2">
            incoming risk gate call · {String(Math.floor(secs / 60)).padStart(1, "0")}:{String(secs % 60).padStart(2, "0")}
          </span>
          <h1 className="mt-1 text-[30px] font-semibold tracking-[-0.03em] text-ink">{r.brand.brand_name} Risk Gate</h1>
          <div className="relative mt-3 flex h-40 w-40 shrink-0 items-center justify-center">
            <VoiceOrb variant="orb" tone="danger" ambient className="absolute inset-0 h-full w-full" />
            <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-danger text-white shadow-[0_20px_60px_-10px_var(--danger)]">
              <ShieldAlert className="h-9 w-9" />
            </span>
          </div>
          <span className="mt-1 text-[12.5px] font-medium text-ink-3" aria-live="polite">
            {r.speaking ? "Reading executive risk summary aloud…" : "Ringing — tap speaker to replay summary"}
          </span>
        </div>

        <div className="mt-5 rounded-2xl border border-line bg-surface/80 p-4 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <code className="font-mono text-[14px] font-medium text-ink">{approval.tool_name}()</code>
            <Chip tone="danger">approval required</Chip>
          </div>
          <p className="mt-1.5 text-[14px] leading-snug text-ink-2">{approval.risk_reason}</p>
          <button
            onClick={() => {
              soundFx.playUiClick();
              setDetails((d) => !d);
            }}
            className="mt-2 text-[13px] font-medium text-accent"
          >
            {details ? "Hide staged diff" : "Show staged diff"}
          </button>
          <AnimatePresence>
            {details && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mt-2 overflow-hidden rounded-lg border border-line">
                  {approval.diff_preview ? (
                    <DiffBlock diff={approval.diff_preview} max={160} />
                  ) : (
                    <pre className="bg-code p-2 font-mono text-[11px] text-ink-2">{JSON.stringify(approval.args, null, 2)}</pre>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-auto space-y-6 pt-6">
          <div className="flex items-end justify-around">
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={() => {
                  buzz(60);
                  soundFx.playUiClick();
                  r.decide(approval.req_id, false);
                }}
                aria-label="Reject and rollback"
                className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-danger text-white shadow-lg active:scale-95"
              >
                <PhoneOff className="h-7 w-7" />
              </button>
              <span className="text-[12.5px] font-medium text-ink-2">Reject &amp; Rollback</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={() => {
                  soundFx.playUiClick();
                  r.replayBriefing();
                }}
                aria-label="Repeat spoken summary"
                className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-line bg-surface/80 text-ink backdrop-blur active:scale-95"
              >
                <Volume2 className={cx("h-7 w-7", r.speaking && "animate-pulse text-accent")} />
              </button>
              <span className="text-[12.5px] font-medium text-ink-2">{r.speaking ? "Speaking…" : "Repeat summary"}</span>
            </div>
          </div>
          <SlideToApprove onApprove={() => r.decide(approval.req_id, true)} />
        </div>
      </div>
    </motion.div>
  );
}

function GateHome({ r, theme, onToggleTheme, onExit }: { r: RecoupRuntime; theme: Theme; onToggleTheme: () => void; onExit: () => void }) {
  const recent = r.events.slice(-4).reverse();
  const click = (fn: () => void) => () => {
    soundFx.playUiClick();
    fn();
  };
  return (
    <div className="flex h-full flex-col">
      <StatusBar />
      <div className="flex items-center justify-between px-5 pb-3 pt-2">
        <div className="flex items-center gap-2.5">
          <RecoupMark className="h-8 w-8" />
          <div className="leading-tight">
            <div className="text-[17px] font-semibold tracking-tight text-ink">Mobile Risk Gate</div>
            <div className="max-w-[220px] truncate text-[12px] text-ink-3">
              <span className="font-medium text-ink-2">{r.brand.brand_name}</span> · {r.brand.brand_tagline}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={click(onToggleTheme)} aria-label="Toggle theme" className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2">
            {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
          <button onClick={click(onExit)} aria-label="Open desktop HUD" className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2">
            <Monitor className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-5 pb-4">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-5 shadow-card">
          <div className="flex items-center gap-4">
            <div className="relative flex h-16 w-16 items-center justify-center">
              <motion.span
                className="absolute inset-0 rounded-full border-2 border-ok/40"
                animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 2.6, repeat: Infinity }}
              />
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-ok/12 text-ok">
                <ShieldCheck className="h-8 w-8" />
              </span>
            </div>
            <div>
              <div className="text-[20px] font-semibold tracking-tight text-ink">Risk gate armed</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-3">
                <Dot tone={r.connected ? "ok" : "neutral"} live={r.connected} />
                {r.connected ? "Live SSE link to runtime" : "Standby · demo ready"}
              </div>
            </div>
          </div>
          <p className="mt-4 text-[13.5px] leading-relaxed text-ink-2">
            Vendor claims of EUR 250+, outbound emails/calls, row deletions and first-run synthesized tools ring this device for manager sign-off.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Hash</div>
              <div className="font-mono text-[13px] text-ink">{(r.wsState?.fingerprint ?? "——").slice(0, 8)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Receipts</div>
              <div className="font-mono text-[13px] text-ink">{r.wsState?.undo_stack.length ?? 0}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Risk held</div>
              <div className={cx("font-mono text-[13px]", r.pendingApproval ? "text-danger" : "text-ink")}>{r.pendingApproval ? 1 : 0}</div>
            </div>
          </div>
        </div>

        <div className="flex justify-center">
          <VoicePill r={r} compact />
        </div>

        <AnimatePresence>
          {r.offer && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="rounded-3xl border border-signal/40 bg-surface p-4 shadow-card"
            >
              <div className="flex items-center gap-2 text-[12px] font-semibold text-signal">
                <Sparkles className="h-4 w-4" /> Anticipated · {Math.round(r.offer.prediction.confidence * 100)}%
              </div>
              <div className="mt-1.5 text-[15px] font-semibold leading-snug text-ink">{r.offer.prediction.need}</div>
              <div className="mt-1 text-[13px] text-ink-3">{r.offer.prediction.evidence}</div>
              <div className="mt-3 flex gap-2">
                <button onClick={click(() => r.acceptOffer(r.offer!.offer_id))} className={cx(btn("signal", "lg"), "h-11 flex-1 rounded-xl")}>
                  Apply ({r.offer.mutations_count})
                </button>
                <button onClick={click(() => r.dismissOffer(r.offer!.offer_id))} className={cx(btn("outline", "lg"), "h-11 rounded-xl")}>
                  Dismiss
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="rounded-3xl border border-line bg-surface p-4 shadow-card">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">Recent activity</div>
          {recent.length === 0 ? (
            <div className="text-[13px] text-ink-3">Quiet. Audits started on the desktop HUD stream here live.</div>
          ) : (
            <ul className="space-y-2.5">
              {recent.map((e) => (
                <li key={e.id} className="text-[13px] leading-snug text-ink-2">
                  <InlineCode text={narrate(e, r.brand.brand_name)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t border-line px-5 pb-8 pt-3">
        <button
          onClick={() => r.undo()}
          disabled={!!r.rewind || (r.wsState?.undo_stack.length ?? 0) === 0}
          className={cx(btn("warn", "lg"), "h-14 w-full rounded-2xl text-[15px]")}
        >
          <Undo2 className={cx("h-5 w-5", r.rewind && "animate-spin [animation-direction:reverse]")} />
          {r.rewind ? "Rewinding…" : `Reversible Undo (${r.wsState?.undo_stack.length ?? 0})`}
        </button>
      </div>
    </div>
  );
}

export function MobileGate({
  r,
  theme,
  onToggleTheme,
  onExit,
}: {
  r: RecoupRuntime;
  theme: Theme;
  onToggleTheme: () => void;
  onExit: () => void;
}) {
  const [framed, setFramed] = useState(() => window.innerWidth > 520);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => {
      setFramed(window.innerWidth > 520);
      setScale(Math.min(1, (window.innerHeight - 48) / 956, (window.innerWidth - 32) / 440));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const screen = (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <GateHome r={r} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} />
      <AnimatePresence>{r.pendingApproval && <IncomingCall approval={r.pendingApproval} r={r} />}</AnimatePresence>
    </div>
  );

  if (!framed) return <div className="h-[100dvh] w-full text-ink">{screen}</div>;

  return (
    <div className="recoup-canvas flex h-screen w-full items-center justify-center gap-14 overflow-hidden text-ink">
      <div className="hidden max-w-[300px] xl:block">
        <div className="flex items-center gap-2">
          <RecoupMark className="h-6 w-6" />
          <span className="text-[13px] font-semibold text-ink">{r.brand.brand_name} · Mobile Risk Gate</span>
        </div>
        <h2 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.03em] text-ink">High-value claims ring your phone.</h2>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
          When {r.brand.brand_name} intercepts a vendor claim of EUR 250+ or outbound dispatch, this device receives an executive voice briefing. Slide to commit staged ERP changes, or reject and roll back.
        </p>
        <button
          onClick={() => {
            soundFx.playUiClick();
            onExit();
          }}
          className={cx(btn("outline", "md"), "mt-6")}
        >
          <Monitor className="h-3.5 w-3.5" /> Back to Audit Control
        </button>
      </div>
      <div style={{ width: 440 * scale, height: 956 * scale }} className="shrink-0">
        <div
          style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
          className="relative h-[956px] w-[440px] rounded-[72px] bg-[#1a1b1f] p-[12px] shadow-[0_0_0_2px_#3a3b40,0_50px_120px_-30px_rgba(0,0,0,0.6)]"
        >
          <div className="relative h-full w-full overflow-hidden rounded-[60px]">
            {screen}
            <div className="pointer-events-none absolute left-1/2 top-[11px] z-40 flex h-[37px] w-[126px] -translate-x-1/2 items-center justify-end rounded-full bg-black pr-3">
              {r.pendingApproval && <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />}
            </div>
            <div className="pointer-events-none absolute bottom-2 left-1/2 z-40 h-[5px] w-[140px] -translate-x-1/2 rounded-full bg-ink/70" />
          </div>
        </div>
      </div>
    </div>
  );
}
