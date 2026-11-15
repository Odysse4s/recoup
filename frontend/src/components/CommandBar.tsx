import { AnimatePresence, motion } from "framer-motion";
import {
  Camera,
  CornerDownLeft,
  FileCheck2,
  Loader2,
  Mic,
  Paperclip,
  Sparkles,
  UploadCloud,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { ApprovalNeededPayload, EvidencePayload } from "../contracts";
import { soundFx } from "../lib/sound";
import { pickRecorderMimeType, stopSpeaking, useSpeechInput, useVoiceSignal } from "../lib/voice";
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
  isGateActive = false,
}: {
  mode: "speaking" | "listening";
  text: string;
  progress: number;
  isGateActive?: boolean;
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
          title={
            listening
              ? "Microphone voice input active"
              : provider
              ? "Cloud Voice: Grok Voice · fal.ai"
              : "Voice briefing active"
          }
        >
          <Chip tone={listening ? "danger" : "accent"}>
            {listening ? <Mic className="h-2.5 w-2.5" /> : <Volume2 className="h-2.5 w-2.5" />}
            {listening ? (isGateActive ? "Voice Gate Mic" : "Push-to-talk") : provider ?? "Grok Voice · fal.ai"}
          </Chip>
          <VoiceOrb variant="bars" tone={listening ? "danger" : "accent"} className="h-5 w-[76px]" />
        </div>
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-snug tracking-tight">
          {listening && !text ? (
            <span className="text-ink-3">
              {isGateActive
                ? "Listening — ask “Why €587?” or say “Enforce claim” / “Hold off”…"
                : "Listening — speak a supplier audit goal or “approve”..."}
            </span>
          ) : (
            <>
              <span className={listening ? "text-ink" : "karaoke-spoken"}>{spoken}</span>
              <span className="text-ink-3">{rest}</span>
              {listening && (
                <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-danger cursor-blink" />
              )}
            </>
          )}
        </p>
        {!listening && (
          <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{
                width: `${Math.round(progress * 100)}%`,
                backgroundImage: "linear-gradient(90deg, var(--accent), var(--purple))",
              }}
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
  consultActive = false,
  onApprove,
  onDesktopVoiceTurn,
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
  consultActive?: boolean;
  onApprove?: (reqId: string, approved: boolean) => void;
  onDesktopVoiceTurn?: (text: string) => Promise<void> | void;
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
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  // Dual-Engine STT + Auto-Run State
  const [recording, setRecording] = useState(false);
  const [autoRunCountdown, setAutoRunCountdown] = useState<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const hasReceivedFinalTranscriptRef = useRef(false);
  const autoRunTimerRef = useRef<number | null>(null);
  const pendingGoalRef = useRef<string | null>(null);
  const lastProcessedSentenceRef = useRef<string>("");
  const lastSentenceTsRef = useRef<number>(0);

  useEffect(() => {
    if (evidenceItems.length === 0) setEvidenceOpen(false);
  }, [evidenceItems.length]);

  // Clean up media tracks and timers
  const cleanupMediaTracks = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      cleanupMediaTracks();
      if (autoRunTimerRef.current) {
        window.clearTimeout(autoRunTimerRef.current);
      }
    };
  }, [cleanupMediaTracks]);

  // Routing the transcribed voice input
  const handleSpokenSentence = useCallback(
    (sentence: string) => {
      const clean = sentence.trim();
      if (!clean) return;

      const now = Date.now();
      if (
        clean.toLowerCase() === lastProcessedSentenceRef.current.toLowerCase() &&
        now - lastSentenceTsRef.current < 2500
      ) {
        return;
      }
      lastProcessedSentenceRef.current = clean;
      lastSentenceTsRef.current = now;

      soundFx.playUiClick();

      // Case A — pendingApproval is active at the Risk Gate OR an open post-commit voice consult is awaiting follow-up ("Need anything else?")
      if (pendingApproval || consultActive) {
        if (onDesktopVoiceTurn) {
          void onDesktopVoiceTurn(clean);
          return;
        }
        if (pendingApproval && onApprove) {
          const lower = clean.toLowerCase();
          if (/^(approve|yes|confirm|authorize|commit|enforce)\b/.test(lower)) {
            onApprove(pendingApproval.req_id, true);
            return;
          }
          if (/^(reject|abort|deny|cancel|no|rollback|hold)\b/.test(lower)) {
            onApprove(pendingApproval.req_id, false);
            return;
          }
        }
        return;
      }

      // Case B — Idle / no active gate (!pendingApproval and !busy)
      if (!busy) {
        onChange(clean);
        pendingGoalRef.current = clean;
        setAutoRunCountdown(1);

        if (autoRunTimerRef.current) window.clearTimeout(autoRunTimerRef.current);
        autoRunTimerRef.current = window.setTimeout(() => {
          setAutoRunCountdown(null);
          if (pendingGoalRef.current) {
            onSubmit(pendingGoalRef.current.trim());
            pendingGoalRef.current = null;
          }
        }, 1000);
      }
    },
    [busy, consultActive, onApprove, onChange, onDesktopVoiceTurn, onSubmit, pendingApproval]
  );

  // Send recorded Audio Blob to /api/voice/stt fallback
  const sendRecorderBlobToStt = useCallback(
    async (blob: Blob, ext: string) => {
      if (blob.size < 400 || hasReceivedFinalTranscriptRef.current) return;
      try {
        const formData = new FormData();
        formData.append("audio", blob, `command_voice.${ext || "webm"}`);
        const res = await fetch("/api/voice/stt", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          const data = (await res.json()) as { ok?: boolean; text?: string; transcript?: string };
          const text = (data.text || data.transcript || "").trim();
          if (text && !hasReceivedFinalTranscriptRef.current) {
            hasReceivedFinalTranscriptRef.current = true;
            handleSpokenSentence(text);
          }
        }
      } catch (err) {
        console.warn("CommandBar /api/voice/stt error:", err);
      }
    },
    [handleSpokenSentence]
  );

  // Web Speech API hook
  const speech = useSpeechInput((text, final) => {
    setTranscript(text);
    if (!pendingApproval && !consultActive) {
      onChange(text);
    }
    if (final && text.trim()) {
      hasReceivedFinalTranscriptRef.current = true;
      handleSpokenSentence(text);
      if (speech.listening) speech.stop();
      cleanupMediaTracks();
      inputRef.current?.focus();
    }
  });

  const stopRecordingSession = useCallback(() => {
    if (speech.listening) {
      speech.stop();
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    } else {
      cleanupMediaTracks();
    }
  }, [cleanupMediaTracks, speech]);

  const startRecordingSession = useCallback(async () => {
    // 1. Barge-in immediately
    stopSpeaking();

    // Cancel any active auto-run countdown
    if (autoRunTimerRef.current) {
      window.clearTimeout(autoRunTimerRef.current);
      autoRunTimerRef.current = null;
    }
    setAutoRunCountdown(null);
    pendingGoalRef.current = null;

    setTranscript("");
    hasReceivedFinalTranscriptRef.current = false;
    audioChunksRef.current = [];

    // Start Web Speech API recognizer
    if (speech.supported) {
      speech.start();
    }

    // Acquire MediaStream for simultaneous MediaRecorder capture
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      setRecording(true);

      const { mimeType, ext } = pickRecorderMimeType();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          audioChunksRef.current.push(ev.data);
        }
      };

      rec.onstop = () => {
        const blob = new Blob(audioChunksRef.current, {
          type: rec.mimeType || mimeType || "audio/webm",
        });
        audioChunksRef.current = [];

        // If Web Speech API didn't produce a final transcript, fallback to /api/voice/stt
        if (!hasReceivedFinalTranscriptRef.current && blob.size >= 400) {
          void sendRecorderBlobToStt(blob, ext);
        }

        cleanupMediaTracks();
      };

      rec.start(250);
    } catch (micErr) {
      console.warn("Microphone capture failed:", micErr);
      if (speech.supported) {
        setRecording(true);
      }
    }
  }, [cleanupMediaTracks, sendRecorderBlobToStt, speech]);

  const toggleRecording = useCallback(() => {
    soundFx.playUiClick();
    if (recording || speech.listening) {
      stopRecordingSession();
    } else {
      void startRecordingSession();
    }
  }, [recording, speech.listening, startRecordingSession, stopRecordingSession]);

  useEffect(() => {
    if (speech.listening || recording) setTranscript("");
  }, [recording, speech.listening]);

  const isMicActive = recording || speech.listening;
  const captionProgress = useCaptionProgress(spokenText, speaking, speechProgress);
  const caption: { mode: "speaking" | "listening"; text: string } | null = isMicActive
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
      if (e.key === "Escape" && autoRunCountdown !== null) {
        if (autoRunTimerRef.current) window.clearTimeout(autoRunTimerRef.current);
        setAutoRunCountdown(null);
        pendingGoalRef.current = null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoRunCountdown]);

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
          if (autoRunTimerRef.current) {
            window.clearTimeout(autoRunTimerRef.current);
            autoRunTimerRef.current = null;
          }
          setAutoRunCountdown(null);
          soundFx.playUiClick();
          onSubmit(value.trim());
        }}
        className={cx(
          "relative flex h-10 w-full items-center gap-2 rounded-xl border bg-surface pl-3 pr-1.5 shadow-card transition-all",
          dragOver
            ? "border-accent bg-accent/[0.06] ring-4 ring-accent/15"
            : isMicActive
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
          onChange={(e) => {
            if (autoRunCountdown !== null) {
              if (autoRunTimerRef.current) window.clearTimeout(autoRunTimerRef.current);
              setAutoRunCountdown(null);
              pendingGoalRef.current = null;
            }
            onChange(e.target.value);
          }}
          placeholder={
            dragOver
              ? "Drop receiving photo or delivery note to audit into workspace inbox…"
              : isMicActive
              ? pendingApproval
                ? "Listening — ask a question or approve/reject by voice…"
                : "Listening — speak your audit goal…"
              : "Check delivery D-1042 from Kappa Office Systems — 22 hubs arrived missing or broken and invoice INV-7781 is overcharged"
          }
          aria-label="Goal"
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
        />
        {!focused && !value && !dragOver && autoRunCountdown === null && <Kbd>⌘K</Kbd>}

        {/* Auto-Run Countdown Pill */}
        {autoRunCountdown !== null && (
          <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent animate-pulse">
            <span>⚡ Running in 1s…</span>
            <button
              type="button"
              onClick={() => {
                if (autoRunTimerRef.current) window.clearTimeout(autoRunTimerRef.current);
                setAutoRunCountdown(null);
                pendingGoalRef.current = null;
                inputRef.current?.focus();
              }}
              className="ml-1 rounded px-1 text-[9.5px] text-ink-2 underline hover:text-ink"
            >
              Cancel / Edit (Esc)
            </button>
          </div>
        )}

        {evidenceItems.length > 0 && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                soundFx.playUiClick();
                setEvidenceOpen((o) => !o);
              }}
              title="Click to view attached evidence findings"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-ok/40 bg-ok/10 px-2 text-[12px] font-medium text-ink transition-colors hover:bg-ok/15"
            >
              <Paperclip className="h-3.5 w-3.5 text-ok shrink-0" />
              <span className="max-w-[150px] truncate font-mono text-[11px] font-semibold text-ok">
                {evidenceItems.length === 1 ? evidenceItems[0].source : `${evidenceItems.length} attachments`}
              </span>
              {onDismissEvidence && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Dismiss evidence"
                  onClick={(e) => {
                    e.stopPropagation();
                    soundFx.playUiClick();
                    evidenceItems.forEach((ev) => onDismissEvidence(ev.source));
                    setEvidenceOpen(false);
                  }}
                  className="ml-0.5 rounded p-0.5 text-ink-3 hover:text-ink hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="h-3 w-3" />
                </span>
              )}
            </button>

            <AnimatePresence>
              {evidenceOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.98 }}
                  transition={{ duration: 0.16 }}
                  className="absolute right-0 top-full z-40 mt-2 w-[380px] max-w-[90vw] rounded-xl border border-line bg-surface p-3 shadow-card backdrop-blur-xl"
                >
                  <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
                    <span className="text-[12px] font-semibold text-ink">
                      Attached Evidence ({evidenceItems.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setEvidenceOpen(false)}
                      className="rounded p-0.5 text-ink-3 hover:text-ink"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="max-h-[220px] space-y-2 overflow-y-auto scroll-thin">
                    {evidenceItems.map((ev) => (
                      <div key={ev.source} className="rounded-lg border border-line/60 bg-sunken/50 p-2.5 text-[11.5px]">
                        <div className="mb-1 flex items-center justify-between gap-1">
                          <span className="truncate font-mono font-semibold text-ink">{ev.source}</span>
                          <Chip tone={ev.kind === "photo" ? "signal" : "ok"}>
                            {ev.kind === "photo" ? (
                              <Camera className="h-2.5 w-2.5" />
                            ) : (
                              <FileCheck2 className="h-2.5 w-2.5" />
                            )}
                            {ev.kind}
                          </Chip>
                        </div>
                        <div className="space-y-0.5 text-ink-2">
                          {ev.findings.map((f, i) => (
                            <div key={i} className="line-clamp-2">
                              • {f}
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              soundFx.playUiClick();
                              if (/1042|kappa/i.test(ev.source) || ev.findings.some((f) => /1042|kappa|7781/i.test(f))) {
                                onChange(
                                  "Check delivery D-1042 from Kappa Office Systems — 22 hubs arrived missing or broken and invoice INV-7781 is overcharged"
                                );
                              } else {
                                const summary = ev.findings?.slice(0, 2).join("; ") || "inspect discrepancies";
                                onChange(
                                  `Audit uploaded ${ev.kind} (${ev.source}: ${summary}), cross-check contract & ERP tables, and stage any supplier claim`
                                );
                              }
                              setEvidenceOpen(false);
                              inputRef.current?.focus();
                            }}
                            className="rounded border border-accent/35 bg-accent/10 px-2 py-0.5 text-[10.5px] font-semibold text-accent hover:bg-accent/15"
                          >
                            Use in Goal
                          </button>
                          {onDismissEvidence && (
                            <button
                              type="button"
                              onClick={() => {
                                onDismissEvidence(ev.source);
                                if (evidenceItems.length <= 1) setEvidenceOpen(false);
                              }}
                              className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:text-danger"
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {onUploadEvidence && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.md,.txt,.csv,.json,.pdf"
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
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

        {/* Upgraded Dual-Engine Voice Button */}
        <button
          type="button"
          onClick={toggleRecording}
          aria-pressed={isMicActive}
          aria-label={isMicActive ? "Stop voice input" : "Voice input"}
          title={
            isMicActive
              ? "Stop listening"
              : pendingApproval
              ? "Speak question or decision (e.g. 'Why €587?' or 'Approve')"
              : "Voice input (Speak goal to auto-run)"
          }
          className={cx(
            "relative flex h-8 items-center gap-2 overflow-hidden rounded-lg border px-2.5 text-[12px] font-medium transition-colors",
            isMicActive
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-line bg-sunken text-ink-2 hover:text-ink disabled:opacity-40"
          )}
        >
          <Mic className={cx("h-3.5 w-3.5", isMicActive && "animate-pulse text-danger")} />
          <AnimatePresence initial={false}>
            {isMicActive && (
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
          <span className="hidden sm:inline">
            {isMicActive ? "Listening" : pendingApproval ? "Voice Gate" : "Voice"}
          </span>
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
            isGateActive={Boolean(pendingApproval)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
