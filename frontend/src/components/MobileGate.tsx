import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  FileCheck2,
  Loader2,
  Mic,
  Monitor,
  Moon,
  PackageCheck,
  PhoneCall,
  PhoneOff,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Undo2,
  Volume2,
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
import { hasSpeechRecognition, speakCallTurn, stopSpeaking, useSpeechInput } from "../lib/voice";
import { DiffBlock } from "./RightRail";
import { RecoupMark, VoicePill } from "./TopBar";
import { btn, Chip, cx, Dot } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

const DEFAULT_CLAIM_ID = "CLM-D-1042";
const DEFAULT_OPENING_QUESTION =
  "Shipment D-1042 from Kappa Office Systems shows €587.30 in billing discrepancies across 22 hubs and unit-price overcharges. Say 'refund' to enforce the €587.30 refund and stage an AADE myDATA 5.1 credit note, or say 're-delivery' to accept 22 replacement units with a €202.30 credit.";

const buzz = (p: number | number[]) => {
  try {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (ua && !ua.hasBeenActive) return;
    navigator.vibrate?.(p);
  } catch {
    // unsupported
  }
};

function pickRecorderMimeType(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return { mimeType: "", ext: "webm" };
  }
  const candidates: { mimeType: string; ext: string }[] = [
    { mimeType: "audio/mp4", ext: "mp4" },
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
    { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: "", ext: "mp4" };
}

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
      if (
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

interface LocalCompletion {
  sessionKey: string;
  choice: OperatorChoice;
  summary: string;
  claimId: string;
}

interface UserRespondApiBody {
  ok?: boolean;
  choice?: OperatorChoice | string;
  transcript?: string;
  reply?: string;
  confirmation?: string;
  spoken_summary?: string;
  summary?: string;
  agreed_amount?: number;
  resolved?: boolean;
  approved?: boolean;
}

function OperatorEscalationCall({
  sessionKey,
  consult,
  approval,
  r,
  localCompletion,
  onSetLocalCompletion,
  onDismissCompleted,
}: {
  sessionKey: string;
  consult: OperatorConsultState | null;
  approval: ApprovalNeededPayload | null;
  r: RecoupRuntime;
  localCompletion: LocalCompletion | null;
  onSetLocalCompletion: (c: LocalCompletion | null) => void;
  onDismissCompleted: () => void;
}) {
  const [secs, setSecs] = useState(0);
  const [answered, setAnswered] = useState(false);
  const [details, setDetails] = useState(false);
  const [recording, setRecording] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitSource, setSubmitSource] = useState<"mic" | "tap" | null>(null);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const [localTurns, setLocalTurns] = useState<OperatorConsultTurn[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const transcriptBoxRef = useRef<HTMLDivElement>(null);
  const spokenOpeningKeyRef = useRef<string | null>(null);
  const spokenEndKeyRef = useRef<string | null>(null);

  const reqId = approval?.req_id ?? consult?.reqId ?? null;
  const claimId = useMemo(() => {
    if (consult?.claimId) return consult.claimId;
    if (localCompletion?.claimId) return localCompletion.claimId;
    const argRow = approval?.args?.row as Record<string, unknown> | undefined;
    const candidate = approval?.args?.claim_id ?? argRow?.id;
    return typeof candidate === "string" && candidate.trim() ? candidate : DEFAULT_CLAIM_ID;
  }, [approval, consult?.claimId, localCompletion?.claimId]);

  const callKey = sessionKey;

  const openingText = useMemo(() => {
    const firstAgentTurn = consult?.turns.find((t) => t.speaker === "agent")?.text;
    if (firstAgentTurn) return firstAgentTurn;
    if (approval?.spoken_summary?.trim()) return approval.spoken_summary.trim();
    return DEFAULT_OPENING_QUESTION;
  }, [approval?.spoken_summary, consult?.turns]);

  const mergedTurns = useMemo<OperatorConsultTurn[]>(() => {
    const sseTurns = consult?.turns ?? [];
    if (sseTurns.length > 0) {
      const existingTexts = new Set(sseTurns.map((t) => `${t.speaker}:${t.text.trim().toLowerCase()}`));
      const extras = localTurns.filter(
        (lt) => !existingTexts.has(`${lt.speaker}:${lt.text.trim().toLowerCase()}`)
      );
      return [...sseTurns, ...extras];
    }
    const seed: OperatorConsultTurn[] = [
      { speaker: "agent", text: openingText, ts: 0 },
      ...localTurns,
    ];
    return seed;
  }, [consult?.turns, localTurns, openingText]);

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

  const speakAgentLine = useCallback(
    (text: string, interrupt = false) => {
      if (!text.trim()) return;
      speakCallTurn(
        "agent",
        text,
        {
          onStart: () => setLocalSpeaking(true),
          onEnd: () => setLocalSpeaking(false),
        },
        interrupt
      );
    },
    []
  );

  // Haptic ring + call timer on fresh escalation
  useEffect(() => {
    buzz([220, 120, 220, 400]);
    setSecs(0);
    setVoiceHint(null);
    setLocalTurns([]);
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => {
      window.clearInterval(t);
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, [callKey]);

  // Web Audio ringtone loop every 2.2s while ringing until answered
  useEffect(() => {
    if (answered || resolvedEnd) return;
    const isRinging = Boolean(consult?.ringing || (!consult?.end && consult?.turns.length === 0));
    if (!isRinging) return;
    soundFx.playIncomingCall();
    buzz([220, 120, 220, 400]);
    const interval = window.setInterval(() => {
      soundFx.playIncomingCall();
      buzz([220, 120, 220, 400]);
    }, 2200);
    return () => window.clearInterval(interval);
  }, [answered, consult?.end, consult?.ringing, consult?.turns.length, resolvedEnd]);

  // Auto-play Recoup's fal.ai Voice opening question when call arrives or is answered
  useEffect(() => {
    const key = `${callKey}:${openingText}`;
    if (spokenOpeningKeyRef.current === key) return;
    if (!r.voiceOn && !answered) return;
    spokenOpeningKeyRef.current = key;
    speakAgentLine(openingText, false);
  }, [answered, callKey, openingText, r.voiceOn, speakAgentLine]);

  // Speak confirmation aloud when SSE CALL_END arrives from backend/desktop
  useEffect(() => {
    if (!consult?.end?.summary) return;
    const key = `${consult.callId}:end:${consult.end.summary}`;
    if (spokenEndKeyRef.current === key) return;
    spokenEndKeyRef.current = key;
    buzz([30, 50, 30]);
    if (r.voiceOn) {
      const lastAgentTurn = [...(consult.turns ?? [])].reverse().find((t) => t.speaker === "agent");
      const textToSpeak =
        lastAgentTurn && lastAgentTurn.text !== openingText ? lastAgentTurn.text : consult.end.summary;
      speakAgentLine(textToSpeak, false);
    }
  }, [consult?.callId, consult?.end, consult?.turns, openingText, r.voiceOn, speakAgentLine]);

  // Auto-scroll live transcript preview
  useEffect(() => {
    if (transcriptBoxRef.current) {
      transcriptBoxRef.current.scrollTo({
        top: transcriptBoxRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [mergedTurns.length, resolvedEnd]);

  const finalizeOfflineOrDemo = useCallback(
    (choice: OperatorChoice, userUtterance: string) => {
      const confirmation = defaultConfirmationFor(choice, claimId);
      setLocalTurns((prev) => [
        ...prev,
        { speaker: "user", text: userUtterance, ts: Date.now() },
        { speaker: "agent", text: confirmation, ts: Date.now() + 1 },
      ]);
      onSetLocalCompletion({ sessionKey: callKey, choice, summary: confirmation, claimId });
      setVoiceHint(
        choice === "refund"
          ? "€587.30 Refund + AADE 5.1 Credit Note staged"
          : "22-Unit Re-Delivery + AADE 9.3 Credit staged"
      );
      buzz([30, 50, 30]);
      if (reqId) {
        r.decide(reqId, true);
      }
      speakAgentLine(confirmation, true);
    },
    [callKey, claimId, onSetLocalCompletion, r, reqId, speakAgentLine]
  );

  const handleApiDecisionResponse = useCallback(
    (body: UserRespondApiBody, fallbackChoice: OperatorChoice | null, fallbackUserText: string) => {
      const resolvedChoice: OperatorChoice =
        body.choice === "redelivery" || body.choice === "refund"
          ? body.choice
          : (body.transcript ? parseChoiceFromText(body.transcript) : null) ??
            fallbackChoice ??
            "refund";

      const userLine = body.transcript?.trim() || fallbackUserText;
      const confirmation =
        body.reply?.trim() ||
        body.confirmation?.trim() ||
        body.spoken_summary?.trim() ||
        body.summary?.trim() ||
        defaultConfirmationFor(resolvedChoice, claimId);

      setLocalTurns((prev) => [
        ...prev,
        ...(userLine ? [{ speaker: "user" as const, text: userLine, ts: Date.now() }] : []),
        { speaker: "agent" as const, text: confirmation, ts: Date.now() + 1 },
      ]);
      onSetLocalCompletion({
        sessionKey: callKey,
        choice: resolvedChoice,
        summary: confirmation,
        claimId,
      });
      setVoiceHint(
        resolvedChoice === "refund"
          ? "AADE myDATA 5.1 Credit Note staged"
          : "22-Unit Re-Delivery + AADE 9.3 staged"
      );
      buzz([30, 50, 30]);

      if (reqId && (r.mode === "demo" || body.resolved === false)) {
        r.decide(reqId, body.approved ?? true);
      }

      speakAgentLine(confirmation, false);
    },
    [callKey, claimId, onSetLocalCompletion, r, reqId, speakAgentLine]
  );

  const submitChoicePill = useCallback(
    async (choice: OperatorChoice) => {
      soundFx.playUiClick();
      stopSpeaking();
      setAnswered(true);
      setSubmitting(true);
      setSubmitSource("tap");
      const userLabel =
        choice === "refund"
          ? "Enforce €587.30 refund and stage Greek AADE myDATA 5.1 credit note."
          : "Accept next-day 22-unit re-delivery with €202.30 SLA and price credit.";
      setVoiceHint("Applying Decision & Emailing Vendor…");

      if (r.mode === "demo" && (!reqId || reqId.startsWith("req_demo"))) {
        setSubmitting(false);
        setSubmitSource(null);
        finalizeOfflineOrDemo(choice, userLabel);
        return;
      }

      try {
        const res = await fetch("/api/call/user-respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            choice,
            req_id: reqId,
            claim_id: claimId || DEFAULT_CLAIM_ID,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as UserRespondApiBody;
          handleApiDecisionResponse(data, choice, userLabel);
          return;
        }
        finalizeOfflineOrDemo(choice, userLabel);
      } catch {
        finalizeOfflineOrDemo(choice, userLabel);
      } finally {
        setSubmitting(false);
        setSubmitSource(null);
      }
    },
    [claimId, finalizeOfflineOrDemo, handleApiDecisionResponse, r.mode, reqId]
  );

  const submitSpeechTranscript = useCallback(
    async (transcript: string) => {
      const clean = transcript.trim();
      if (!clean) return;
      setSubmitting(true);
      setSubmitSource("mic");
      setVoiceHint(`Heard “${clean}” — resolving…`);
      const parsed = parseChoiceFromText(clean);

      try {
        const res = await fetch("/api/call/user-respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: clean,
            req_id: reqId,
            claim_id: claimId || DEFAULT_CLAIM_ID,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as UserRespondApiBody;
          if (data.ok === false && !data.choice && !parsed) {
            setVoiceHint(`Heard “${clean}” — say “587 refund” or “22-unit re-delivery”`);
            return;
          }
          handleApiDecisionResponse(data, parsed, clean);
          return;
        }
      } catch {
        // Offline / demo fallback below
      } finally {
        setSubmitting(false);
        setSubmitSource(null);
      }

      if (parsed) {
        finalizeOfflineOrDemo(parsed, clean);
      } else if (/\b(reject|abort|cancel|rollback)\b/i.test(clean) && reqId) {
        r.decide(reqId, false);
      } else {
        setVoiceHint(`Heard “${clean}” — say “enforce refund” or “accept re-delivery”, or tap a pill below`);
      }
    },
    [claimId, finalizeOfflineOrDemo, handleApiDecisionResponse, r, reqId]
  );

  const speech = useSpeechInput((text, final) => {
    setVoiceHint(text ? `“${text}”` : "Listening…");
    if (final && text.trim()) {
      submitSpeechTranscript(text.trim());
    }
  });

  const stopMediaRecorder = useCallback(() => {
    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const toggleTapAndSpeak = useCallback(async () => {
    soundFx.playUiClick();
    setAnswered(true);

    if (recording) {
      stopMediaRecorder();
      return;
    }
    if (speech.listening) {
      speech.stop();
      return;
    }

    stopSpeaking();

    const canRecordAudio =
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined";

    if (!canRecordAudio) {
      if (hasSpeechRecognition()) {
        speech.start();
        setVoiceHint("Listening — say “refund” or “re-delivery”…");
      } else {
        setVoiceHint("Mic unavailable — use the 1-tap resolution pills below");
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const { mimeType, ext } = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      recorder.onstop = async () => {
        setRecording(false);
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;

        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/mp4" });
        if (blob.size === 0) {
          setVoiceHint("No speech captured — tap mic again or use a 1-tap pill below");
          return;
        }

        setSubmitting(true);
        setSubmitSource("mic");
        setVoiceHint("Transcribing via fal.ai Wizper…");
        try {
          const form = new FormData();
          form.append("audio", blob, `operator-decision.${ext}`);
          if (reqId) form.append("req_id", reqId);
          form.append("claim_id", claimId || DEFAULT_CLAIM_ID);

          const res = await fetch("/api/call/user-respond", {
            method: "POST",
            body: form,
          });
          if (res.ok) {
            const body = (await res.json()) as UserRespondApiBody;
            const parsed = body.transcript ? parseChoiceFromText(body.transcript) : null;
            if (body.ok === false && !body.choice && !parsed) {
              setVoiceHint(
                body.transcript
                  ? `Heard “${body.transcript}” — say “refund” or “re-delivery”, or tap below`
                  : "Could not parse voice decision — tap a resolution pill below"
              );
              return;
            }
            handleApiDecisionResponse(body, parsed, body.transcript || "Voice authorization via Wizper STT");
            return;
          }
          if (r.mode === "demo") {
            finalizeOfflineOrDemo("refund", "Enforce €587.30 refund and stage AADE 5.1 credit note.");
            return;
          }
          setVoiceHint("Wizper STT endpoint unreachable — tap a 1-tap backup pill below");
        } catch {
          if (r.mode === "demo") {
            finalizeOfflineOrDemo("refund", "Enforce €587.30 refund and stage AADE 5.1 credit note.");
          } else {
            setVoiceHint("Offline — tap a 1-tap resolution pill below");
          }
        } finally {
          setSubmitting(false);
          setSubmitSource(null);
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      buzz(25);
      setVoiceHint("Recording — speak your decision, then tap again to send…");
      stopTimerRef.current = window.setTimeout(() => stopMediaRecorder(), 6500);
    } catch {
      setRecording(false);
      if (hasSpeechRecognition()) {
        speech.start();
        setVoiceHint("Listening via browser speech — say “refund” or “re-delivery”…");
      } else {
        setVoiceHint("Microphone permission denied — tap a resolution pill below");
      }
    }
  }, [
    claimId,
    finalizeOfflineOrDemo,
    handleApiDecisionResponse,
    r.mode,
    recording,
    reqId,
    speech,
    stopMediaRecorder,
  ]);

  const micActive = recording || speech.listening;
  const aiSpeaking = r.speaking || localSpeaking;

  return (
    <motion.div
      key={callKey}
      initial={{ opacity: 0, scale: 1.03 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.3 }}
      className="absolute inset-0 z-20 flex flex-col"
      style={{
        background: resolvedEnd
          ? "radial-gradient(120% 60% at 50% 0%, color-mix(in oklab, var(--ok) 24%, var(--canvas)), var(--canvas) 72%)"
          : "radial-gradient(120% 60% at 50% 0%, color-mix(in oklab, var(--signal) 22%, var(--canvas)), var(--canvas) 72%)",
      }}
    >
      <StatusBar />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-7">
        {/* Call Header & Voice Orb */}
        <div className="mt-2 flex flex-col items-center text-center">
          <Chip tone={resolvedEnd ? "ok" : "accent"} className="mb-1.5">
            <Volume2 className="h-2.5 w-2.5" />
            fal.ai Voice · Wizper STT
          </Chip>
          <span className="font-mono text-[11.5px] font-medium uppercase tracking-wider text-ink-3">
            {resolvedEnd
              ? `call completed · ${claimId}`
              : `live operator escalation · ${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(
                  secs % 60
                ).padStart(2, "0")}`}
          </span>
          <h1 className="mt-1 text-[23px] font-semibold leading-tight tracking-[-0.03em] text-ink">
            {r.brand.brand_name} AI · Shipment D-1042 Resolution
          </h1>

          <div className="relative mt-2.5 flex h-28 w-28 shrink-0 items-center justify-center">
            <VoiceOrb
              variant="orb"
              tone={resolvedEnd ? "ok" : micActive ? "danger" : "signal"}
              ambient
              className="absolute inset-0 h-full w-full"
            />
            <button
              type="button"
              onClick={() => {
                soundFx.playUiClick();
                setAnswered(true);
                speakAgentLine(
                  resolvedEnd ? resolvedEnd.summary : openingText,
                  true
                );
              }}
              aria-label={answered ? "Replay spoken prompt" : "Answer and play spoken prompt"}
              className={cx(
                "relative flex h-16 w-16 items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95",
                resolvedEnd
                  ? "bg-ok text-on-solid"
                  : micActive
                  ? "bg-danger"
                  : "bg-signal"
              )}
            >
              {resolvedEnd ? (
                <CheckCircle2 className="h-8 w-8" />
              ) : micActive ? (
                <Mic className="h-7 w-7 animate-pulse" />
              ) : (
                <PhoneCall className={cx("h-7 w-7", aiSpeaking && "animate-pulse")} />
              )}
            </button>
          </div>

          <div className="mt-1.5 flex items-center justify-center gap-2">
            <span className="text-[12px] font-medium text-ink-2" aria-live="polite">
              {voiceHint
                ? voiceHint
                : aiSpeaking
                ? "Speaking via fal.ai Voice…"
                : resolvedEnd
                ? "Resolution staged · reversible receipt ready"
                : "Ringing — tap Answer/Replay, speak decision, or tap an option"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              soundFx.playUiClick();
              setAnswered(true);
              speakAgentLine(resolvedEnd ? resolvedEnd.summary : openingText, true);
            }}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/85 px-3 py-1 text-[11.5px] font-semibold text-ink-2 backdrop-blur hover:text-ink"
          >
            <Volume2 className={cx("h-3.5 w-3.5 text-accent", aiSpeaking && "animate-pulse")} />
            {answered ? "Replay Spoken Question" : "Answer & Play Question"}
          </button>
        </div>

        {/* Live Call Transcript Preview (Recoup AI & You) */}
        <div className="mt-3.5 rounded-2xl border border-line bg-surface/85 p-3 backdrop-blur-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Live Call Transcript
            </span>
            <span className="font-mono text-[10.5px] text-ink-3">{claimId} · INV-7781</span>
          </div>
          <div
            ref={transcriptBoxRef}
            className="scroll-thin max-h-[156px] space-y-2 overflow-y-auto pr-0.5"
            aria-live="polite"
          >
            {mergedTurns.map((turn, idx) => {
              const isUser = turn.speaker === "user";
              return (
                <div
                  key={`m-turn-${idx}`}
                  className={cx(
                    "rounded-xl border px-3 py-2 text-[12.5px] leading-snug",
                    isUser
                      ? "ml-5 border-signal/35 bg-signal/10 text-ink"
                      : "mr-3 border-ok/30 bg-ok/[0.06] text-ink"
                  )}
                >
                  <div className="mb-0.5 flex items-center justify-between text-[10.5px] font-semibold">
                    <span className={isUser ? "text-signal" : "text-ok"}>
                      {isUser ? "You" : `${r.brand.brand_name} AI`}
                    </span>
                    <span className="font-mono text-[9.5px] text-ink-3">
                      {isUser ? "Wizper STT" : "fal.ai Voice"}
                    </span>
                  </div>
                  <p className="text-ink-2">{turn.text}</p>
                </div>
              );
            })}
          </div>

          {approval && (
            <div className="mt-2 border-t border-line pt-2">
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  setDetails((d) => !d);
                }}
                className="text-[12px] font-medium text-accent"
              >
                {details ? "Hide staged ERP diff" : `Inspect staged diff (${approval.tool_name})`}
              </button>
              <AnimatePresence>
                {details && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 overflow-hidden rounded-lg border border-line">
                      {approval.diff_preview ? (
                        <DiffBlock diff={approval.diff_preview} max={140} />
                      ) : (
                        <pre className="bg-code p-2 font-mono text-[11px] text-ink-2">
                          {JSON.stringify(approval.args, null, 2).replace(/"pk_col":/g, '"record_id":')}
                        </pre>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* Completion Card OR Active Decision Controls */}
        <div className="mt-auto pt-4">
          {resolvedEnd ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
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
                      ? "22-Unit Replacement + AADE 9.3 (€202.30 Credit + Email Vendor)"
                      : "AP Hold INV-7781 + AADE 5.1 (€587.30 Net / €728.25 Gross + Email Vendor)"}
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
                    Recoup found €175.00 more on paid shipments D-1017 &amp; D-1031 — Run this next?
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
            <div className="space-y-2.5">
              {/* Prominent Tap & Speak Decision Microphone Button */}
              <button
                type="button"
                disabled={submitting}
                onClick={toggleTapAndSpeak}
                aria-pressed={micActive}
                className={cx(
                  "flex h-16 w-full items-center justify-center gap-3 rounded-2xl border text-[15.5px] font-semibold shadow-lg transition-all active:scale-[0.99]",
                  micActive
                    ? "border-danger bg-danger text-white"
                    : "border-ok/50 bg-ok text-on-solid hover:brightness-105"
                )}
              >
                {submitting ? (
                  submitSource === "tap" ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Applying Decision &amp; Emailing Vendor…
                    </>
                  ) : (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Transcribing via fal.ai Wizper…
                    </>
                  )
                ) : recording ? (
                  <>
                    <Square className="h-5 w-5 fill-current" />
                    Tap to Send Spoken Decision
                  </>
                ) : speech.listening ? (
                  <>
                    <Mic className="h-5 w-5 animate-pulse" />
                    Listening — Speak Now…
                  </>
                ) : (
                  <>
                    <Mic className="h-5 w-5" />
                    Tap &amp; Speak Decision
                  </>
                )}
              </button>

              {/* Two Crisp 1-Tap Stage Backup Pills */}
              <div className="space-y-2 pt-0.5">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => submitChoicePill("refund")}
                  className="flex w-full items-center justify-between gap-2 rounded-2xl border border-ok/45 bg-ok/12 px-4 py-3 text-left transition-colors hover:bg-ok/18 active:scale-[0.99] disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {submitting && submitSource === "tap" ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ok" />
                    ) : (
                      <FileCheck2 className="h-4 w-4 shrink-0 text-ok" />
                    )}
                    <span className="truncate text-[13.5px] font-semibold text-ink">
                      {submitting && submitSource === "tap"
                        ? "Applying Decision & Emailing Vendor…"
                        : "Enforce €587.30 Refund + Email Vendor"}
                    </span>
                  </span>
                  <Chip tone="ok" solid className="shrink-0 text-[11px]">
                    AADE 5.1 + Hold INV-7781
                  </Chip>
                </button>

                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => submitChoicePill("redelivery")}
                  className="flex w-full items-center justify-between gap-2 rounded-2xl border border-line bg-surface/90 px-4 py-3 text-left transition-colors hover:border-signal/50 hover:bg-surface active:scale-[0.99] disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {submitting && submitSource === "tap" ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-signal" />
                    ) : (
                      <PackageCheck className="h-4 w-4 shrink-0 text-signal" />
                    )}
                    <span className="truncate text-[13.5px] font-semibold text-ink">
                      {submitting && submitSource === "tap"
                        ? "Applying Decision & Emailing Vendor…"
                        : "Accept 22-Unit Re-Delivery + Email Vendor"}
                    </span>
                  </span>
                  <Chip tone="signal" className="shrink-0 text-[11px]">
                    €202.30 Credit + AADE 9.3
                  </Chip>
                </button>
              </div>

              {reqId && (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      buzz(50);
                      soundFx.playUiClick();
                      stopSpeaking();
                      r.decide(reqId, false);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium text-ink-3 hover:text-danger"
                  >
                    <PhoneOff className="h-3.5 w-3.5" />
                    Decline &amp; Roll Back Workspace
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function AudioUnlockBanner({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      className="flex w-full items-center justify-between gap-2 border-b border-signal/40 bg-signal/15 px-5 py-2.5 text-[12px] font-semibold text-signal transition-colors hover:bg-signal/20 active:scale-[0.99]"
    >
      <span className="flex items-center gap-2">
        <Volume2 className="h-4 w-4 animate-pulse" />
        Tap once to arm iPhone sound &amp; mic
      </span>
      <span className="rounded-full bg-signal px-2 py-0.5 text-[10.5px] font-bold text-white shadow-sm">
        Arm Audio
      </span>
    </button>
  );
}

function GateHome({
  r,
  theme,
  audioUnlocked,
  onUnlockAudio,
  onToggleTheme,
  onExit,
}: {
  r: RecoupRuntime;
  theme: Theme;
  audioUnlocked: boolean;
  onUnlockAudio: () => void;
  onToggleTheme: () => void;
  onExit: () => void;
}) {
  const recent = r.events.slice(-4).reverse();
  const click = (fn: () => void) => () => {
    soundFx.playUiClick();
    fn();
  };
  return (
    <div className="flex h-full flex-col">
      <StatusBar />
      {!audioUnlocked && <AudioUnlockBanner onUnlock={onUnlockAudio} />}
      <div className="flex items-center justify-between px-5 pb-3 pt-2">
        <div className="flex items-center gap-2.5">
          <RecoupMark className="h-8 w-8" />
          <div className="leading-tight">
            <div className="text-[17px] font-semibold tracking-tight text-ink">Mobile Companion</div>
            <div className="max-w-[220px] truncate text-[12px] text-ink-3">
              <span className="font-medium text-ink-2">{r.brand.brand_name}</span> · fal.ai Voice · Wizper STT
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
        {/* State 2 — Tier 1 Push Notification Card: Pre-call Voice Escalation Waiting */}
        {r.pendingApproval && r.pendingApproval.channel === "voice_call" && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-3xl border border-signal/50 bg-signal/10 p-4 shadow-card"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-signal">
                Incoming Call Waiting · D-1042
              </span>
              <Chip tone="signal">€587.30 Discrepancy</Chip>
            </div>
            <div className="mt-2 text-[15px] font-semibold leading-snug text-ink">
              Shipment D-1042 Decision — Live ERP &amp; Vendor Email Held
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              {r.pendingApproval.spoken_summary}
            </p>
            <div className="mt-3">
              <button
                type="button"
                onClick={click(() => r.escalateToPhone(r.pendingApproval!.req_id))}
                className={cx(btn("signal", "lg"), "h-12 w-full rounded-2xl text-[14px] font-semibold shadow-md")}
              >
                <PhoneCall className="h-4 w-4" />
                Answer / Take Voice Call Now
              </button>
            </div>
          </motion.div>
        )}

        {/* State 2 — Tier 1 Push Notification Card: Lightweight Notification Approval */}
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
              Approve Outbound Vendor Email to accounts@kappaoffice.example
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

        {/* State 3 — Standby Connected Card */}
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
                Connected to Desktop · Ready for Approvals &amp; Calls
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
                <Dot tone={r.connected ? "ok" : "neutral"} live={r.connected} />
                {r.connected ? "Live SSE & 1.5s Poll Sync · fal.ai Voice ready" : "Standby · demo ready"}
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

        <div className="flex justify-center">
          <VoicePill r={r} compact />
        </div>

        {/* State 2 — Tier 1 Push Notification Card: Next Prompt Suggestion */}
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
                Recoup found €175.00 more on paid shipments D-1017 &amp; D-1031 — Run this next?
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
  const [audioUnlocked, setAudioUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem("recoup.audioUnlocked") === "1";
    } catch {
      return false;
    }
  });

  const unlockAudio = useCallback(() => {
    soundFx.playUiClick();
    soundFx.playStageTick(0);
    try {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0.01;
        window.speechSynthesis.speak(u);
      }
    } catch {
      // ignore
    }
    setAudioUnlocked(true);
    try {
      sessionStorage.setItem("recoup.audioUnlocked", "1");
    } catch {
      // ignore
    }
  }, []);

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

  useEffect(() => {
    if (r.events.length === 0) {
      setLocalCompletion(null);
      setDismissedCallKey(null);
    }
  }, [r.events.length]);

  useEffect(() => {
    if (r.pendingApproval?.req_id && localCompletion && localCompletion.sessionKey !== r.pendingApproval.req_id) {
      setLocalCompletion(null);
    }
  }, [localCompletion, r.pendingApproval?.req_id]);

  const currentSessionKey =
    consult?.callId ?? r.pendingApproval?.req_id ?? localCompletion?.sessionKey ?? "session-d-1042";
  const showEscalationScreen = Boolean(
    consult?.active ||
      consult?.ringing ||
      localCompletion ||
      (consult?.end && dismissedCallKey !== currentSessionKey)
  );

  const screen = (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <GateHome
        r={r}
        theme={theme}
        audioUnlocked={audioUnlocked}
        onUnlockAudio={unlockAudio}
        onToggleTheme={onToggleTheme}
        onExit={onExit}
      />
      <AnimatePresence>
        {showEscalationScreen && (
          <OperatorEscalationCall
            sessionKey={currentSessionKey}
            consult={consult}
            approval={r.pendingApproval}
            r={r}
            localCompletion={localCompletion}
            onSetLocalCompletion={setLocalCompletion}
            onDismissCompleted={() => {
              setLocalCompletion(null);
              setDismissedCallKey(currentSessionKey);
            }}
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
          Powered by <span className="font-semibold text-ink">fal.ai Voice</span> &amp;{" "}
          <span className="font-semibold text-ink">Wizper STT</span>. Hear the Shipment D-1042 discrepancy summary aloud,
          speak your decision hands-free, and stage Greek AADE <code className="font-mono text-[12.5px]">myDATA</code>{" "}
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
