import { AnimatePresence, motion } from "framer-motion";
import { Camera, CornerDownLeft, FileCheck2, Loader2, Mic, MicOff, Paperclip, Sparkles, UploadCloud, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { ApprovalNeededPayload, EvidencePayload } from "../contracts";
import { soundFx } from "../lib/sound";
import { useSpeechInput, useVoiceSignal } from "../lib/voice";
import { btn, Chip, cx, Kbd } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

const EST_CHARS_PER_SEC = 15;

function useCaptionProgress(text: string | null, speaking: boolean, reported: number) {
  const [estimate, setEstimate] = useState(0);
  useEffect(() => {
    setEstimate(0);
    if (!speaking || !text) return;
    const start = performance.now();
    const t = window.setInterval(() => {
      const chars = ((performance.now() - start) / 1000) * EST_CHARS_PER_SEC;
      setEstimate(Math.min(0.98, chars / text.length));
    }, 100);
    return () => window.clearInterval(t);
  }, [text, speaking]);
  return speaking ? Math.max(reported, estimate) : 1;
}

function sentencesOf(text: string) {
  const out: { start: number; text: string }[] = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ start: m.index, text: m[0] });
  return out.length ? out : [{ start: 0, text }];
}

function VoiceCaption({
  mode,
  text,
  progress,
}: {
  mode: "speaking" | "listening";
  text: string;
  progress: number;
}) {
  const listening = mode === "listening";
  const signal = useVoiceSignal();
  const provider = !listening && signal.provider === "fal" ? "Grok Voice · fal.ai" : null;
  const { spoken, rest } = useMemo(() => {
    if (listening) return { spoken: text, rest: "" };
    const pos = Math.round(progress * text.length);
    const sentences = sentencesOf(text);
    const current = [...sentences].reverse().find((s) => s.start <= pos) ?? sentences[0];
    const within = Math.max(0, Math.min(current.text.length, pos - current.start));
    const nextSpace = current.text.indexOf(" ", within);
    const cut = within === 0 ? 0 : nextSpace === -1 ? current.text.length : nextSpace;
    return { spoken: current.text.slice(0, cut), rest: current.text.slice(cut) };
  }, [listening, text, progress]);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: "auto", marginTop: 8 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      role="status"
      aria-live="polite"
      className="overflow-hidden"
    >
      <div
        className={cx(
          "flex h-[34px] items-center gap-3 rounded-xl border bg-surface px-3.5 shadow-card",
          listening ? "border-danger/40" : "border-accent/35"
        )}
      >
        <div
          className="flex shrink-0 items-center gap-2"
          title={listening ? "Push-to-talk microphone active" : provider ? "Cloud Voice: Grok Voice · fal.ai" : "Voice briefing active"}
        >
          <Chip tone={listening ? "danger" : "accent"}>
            {listening ? <Mic className="h-2.5 w-2.5" /> : <Volume2 className="h-2.5 w-2.5" />}
            {listening ? "Push-to-talk" : provider ?? "Grok Voice · fal.ai"}
          </Chip>
          <VoiceOrb variant="bars" tone={listening ? "danger" : "accent"} className="h-5 w-[76px]" />
        </div>
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-snug tracking-tight">
          {listening && !text ? (
            <span className="text-ink-3">Listening — speak a supplier audit goal or “approve”…</span>
          ) : (
            <>
              <span className={listening ? "text-ink" : "karaoke-spoken"}>{spoken}</span>
              <span className="text-ink-3">{rest}</span>
              {listening && <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-danger cursor-blink" />}
            </>
          )}
        </p>
        {!listening && (
          <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{ width: `${Math.round(progress * 100)}%`, backgroundImage: "linear-gradient(90deg, var(--accent), var(--purple))" }}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function CommandBar({
  value,
  onChange,
  onSubmit,
  busy,
  pendingApproval = null,
  onApprove,
  speaking = false,
  spokenText = null,
  speechProgress = 0,
  evidenceItems = [],
  uploadingEvidence = false,
  onUploadEvidence,
  onDismissEvidence,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (goal: string) => void;
  busy: boolean;
  brandName?: string;
  pendingApproval?: ApprovalNeededPayload | null;
  onApprove?: (reqId: string, approved: boolean) => void;
  speaking?: boolean;
  spokenText?: string | null;
  speechProgress?: number;
  evidenceItems?: EvidencePayload[];
  uploadingEvidence?: boolean;
  onUploadEvidence?: (file: File) => Promise<EvidencePayload | null>;
  onDismissEvidence?: (source: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [transcript, setTranscript] = useState("");

  const speech = useSpeechInput((text, final) => {
    setTranscript(text);
    if (final && pendingApproval && onApprove) {
      const cmd = text.trim().toLowerCase();
      if (/^(approve|yes|confirm|authorize|commit)\b/.test(cmd)) {
        onApprove(pendingApproval.req_id, true);
        return;
      }
      if (/^(reject|abort|deny|cancel|no|rollback)\b/.test(cmd)) {
        onApprove(pendingApproval.req_id, false);
        return;
      }
    }
    onChange(text);
    if (final) inputRef.current?.focus();
  });

  useEffect(() => {
    if (speech.listening) setTranscript("");
  }, [speech.listening]);

  const captionProgress = useCaptionProgress(spokenText, speaking, speechProgress);
  const caption: { mode: "speaking" | "listening"; text: string } | null = speech.listening
    ? { mode: "listening", text: transcript }
    : speaking && spokenText
    ? { mode: "speaking", text: spokenText }
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !onUploadEvidence) return;
    soundFx.playUiClick();
    await onUploadEvidence(file);
  };

  const onDragEnterOrOver = (e: DragEvent<HTMLDivElement>) => {
    if (!onUploadEvidence) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    await handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      className="relative min-w-0 flex-1"
      onDragEnter={onDragEnterOrOver}
      onDragOver={onDragEnterOrOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim() || busy) return;
          soundFx.playUiClick();
          onSubmit(value.trim());
        }}
        className={cx(
          "relative flex h-11 w-full items-center gap-2 rounded-xl border bg-surface pl-3 pr-1.5 shadow-card transition-all",
          dragOver
            ? "border-accent bg-accent/[0.06] ring-4 ring-accent/15"
            : speech.listening
            ? "border-danger/50"
            : focused
            ? "border-accent/60 ring-4 ring-accent/10"
            : "border-line"
        )}
      >
        {dragOver ? (
          <UploadCloud className="h-4 w-4 shrink-0 animate-bounce text-accent" />
        ) : (
          <Sparkles className="h-4 w-4 shrink-0 text-accent" />
        )}
        <input
          ref={inputRef}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            dragOver
              ? "Drop receiving photo or delivery note to audit into workspace inbox…"
              : speech.listening
              ? "Listening…"
              : "Check delivery D-1042 from Kappa Office Systems — 22 hubs arrived missing or broken and invoice INV-7781 is overcharged"
          }
          aria-label="Goal"
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
        />
        {!focused && !value && !dragOver && <Kbd>⌘K</Kbd>}

        {onUploadEvidence && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.md,.txt,.csv,.json,.pdf"
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploadingEvidence}
              onClick={() => {
                soundFx.playUiClick();
                fileInputRef.current?.click();
              }}
              aria-label="Attach File"
              title="Attach receiving photo, delivery note, or invoice (or drag & drop onto bar)"
              className={cx(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors",
                uploadingEvidence
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-line bg-sunken text-ink-2 hover:border-accent/40 hover:text-ink"
              )}
            >
              {uploadingEvidence ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
              <span className="hidden md:inline">{uploadingEvidence ? "Auditing…" : "Attach File"}</span>
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => {
            soundFx.playUiClick();
            speech.toggle();
          }}
          disabled={!speech.supported}
          aria-pressed={speech.listening}
          aria-label={speech.listening ? "Stop voice input" : "Voice input"}
          title={speech.supported ? (speech.listening ? "Stop listening" : "Voice input") : "Voice input isn't supported in this browser"}
          className={cx(
            "relative flex h-8 items-center gap-2 overflow-hidden rounded-lg border px-2.5 text-[12px] font-medium transition-colors",
            speech.listening
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-line bg-sunken text-ink-2 hover:text-ink disabled:opacity-40"
          )}
        >
          {speech.supported ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
          <AnimatePresence initial={false}>
            {speech.listening && (
              <motion.span
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "auto", opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                className="flex items-center overflow-hidden"
              >
                <VoiceOrb variant="bars" tone="danger" className="h-4 w-9" />
              </motion.span>
            )}
          </AnimatePresence>
          <span className="hidden sm:inline">{speech.listening ? "Listening" : "Voice"}</span>
        </button>

        <button
          type="submit"
          disabled={!value.trim() || busy}
          className={cx(btn("primary", "md"), "h-8 pl-3 pr-2.5 gap-1.5")}
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Running…</span>
            </>
          ) : (
            <>
              <span>Run Agent ↵</span>
              <CornerDownLeft className="h-3.5 w-3.5 opacity-70" />
            </>
          )}
        </button>
      </form>

      <AnimatePresence>
        {caption && (
          <VoiceCaption
            key={caption.mode}
            mode={caption.mode}
            text={caption.text}
            progress={caption.mode === "speaking" ? captionProgress : 1}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {evidenceItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 8 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            className="space-y-1.5 overflow-hidden"
          >
            {evidenceItems.slice(0, 2).map((ev) => (
              <div
                key={ev.source}
                className="flex items-center gap-2.5 rounded-xl border border-ok/35 bg-surface px-3 py-1.5 text-[12px] shadow-card"
              >
                <Chip tone={ev.kind === "photo" ? "signal" : "ok"}>
                  {ev.kind === "photo" ? <Camera className="h-2.5 w-2.5" /> : <FileCheck2 className="h-2.5 w-2.5" />}
                  {ev.kind}
                </Chip>
                <code className="shrink-0 font-mono text-[11px] font-semibold text-ink">{ev.source}</code>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {ev.findings.join(" · ")}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    soundFx.playUiClick();
                    onChange(
                      "Check delivery D-1042 from Kappa Office Systems — 22 hubs arrived missing or broken and invoice INV-7781 is overcharged"
                    );
                    inputRef.current?.focus();
                  }}
                  className="shrink-0 rounded-md border border-accent/35 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-accent/15"
                >
                  Use in Goal
                </button>
                {onDismissEvidence && (
                  <button
                    type="button"
                    onClick={() => onDismissEvidence(ev.source)}
                    aria-label={`Dismiss ${ev.source}`}
                    className="rounded p-0.5 text-ink-3 hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
