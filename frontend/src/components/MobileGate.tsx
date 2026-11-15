import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  ChevronDown,
  Database,
  FileCheck2,
  FileCode2,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Moon,
  PackageCheck,
  PhoneCall,
  PhoneOff,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  Undo2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalNeededPayload,
  CallEndPayload,
  CallStartPayload,
  CallTurnPayload,
  ServerEvent,
} from "../contracts";
import type { RecoupRuntime } from "../hooks/useRecoup";
import { InlineCode } from "../lib/highlight";
import { narrate } from "../lib/narrate";
import { soundFx } from "../lib/sound";
import type { Theme } from "../lib/theme";
import type { OperatorChoice, OperatorConsultState, OperatorConsultTurn } from "../lib/types";
import {
  acquirePersistentMicStream,
  getPrimedAudioElement,
  getSharedAudioContext,
  getWarmMicStream,
  hasSpeechRecognition,
  isMobileCallManagingAudio,
  mutePersistentMicStream,
  pickRecorderMimeType,
  prefetchTurnAudio,
  setMobileCallOwnsAudio,
  speakCallTurn,
  stopSpeaking,
  unlockAudioSession,
  useAutoVad,
  useSpeechInput,
} from "../lib/voice";
import { DiffBlock } from "./RightRail";
import { RecoupMark, VoicePill } from "./TopBar";
import { btn, Chip, cx, Dot } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

const DEFAULT_CLAIM_ID = "CLM-D-1042";
const DEFAULT_OPENING_QUESTION =
  "Hey! Kappa's delivery is short 22 hubs—they owe us 587 euros. Should I demand the full refund, or take replacement hubs?";

let cachedRingtoneUrl: string | null = null;
function getDualToneRingtoneUrl(): string {
  if (cachedRingtoneUrl) return cachedRingtoneUrl;
  const sampleRate = 8000;
  const ringDuration = 1.2;
  const totalDuration = 3.0;
  const totalSamples = Math.floor(sampleRate * totalDuration);
  const ringSamples = Math.floor(sampleRate * ringDuration);
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46); // 'RIFF'
  view.setUint32(4, 36 + totalSamples * 2, true);
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45); // 'WAVE'
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20); // 'fmt '
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61); // 'data'
  view.setUint32(40, totalSamples * 2, true);

  const attackDecaySamples = Math.floor(sampleRate * 0.05); // 50ms fade
  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    let sample = 0;
    if (i < ringSamples) {
      const t = i / sampleRate;
      let env = 1;
      if (i < attackDecaySamples) {
        env = i / attackDecaySamples;
      } else if (i > ringSamples - attackDecaySamples) {
        env = (ringSamples - i) / attackDecaySamples;
      }
      // Enterprise dual-tone (440Hz + 480Hz)
      const tone = (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * 0.45;
      sample = Math.max(-32768, Math.min(32767, Math.round(tone * env * 32767)));
    }
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  cachedRingtoneUrl = URL.createObjectURL(blob);
  return cachedRingtoneUrl;
}

function AudioUnlockBanner({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      className="flex w-full items-center justify-between gap-2 border-b border-signal/40 bg-signal/15 px-5 py-2.5 text-[12px] font-semibold text-signal transition-colors hover:bg-signal/20 active:scale-[0.99] animate-pulse"
    >
      <span className="flex items-center gap-2">
        <Volume2 className="h-4 w-4 shrink-0 animate-bounce" />
        <span>🔔 Tap Once to Arm Ringtone &amp; Mic</span>
      </span>
      <span className="shrink-0 rounded-full bg-signal px-2 py-0.5 text-[10.5px] font-bold text-white shadow-sm">
        Arm Audio
      </span>
    </button>
  );
}

function AudioArmedBadge() {
  return (
    <div className="flex flex-col border-b border-ok/30 bg-ok/10 px-5 py-2 text-[12px] text-ok">
      <div className="flex items-center gap-2 font-semibold">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
        <span>✓ Ringtone &amp; Mic Armed (Zero Prompts Ready)</span>
      </div>
      <div className="mt-0.5 text-[11px] text-ink-3">
        Safari tip: tap aA → Website Settings → Microphone → Allow once to persist across refreshes
      </div>
    </div>
  );
}

const buzz = (p: number | number[]) => {
  try {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (ua && !ua.hasBeenActive) return;
    navigator.vibrate?.(p);
  } catch {
    // unsupported
  }
};

function parseChoiceFromText(text: string): OperatorChoice | null {
  const lower = text.toLowerCase();
  if (/\b(re-?deliver\w*|replace\w*|22\s*unit|option\s*a|9\.3)\b/.test(lower)) {
    return "redelivery";
  }
  if (/\b(refund|credit\s*note|587|5\.1|option\s*b|enforce|hold|approve|yes|confirm)\b/.test(lower)) {
    return "refund";
  }
  return null;
}

function defaultConfirmationFor(choice: OperatorChoice, claimId: string): string {
  if (choice === "redelivery") {
    return `Confirmed. Accepting next-day 22-unit USB-C hub re-delivery for ${claimId} and staging AADE myDATA Type 9.3 discrepancy credit of €202.30. Reversible undo receipt is ready.`;
  }
  return `Confirmed. Placing full AP hold on INV-7781 and staging Greek AADE myDATA Type 5.1 credit note for ${claimId} at €587.30 net (€728.25 gross with 24% VAT). Reversible undo receipt is ready.`;
}

function deriveConsultFromEvents(events: ServerEvent[], speaking: boolean): OperatorConsultState | null {
  let latestStartIdx = -1;
  let startPayload: CallStartPayload | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "call_start") {
      const p = ev.payload as unknown as CallStartPayload;
      if (p.channel === "desktop_voice") {
        continue;
      }
      if (
        p.channel === "voice_call" ||
        p.channel === "iphone_transferred" ||
        p.mode === "user_consult" ||
        (typeof p.call_id === "string" && /consult|user|mobile/i.test(p.call_id))
      ) {
        latestStartIdx = i;
        startPayload = p;
      }
    }
  }

  if (latestStartIdx < 0 || !startPayload) return null;

  const callId = startPayload.call_id || `CONSULT-${DEFAULT_CLAIM_ID}`;
  const turns: OperatorConsultTurn[] = [];
  let endPayload: CallEndPayload | null = null;
  let selectedChoice: OperatorChoice | null = null;

  for (let i = latestStartIdx + 1; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "call_turn") {
      const t = ev.payload as unknown as CallTurnPayload;
      if (t.channel === "desktop_voice") {
        continue;
      }
      if (!t.call_id || t.call_id === callId) {
        turns.push({
          speaker: t.speaker,
          text: t.text,
          audioUrl: t.audio_url ?? null,
          ts: ev.ts || Date.now(),
        });
        if (t.speaker === "user") {
          const parsed = parseChoiceFromText(t.text);
          if (parsed) selectedChoice = parsed;
        }
      }
    } else if (ev.type === "call_end") {
      const e = ev.payload as unknown as CallEndPayload;
      if (!e.call_id || e.call_id === callId) {
        endPayload = e;
        if (!selectedChoice) {
          selectedChoice =
            typeof e.agreed_amount === "number" && e.agreed_amount > 0 && e.agreed_amount < 350
              ? "redelivery"
              : parseChoiceFromText(e.summary) ?? "refund";
        }
      }
    }
  }

  const lastTurn = turns[turns.length - 1];
  return {
    active: !endPayload,
    ringing: turns.length === 0 && !endPayload,
    mode: "user_consult",
    channel: (startPayload.channel as "notification" | "voice_call" | "desktop_voice" | "iphone_transferred") ?? "voice_call",
    callId,
    reqId: startPayload.req_id ?? null,
    claimId: startPayload.claim_id || DEFAULT_CLAIM_ID,
    claimAmount: typeof startPayload.claim_amount === "number" ? startPayload.claim_amount : 587.3,
    counterparty: startPayload.counterparty || "Operator Mobile",
    turns,
    activeSpeaker: !endPayload && speaking && lastTurn ? lastTurn.speaker : null,
    selectedChoice,
    end: endPayload
      ? {
          outcome: endPayload.outcome,
          agreed_amount: endPayload.agreed_amount,
          summary: endPayload.summary,
        }
      : null,
  };
}

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
    <div className="relative z-30 flex h-[50px] shrink-0 items-center justify-between px-7 pt-1 text-[14.5px] font-semibold text-ink">
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

interface LocalCompletion {
  sessionKey: string;
  choice: OperatorChoice;
  summary: string;
  claimId: string;
}

interface MobileConsultTurn extends OperatorConsultTurn {
  id?: string;
}

interface ActiveStreamingTurn {
  id: string;
  fullText: string;
  currentText: string;
}

interface UserRespondApiBody {
  ok?: boolean;
  call_id?: string;
  keep_call_open?: boolean;
  call_status?: "connected" | "ended";
  choice?: OperatorChoice | string;
  transcript?: string;
  reply_text?: string;
  confirmation_text?: string;
  reply?: string;
  confirmation?: string;
  summary?: string;
  spoken_summary?: string;
  agreed_amount?: number;
  resolved?: boolean;
  approved?: boolean;
  ui_action?: {
    action: string;
    path?: string;
    view?: string;
    table?: string;
    label?: string;
  } | null;
}

function OperatorEscalationCall({
  sessionKey,
  consult,
  approval,
  r,
  localCompletion,
  audioUnlocked,
  onUnlockAudio,
  onSetLocalCompletion,
  onDismissCompleted,
  onEndWithoutDecision,
}: {
  sessionKey: string;
  consult: OperatorConsultState | null;
  approval: ApprovalNeededPayload | null;
  r: RecoupRuntime;
  localCompletion: LocalCompletion | null;
  audioUnlocked: boolean;
  onUnlockAudio: () => void;
  onSetLocalCompletion: (c: LocalCompletion | null) => void;
  onDismissCompleted: () => void;
  onEndWithoutDecision: () => void;
}) {
  const [secs, setSecs] = useState(0);
  const [answered, setAnswered] = useState(() => {
    // If call is already active with turns on reconnect, consider answered
    return Boolean(consult?.active && !consult?.ringing && consult.turns.length > 0);
  });
  const [details, setDetails] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [localTurns, setLocalTurns] = useState<MobileConsultTurn[]>([]);
  const [warmStream, setWarmStream] = useState<MediaStream | null>(null);
  const [committedChoice, setCommittedChoice] = useState<OperatorChoice | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");

  const activeStreamingTurnRef = useRef<ActiveStreamingTurn | null>(null);
  const actionToastTimerRef = useRef<number | null>(null);
  const spokenOpeningKeyRef = useRef<string | null>(null);
  const spokenEndKeyRef = useRef<string | null>(null);
  const lastSpokenTextRef = useRef<string>("");

  const initialReqIdRef = useRef<string | null>(approval?.req_id ?? consult?.reqId ?? null);
  useEffect(() => {
    if (approval?.req_id) initialReqIdRef.current = approval.req_id;
  }, [approval?.req_id]);
  const reqId = approval?.req_id ?? consult?.reqId ?? initialReqIdRef.current;

  const claimId = useMemo(() => {
    if (consult?.claimId) return consult.claimId;
    if (localCompletion?.claimId) return localCompletion.claimId;
    const argRow = approval?.args?.row as Record<string, unknown> | undefined;
    const candidate = approval?.args?.claim_id ?? argRow?.id;
    return typeof candidate === "string" && candidate.trim() ? candidate : DEFAULT_CLAIM_ID;
  }, [approval, consult?.claimId, localCompletion?.claimId]);

  const claimAmount = useMemo(() => {
    if (typeof consult?.claimAmount === "number" && consult.claimAmount > 0) return consult.claimAmount;
    const argRow = approval?.args?.row as Record<string, unknown> | undefined;
    const candidate =
      (typeof approval?.args?.claim_amount === "number" ? approval.args.claim_amount : null) ??
      (typeof approval?.args?.amount === "number" ? approval.args.amount : null) ??
      (typeof argRow?.amount === "number" ? argRow.amount : null) ??
      (typeof argRow?.total === "number" ? argRow.total : null);
    return typeof candidate === "number" && candidate > 0 ? candidate : 587.3;
  }, [approval, consult?.claimAmount]);

  const callKey = sessionKey;

  const irisGate =
    (consult as unknown as { irisGate?: { gate_probability?: number; live?: boolean } })?.irisGate ||
    ((r as { operatorConsult?: unknown })?.operatorConsult as { irisGate?: { gate_probability?: number; live?: boolean } } | undefined)?.irisGate ||
    (r.wsState as unknown as { iris_gate?: { gate_probability?: number; live?: boolean } })?.iris_gate;

  const committedChoiceInCall = committedChoice || consult?.selectedChoice || null;

  const openingText = useMemo(() => {
    const consultTurn0 = consult?.turns?.[0]?.text?.trim();
    if (consultTurn0) return consultTurn0;

    const firstAgentTurn = consult?.turns?.find((t) => t.speaker === "agent")?.text?.trim();
    if (firstAgentTurn) return firstAgentTurn;

    const spokenSummary = approval?.spoken_summary?.trim();
    if (spokenSummary) {
      if (
        spokenSummary.toLowerCase().includes("check your screen") ||
        spokenSummary.toLowerCase().includes("on your screen")
      ) {
        return DEFAULT_OPENING_QUESTION;
      }
      return spokenSummary;
    }

    return DEFAULT_OPENING_QUESTION;
  }, [consult?.turns, approval?.spoken_summary]);

  // Pre-fetch opening TTS MP3 into RAM while phone is ringing so Accept Call plays in 0ms
  useEffect(() => {
    if (openingText) {
      prefetchTurnAudio(openingText);
    }
  }, [openingText]);

  const mergedTurns = useMemo<MobileConsultTurn[]>(() => {
    const sseTurns = consult?.turns ?? [];
    const streaming = activeStreamingTurnRef.current;

    if (sseTurns.length > 0) {
      // Guard SSE turns from prematurely flashing full text over active streaming text
      const guardedSseTurns: MobileConsultTurn[] = sseTurns.map((t) => {
        if (
          streaming &&
          t.speaker === "agent" &&
          t.text.trim().toLowerCase() === streaming.fullText.trim().toLowerCase()
        ) {
          return { ...t, text: streaming.currentText };
        }
        return t;
      });

      const existingTexts = new Set(
        guardedSseTurns.map((t) => `${t.speaker}:${t.text.trim().toLowerCase()}`)
      );
      const extras = localTurns.filter((lt) => {
        if (streaming && lt.id === streaming.id) {
          const inSse = sseTurns.some(
            (st) =>
              st.speaker === "agent" &&
              st.text.trim().toLowerCase() === streaming.fullText.trim().toLowerCase()
          );
          if (inSse) return false;
        }
        return !existingTexts.has(`${lt.speaker}:${lt.text.trim().toLowerCase()}`);
      });
      return [...guardedSseTurns, ...extras];
    }

    if (localTurns.length > 0) {
      return localTurns;
    }

    const seed: MobileConsultTurn[] = [
      { speaker: "agent", text: openingText, ts: 0 },
    ];
    return seed;
  }, [consult?.turns, localTurns, openingText]);

  const latestAgentTurn = useMemo(() => {
    return [...mergedTurns].reverse().find((t) => t.speaker === "agent") ?? null;
  }, [mergedTurns]);

  const latestUserTurn = useMemo(() => {
    return [...mergedTurns].reverse().find((t) => t.speaker === "user") ?? null;
  }, [mergedTurns]);

  const resolvedEnd = useMemo(() => {
    if (consult?.end) {
      const choice: OperatorChoice =
        consult.selectedChoice ??
        (typeof consult.end.agreed_amount === "number" &&
        consult.end.agreed_amount > 0 &&
        consult.end.agreed_amount < 350
          ? "redelivery"
          : parseChoiceFromText(consult.end.summary) ?? "refund");
      return {
        choice,
        summary: consult.end.summary,
        claimId,
      };
    }
    return localCompletion;
  }, [claimId, consult?.end, consult?.selectedChoice, localCompletion]);

  const showActionToast = useCallback((msg: string) => {
    if (actionToastTimerRef.current) {
      window.clearTimeout(actionToastTimerRef.current);
    }
    setActionToast(msg);
    soundFx.playWindowPop();
    buzz([30, 40]);
    actionToastTimerRef.current = window.setTimeout(() => {
      setActionToast(null);
    }, 4500);
  }, []);

  const streamAgentTurn = useCallback(
    (fullText: string, turnId: string, interrupt = true) => {
      const clean = fullText.trim();
      if (!clean) return;
      lastSpokenTextRef.current = clean;
      setAgentSpeaking(true);

      const words = clean.split(/\s+/).filter(Boolean);
      activeStreamingTurnRef.current = {
        id: turnId,
        fullText: clean,
        currentText: "…",
      };

      speakCallTurn(
        "agent",
        clean,
        {
          onStart: () => {
            setAgentSpeaking(true);
            const initialText = words.slice(0, Math.min(2, words.length)).join(" ");
            if (activeStreamingTurnRef.current?.id === turnId) {
              activeStreamingTurnRef.current.currentText = initialText;
            }
            setLocalTurns((prev) =>
              prev.map((t) => (t.id === turnId ? { ...t, text: initialText } : t))
            );
          },
          onProgress: (p: number) => {
            const count = Math.max(2, Math.ceil(words.length * Math.min(1, p * 1.05)));
            const sliced = words.slice(0, count).join(" ");
            if (activeStreamingTurnRef.current?.id === turnId) {
              activeStreamingTurnRef.current.currentText = sliced;
            }
            setLocalTurns((prev) =>
              prev.map((t) => (t.id === turnId ? { ...t, text: sliced } : t))
            );
          },
          onEnd: () => {
            setAgentSpeaking(false);
            if (activeStreamingTurnRef.current?.id === turnId) {
              activeStreamingTurnRef.current = null;
            }
            setLocalTurns((prev) =>
              prev.map((t) => (t.id === turnId ? { ...t, text: clean } : t))
            );
          },
        },
        interrupt
      );
    },
    []
  );

  const speakAgentLine = useCallback(
    (text: string, interrupt = false) => {
      const clean = text.trim();
      if (!clean) return;
      const existing = [...localTurns].reverse().find(
        (t) => t.speaker === "agent" && (t.text === clean || t.text === "…")
      );
      if (existing?.id) {
        streamAgentTurn(clean, existing.id, interrupt);
      } else {
        const tid = `agent-${Date.now()}`;
        setLocalTurns((prev) => [
          ...prev,
          { id: tid, speaker: "agent", text: "…", ts: Date.now() },
        ]);
        streamAgentTurn(clean, tid, interrupt);
      }
    },
    [localTurns, streamAgentTurn]
  );

  // Keep mobileCallOwnsAudio active throughout answered call
  useEffect(() => {
    if (answered && !resolvedEnd) {
      setMobileCallOwnsAudio(true);
    }
    return () => {
      setMobileCallOwnsAudio(false);
    };
  }, [answered, resolvedEnd]);

  // Call timer starts when call is answered
  useEffect(() => {
    if (!answered || resolvedEnd) return;
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [answered, resolvedEnd]);

  // Teardown warm media stream when call ends or unmounts (never call t.stop())
  useEffect(() => {
    return () => {
      if (actionToastTimerRef.current) window.clearTimeout(actionToastTimerRef.current);
      setMobileCallOwnsAudio(false);
      mutePersistentMicStream(true);
    };
  }, []);

  // Ringtone & vibration loop while call is incoming/ringing and unanswered
  useEffect(() => {
    if (answered || resolvedEnd) return;
    const isRinging = Boolean(consult?.ringing || (!consult?.end && consult?.turns.length === 0));
    if (!isRinging) return;

    let ringAudio: HTMLAudioElement | null = null;
    try {
      const ringUrl = getDualToneRingtoneUrl();
      const ring = new Audio(ringUrl);
      ring.loop = true;
      ring.volume = 0.85;
      ringAudio = ring;
      ring.play().catch(() => {});
    } catch {
      // ignore
    }

    soundFx.playIncomingCall();
    buzz([220, 120, 220, 400]);
    const interval = window.setInterval(() => {
      soundFx.playIncomingCall();
      buzz([220, 120, 220, 400]);
    }, 2000);

    return () => {
      window.clearInterval(interval);
      if (ringAudio) {
        try {
          ringAudio.loop = false;
          ringAudio.pause();
          ringAudio.currentTime = 0;
          ringAudio.src = "";
        } catch {
          // ignore
        }
        ringAudio = null;
      }
      const primed = getPrimedAudioElement();
      if (primed) {
        primed.loop = false;
      }
    };
  }, [answered, consult?.end, consult?.ringing, consult?.turns.length, resolvedEnd]);

  // Handle SSE CALL_END when server completes call
  useEffect(() => {
    if (!consult?.end?.summary) return;
    const key = `${consult.callId}:end:${consult.end.summary}`;
    if (spokenEndKeyRef.current === key) return;
    spokenEndKeyRef.current = key;
    buzz([30, 50, 30]);
    setMobileCallOwnsAudio(false);
    mutePersistentMicStream(true);
    setWarmStream(null);
    if (r.voiceOn) {
      const lastAgent = [...(consult.turns ?? [])].reverse().find((t) => t.speaker === "agent");
      const textToSpeak = (
        lastAgent && lastAgent.text !== openingText ? lastAgent.text : consult.end.summary
      ).trim();
      if (textToSpeak && lastSpokenTextRef.current !== textToSpeak) {
        speakAgentLine(textToSpeak, false);
      }
    }
  }, [consult?.callId, consult?.end, consult?.turns, openingText, r.voiceOn, speakAgentLine]);

  // Core handler for API responses from /api/call/user-respond
  const processRespondResponse = useCallback(
    (
      data: UserRespondApiBody,
      fallbackChoice: OperatorChoice | null,
      fallbackUserText: string,
      isPhysicalButtonTap = false
    ) => {
      // 1. Live Voice-to-Desktop Action Toast
      if (data.ui_action) {
        const act = data.ui_action;
        const label =
          act.label ||
          (act.action === "open_file"
            ? `Opened ${act.path?.split("/").pop() || "AADE myDATA XML"}`
            : act.action === "switch_view" || act.action === "switch_tab"
            ? `Switched Desktop to ${act.table || "SQLite"} table`
            : "Desktop HUD Synchronized");
        showActionToast(`✓ ${label} on Desktop`);
      }

      if (data.choice === "refund" || data.choice === "redelivery") {
        setCommittedChoice(data.choice as OperatorChoice);
      }

      const userLine = data.transcript?.trim() || fallbackUserText;
      const keepCallOpen = Boolean(data.keep_call_open && data.call_status !== "ended");

      if (userLine) {
        setLocalTurns((prev) => [...prev, { speaker: "user", text: userLine, ts: Date.now() }]);
      }

      // Sync staged decision in mock demo runtime when call stays open (live mode is resolved server-side)
      if (reqId && r.mode === "demo" && (data.resolved || data.approved !== undefined)) {
        r.decide(reqId, data.approved ?? true);
      }

      if (keepCallOpen) {
        if ((data as { barge_in_ack?: boolean }).barge_in_ack) {
          showActionToast("Listening — go ahead");
          return;
        }
        // Multi-Turn: Call stays connected! Recoup speaks reply and Auto-VAD re-arms!
        const replyText =
          data.reply_text?.trim() ||
          data.reply?.trim() ||
          data.spoken_summary?.trim() ||
          (consult?.claimId && consult.claimId !== "CLM-D-1042"
            ? `Claim ${consult.claimId} (€${(consult.claimAmount ?? 0).toFixed(2)}) is staged at the Risk Gate. Should I enforce the claim or hold off?`
            : "Kappa owes 587 euros cash back, or 22 free replacements tomorrow. Which should I take?");

        const turnId = `agent-reply-${Date.now()}`;
        setLocalTurns((prev) => [
          ...prev,
          { id: turnId, speaker: "agent", text: "…", ts: Date.now() + 1 },
        ]);
        buzz([30, 40]);
        streamAgentTurn(replyText, turnId, true);
        return;
      }

      // Final Turn: Check if a choice was actually committed during this call
      const isCommitted = Boolean(
        data.choice === "refund" ||
        data.choice === "redelivery" ||
        committedChoiceInCall ||
        (data as { outcome?: string }).outcome === "accepted" ||
        (fallbackChoice !== null && fallbackChoice !== undefined)
      );

      if (!isCommitted) {
        // Early hangup / call ended without committing a choice!
        setMobileCallOwnsAudio(false);
        mutePersistentMicStream(true);
        setWarmStream(null);

        const replyText = data.reply_text?.trim() || data.confirmation_text?.trim();
        if (isPhysicalButtonTap) {
          stopSpeaking();
          onEndWithoutDecision();
        } else if (replyText) {
          speakAgentLine(replyText, true);
          window.setTimeout(() => {
            onEndWithoutDecision();
          }, 1400);
        } else {
          onEndWithoutDecision();
        }
        return;
      }

      // Choice committed: apply ERP commit and transition to Call Completed screen
      const resolvedChoice: OperatorChoice =
        data.choice === "redelivery" || data.choice === "refund"
          ? (data.choice as OperatorChoice)
          : committedChoiceInCall ??
            (data.transcript ? parseChoiceFromText(data.transcript) : null) ??
            fallbackChoice ??
            "refund";

      const confirmation =
        data.confirmation_text?.trim() ||
        data.reply_text?.trim() ||
        data.confirmation?.trim() ||
        data.reply?.trim() ||
        data.spoken_summary?.trim() ||
        data.summary?.trim() ||
        defaultConfirmationFor(resolvedChoice, claimId);

      const turnId = `agent-confirm-${Date.now()}`;
      setLocalTurns((prev) => [
        ...prev,
        { id: turnId, speaker: "agent", text: "…", ts: Date.now() + 1 },
      ]);

      onSetLocalCompletion({
        sessionKey: callKey,
        choice: resolvedChoice,
        summary: confirmation,
        claimId,
      });

      buzz([40, 60, 40]);
      setMobileCallOwnsAudio(false);
      mutePersistentMicStream(true);
      setWarmStream(null);

      if (reqId && (r.mode === "demo" || data.resolved === false)) {
        r.decide(reqId, data.approved ?? true);
      }

      streamAgentTurn(confirmation, turnId, true);
    },
    [callKey, claimId, committedChoiceInCall, onEndWithoutDecision, onSetLocalCompletion, r, reqId, showActionToast, streamAgentTurn]
  );

  const vadPhaseResetRef = useRef<(() => void) | null>(null);
  const utteranceAbortRef = useRef<AbortController | null>(null);

  // Dispatch audio recorded by Auto-VAD to /api/call/user-respond
  const handleUtteranceBlob = useCallback(
    async (blob: Blob, _mimeType: string, ext: string) => {
      utteranceAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      utteranceAbortRef.current = abortCtrl;
      const timeoutId = window.setTimeout(() => abortCtrl.abort(), 14000);

      setSubmitting(true);
      buzz(25);
      try {
        const form = new FormData();
        form.append("audio", blob, `utterance.${ext}`);
        form.append("channel", "iphone_transferred");
        if (reqId) form.append("req_id", reqId);
        form.append("claim_id", claimId || DEFAULT_CLAIM_ID);
        if (consult?.callId) form.append("call_id", consult.callId);

        const res = await fetch("/api/call/user-respond", {
          method: "POST",
          body: form,
          signal: abortCtrl.signal,
        });

        if (res.ok) {
          const body = (await res.json()) as UserRespondApiBody & { ignored_noise?: boolean };
          if (body.ignored_noise) {
            showActionToast("Background noise ignored — speak closer or tap orb");
            return;
          }
          processRespondResponse(body, null, body.transcript?.trim() || "");
          return;
        }

        // Demo fallback if network or endpoint fails
        if (r.mode === "demo") {
          processRespondResponse(
            {
              ok: true,
              keep_call_open: false,
              call_status: "ended",
              choice: "refund",
              transcript: "Demand the 587 euro refund",
              confirmation_text: defaultConfirmationFor("refund", claimId),
            },
            "refund",
            "Demand the 587 euro refund"
          );
        } else {
          showActionToast("Sync interrupted — tap orb or speak again");
        }
      } catch (err) {
        console.warn("Failed sending utterance", err);
        if (r.mode === "demo") {
          processRespondResponse(
            {
              ok: true,
              keep_call_open: false,
              call_status: "ended",
              choice: "refund",
              transcript: "Demand the 587 euro refund",
              confirmation_text: defaultConfirmationFor("refund", claimId),
            },
            "refund",
            "Demand the 587 euro refund"
          );
        } else {
          showActionToast("Loud room / slow link — ready to listen again");
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (utteranceAbortRef.current === abortCtrl) {
          utteranceAbortRef.current = null;
        }
        setSubmitting(false);
        vadPhaseResetRef.current?.();
      }
    },
    [claimId, consult?.callId, processRespondResponse, r.mode, reqId, showActionToast]
  );

  // Auto-VAD hook attached to warm MediaStream (kept continuously wired throughout active call)
  const vad = useAutoVad({
    stream: warmStream,
    enabled: answered && !resolvedEnd,
    agentSpeaking: agentSpeaking || r.speaking,
    muted: isMuted || submitting,
    onBargeIn: () => {
      stopSpeaking();
      setAgentSpeaking(false);
    },
    onUtterance: (blob, mimeType, ext) => {
      handleUtteranceBlob(blob, mimeType, ext);
    },
  });
  vadPhaseResetRef.current = () => {
    if (!resolvedEnd) {
      vad.setPhase("listening");
    }
  };

  // Tapping "Accept Call" on Ringing Screen
  const handleAcceptCall = useCallback(async () => {
    soundFx.playUiClick();
    buzz([50, 80]);

    // Ensure shared primed element loop is reset to false
    const primed = getPrimedAudioElement();
    if (primed) {
      primed.loop = false;
    }

    // 1. Mobile call owns audio & synchronously blesses iOS AudioContext + HTMLAudioElement inside user tap
    setMobileCallOwnsAudio(true);
    unlockAudioSession("play-and-record");
    onUnlockAudio();

    const turnId = `agent-open-${Date.now()}`;
    setLocalTurns([{ id: turnId, speaker: "agent", text: "…", ts: Date.now() }]);
    setAnswered(true);

    // 2. Notify backend / desktop immediately in background (non-blocking)
    void (async () => {
      try {
        if (!consult?.active) {
          await fetch("/api/call/user-consult", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              req_id: reqId,
              claim_id: claimId || DEFAULT_CLAIM_ID,
              channel: "iphone_transferred",
            }),
          }).catch(() => {});
        }
        await fetch("/api/call/pickup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            call_id: consult?.callId || `CONSULT-${claimId || DEFAULT_CLAIM_ID}`,
            claim_id: claimId || DEFAULT_CLAIM_ID,
            req_id: reqId,
            channel: "iphone_transferred",
          }),
        }).catch(() => {});
      } catch {
        // offline / demo
      }
    })();

    // 3. Acquire persistent mic stream first so any iOS "Allow Microphone" system sheet
    //    finishes BEFORE Recoup speaks (preventing iOS modal audio interruption) AND stays unmuted!
    const stream = await acquirePersistentMicStream();
    if (stream) {
      stream.getAudioTracks().forEach((t) => {
        t.enabled = true;
      });
      setWarmStream(stream);
    }

    // 4. Resume iOS AudioContext after permission prompt & play pre-fetched opening question out loud
    getSharedAudioContext()?.resume().catch(() => {});
    streamAgentTurn(openingText, turnId, true);
  }, [claimId, consult?.active, consult?.callId, onUnlockAudio, openingText, reqId, streamAgentTurn]);

  // Red End Call Button Handler: tells server to hang up, transitions cleanly
  const handleEndCall = useCallback(async () => {
    soundFx.playUiClick();
    buzz(50);
    stopSpeaking();
    const primed = getPrimedAudioElement();
    if (primed) {
      primed.loop = false;
    }
    setMobileCallOwnsAudio(false);
    mutePersistentMicStream(true);
    setWarmStream(null);

    try {
      const res = await fetch("/api/call/user-respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: consult?.callId,
          channel: "iphone_transferred",
          hangup: true,
          text: "hang up",
          transcript: "hang up",
          req_id: reqId,
          claim_id: claimId || DEFAULT_CLAIM_ID,
        }),
      });

      if (res.ok) {
        const body = (await res.json()) as UserRespondApiBody;
        processRespondResponse(
          { ...body, keep_call_open: false, call_status: "ended" },
          null,
          "hang up",
          true // isPhysicalButtonTap = true
        );
        return;
      }
    } catch (err) {
      console.warn("End call API failed", err);
    }

    // Offline / fallback when no choice was committed during call:
    if (!committedChoiceInCall) {
      onEndWithoutDecision();
      return;
    }

    // Offline fallback if choice was committed earlier
    const fallbackChoice = committedChoiceInCall;
    const summary = defaultConfirmationFor(fallbackChoice, claimId);
    setLocalTurns((prev) => [
      ...prev,
      { speaker: "user", text: "Thanks, hang up", ts: Date.now() },
      { speaker: "agent", text: summary, ts: Date.now() + 1 },
    ]);
    onSetLocalCompletion({
      sessionKey: callKey,
      choice: fallbackChoice,
      summary,
      claimId,
    });
  }, [
    callKey,
    claimId,
    committedChoiceInCall,
    consult?.callId,
    onEndWithoutDecision,
    onSetLocalCompletion,
    processRespondResponse,
    reqId,
  ]);

  // 1-Tap Quick Trigger Backup (Pills & Sheet)
  const submitQuickTrigger = useCallback(
    async (params: { transcript: string; choice?: OperatorChoice; ui_command?: string; hangup?: boolean }) => {
      soundFx.playUiClick();
      setTriggersOpen(false);
      stopSpeaking();
      setSubmitting(true);
      buzz(25);

      try {
        const res = await fetch("/api/call/user-respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: params.transcript,
            choice: params.choice,
            ui_command: params.ui_command,
            hangup: params.hangup,
            channel: "iphone_transferred",
            req_id: reqId,
            claim_id: claimId || DEFAULT_CLAIM_ID,
            call_id: consult?.callId,
          }),
        });

        if (res.ok) {
          const body = (await res.json()) as UserRespondApiBody;
          if (params.hangup) {
            processRespondResponse({ ...body, keep_call_open: false, call_status: "ended" }, params.choice ?? null, params.transcript);
          } else {
            processRespondResponse(body, params.choice ?? null, params.transcript);
          }
          return;
        }

        // Offline / demo fallback
        if (params.hangup) {
          processRespondResponse(
            {
              ok: true,
              keep_call_open: false,
              call_status: "ended",
              transcript: params.transcript,
              confirmation_text: "Call ended. Staged audit records preserved.",
            },
            params.choice ?? null,
            params.transcript
          );
        } else if (params.ui_command === "open_aade") {
          showActionToast("✓ Opened AADE myDATA XML on Desktop");
          speakAgentLine("Displaying the AADE myDATA 5.1 credit note on your desktop screen.", true);
        } else if (params.ui_command === "compare_options" || params.transcript.toLowerCase().includes("compare")) {
          showActionToast("✓ Compared Refund vs Replacement on Desktop");
          speakAgentLine("Displaying the comparison between 587 euro refund and 22 replacement hubs on your desktop screen.", true);
        } else if (params.choice) {
          processRespondResponse(
            {
              ok: true,
              keep_call_open: false,
              call_status: "ended",
              choice: params.choice,
              transcript: params.transcript,
              confirmation_text: defaultConfirmationFor(params.choice, claimId),
            },
            params.choice,
            params.transcript
          );
        }
      } catch {
        if (params.hangup) {
          processRespondResponse(
            {
              ok: true,
              keep_call_open: false,
              call_status: "ended",
              transcript: params.transcript,
              confirmation_text: "Call ended.",
            },
            params.choice ?? null,
            params.transcript
          );
        } else if (params.choice) {
          processRespondResponse(
            {
              ok: true,
              keep_call_open: false,
              call_status: "ended",
              choice: params.choice,
              transcript: params.transcript,
              confirmation_text: defaultConfirmationFor(params.choice, claimId),
            },
            params.choice,
            params.transcript
          );
        }
      } finally {
        setSubmitting(false);
      }
    },
    [claimId, consult?.callId, processRespondResponse, reqId, showActionToast, speakAgentLine]
  );

  // Manual fallback speech recognition (if mic stream denied or user taps center orb)
  const speechFallback = useSpeechInput((text, final) => {
    if (final && text.trim()) {
      submitQuickTrigger({ transcript: text.trim() });
    }
  });

  const isSpeaking = agentSpeaking || r.speaking;
  const isHearing = vad.phase === "hearing";
  const isSyncing = vad.phase === "syncing" || submitting;
  const isListening = answered && !isSpeaking && !isHearing && !isSyncing && !resolvedEnd;

  // -------------------------------------------------------------------------
  // SCREEN 1: RINGING SCREEN (Before Call Accepted)
  // -------------------------------------------------------------------------
  if (!answered && !resolvedEnd) {
    return (
      <motion.div
        key={`ringing-${callKey}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-30 flex flex-col justify-between overflow-hidden bg-[#08090c] text-white"
        style={{
          backgroundColor: "#08090c",
          backgroundImage:
            "radial-gradient(130% 70% at 50% 18%, rgba(16, 185, 129, 0.28) 0%, rgba(12, 13, 18, 0.96) 65%, #08090c 100%)",
        }}
      >
        <StatusBar />
        {!audioUnlocked && <AudioUnlockBanner onUnlock={onUnlockAudio} />}

        {/* Top Executive Line Pill */}
        <div className="mt-2 flex flex-col items-center px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-ok/40 bg-ok/15 px-3.5 py-1 text-[11px] font-bold uppercase tracking-wider text-ok shadow-[0_0_18px_rgba(16,185,129,0.3)]">
            <span className="h-2 w-2 animate-ping rounded-full bg-ok" />
            RECOUP EXECUTIVE LINE · GROK REALTIME VOICE
          </div>

          {irisGate && typeof irisGate.gate_probability === "number" && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-signal/40 bg-signal/15 px-2.5 py-0.5 text-[11px] font-semibold text-signal shadow-sm">
              <span>⚡ Oumi Iris · {Math.round(irisGate.gate_probability * 100)}% Gate · 0 out-tok</span>
            </div>
          )}

          <div className="mt-6 text-[13px] font-semibold uppercase tracking-widest text-emerald-400/80">
            Incoming Executive Escalation
          </div>
          <h1 className="mt-1 text-[32px] font-bold tracking-tight text-white">
            {r.brand.brand_name} AI
          </h1>
          <p className="mt-1 text-[14.5px] font-medium text-emerald-200/90">
            {claimId.startsWith("CLM-") ? `Claim ${claimId}` : `Shipment ${claimId}`} · €{claimAmount.toFixed(2)} Decision
          </p>
        </div>

        {/* Center Pulsing Concentric Radar Rings & Emblem */}
        <div className="relative flex flex-1 items-center justify-center">
          <motion.div
            className="absolute h-64 w-64 rounded-full border border-emerald-500/20"
            animate={{ scale: [1, 1.45, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute h-52 w-52 rounded-full border border-emerald-400/30"
            animate={{ scale: [1, 1.35, 1], opacity: [0.7, 0.1, 0.7] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}
          />
          <motion.div
            className="absolute h-40 w-40 rounded-full border border-cyan-400/40 bg-emerald-500/10 shadow-[0_0_50px_rgba(16,185,129,0.4)]"
            animate={{ scale: [1, 1.15, 1] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />

          <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-tr from-emerald-600 to-cyan-500 shadow-2xl">
            <PhoneCall className="h-12 w-12 text-white animate-pulse" />
          </div>
        </div>

        {/* Bottom Call Card: Plain-English Preview & Big Accept Call Button */}
        <div className="px-6 pb-9">
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.06] p-3 text-center backdrop-blur-md">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
              Audit Discrepancy Preview
            </div>
            <div className="mt-1 text-[13px] font-medium text-white/90">
              {consult?.turns?.[0]?.text && !consult.turns[0].text.toLowerCase().includes("screen")
                ? consult.turns[0].text
                : approval?.risk_reason || approval?.spoken_summary || "22 missing/broken hubs + overcharged invoice INV-7781"}
            </div>
          </div>

          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleAcceptCall}
              className="group relative flex h-20 w-full items-center justify-center gap-3.5 rounded-3xl bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-500 text-[18px] font-bold text-slate-950 shadow-[0_0_40px_rgba(16,185,129,0.65)] transition-all hover:brightness-110 active:scale-[0.98]"
            >
              <PhoneCall className="h-7 w-7 transition-transform group-hover:scale-110" />
              <span>Accept Call · Hands-Free</span>
            </button>

            {reqId && (
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  stopSpeaking();
                  const primed = getPrimedAudioElement();
                  if (primed) {
                    primed.loop = false;
                  }
                  mutePersistentMicStream();
                  setMobileCallOwnsAudio(false);
                  r.decide(reqId, false);
                }}
                className="mt-1 flex items-center gap-1.5 py-1 text-[13px] font-medium text-white/50 transition-colors hover:text-white/80"
              >
                <PhoneOff className="h-3.5 w-3.5" />
                Decline / Keep on Hold
              </button>
            )}
          </div>
        </div>
      </motion.div>
    );
  }

  // -------------------------------------------------------------------------
  // SCREEN 2: CONNECTED LIVE SPEAKERPHONE CALL SCREEN (Multi-Turn Auto-VAD)
  // -------------------------------------------------------------------------
  return (
    <motion.div
      key={`call-${callKey}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-30 flex flex-col justify-between overflow-hidden bg-canvas"
      style={{
        backgroundColor: "var(--canvas)",
        backgroundImage: resolvedEnd
          ? "radial-gradient(130% 65% at 50% 0%, color-mix(in oklab, var(--ok) 25%, var(--canvas)), var(--canvas) 75%)"
          : (isHearing || vad.manualRecording)
          ? "radial-gradient(130% 65% at 50% 12%, color-mix(in oklab, var(--danger) 24%, var(--canvas)) 0%, var(--canvas) 75%)"
          : isSpeaking
          ? "radial-gradient(130% 65% at 50% 12%, color-mix(in oklab, var(--ok) 24%, var(--canvas)) 0%, var(--canvas) 75%)"
          : "radial-gradient(130% 65% at 50% 12%, color-mix(in oklab, var(--signal) 22%, var(--canvas)) 0%, var(--canvas) 75%)",
      }}
    >
      <StatusBar />

      {/* Action Toast: Live Voice-to-Desktop sync indicator */}
      <AnimatePresence>
        {actionToast && (
          <motion.div
            initial={{ opacity: 0, y: -24, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.95 }}
            className="absolute left-5 right-5 top-[58px] z-40 flex items-center gap-2.5 rounded-2xl border border-ok/50 bg-ok/20 px-4 py-2.5 text-[13px] font-semibold text-ink shadow-[0_10px_30px_rgba(0,0,0,0.3)] backdrop-blur-xl"
          >
            <Monitor className="h-4 w-4 shrink-0 animate-pulse text-ok" />
            <span className="truncate">{actionToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1 flex-col justify-between px-5 pb-6">
        {/* Header: Call Timer & Hands-Free Emerald Badge */}
        <div className="mt-1 flex flex-col items-center text-center">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/40 bg-ok/15 px-3 py-0.5 text-[11px] font-bold uppercase tracking-wider text-ok">
              <span className="h-2 w-2 rounded-full bg-ok animate-pulse" />
              {resolvedEnd ? "CALL COMPLETED" : "LIVE CALL · HANDS-FREE"}
            </span>
            <span className="font-mono text-[12px] font-semibold text-ink-2">
              {String(Math.floor(secs / 60)).padStart(2, "0")}:{String(secs % 60).padStart(2, "0")}
            </span>
          </div>

          {irisGate && typeof irisGate.gate_probability === "number" && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-signal/40 bg-signal/15 px-2.5 py-0.5 text-[11px] font-semibold text-signal shadow-sm">
              <span>⚡ Oumi Iris · {Math.round(irisGate.gate_probability * 100)}% Gate · 0 out-tok</span>
            </div>
          )}

          <h2 className="mt-1 text-[21px] font-bold tracking-tight text-ink">
            {r.brand.brand_name} AI · {claimId.startsWith("CLM-") ? claimId : `Shipment ${claimId}`}
          </h2>
          <div className="text-[12px] font-medium text-ink-3">
            €{claimAmount.toFixed(2)} Decision · Grok Realtime Voice &amp; Auto-VAD
          </div>
        </div>

        {/* Centerpiece 3D/Radial Voice Visualizer */}
        <div className="my-auto flex flex-col items-center py-2">
          <div className="relative flex h-52 w-52 items-center justify-center">
            {/* Concentric Reactive Rings driven by real audio energy */}
            <motion.div
              className={cx(
                "absolute inset-0 rounded-full border transition-colors",
                resolvedEnd
                  ? "border-ok/30"
                  : (isHearing || vad.manualRecording)
                  ? "border-rose-500/40"
                  : isSpeaking
                  ? "border-emerald-400/40"
                  : "border-signal/30"
              )}
              animate={{
                scale: (isHearing || vad.manualRecording) ? [1, 1.25, 1] : isSpeaking ? [1, 1.18, 1] : [1, 1.08, 1],
                opacity: [0.4, 0.8, 0.4],
              }}
              transition={{ duration: (isHearing || vad.manualRecording) ? 1.2 : 2.4, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className={cx(
                "absolute -inset-4 rounded-full border border-dashed transition-colors",
                (isHearing || vad.manualRecording) ? "border-rose-400/30" : "border-emerald-500/25"
              )}
              animate={{ rotate: 360 }}
              transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
            />

            {/* Embedded Canvas VoiceOrb */}
            <VoiceOrb
              variant="orb"
              tone={resolvedEnd ? "ok" : (isHearing || vad.manualRecording) ? "danger" : isSpeaking ? "ok" : "signal"}
              active
              ambient={!isSpeaking && !isHearing && !vad.manualRecording}
              className="absolute inset-2 h-48 w-48"
            />

            {/* Center Interactive Orb Button */}
            <button
              type="button"
              onClick={() => {
                soundFx.playUiClick();
                if (isSyncing) {
                  // Instant escape hatch if venue Wi-Fi / noisy upload stalls
                  utteranceAbortRef.current?.abort();
                  setSubmitting(false);
                  vad.setPhase("listening");
                } else if (isSpeaking) {
                  // Interruption / Barge-in
                  stopSpeaking();
                  setAgentSpeaking(false);
                  vad.setPhase("listening");
                } else if (isHearing || vad.manualRecording) {
                  // Immediately finish recording and send
                  vad.stopAndSendManualRecording();
                } else if (isListening) {
                  // Manual tap-to-speak fallback
                  vad.startManualRecording();
                } else if (!resolvedEnd) {
                  speakAgentLine(latestAgentTurn?.text || openingText, true);
                }
              }}
              aria-label="Voice orb status and instant send shortcut"
              className={cx(
                "relative z-10 flex h-20 w-20 items-center justify-center rounded-full text-white shadow-2xl transition-transform active:scale-95",
                resolvedEnd
                  ? "bg-ok text-on-solid"
                  : (isHearing || vad.manualRecording)
                  ? "bg-danger text-white shadow-[0_0_30px_rgba(244,63,94,0.6)] animate-pulse"
                  : isSpeaking
                  ? "bg-ok text-on-solid shadow-[0_0_30px_rgba(16,185,129,0.5)]"
                  : isSyncing
                  ? "bg-signal text-white"
                  : "bg-surface border border-line text-ink shadow-md hover:border-signal/50"
              )}
            >
              {resolvedEnd ? (
                <CheckCircle2 className="h-9 w-9" />
              ) : isSyncing ? (
                <Loader2 className="h-9 w-9 animate-spin text-white" />
              ) : (isHearing || vad.manualRecording) ? (
                <Mic className="h-9 w-9 animate-pulse" />
              ) : isSpeaking ? (
                <Volume2 className="h-9 w-9 animate-pulse" />
              ) : (
                <Mic className="h-9 w-9 text-signal" />
              )}
            </button>
          </div>

          {/* Unmistakable Live State Headline */}
          <div className="mt-3 flex flex-col items-center text-center">
            <div
              className={cx(
                "text-[15.5px] font-bold tracking-tight uppercase transition-colors",
                resolvedEnd
                  ? "text-ok"
                  : isSpeaking
                  ? "text-ok"
                  : (isHearing || vad.manualRecording)
                  ? "text-danger"
                  : isSyncing
                  ? "text-signal"
                  : "text-signal"
              )}
            >
              {resolvedEnd
                ? "DECISION APPLIED · REVERSIBLE UNDO READY"
                : isSpeaking
                ? "RECOUP SPEAKING…"
                : (isHearing || vad.manualRecording)
                ? "HEARING YOU…"
                : isSyncing
                ? "SYNCING WITH DESKTOP…"
                : "YOUR TURN — JUST SPEAK"}
            </div>

            {/* Live Green Mic Level Bar (`rms`) */}
            {!resolvedEnd && (
              <div className="mt-2 flex items-center gap-2 rounded-full border border-line bg-surface/85 px-3 py-1 shadow-sm backdrop-blur-md">
                <Mic
                  className={cx(
                    "h-3.5 w-3.5 shrink-0 transition-colors",
                    isHearing || vad.manualRecording || vad.rms > 0.012
                      ? "text-emerald-400 animate-pulse"
                      : "text-ink-3"
                  )}
                />
                <div className="relative h-2 w-28 overflow-hidden rounded-full bg-ink/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-300 shadow-[0_0_10px_rgba(16,185,129,0.85)] transition-all duration-75"
                    style={{
                      width: `${Math.min(100, Math.round(vad.rms * 600))}%`,
                    }}
                  />
                </div>
                <span className="w-8 font-mono text-[10.5px] font-semibold text-emerald-400 tabular text-right">
                  {Math.min(100, Math.round(vad.rms * 600))}%
                </span>
              </div>
            )}

            <p className="mt-1.5 max-w-[320px] text-[12px] font-medium text-ink-2">
              {resolvedEnd
                ? "ERP staged and vendor email ready · reversible receipt below"
                : (isHearing || vad.manualRecording)
                ? "Auto-sends on pause · or tap orb to send now"
                : isSyncing
                ? "Syncing with desktop… (tap orb to cancel & speak again)"
                : "Hands-free Auto-VAD · or tap orb to talk / send"}
            </p>
          </div>
        </div>

        {/* Live Rolling Subtitle Strip (Latest Recoup AI & You lines) */}
        {!resolvedEnd && (
          <div className="mb-4 space-y-1.5 rounded-2xl border border-line bg-surface/75 p-3 backdrop-blur-xl">
            {latestAgentTurn && (
              <div className="flex items-start justify-between gap-2 text-[12.5px] leading-snug">
                <div className="min-w-0 flex-1">
                  <span className="font-bold text-ok">{r.brand.brand_name} AI: </span>
                  <span className="text-ink-2">
                    {latestAgentTurn.text === "…" ? openingText : latestAgentTurn.text}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    soundFx.playUiClick();
                    unlockAudioSession("play-and-record");
                    speakAgentLine(
                      latestAgentTurn.text === "…" ? openingText : latestAgentTurn.text,
                      true
                    );
                  }}
                  title="Replay Recoup voice"
                  className="shrink-0 inline-flex items-center gap-1 rounded-full border border-ok/35 bg-ok/10 px-2 py-0.5 text-[10.5px] font-semibold text-ok active:scale-95"
                >
                  <Volume2 className="h-3 w-3" />
                  <span>Replay</span>
                </button>
              </div>
            )}
            {latestUserTurn && (
              <div className="text-[12.5px] leading-snug">
                <span className="font-bold text-signal">You: </span>
                <span className="text-ink-2">{latestUserTurn.text}</span>
              </div>
            )}
          </div>
        )}

        {/* SCREEN 3: CALL COMPLETED CARD */}
        {resolvedEnd ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3 rounded-3xl border border-ok/45 bg-ok/12 p-4 shadow-card backdrop-blur-xl"
          >
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold leading-snug text-ink">
                  Applied &amp; Vendor Emailed · Undo Ready
                </div>
                <div className="mt-0.5 font-mono text-[11px] font-semibold text-ok">
                  {resolvedEnd.choice === "redelivery"
                    ? "22-Unit Replacement + AADE 9.3 (€202.30 Credit)"
                    : claimId === DEFAULT_CLAIM_ID || claimId === "CLM-D-1042" || claimId === "D-1042"
                    ? "AP Hold INV-7781 + AADE 5.1 (€587.30 Net / €728.25 Gross)"
                    : `AP Hold & Credit Note · ${claimId} (€${claimAmount.toFixed(2)} Net)`}
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
                  {resolvedEnd.summary}
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={Boolean(r.rewind)}
                onClick={() => {
                  soundFx.playUiClick();
                  buzz([30, 40]);
                  r.undo();
                  onDismissCompleted();
                }}
                className={cx(btn("warn", "lg"), "h-12 flex-1 rounded-2xl text-[14px]")}
              >
                <Undo2 className={cx("h-4 w-4", r.rewind && "animate-spin [animation-direction:reverse]")} />
                {r.rewind ? "Rewinding…" : "Undo Staged Commit"}
              </button>
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  onDismissCompleted();
                }}
                className={cx(btn("outline", "lg"), "h-12 rounded-2xl px-4 text-[13.5px]")}
              >
                Done
              </button>
            </div>

            {/* Next Prompt Suggestion when present */}
            {r.offer && (
              <div className="mt-2 rounded-2xl border border-signal/40 bg-surface/90 p-3 shadow-sm">
                <div className="flex items-center gap-2 text-[11.5px] font-semibold text-signal">
                  <Sparkles className="h-3.5 w-3.5" /> Next Audit Suggestion
                </div>
                <div className="mt-1 text-[13px] font-semibold text-ink">
                  {r.offer.prediction.need} — Run this next?
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      soundFx.playUiClick();
                      r.acceptOffer(r.offer!.offer_id);
                      onDismissCompleted();
                    }}
                    className={cx(btn("signal", "sm"), "h-9 flex-1 rounded-xl font-semibold")}
                  >
                    Approve &amp; Run
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      soundFx.playUiClick();
                      r.dismissOffer(r.offer!.offer_id);
                    }}
                    className={cx(btn("outline", "sm"), "h-9 rounded-xl")}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        ) : (
          /* SLEEK ENTERPRISE CALL BOTTOM DOCK (4 NATIVE PHONE CONTROLS) */
          <div className="space-y-3">
            {/* 4 Bottom Controls */}
            <div className="grid grid-cols-4 items-center justify-items-center gap-2 rounded-3xl border border-line bg-surface/85 px-3 py-2.5 backdrop-blur-2xl">
              {/* 1. Mute Mic Toggle */}
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  setIsMuted((m) => !m);
                }}
                className="flex flex-col items-center gap-1 text-ink-2 transition-transform active:scale-95"
              >
                <div
                  className={cx(
                    "flex h-12 w-12 items-center justify-center rounded-full border transition-colors",
                    isMuted
                      ? "border-warn/50 bg-warn/20 text-warn"
                      : "border-line bg-surface text-ink hover:text-ink"
                  )}
                >
                  {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </div>
                <span className="text-[11px] font-medium text-ink-3">
                  {isMuted ? "Muted" : "Mute"}
                </span>
              </button>

              {/* 2. Speaker (ON/OFF) Toggle */}
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  r.toggleVoice();
                }}
                className="flex flex-col items-center gap-1 text-ink-2 transition-transform active:scale-95"
              >
                <div
                  className={cx(
                    "flex h-12 w-12 items-center justify-center rounded-full border transition-colors",
                    r.voiceOn
                      ? "border-ok/40 bg-ok/15 text-ok"
                      : "border-line bg-surface text-ink-3"
                  )}
                >
                  {r.voiceOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
                </div>
                <span className="text-[11px] font-medium text-ink-3">
                  {r.voiceOn ? "Speaker" : "Muted"}
                </span>
              </button>

              {/* 3. Quick Voice Triggers Drawer Trigger */}
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  setTriggersOpen((v) => !v);
                }}
                className="flex flex-col items-center gap-1 text-ink-2 transition-transform active:scale-95"
              >
                <div
                  className={cx(
                    "flex h-12 w-12 items-center justify-center rounded-full border transition-colors",
                    triggersOpen
                      ? "border-signal/50 bg-signal/20 text-signal"
                      : "border-line bg-surface text-ink"
                  )}
                >
                  <Zap className="h-5 w-5 text-signal" />
                </div>
                <span className="text-[11px] font-medium text-ink-3">Triggers</span>
              </button>

              {/* 4. Red End Call Button */}
              <button
                type="button"
                onClick={handleEndCall}
                className="flex flex-col items-center gap-1 text-ink-2 transition-transform active:scale-95"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger text-white shadow-lg shadow-danger/30 hover:bg-danger/90">
                  <PhoneOff className="h-5 w-5" />
                </div>
                <span className="text-[11px] font-medium text-danger">End</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* QUICK VOICE TRIGGERS BOTTOM DRAWER / SHEET */}
      <AnimatePresence>
        {triggersOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="rounded-t-3xl border-t border-line bg-canvas p-5 shadow-2xl"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-signal" />
                  <span className="text-[14px] font-bold text-ink">
                    Quick Voice Triggers (Noise Backup)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setTriggersOpen(false)}
                  className="rounded-full p-1 text-ink-3 hover:text-ink"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <p className="mb-3 text-[12px] text-ink-3">
                Ask anything or trigger decisions directly over the live phone call:
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = customPrompt.trim();
                  if (!q || submitting) return;
                  setCustomPrompt("");
                  void submitQuickTrigger({ transcript: q });
                }}
                className="mb-3 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Ask Recoup anything or type command…"
                  className="h-10 flex-1 rounded-xl border border-line bg-surface px-3 text-[13px] text-ink placeholder:text-ink-3 focus:border-signal focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!customPrompt.trim() || submitting}
                  className={cx(btn("signal", "sm"), "h-10 rounded-xl px-3.5 text-[12.5px] font-semibold disabled:opacity-40")}
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Send</span>
                </button>
              </form>

              <div className="space-y-2.5">
                {/* 1. What are my options? */}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    submitQuickTrigger({
                      transcript: "What are my options?",
                    })
                  }
                  className="flex w-full items-center justify-between rounded-2xl border border-line bg-surface/90 px-4 py-3 text-left transition-colors hover:border-signal/50 hover:bg-surface active:scale-[0.99]"
                >
                  <span className="flex items-center gap-3">
                    <Database className="h-5 w-5 text-signal" />
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">What are my options?</div>
                      <div className="text-[11.5px] text-ink-3">
                        ⚖️ “What are my options?”
                      </div>
                    </div>
                  </span>
                  <Chip tone="signal">options</Chip>
                </button>

                {/* 2. Why do they owe euros? */}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    submitQuickTrigger({
                      transcript: `Why do they owe ${claimAmount === Math.round(claimAmount) ? claimAmount : claimAmount.toFixed(2)} euros?`,
                    })
                  }
                  className="flex w-full items-center justify-between rounded-2xl border border-line bg-surface/90 px-4 py-3 text-left transition-colors hover:border-signal/50 hover:bg-surface active:scale-[0.99]"
                >
                  <span className="flex items-center gap-3">
                    <FileCode2 className="h-5 w-5 text-signal" />
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">
                        Why do they owe €{claimAmount === Math.round(claimAmount) ? claimAmount : claimAmount.toFixed(2)}?
                      </div>
                      <div className="text-[11.5px] text-ink-3">
                        🧮 “Why do they owe {claimAmount === Math.round(claimAmount) ? claimAmount : claimAmount.toFixed(2)} euros?”
                      </div>
                    </div>
                  </span>
                  <Chip tone="signal">audit proof</Chip>
                </button>

                {/* 3. Demand the refund */}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    submitQuickTrigger({
                      transcript: `Demand the ${claimAmount === Math.round(claimAmount) ? claimAmount : claimAmount.toFixed(2)} euro refund`,
                      choice: "refund",
                    })
                  }
                  className="flex w-full items-center justify-between rounded-2xl border border-ok/45 bg-ok/12 px-4 py-3 text-left transition-colors hover:bg-ok/18 active:scale-[0.99]"
                >
                  <span className="flex items-center gap-3">
                    <FileCheck2 className="h-5 w-5 text-ok" />
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">
                        Demand the €{claimAmount === Math.round(claimAmount) ? claimAmount : claimAmount.toFixed(2)} refund
                      </div>
                      <div className="text-[11.5px] text-ink-3">
                        ✅ “Demand the {claimAmount === Math.round(claimAmount) ? claimAmount : claimAmount.toFixed(2)} euro refund”
                      </div>
                    </div>
                  </span>
                  <Chip tone="ok" solid>
                    €{claimAmount.toFixed(2)} Net
                  </Chip>
                </button>

                {/* 3b. Take 22 replacement hubs (Kappa scenario) */}
                {(claimId === DEFAULT_CLAIM_ID || claimId === "CLM-D-1042" || claimId === "D-1042") && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      submitQuickTrigger({
                        transcript: "Take the 22 replacement hubs tomorrow",
                        choice: "redelivery",
                      })
                    }
                    className="flex w-full items-center justify-between rounded-2xl border border-signal/45 bg-signal/12 px-4 py-3 text-left transition-colors hover:bg-signal/18 active:scale-[0.99]"
                  >
                    <span className="flex items-center gap-3">
                      <PackageCheck className="h-5 w-5 text-signal" />
                      <div>
                        <div className="text-[13.5px] font-semibold text-ink">
                          Take 22 replacement hubs + €202.30 credit
                        </div>
                        <div className="text-[11.5px] text-ink-3">
                          📦 “Take the 22 replacement hubs tomorrow”
                        </div>
                      </div>
                    </span>
                    <Chip tone="signal">replace</Chip>
                  </button>
                )}

                {/* 4. Hang up for now */}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    submitQuickTrigger({
                      transcript: "Hang up for now",
                      hangup: true,
                    })
                  }
                  className="flex w-full items-center justify-between rounded-2xl border border-line bg-surface/90 px-4 py-3 text-left transition-colors hover:border-danger/50 hover:bg-surface active:scale-[0.99]"
                >
                  <span className="flex items-center gap-3">
                    <PhoneOff className="h-5 w-5 text-danger" />
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">
                        Hang up for now
                      </div>
                      <div className="text-[11.5px] text-ink-3">
                        👋 “Hang up for now”
                      </div>
                    </div>
                  </span>
                  <Chip tone="danger">hang up</Chip>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function GateHome({
  r,
  theme,
  audioUnlocked,
  pausedCallDecision,
  isPhoneCallActive,
  onUnlockAudio,
  onToggleTheme,
  onExit,
  onCallRecoupBack,
  onPullCallToPhone,
}: {
  r: RecoupRuntime;
  theme: Theme;
  audioUnlocked: boolean;
  pausedCallDecision?: boolean;
  isPhoneCallActive?: boolean;
  onUnlockAudio: () => void;
  onToggleTheme: () => void;
  onExit: () => void;
  onCallRecoupBack?: () => void;
  onPullCallToPhone?: () => void;
}) {
  const recent = r.events.slice(-4).reverse();
  const click = (fn: () => void) => () => {
    soundFx.playUiClick();
    fn();
  };
  return (
    <div className="flex h-full flex-col">
      <StatusBar />
      {audioUnlocked ? <AudioArmedBadge /> : <AudioUnlockBanner onUnlock={onUnlockAudio} />}
      <div className="flex items-center justify-between px-5 pb-3 pt-2">
        <div className="flex items-center gap-2.5">
          <RecoupMark className="h-8 w-8" />
          <div className="leading-tight">
            <div className="text-[17px] font-semibold tracking-tight text-ink">Mobile Companion</div>
            <div className="max-w-[220px] truncate text-[12px] text-ink-3">
              <span className="font-medium text-ink-2">{r.brand.brand_name}</span> · Grok Realtime Voice
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={click(onToggleTheme)}
            aria-label="Toggle theme"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2"
          >
            {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
          <button
            onClick={click(onExit)}
            aria-label="Open desktop HUD"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2"
          >
            <Monitor className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-5 pb-4">
        {/* Paused Decision Waiting Card (early hangup recovery) */}
        {pausedCallDecision && (() => {
          const argRow = r.pendingApproval?.args?.row as Record<string, unknown> | undefined;
          const cardClaimId = (r.pendingApproval?.args?.claim_id ?? argRow?.id ?? DEFAULT_CLAIM_ID) as string;
          const cardAmount = (
            (typeof r.pendingApproval?.args?.claim_amount === "number" ? r.pendingApproval.args.claim_amount : null) ??
            (typeof r.pendingApproval?.args?.amount === "number" ? r.pendingApproval.args.amount : null) ??
            (typeof argRow?.amount === "number" ? argRow.amount : null) ??
            (typeof argRow?.total === "number" ? argRow.total : null) ??
            587.3
          );
          return (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-4 shadow-card"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-amber-400">
                  Paused · Decision Pending
                </span>
                <Chip tone="warn">€{cardAmount.toFixed(2)} at Stake</Chip>
              </div>
              <div className="mt-2 text-[15px] font-semibold leading-snug text-ink">
                Call Ended — Decide on Desktop or Tap to Call Back
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {cardClaimId.startsWith("CLM-") ? `Claim ${cardClaimId}` : `Shipment ${cardClaimId}`} decision remains pending. AP hold on vendor invoice is still active.
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={click(() => onCallRecoupBack?.())}
                  className={cx(btn("signal", "lg"), "h-12 w-full rounded-2xl text-[14px] font-semibold shadow-md")}
                >
                  <PhoneCall className="h-4 w-4" />
                  📞 Call Recoup Back
                </button>
              </div>
            </motion.div>
          );
        })()}

        {/* Tier-1 Decision Gate Standby Card: Active on Desktop, Tap to Pull to iPhone */}
        {!pausedCallDecision && r.pendingApproval && !isPhoneCallActive && r.pendingApproval.channel !== "notification" && (() => {
          const argRow = r.pendingApproval.args?.row as Record<string, unknown> | undefined;
          const cardClaimId = (r.pendingApproval.args?.claim_id ?? argRow?.id ?? DEFAULT_CLAIM_ID) as string;
          const cardAmount = (
            (typeof r.pendingApproval.args?.claim_amount === "number" ? r.pendingApproval.args.claim_amount : null) ??
            (typeof r.pendingApproval.args?.amount === "number" ? r.pendingApproval.args.amount : null) ??
            (typeof argRow?.amount === "number" ? argRow.amount : null) ??
            (typeof argRow?.total === "number" ? argRow.total : null) ??
            587.3
          );
          const isDesktopVoice = r.operatorConsult?.channel === "desktop_voice";
          return (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-3xl border border-line bg-surface p-4 shadow-card"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-2">
                  Standby · Desktop Gate Active
                </span>
                <Chip tone={isDesktopVoice ? "signal" : "neutral"}>
                  {isDesktopVoice ? "Live Desktop Voice" : `€${cardAmount.toFixed(2)} Discrepancy`}
                </Chip>
              </div>
              <div className="mt-2 text-[15px] font-semibold leading-snug text-ink">
                Decision Gate Active on Desktop · Tap to Pull Call to iPhone (or click Transfer on Laptop)
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {r.pendingApproval.spoken_summary ||
                  `${cardClaimId.startsWith("CLM-") ? `Claim ${cardClaimId}` : `Shipment ${cardClaimId}`} decision pending (€${cardAmount.toFixed(2)} discrepancy). ERP hold active.`}
                {isDesktopVoice && (
                  <span className="mt-1 block font-medium text-signal">
                    Live voice consult currently active on Laptop
                  </span>
                )}
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={click(() => {
                    unlockAudioSession("play-and-record");
                    if (onPullCallToPhone) {
                      onPullCallToPhone();
                    } else if (r.escalateToPhone && r.pendingApproval) {
                      r.escalateToPhone(r.pendingApproval.req_id);
                    } else if (onCallRecoupBack) {
                      onCallRecoupBack();
                    }
                  })}
                  className={cx(btn("signal", "lg"), "h-12 w-full rounded-2xl text-[14px] font-semibold shadow-md")}
                >
                  <PhoneCall className="h-4 w-4" />
                  📲 Answer / Pull Call to iPhone
                </button>
              </div>
            </motion.div>
          );
        })()}

        {/* Tier-1 Push Notification Card: Notification Approval */}
        {r.pendingApproval && r.pendingApproval.channel === "notification" && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl border border-danger/40 bg-danger/[0.06] p-4 shadow-card"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-danger">
                Push Notification · Approval Needed
              </span>
              <Chip tone="danger">Vendor Email</Chip>
            </div>
            <div className="mt-2 text-[15px] font-semibold leading-snug text-ink">
              Approve Outbound Vendor Email
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              {r.pendingApproval.spoken_summary || r.pendingApproval.risk_reason}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={click(() => r.decide(r.pendingApproval!.req_id, true))}
                className={cx(btn("ok", "lg"), "h-11 flex-1 rounded-xl text-[13.5px] font-semibold")}
              >
                Approve &amp; Send Email
              </button>
              <button
                type="button"
                onClick={click(() => r.decide(r.pendingApproval!.req_id, false))}
                className={cx(btn("outline", "lg"), "h-11 rounded-xl text-[13.5px]")}
              >
                Hold &amp; Cancel
              </button>
            </div>
          </motion.div>
        )}

        {/* Standby Connected Card */}
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
              <div className="text-[19px] font-semibold tracking-tight text-ink">
                Connected to Desktop · Ready for Live Calls
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
                <Dot tone={r.connected ? "ok" : "neutral"} live={r.connected} />
                {r.connected ? "Live SSE Sync · Grok Realtime Voice Ready" : "Standby · demo ready"}
              </div>
            </div>
          </div>
          <p className="mt-4 text-[13.5px] leading-relaxed text-ink-2">
            When you step away from the desktop HUD during high-value vendor audits (€250+),{" "}
            {r.brand.brand_name} rings this phone with a spoken briefing and stages your AADE myDATA resolution live.
          </p>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={click(() => r.runStageDemo())}
              className={cx(btn("ok", "lg"), "h-11 flex-1 rounded-xl text-[13.5px] font-semibold shadow-sm")}
            >
              Start 12s Stage Demo
            </button>
          </div>

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
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Gate held</div>
              <div className={cx("font-mono text-[13px]", r.pendingApproval ? "text-danger" : "text-ink")}>
                {r.pendingApproval ? 1 : 0}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-1.5 justify-center">
          <VoicePill r={r} compact />
          {(() => {
            const iris =
              ((r as { operatorConsult?: unknown })?.operatorConsult as { irisGate?: { gate_probability?: number; live?: boolean } } | undefined)?.irisGate ||
              (r.wsState as unknown as { iris_gate?: { gate_probability?: number; live?: boolean } })?.iris_gate;
            if (iris && typeof iris.gate_probability === "number") {
              return (
                <div className="inline-flex items-center gap-1.5 rounded-full border border-signal/40 bg-signal/15 px-2.5 py-0.5 text-[11px] font-semibold text-signal shadow-sm">
                  <span>⚡ Oumi Iris · {Math.round(iris.gate_probability * 100)}% Gate · 0 out-tok</span>
                </div>
              );
            }
            return null;
          })()}
        </div>

        {/* Tier-1 Push Notification Card: Next Prompt Suggestion */}
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
              <div className="mt-1 text-[13px] text-ink-3">
                {r.offer.prediction.evidence || "Pre-rehearsed recovery ready — Run this next?"}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={click(() => r.acceptOffer(r.offer!.offer_id))}
                  className={cx(btn("signal", "lg"), "h-11 flex-1 rounded-xl text-[13.5px] font-semibold")}
                >
                  Approve &amp; Run ({r.offer.mutations_count})
                </button>
                <button
                  onClick={click(() => r.dismissOffer(r.offer!.offer_id))}
                  className={cx(btn("outline", "lg"), "h-11 rounded-xl text-[13.5px]")}
                >
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
  const [dismissedCallKey, setDismissedCallKey] = useState<string | null>(null);
  const [localCompletion, setLocalCompletion] = useState<LocalCompletion | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [pausedCallDecision, setPausedCallDecision] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(() => {
    if (typeof window === "undefined") return false;
    const ctx = getSharedAudioContext();
    return ctx?.state === "running";
  });

  const unlockPlaybackOnly = useCallback(() => {
    unlockAudioSession("playback");
    setAudioUnlocked(true);
  }, []);

  const unlockAudio = useCallback(async () => {
    soundFx.playUiClick();
    soundFx.playStageTick(0);
    unlockAudioSession("play-and-record");
    if (!isMobileCallManagingAudio()) {
      try {
        const stream = await acquirePersistentMicStream();
        if (stream && !isMobileCallManagingAudio()) {
          mutePersistentMicStream();
        }
      } catch {
        // ignore
      }
    }
    setAudioUnlocked(true);
  }, []);

  useEffect(() => {
    if (audioUnlocked) return;
    const handleGesture = () => {
      // Passive touchstart/click ONLY unlocks playback — NEVER pops getUserMedia or mutes an active call mic!
      unlockPlaybackOnly();
    };
    window.addEventListener("touchstart", handleGesture, { passive: true, once: true });
    window.addEventListener("click", handleGesture, { passive: true, once: true });
    return () => {
      window.removeEventListener("touchstart", handleGesture);
      window.removeEventListener("click", handleGesture);
    };
  }, [audioUnlocked, unlockPlaybackOnly]);

  useEffect(() => {
    const fit = () => {
      setFramed(window.innerWidth > 520);
      setScale(Math.min(1, (window.innerHeight - 48) / 956, (window.innerWidth - 32) / 440));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const runtimeConsult = (r as RecoupRuntime & { operatorConsult?: OperatorConsultState | null }).operatorConsult;
  const fallbackConsult = useMemo(
    () => deriveConsultFromEvents(r.events, r.speaking),
    [r.events, r.speaking]
  );
  const consult = runtimeConsult ?? fallbackConsult;

  const isPhoneChannel = consult?.channel === "voice_call" || consult?.channel === "iphone_transferred";

  useEffect(() => {
    if ((consult?.active || consult?.ringing) && isPhoneChannel) {
      setActiveCallId(consult.callId || "session-d-1042");
    }
  }, [consult?.active, consult?.callId, consult?.ringing, isPhoneChannel]);

  useEffect(() => {
    if (r.events.length === 0) {
      setLocalCompletion(null);
      setActiveCallId(null);
      setDismissedCallKey(null);
      setPausedCallDecision(false);
    }
  }, [r.events.length]);

  useEffect(() => {
    if (r.pendingApproval?.req_id && localCompletion && localCompletion.sessionKey !== r.pendingApproval.req_id) {
      setLocalCompletion(null);
    }
  }, [localCompletion, r.pendingApproval?.req_id]);

  const currentSessionKey =
    r.pendingApproval?.req_id ?? consult?.reqId ?? consult?.callId ?? activeCallId ?? localCompletion?.sessionKey ?? "session-d-1042";

  const handleEndWithoutDecision = useCallback(() => {
    setLocalCompletion(null);
    setActiveCallId(null);
    setDismissedCallKey(currentSessionKey);
    setPausedCallDecision(true);
    setMobileCallOwnsAudio(false);
    mutePersistentMicStream(true);
  }, [currentSessionKey]);

  const resolvedMobileClaimId = useMemo(() => {
    if (consult?.claimId) return consult.claimId;
    const row = (r.pendingApproval?.args?.row ?? {}) as Record<string, unknown>;
    if (typeof row.id === "string" && row.id.trim()) return row.id.trim();
    const corpus = [
      r.pendingApproval?.diff_preview,
      r.pendingApproval?.risk_reason,
      r.pendingApproval?.spoken_summary,
    ]
      .filter(Boolean)
      .join(" ");
    const match = corpus.match(/\b(CLM-[A-Z0-9-]+)\b/i);
    return match ? match[1].toUpperCase() : DEFAULT_CLAIM_ID;
  }, [consult?.claimId, r.pendingApproval]);

  const handleCallRecoupBack = useCallback(async () => {
    soundFx.playUiClick();
    buzz([40, 60]);
    setPausedCallDecision(false);
    setDismissedCallKey(null);
    unlockAudioSession("play-and-record");
    try {
      await fetch("/api/call/user-consult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          req_id: r.pendingApproval?.req_id,
          claim_id: resolvedMobileClaimId,
          channel: "voice_call",
        }),
      });
    } catch {
      // offline
    }
    setActiveCallId(`CONSULT-${resolvedMobileClaimId}`);
  }, [r.pendingApproval?.req_id, resolvedMobileClaimId]);

  const handlePullCallToPhone = useCallback(async () => {
    soundFx.playUiClick();
    buzz([40, 60]);
    setPausedCallDecision(false);
    setDismissedCallKey(null);
    unlockAudioSession("play-and-record");
    const reqId = r.pendingApproval?.req_id;
    const callId = consult?.callId || `CONSULT-${resolvedMobileClaimId}`;
    setActiveCallId(callId);
    if (r.escalateToPhone) {
      await r.escalateToPhone(reqId, resolvedMobileClaimId);
    } else {
      try {
        await fetch("/api/call/user-consult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            req_id: reqId,
            claim_id: resolvedMobileClaimId,
            channel: "iphone_transferred",
          }),
        });
      } catch {
        // offline
      }
    }
  }, [r, consult?.callId, resolvedMobileClaimId]);

  // Phone (MobileGate.tsx) MUST ONLY enter showEscalationScreen when:
  // 1. (consult?.active || consult?.ringing) is true AND isPhoneChannel (consult?.channel === "voice_call" || consult?.channel === "iphone_transferred")
  // 2. The user explicitly tapped the manual pull-call button on /mobile (activeCallId set by manual user tap)
  // 3. localCompletion is set or (consult?.end && isPhoneChannel && dismissedCallKey !== currentSessionKey)
  // Do NOT set activeCallId or isPhoneCallActive or showEscalationScreen if consult?.channel === "desktop_voice"!
  const isPhoneCallActive = Boolean(
    consult?.channel !== "desktop_voice" &&
    (
      ((consult?.active || consult?.ringing) && isPhoneChannel) ||
      (Boolean(activeCallId) && !consult?.end)
    ) &&
    dismissedCallKey !== currentSessionKey
  );

  const showEscalationScreen = Boolean(
    consult?.channel !== "desktop_voice" &&
    (
      isPhoneCallActive ||
      Boolean(localCompletion) ||
      Boolean(consult?.end && isPhoneChannel && dismissedCallKey !== currentSessionKey)
    )
  );

  const screen = (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <GateHome
        r={r}
        theme={theme}
        audioUnlocked={audioUnlocked}
        pausedCallDecision={pausedCallDecision}
        isPhoneCallActive={isPhoneCallActive}
        onUnlockAudio={unlockAudio}
        onToggleTheme={onToggleTheme}
        onExit={onExit}
        onCallRecoupBack={handleCallRecoupBack}
        onPullCallToPhone={handlePullCallToPhone}
      />
      <AnimatePresence>
        {showEscalationScreen && (
          <OperatorEscalationCall
            sessionKey={currentSessionKey}
            consult={consult}
            approval={r.pendingApproval}
            r={r}
            localCompletion={localCompletion}
            audioUnlocked={audioUnlocked}
            onUnlockAudio={unlockPlaybackOnly}
            onSetLocalCompletion={setLocalCompletion}
            onDismissCompleted={() => {
              setLocalCompletion(null);
              setActiveCallId(null);
              setDismissedCallKey(currentSessionKey);
            }}
            onEndWithoutDecision={handleEndWithoutDecision}
          />
        )}
      </AnimatePresence>
    </div>
  );

  if (!framed) return <div className="h-[100dvh] w-full text-ink">{screen}</div>;

  return (
    <div className="recoup-canvas flex h-screen w-full items-center justify-center gap-14 overflow-hidden text-ink">
      <div className="hidden max-w-[310px] xl:block">
        <div className="flex items-center gap-2">
          <RecoupMark className="h-6 w-6" />
          <span className="text-[13px] font-semibold text-ink">{r.brand.brand_name} · Mobile Operator Escalation</span>
        </div>
        <h2 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.03em] text-ink">
          Step away from your desk — Recoup calls your phone.
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
          Powered by <span className="font-semibold text-ink">Grok Realtime Voice</span> &amp;{" "}
          <span className="font-semibold text-ink">Wizper STT</span>. Hear the Shipment D-1042 discrepancy summary aloud,
          speak your decision hands-free with auto voice activity detection, and stage Greek AADE <code className="font-mono text-[12.5px]">myDATA</code>{" "}
          credit notes with 1-tap reversible undo.
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
              {showEscalationScreen && (
                <span
                  className={cx(
                    "h-2 w-2 animate-pulse rounded-full",
                    consult?.end ? "bg-ok" : "bg-signal"
                  )}
                />
              )}
            </div>
            <div className="pointer-events-none absolute bottom-2 left-1/2 z-40 h-[5px] w-[140px] -translate-x-1/2 rounded-full bg-ink/70" />
          </div>
        </div>
      </div>
    </div>
  );
}
