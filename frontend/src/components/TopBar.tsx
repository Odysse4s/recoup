import { AnimatePresence, motion } from "framer-motion";
import { AudioLines, FileDown, Mic, MicOff, Moon, Play, RotateCcw, ShieldCheck, Smartphone, Sun, Volume2, VolumeX } from "lucide-react";
import type { RecoupRuntime } from "../hooks/useRecoup";
import { soundFx, useSfx } from "../lib/sound";
import { PACE, type Speed } from "../lib/speed";
import type { Theme } from "../lib/theme";
import { useVoiceSignal } from "../lib/voice";
import { btn, Chip, cx, Dot, Equalizer, Segmented, type Tone } from "./ui";

export function RecoupMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="recoup-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--signal)" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 27 6.8v8c0 7.1-4.6 12.4-11 14.7C9.6 27.2 5 21.9 5 14.8v-8L16 2.5Z" fill="url(#recoup-g)" />
      <path
        d="M11.3 15.8a4.7 4.7 0 0 1 8.1-3.2l1.2-1.2v3.8h-3.8l1.3-1.3a3 3 0 1 0 .8 2.8h1.7a4.7 4.7 0 0 1-9.3-.9Z"
        fill="white"
        fillOpacity=".96"
      />
      <path d="m13.6 16.2 1.7 1.7 3.5-3.5 1.2 1.2-4.7 4.7-2.9-2.9 1.2-1.2Z" fill="white" fillOpacity=".96" />
    </svg>
  );
}

function statusOf(r: RecoupRuntime): { label: string; tone: Tone; live: boolean } {
  if (r.rewind) return { label: "Rewinding receipts", tone: "warn", live: true };
  if (r.pendingApproval) return { label: "Awaiting authorization", tone: "danger", live: true };
  if (r.rehearsalActive) return { label: "Rehearsal active", tone: "warn", live: true };
  if (r.runStatus === "committing") return { label: "Committing changes", tone: "accent", live: true };
  if (r.runStatus === "running") return { label: "Audit running", tone: "accent", live: true };
  if (r.runStatus === "aborted") return { label: "Rolled back", tone: "warn", live: false };
  return { label: "Risk guard armed", tone: "ok", live: false };
}

export function TopBar({
  r,
  theme,
  onToggleTheme,
  onOpenMobile,
}: {
  r: RecoupRuntime;
  theme: Theme;
  onToggleTheme: (origin: { x: number; y: number }) => void;
  onOpenMobile: () => void;
}) {
  const status = statusOf(r);
  const domainLabel = r.wsState?.domain?.label ?? "Enterprise Vendor Ops";
  const click = (fn: () => void) => () => {
    soundFx.playUiClick();
    fn();
  };

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2.5 overflow-x-hidden border-b border-line bg-surface/80 px-3.5 backdrop-blur-xl xl:gap-3.5 xl:px-5">
      <div className="flex shrink-0 items-center gap-2.5" title={r.wsState?.domain?.vertical}>
        <RecoupMark className="h-6 w-6 shrink-0 xl:h-7 xl:w-7" />
        <div className="leading-none">
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-semibold tracking-[-0.02em] text-ink xl:text-[15px]">{r.brand.brand_name}</span>
            <Chip tone="accent" className="hidden h-4 px-1.5 text-[9px] sm:inline-flex">
              <ShieldCheck className="h-2.5 w-2.5" /> {domainLabel}
            </Chip>
          </div>
          <div className="mt-0.5 hidden max-w-[260px] truncate text-[10.5px] text-ink-3 lg:block 2xl:max-w-[360px]">
            {r.brand.brand_tagline}
          </div>
        </div>
      </div>

      <div className="hidden h-5 w-px shrink-0 bg-line xl:block" />

      <AnimatePresence mode="wait">
        <motion.div
          key={status.label}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.18 }}
          className="hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-sunken px-2.5 py-1 text-[11.5px] font-medium text-ink-2 xl:flex"
        >
          <Dot tone={status.tone} live={status.live} />
          {status.label}
          <span className="font-mono text-[10.5px] text-ink-3">{r.wsState?.fingerprint ?? "——"}</span>
        </motion.div>
      </AnimatePresence>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 xl:gap-2">
        <VoicePill r={r} />

        <Segmented<Speed>
          ariaLabel="Pace"
          size="xs"
          value={r.speed}
          onChange={r.setSpeed}
          options={(Object.keys(PACE) as Speed[]).map((s) => ({
            value: s,
            label: s === "1x" ? "1x" : PACE[s].label,
            title: `${s === "1x" ? "1x Cinematic · " : ""}${PACE[s].eventMs}ms per event`,
          }))}
        />

        <button
          onClick={(e) => {
            soundFx.playUiClick();
            const rect = e.currentTarget.getBoundingClientRect();
            onToggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Editorial Daylight" : "Emerald Tactical"}
          className={cx(btn("outline", "sm"), "w-8 px-0")}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={theme}
              initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
              animate={{ rotate: 0, opacity: 1, scale: 1 }}
              exit={{ rotate: 90, opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.2 }}
            >
              {theme === "dark" ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            </motion.span>
          </AnimatePresence>
        </button>

        <div className="h-5 w-px bg-line" />

        <button onClick={click(r.runDemo)} className={cx(btn("outline", "sm"), "whitespace-nowrap")}>
          <Play className="h-3.5 w-3.5 text-accent" /> Demo Replay
        </button>
        <a
          href="/api/runs/report?download=1"
          download
          className={cx(btn("ghost", "sm"), "whitespace-nowrap")}
          title="Download documented Markdown audit report of the latest run"
        >
          <FileDown className="h-3.5 w-3.5" /> <span className="hidden lg:inline">Report</span>
        </a>
        <button onClick={click(onOpenMobile)} className={cx(btn("ghost", "sm"), "whitespace-nowrap")} title="Open the Mobile Risk Gate (/mobile)">
          <Smartphone className="h-3.5 w-3.5" /> <span className="hidden lg:inline">Mobile</span>
        </button>
        <button onClick={click(r.reset)} className={cx(btn("ghost", "sm"), "w-8 px-0")} title="Reset workspace" aria-label="Reset workspace">
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

export function SfxToggle({ compact }: { compact?: boolean }) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      onClick={sfx.toggle}
      aria-pressed={sfx.enabled}
      aria-label={sfx.enabled ? "Mute interface sound effects" : "Enable interface sound effects"}
      title={sfx.enabled ? "Interface sound effects on (voice briefings are separate)" : "Interface sound effects off"}
      className={cx(
        "relative flex h-8 items-center gap-1.5 rounded-full border px-2.5 transition-colors",
        sfx.enabled ? "border-line bg-sunken text-ink-2 hover:text-ink" : "border-dashed border-line-strong text-ink-3 hover:text-ink-2"
      )}
    >
      <AnimatePresence>
        {sfx.enabled && sfx.pulse > 0 && (
          <motion.span
            key={sfx.pulse}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full border border-accent"
            initial={{ opacity: 0.85, scale: 1 }}
            animate={{ opacity: 0, scale: 1.32 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65, ease: [0.2, 0.8, 0.2, 1] }}
          />
        )}
      </AnimatePresence>
      <motion.span
        key={sfx.enabled ? sfx.pulse : "off"}
        initial={{ scale: sfx.enabled ? 0.82 : 1 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 600, damping: 18 }}
        className={cx("relative flex h-3.5 w-3.5 items-center justify-center", sfx.enabled && "text-accent")}
      >
        <AudioLines className="h-3.5 w-3.5" />
        {!sfx.enabled && <span aria-hidden className="absolute h-[1.5px] w-[18px] -rotate-45 rounded-full bg-current" />}
      </motion.span>
      {!compact && <span className="hidden font-mono text-[10px] font-medium uppercase tracking-wider 2xl:inline">SFX</span>}
    </button>
  );
}

export function VoicePill({ r, compact }: { r: RecoupRuntime; compact?: boolean }) {
  const signal = useVoiceSignal();
  const sfx = useSfx();
  const falCloud = r.speaking && signal.provider === "fal";
  return (
    <div
      className={cx(
        "flex h-8 items-center gap-0.5 rounded-full border px-1 transition-colors",
        r.speaking ? "border-purple/40 bg-purple/10" : "border-line bg-sunken"
      )}
    >
      <button
        type="button"
        onClick={() => {
          soundFx.playUiClick();
          r.replayBriefing();
        }}
        disabled={!r.lastBriefing}
        title={
          r.lastBriefing
            ? `fal.ai Voice · Replay briefing: “${r.lastBriefing}”`
            : "fal.ai Voice briefings play on rehearsal, risk gate and operator consultations"
        }
        className="flex h-6 items-center gap-1.5 rounded-full pl-2 pr-2 text-[11.5px] font-medium text-ink-2 hover:text-ink disabled:cursor-default"
      >
        <Equalizer active={r.speaking} bars={5} tone={r.voiceOn ? "accent" : "neutral"} />
        {!compact && (
          <span className="hidden items-center gap-1 whitespace-nowrap 2xl:flex">
            {falCloud ? "fal.ai Voice" : r.speaking ? "fal.ai Voice…" : r.voiceOn ? "fal.ai Voice" : "Voice Off"}
            {r.lastBriefing && !r.speaking && <Play className="h-2.5 w-2.5 text-ink-3" />}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={() => {
          soundFx.playUiClick();
          r.toggleVoice();
        }}
        aria-pressed={!r.voiceOn}
        aria-label={r.voiceOn ? "Disable fal.ai Voice briefings" : "Enable fal.ai Voice briefings"}
        title={r.voiceOn ? "fal.ai Voice Briefings: ON (click to mute speech)" : "fal.ai Voice Briefings: OFF"}
        className={cx(
          "flex h-6 items-center gap-1 rounded-full px-1.5 font-mono text-[10px] font-medium transition-colors",
          r.voiceOn ? "text-ink-2 hover:bg-surface hover:text-ink" : "text-ink-3 opacity-60 hover:bg-surface hover:text-ink-2"
        )}
      >
        {r.voiceOn ? <Mic className="h-3 w-3 text-accent" /> : <MicOff className="h-3 w-3" />}
      </button>

      <span className="h-3.5 w-px bg-line" aria-hidden />

      <button
        type="button"
        onClick={sfx.toggle}
        aria-pressed={sfx.enabled}
        aria-label={sfx.enabled ? "Mute UI sound effects (SFX)" : "Enable UI sound effects (SFX)"}
        title={sfx.enabled ? "UI Sound Effects (SFX): ON" : "UI Sound Effects (SFX): OFF"}
        className={cx(
          "relative flex h-6 items-center gap-1 rounded-full px-2 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors",
          sfx.enabled ? "text-ink-2 hover:bg-surface hover:text-ink" : "text-ink-3 opacity-60 hover:bg-surface hover:text-ink-2"
        )}
      >
        <AnimatePresence>
          {sfx.enabled && sfx.pulse > 0 && (
            <motion.span
              key={sfx.pulse}
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full border border-accent"
              initial={{ opacity: 0.85, scale: 0.95 }}
              animate={{ opacity: 0, scale: 1.28 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
            />
          )}
        </AnimatePresence>
        {sfx.enabled ? <Volume2 className="h-3.5 w-3.5 text-accent" /> : <VolumeX className="h-3.5 w-3.5" />}
        <span>SFX</span>
      </button>
    </div>
  );
}
