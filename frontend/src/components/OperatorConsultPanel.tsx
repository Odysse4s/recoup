import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  CornerDownLeft,
  Mic,
  PackageCheck,
  PhoneCall,
  PhoneIncoming,
  Radio,
  Send,
  Smartphone,
  Volume2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalNeededPayload, OumiIrisGate, OumiIrisIntent } from "../contracts";
import { soundFx } from "../lib/sound";
import type { OperatorChoice, OperatorConsultState } from "../lib/types";
import { stopSpeaking, useAutoVad, useSpeechInput } from "../lib/voice";
import { btn, Chip, cx, Dot, Panel } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

export type { OperatorChoice, OperatorConsultState, OperatorConsultTurn } from "../lib/types";

interface ExtendedConsultState extends OperatorConsultState {
  callStatus?: "ringing" | "connected" | "ended";
  connectedAt?: number | null;
  lastUiAction?: { action: string; label: string; ts: number } | null;
}

export interface OperatorConsultPanelProps {
  brandName?: string;
  consult: OperatorConsultState | null;
  pendingApproval: ApprovalNeededPayload | null;
  committedClaimId?: string | null;
  voiceOn: boolean;
  speaking: boolean;
  onDesktopVoiceTurn?: (text: string) => Promise<void> | void;
  onEscalateToPhone: (reqId?: string | null, claimId?: string) => void;
  onSelectResolution: (choice: OperatorChoice, reqId?: string | null, claimId?: string) => void;
  onReject?: (reqId: string) => void;
  onReplayTurn?: (text: string) => void;
  irisGate?: OumiIrisGate | null;
  activeCall?: {
    turns?: {
      speaker: string;
      text: string;
      audio_url?: string | null;
      ts: number;
      iris_intent?: OumiIrisIntent | null;
      irisIntent?: OumiIrisIntent | null;
    }[];
    iris_gate?: OumiIrisGate | null;
    irisGate?: OumiIrisGate | null;
  } | null;
}

function inferChoice(consult: OperatorConsultState | null, committedClaimId?: string | null): OperatorChoice | null {
  if (consult?.selectedChoice) return consult.selectedChoice;
  if (consult?.end) {
    const summary = consult.end.summary.toLowerCase();
    if (
      summary.includes("9.3") ||
      summary.includes("redeliver") ||
      summary.includes("re-deliver") ||
      summary.includes("22-unit") ||
      (typeof consult.end.agreed_amount === "number" && consult.end.agreed_amount > 0 && consult.end.agreed_amount < 350)
    ) {
      return "redelivery";
    }
    if (consult.end.outcome === "accepted") return "refund";
  }
  if (committedClaimId) return "refund";
  return null;
}

export function OperatorConsultPanel({
  brandName = "Recoup",
  consult,
  pendingApproval,
  committedClaimId = null,
  voiceOn,
  speaking,
  onDesktopVoiceTurn,
  onEscalateToPhone,
  onSelectResolution,
  onReject,
  onReplayTurn,
  irisGate: propsIrisGate,
  activeCall,
}: OperatorConsultPanelProps) {
  const extConsult = consult as ExtendedConsultState | null;
  const irisGate =
    propsIrisGate ??
    extConsult?.irisGate ??
    extConsult?.iris_gate ??
    activeCall?.irisGate ??
    activeCall?.iris_gate ??
    null;

  const isPhoneTransferred = Boolean(
    (consult?.active || consult?.ringing) &&
      (consult?.channel === "voice_call" || consult?.channel === "iphone_transferred")
  );

  const routeLabel = useMemo(() => {
    if (!irisGate?.route) return isPhoneTransferred ? "iPhone Voice" : "Laptop Voice";
    if (irisGate.route === "iphone_voice_call") return isPhoneTransferred ? "iPhone Voice" : "Laptop Voice";
    if (irisGate.route === "desktop_queue") return "Desktop Queue";
    if (irisGate.route === "auto_execute") return "Auto Execute";
    return irisGate.route;
  }, [irisGate?.route, isPhoneTransferred]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const escalatedReqIdRef = useRef<string | null>(null);
  const connectedMomentRef = useRef<number | null>(null);
  const [, setHovered] = useState(false);
  const [isDialing, setIsDialing] = useState(false);
  const [timerTick, setTimerTick] = useState(0);

  // Laptop Mic & Auto-VAD State
  const [laptopMicOn, setLaptopMicOn] = useState(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [sttSubmitting, setSttSubmitting] = useState(false);
  const [quickAskText, setQuickAskText] = useState("");
  const lastProcessedTranscriptRef = useRef<string>("");
  const lastTranscriptTimeRef = useRef<number>(0);

  const claimId = useMemo(() => {
    if (consult?.claimId) return consult.claimId;
    if (committedClaimId) return committedClaimId;
    const argRow = pendingApproval?.args?.row as Record<string, unknown> | undefined;
    const rawId =
      pendingApproval?.args?.claim_id ??
      pendingApproval?.args?.id ??
      argRow?.id ??
      argRow?.claim_id;
    if (typeof rawId === "string" && rawId.trim()) return rawId.trim();

    const searchCorpus = [
      pendingApproval?.diff_preview,
      pendingApproval?.risk_reason,
      pendingApproval?.spoken_summary,
    ]
      .filter(Boolean)
      .join(" ");
    const match = searchCorpus.match(/CLM-[A-Z0-9-]+/i);
    if (match) return match[0].toUpperCase();

    return "CLM-D-1042";
  }, [committedClaimId, consult?.claimId, pendingApproval]);

  const isKappa = useMemo(() => {
    const rawCorpus = [
      pendingApproval?.risk_reason,
      pendingApproval?.diff_preview,
      pendingApproval?.spoken_summary,
      JSON.stringify(pendingApproval?.args || {}),
      consult?.counterparty,
      consult?.claimId,
      committedClaimId,
    ]
      .filter(Boolean)
      .join(" ");

    if (/atlas|orion|nova|d-2010|d-3005|d-1050|d-1017|d-1031|inv-9901|inv-8801|inv-7790|followup/i.test(rawCorpus)) {
      return false;
    }
    if (claimId && claimId !== "CLM-D-1042" && !/1042|kappa|7781/i.test(claimId)) {
      return false;
    }
    if (/kappa|sup-kappa|d-1042|inv-7781/i.test(rawCorpus)) {
      return true;
    }
    // If rawCorpus has custom supplier/invoice context without mentioning Kappa/D-1042, treat as custom scenario!
    if (rawCorpus.trim().length > 4) {
      return false;
    }
    return claimId === "CLM-D-1042";
  }, [claimId, committedClaimId, consult?.claimId, consult?.counterparty, pendingApproval]);

  const claimAmount = useMemo(() => {
    if (typeof consult?.claimAmount === "number" && consult.claimAmount > 0) {
      return consult.claimAmount;
    }
    const argRow = pendingApproval?.args?.row as Record<string, unknown> | undefined;
    const rawAmount =
      pendingApproval?.args?.claim_amount ??
      pendingApproval?.args?.amount ??
      argRow?.amount ??
      argRow?.claim_amount;
    if (typeof rawAmount === "number" && !isNaN(rawAmount) && rawAmount > 0) {
      return rawAmount;
    }
    if (typeof rawAmount === "string") {
      const parsed = parseFloat(rawAmount.replace(/[^0-9.]/g, ""));
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    const searchCorpus = [
      pendingApproval?.diff_preview,
      pendingApproval?.risk_reason,
      pendingApproval?.spoken_summary,
    ]
      .filter(Boolean)
      .join(" ");
    const match = searchCorpus.match(/(?:EUR|€)\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (match && match[1]) {
      const parsed = parseFloat(match[1]);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    return isKappa ? 587.3 : null;
  }, [consult?.claimAmount, isKappa, pendingApproval]);

  const formattedClaimAmount = useMemo(() => {
    if (typeof claimAmount === "number" && !isNaN(claimAmount)) {
      return `€${claimAmount.toFixed(2)}`;
    }
    return isKappa ? "€587.30" : "";
  }, [claimAmount, isKappa]);

  const activeReqId = pendingApproval?.req_id ?? consult?.reqId ?? null;

  const hasCommitted = Boolean(
    consult?.selectedChoice === "refund" ||
      consult?.selectedChoice === "redelivery" ||
      Boolean(committedClaimId) ||
      consult?.end?.outcome === "accepted"
  );

  // Check if call ended without decision while pendingApproval is still active
  const callEndedWithoutDecision = Boolean(
    pendingApproval &&
      !hasCommitted &&
      consult &&
      (
        consult.end?.outcome === "escalated" ||
        consult.end?.outcome === "no_answer" ||
        consult.callStatus === "ended" ||
        extConsult?.callStatus === "ended" ||
        (!consult.active && !consult.ringing && consult.turns.length > 0)
      )
  );

  // Determine Call Status states (iPhone call)
  const isRinging = Boolean(
    isPhoneTransferred &&
      !callEndedWithoutDecision &&
      !consult?.end &&
      consult?.callStatus !== "ended" &&
      extConsult?.callStatus !== "ended" &&
      consult?.ringing &&
      consult?.callStatus !== "connected" &&
      extConsult?.callStatus !== "connected" &&
      consult.turns.length <= 1
  );

  const isConnected = Boolean(
    isPhoneTransferred &&
      !callEndedWithoutDecision &&
      !consult?.end &&
      consult?.callStatus !== "ended" &&
      extConsult?.callStatus !== "ended" &&
      consult &&
      (consult.callStatus === "connected" ||
        extConsult?.callStatus === "connected" ||
        consult.turns.some((t) => t.speaker === "user") ||
        (!consult.ringing && consult.active))
  );

  const callLive = isRinging || isConnected;

  // Stop media tracks helper
  const stopLaptopMic = useCallback(() => {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      setMediaStream(null);
    }
    setLaptopMicOn(false);
  }, [mediaStream]);

  // Clean up media tracks on unmount
  useEffect(() => {
    return () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [mediaStream]);

  const consultSessionEnded = Boolean(
    consult?.end ||
      consult?.callStatus === "ended" ||
      extConsult?.callStatus === "ended"
  );

  // Stop laptop mic ONLY when transferred to iPhone or when operator explicitly closes the consult ("No thanks" / hangup)
  useEffect(() => {
    if (isPhoneTransferred || consultSessionEnded) {
      stopLaptopMic();
    }
  }, [isPhoneTransferred, consultSessionEnded, stopLaptopMic]);

  // Reset dialing state once call becomes live or pendingApproval changes
  useEffect(() => {
    if (callLive || !pendingApproval) {
      setIsDialing(false);
    }
  }, [callLive, pendingApproval?.req_id]);

  const isExecutedLive = Boolean(
    (consult?.selectedChoice === "refund" || consult?.selectedChoice === "redelivery" || Boolean(committedClaimId)) &&
      (consult?.active || isConnected || isRinging || consult?.channel === "desktop_voice")
  );

  const callCompleted = Boolean(
    !callEndedWithoutDecision &&
      !isExecutedLive &&
      ((!pendingApproval && committedClaimId) ||
        (!pendingApproval && consult?.selectedChoice && !consult?.active) ||
        (!pendingApproval && consult?.end?.outcome === "accepted") ||
        (hasCommitted && consult?.end?.outcome === "accepted"))
  );

  const isHighStakesApproval = Boolean(
    pendingApproval &&
      (pendingApproval.channel === "voice_call" ||
        Number(
          (pendingApproval.args?.row as Record<string, unknown> | undefined)?.amount ??
            pendingApproval.args?.claim_amount ??
            pendingApproval.args?.amount ??
            claimAmount ??
            587.3
        ) >= 100 ||
        Boolean(pendingApproval.risk_reason) ||
        Boolean(pendingApproval.diff_preview) ||
        /1042|d-1042|kappa|atlas|orion|clm/i.test(
          pendingApproval.risk_reason || pendingApproval.diff_preview || pendingApproval.spoken_summary || ""
        ))
  );
  const hasConsultActivity = Boolean(
    consult && (consult.active || consult.ringing || consult.turns.length > 0 || consult.end || consult.selectedChoice)
  );
  const visible = Boolean(pendingApproval || isHighStakesApproval || hasConsultActivity);

  // Live timer for connected call duration (MM:SS)
  useEffect(() => {
    if (isConnected) {
      if (!connectedMomentRef.current) {
        connectedMomentRef.current = extConsult?.connectedAt ?? Date.now();
      }
    } else if (!callLive) {
      connectedMomentRef.current = null;
    }
  }, [isConnected, callLive, extConsult?.connectedAt]);

  useEffect(() => {
    if (!isConnected) return;
    const interval = window.setInterval(() => {
      setTimerTick((t) => t + 1);
    }, 500);
    return () => window.clearInterval(interval);
  }, [isConnected]);

  const callDurationStr = useMemo(() => {
    if (!connectedMomentRef.current) return "00:01";
    const elapsedSec = Math.max(1, Math.floor((Date.now() - connectedMomentRef.current) / 1000));
    const m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const s = String(elapsedSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }, [timerTick]);

  // Central speech text dispatcher with deduplication
  const handleProcessedText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const now = Date.now();
      if (
        trimmed.toLowerCase() === lastProcessedTranscriptRef.current.toLowerCase() &&
        now - lastTranscriptTimeRef.current < 2500
      ) {
        return;
      }
      lastProcessedTranscriptRef.current = trimmed;
      lastTranscriptTimeRef.current = now;

      soundFx.playUiClick();
      if (onDesktopVoiceTurn) {
        await onDesktopVoiceTurn(trimmed);
      }
    },
    [onDesktopVoiceTurn]
  );

  // Send recorded Audio Blob to Backend /api/voice/stt
  const handleUtteranceBlob = useCallback(
    async (blob: Blob, ext: string) => {
      if (blob.size < 400) return;
      setSttSubmitting(true);
      try {
        const formData = new FormData();
        formData.append("audio", blob, `laptop_turn.${ext || "webm"}`);
        const res = await fetch("/api/voice/stt", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          const data = (await res.json()) as { ok?: boolean; text?: string; transcript?: string };
          const sttText = (data.text || data.transcript || "").trim();
          if (sttText) {
            await handleProcessedText(sttText);
          }
        }
      } catch (err) {
        console.warn("STT POST /api/voice/stt error:", err);
      } finally {
        setSttSubmitting(false);
      }
    },
    [handleProcessedText]
  );

  const echoGuardUntilRef = useRef<number>(0);
  useEffect(() => {
    if (speaking) {
      echoGuardUntilRef.current = Date.now() + 8000;
    } else if (echoGuardUntilRef.current > Date.now()) {
      echoGuardUntilRef.current = Date.now() + 650;
    }
  }, [speaking]);

  // Auto-VAD for hands-free utterance capture & barge-in
  const vad = useAutoVad({
    stream: mediaStream,
    enabled: laptopMicOn && !isPhoneTransferred && !consultSessionEnded,
    agentSpeaking: speaking,
    muted: sttSubmitting,
    onBargeIn: () => {
      echoGuardUntilRef.current = 0;
      stopSpeaking();
    },
    onUtterance: (blob, _mimeType, ext) => {
      void handleUtteranceBlob(blob, ext);
    },
  });

  // Web Speech API fallback / instant recognizer (strictly paused while laptop TTS is speaking so speaker audio never echoes back!)
  const speechInput = useSpeechInput((text, final) => {
    if (speakingRef.current || Date.now() < echoGuardUntilRef.current) return;
    if (final && text.trim() && laptopMicOn && !isPhoneTransferred && !consultSessionEnded) {
      void handleProcessedText(text.trim());
    }
  });

  useEffect(() => {
    if (!laptopMicOn || isPhoneTransferred || consultSessionEnded || speaking) {
      if (speechInput.listening) {
        speechInput.stop();
      }
      return;
    }
    const delayMs = Math.max(80, echoGuardUntilRef.current - Date.now());
    const t = window.setTimeout(() => {
      if (laptopMicOn && !isPhoneTransferred && !consultSessionEnded && !speakingRef.current && speechInput.supported && !speechInput.listening) {
        speechInput.start();
      }
    }, delayMs);
    return () => window.clearTimeout(t);
  }, [laptopMicOn, isPhoneTransferred, consultSessionEnded, speaking, speechInput]);

  // Toggle Laptop Mic
  const toggleLaptopMic = async () => {
    soundFx.playUiClick();
    stopSpeaking();

    if (laptopMicOn) {
      stopLaptopMic();
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setMediaStream(stream);
        setLaptopMicOn(true);
      } catch (err) {
        console.warn("Microphone access failed", err);
        setLaptopMicOn(true);
      }
    }
  };

  // Transfer to iPhone Handler
  const handleTransferToPhone = () => {
    soundFx.playUiClick();
    stopLaptopMic();
    stopSpeaking();
    setIsDialing(true);
    if (pendingApproval?.req_id) escalatedReqIdRef.current = pendingApproval.req_id;
    onEscalateToPhone(activeReqId, claimId);
  };

  const sanitizedTurns = useMemo(() => {
    if (!consult?.turns) return [];
    return consult.turns.map((turn, idx) => {
      const activeCallTurn = activeCall?.turns?.[idx];
      const irisIntent =
        turn.irisIntent ??
        turn.iris_intent ??
        activeCallTurn?.irisIntent ??
        activeCallTurn?.iris_intent ??
        null;
      if (turn.speaker === "agent" && !hasCommitted && /saved with one-click undo/i.test(turn.text)) {
        return {
          ...turn,
          text: "No problem—I'll keep everything safely paused until you're back at your desk. Talk soon!",
          irisIntent,
        };
      }
      return {
        ...turn,
        irisIntent,
      };
    });
  }, [consult?.turns, hasCommitted, activeCall?.turns]);

  // Audio-synced progressive word reveal for the newest agent turn
  const lastIdx = sanitizedTurns.length - 1;
  const lastTurn = lastIdx >= 0 ? sanitizedTurns[lastIdx] : null;
  const isLastTurnAgent = Boolean(lastTurn && lastTurn.speaker !== "user");

  const lastTurnWords = useMemo(() => {
    if (!lastTurn || !isLastTurnAgent) return [];
    return lastTurn.text.trim().split(/\s+/).filter(Boolean);
  }, [lastTurn?.text, isLastTurnAgent]);

  const lastTurnSig = useMemo(() => {
    if (!lastTurn || !isLastTurnAgent) return null;
    return `${consult?.callId ?? "call"}:${lastIdx}:${lastTurn.text}`;
  }, [consult?.callId, lastIdx, isLastTurnAgent, lastTurn?.text]);

  const isConsultEndedOrPast = Boolean(
    consult?.end ||
      consult?.callStatus === "ended" ||
      extConsult?.callStatus === "ended" ||
      (!callLive && !consult?.active && !consult?.ringing)
  );

  const completedTurnSigsRef = useRef<Set<string>>(new Set());
  const initialMountCheckRef = useRef<boolean>(true);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const activeSpeakerRef = useRef(consult?.activeSpeaker);
  activeSpeakerRef.current = consult?.activeSpeaker;

  const [revealingSig, setRevealingSig] = useState<string | null>(null);
  const [visibleWordCount, setVisibleWordCount] = useState<number>(Infinity);

  useEffect(() => {
    if (!lastTurnSig || !lastTurn || !isLastTurnAgent) {
      setRevealingSig(null);
      setVisibleWordCount(Infinity);
      return;
    }

    if (isConsultEndedOrPast) {
      completedTurnSigsRef.current.add(lastTurnSig);
      setRevealingSig(null);
      setVisibleWordCount(Infinity);
      return;
    }

    if (completedTurnSigsRef.current.has(lastTurnSig)) {
      setRevealingSig(null);
      setVisibleWordCount(Infinity);
      return;
    }

    if (initialMountCheckRef.current) {
      initialMountCheckRef.current = false;
      if (!speakingRef.current && activeSpeakerRef.current !== "agent") {
        completedTurnSigsRef.current.add(lastTurnSig);
        setRevealingSig(null);
        setVisibleWordCount(Infinity);
        return;
      }
    }

    const totalWords = lastTurnWords.length;
    if (totalWords <= 1) {
      completedTurnSigsRef.current.add(lastTurnSig);
      setRevealingSig(null);
      setVisibleWordCount(Infinity);
      return;
    }

    setRevealingSig(lastTurnSig);
    setVisibleWordCount(0);

    let intervalId: ReturnType<typeof window.setInterval> | null = null;

    const timeoutId = window.setTimeout(() => {
      setVisibleWordCount(1);
      intervalId = window.setInterval(() => {
        setVisibleWordCount((prev) => {
          const next = prev + 1;
          if (next >= totalWords) {
            if (intervalId !== null) window.clearInterval(intervalId);
            completedTurnSigsRef.current.add(lastTurnSig);
            setRevealingSig(null);
            return Infinity;
          }
          return next;
        });
      }, 310);
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [lastTurnSig, lastTurn, isLastTurnAgent, lastTurnWords.length, isConsultEndedOrPast]);

  const turnsCount = sanitizedTurns.length;
  useEffect(() => {
    if (transcriptRef.current && (turnsCount > 0 || visibleWordCount > 0)) {
      transcriptRef.current.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [turnsCount, visibleWordCount, consult?.end]);

  if (!visible) return null;

  const resolvedChoice = inferChoice(consult, committedClaimId);

  const panelTitle = isExecutedLive
    ? isPhoneTransferred
      ? `On Call with You · ${callDurationStr}`
      : "Executed Live · Undo Ready"
    : callEndedWithoutDecision
    ? "Decision Gate · Awaiting PC Decision"
    : isConnected
    ? `On Call with You · ${callDurationStr}`
    : isRinging
    ? "Calling Your iPhone…"
    : consult?.channel === "desktop_voice"
    ? "Live Laptop Voice Consult"
    : laptopMicOn
    ? "Laptop Voice Gate Ready"
    : callCompleted
    ? "Resolution Committed"
    : "Decision Gate";

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Panel
        title={panelTitle}
        icon={
          isExecutedLive ? (
            isPhoneTransferred ? (
              <Smartphone className="text-ok" />
            ) : (
              <CheckCircle2 className="text-ok" />
            )
          ) : callEndedWithoutDecision ? (
            <Smartphone className="text-warn" />
          ) : isConnected ? (
            <Smartphone className="text-ok" />
          ) : isRinging ? (
            <Radio className="animate-pulse text-signal" />
          ) : consult?.channel === "desktop_voice" || laptopMicOn ? (
            <Mic className="text-accent animate-pulse" />
          ) : (
            <PhoneIncoming className="text-signal" />
          )
        }
        meta={
          isExecutedLive ? (
            <Chip tone="ok" className="font-mono text-[10px] font-bold ring-1 ring-ok/60 shadow-[0_0_12px_rgba(16,185,129,0.35)]">
              <Dot tone="ok" live /> {isPhoneTransferred ? "✓ EXECUTED LIVE VIA IPHONE VOICE · UNDO READY" : "✓ EXECUTED LIVE VIA LAPTOP VOICE · UNDO READY"}
            </Chip>
          ) : callEndedWithoutDecision ? (
            <Chip tone="warn" className="font-mono text-[10px]">
              <Dot tone="warn" live /> AWAITING PC DECISION
            </Chip>
          ) : isConnected ? (
            <Chip tone="ok" className="font-mono text-[10px]">
              <Dot tone="ok" live /> LIVE CALL
            </Chip>
          ) : isRinging ? (
            <Chip tone="signal" className="font-mono text-[10px]">
              <Dot tone="signal" live /> RINGING
            </Chip>
          ) : consult?.channel === "desktop_voice" ? (
            <Chip tone="accent" className="font-mono text-[10px]">
              <Dot tone="accent" live /> LIVE LAPTOP VOICE
            </Chip>
          ) : laptopMicOn ? (
            <Chip tone="accent" className="font-mono text-[10px]">
              <Dot tone="accent" live /> LAPTOP MIC ACTIVE
            </Chip>
          ) : callCompleted ? (
            <Chip tone="ok" className="font-mono text-[10px]">
              RESOLVED · UNDO READY
            </Chip>
          ) : (
            <Chip tone="danger" className="font-mono text-[10px]">
              <Dot tone="danger" live /> DECISION GATE
            </Chip>
          )
        }
        actions={
          voiceOn ? (
            <Chip tone="accent" className="font-mono text-[9.5px]">
              Voice Ready
            </Chip>
          ) : null
        }
        pulseTone={
          isExecutedLive
            ? "ok"
            : callCompleted
            ? "ok"
            : callEndedWithoutDecision
            ? "warn"
            : isConnected
            ? "ok"
            : isRinging
            ? "signal"
            : laptopMicOn || consult?.channel === "desktop_voice"
            ? "accent"
            : "danger"
        }
      >
        <div className="space-y-2 p-2.5">
          {/* Oumi Iris System-1 Scorecard */}
          {irisGate && (
            <div className="flex h-6 items-center justify-between rounded border border-emerald-500/30 bg-emerald-950/25 px-2 font-mono text-[10.5px]">
              <div className="flex items-center gap-1.5 truncate">
                <span className="font-bold tracking-tight text-emerald-400">⚡ OUMI IRIS · SYSTEM-1</span>
                <span className="text-ink-3">·</span>
                <span className="text-ink-2">
                  Hold Gate: <span className="font-semibold text-emerald-300">{(irisGate.gate_probability * 100).toFixed(1)}%</span>
                </span>
                <span className="text-ink-3">·</span>
                <span className="text-ink-2">
                  Route: <span className="font-semibold text-ink">{routeLabel}</span>
                </span>
                <span className="text-ink-3">·</span>
                <span className="text-ink-2">
                  Risk: <span className="font-semibold text-amber-400">{irisGate.risk_score.toFixed(1)}/{irisGate.risk_max}</span>
                </span>
              </div>
              <div className="ml-1.5 shrink-0">
                {irisGate.live ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-300 ring-1 ring-emerald-500/40">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    LIVE · 0 OUT-TOK · {irisGate.latency_ms}ms
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-sunken px-1.5 py-0.5 text-[9.5px] font-medium text-ink-3 ring-1 ring-line">
                    FALLBACK · 0 OUT-TOK
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 1. Live Call Banner OR Prominent Laptop Voice & iPhone Transfer Actions */}
          {isExecutedLive ? (
            <div className="space-y-1.5">
              <div className="flex h-7 items-center justify-between rounded-lg border border-ok/70 bg-ok/15 px-2.5 text-[11.5px] shadow-[0_0_12px_rgba(16,185,129,0.25)]">
                <div className="flex min-w-0 items-center gap-1.5 font-bold text-ok">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />
                  <span className="truncate">
                    {isPhoneTransferred ? "✓ EXECUTED LIVE VIA IPHONE VOICE: " : "✓ EXECUTED LIVE VIA LAPTOP VOICE: "}
                    <span className="font-semibold text-ink">
                      {isKappa
                        ? resolvedChoice === "redelivery"
                          ? "22 Replacement Hubs + €202.30 Credit + AADE 9.3"
                          : "€587.30 Refund + AADE 5.1 + Kappa Emailed"
                        : resolvedChoice === "redelivery"
                        ? `Hold / Replacement · ${claimId}`
                        : `Enforce ${formattedClaimAmount || "Claim"} · ${claimId}`}
                    </span>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <VoiceOrb variant="bars" tone="ok" className="h-3 w-8" />
                  <span className="font-mono text-[10px] font-semibold text-ok">{callDurationStr}</span>
                </div>
              </div>

              {!isPhoneTransferred && !consultSessionEnded && (
                <div className="space-y-1.5 rounded-xl border border-emerald-500/35 bg-surface/65 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={toggleLaptopMic}
                      className={cx(
                        "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-all",
                        laptopMicOn
                          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
                          : "border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
                      )}
                    >
                      <Mic className={cx("h-3.5 w-3.5", laptopMicOn && "animate-pulse")} />
                      <span>{laptopMicOn ? "🎙️ Still Listening — Ask Anything or Assign Next Task" : "🎙️ Resume Laptop Voice"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        stopSpeaking();
                        void handleProcessedText("No thanks, that's all");
                      }}
                      className="rounded-lg border border-line bg-sunken px-2 py-1 text-[10px] font-medium text-ink-2 hover:border-ok/50 hover:text-ok"
                    >
                      End Voice Session
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {[
                      "No thanks, that's all",
                      "Yes, audit paid shipments D-1017 & D-1031",
                      "Check delivery D-3005 from Atlas Industrial Supply",
                    ].map((hint) => (
                      <button
                        key={hint}
                        type="button"
                        onClick={() => {
                          stopSpeaking();
                          void handleProcessedText(hint);
                        }}
                        className="rounded-full border border-line/80 bg-sunken/80 px-2 py-0.5 text-[10px] text-ink-2 hover:border-accent/50 hover:bg-accent/10 hover:text-accent transition-colors"
                      >
                        ⚡ {hint}
                      </button>
                    ))}
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!quickAskText.trim()) return;
                      stopSpeaking();
                      void handleProcessedText(quickAskText.trim());
                      setQuickAskText("");
                    }}
                    className="flex items-center gap-1"
                  >
                    <input
                      type="text"
                      value={quickAskText}
                      onChange={(e) => setQuickAskText(e.target.value)}
                      placeholder="Ask follow-up, say 'No thanks', or assign a new supplier audit…"
                      className="h-6 flex-1 rounded border border-line bg-surface/80 px-2 text-[10.5px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!quickAskText.trim()}
                      className={cx(btn("primary", "sm"), "h-6 px-2 text-[10px] font-semibold disabled:opacity-40")}
                    >
                      <span>Send</span>
                      <CornerDownLeft className="h-2.5 w-2.5 opacity-80" />
                    </button>
                  </form>
                </div>
              )}
            </div>
          ) : callEndedWithoutDecision ? (
            <div className="flex h-7 items-center justify-between rounded-lg border border-warn/45 bg-warn/15 px-2.5 text-[11px] text-warn">
              <div className="flex min-w-0 items-center gap-1.5 font-semibold text-warn">
                <Smartphone className="h-3.5 w-3.5 shrink-0 text-warn" />
                <span className="truncate">Paused — Call Ended Without Decision (Choose Below or Call Again)</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={isDialing}
                  onClick={handleTransferToPhone}
                  className={cx(btn("signal", "sm"), "h-5 px-2 text-[10px] font-semibold")}
                >
                  <PhoneCall className="h-2.5 w-2.5" />
                  {isDialing ? "Calling…" : "Call Again"}
                </button>
              </div>
            </div>
          ) : isConnected ? (
            <div className="flex h-7 items-center justify-between rounded-lg border border-ok/40 bg-ok/10 px-2.5 text-[11.5px]">
              <div className="flex items-center gap-1.5 font-medium text-ok">
                <Dot tone="ok" live />
                <span>On Call with You (iPhone) · {callDurationStr}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <VoiceOrb variant="bars" tone="ok" className="h-3 w-10" />
                <span className="font-mono text-[10px] text-ink-3">Auto-VAD</span>
              </div>
            </div>
          ) : isRinging ? (
            <div className="flex h-7 items-center justify-between rounded-lg border border-signal/40 bg-signal/10 px-2.5 text-[11.5px]">
              <div className="flex items-center gap-1.5 font-medium text-signal">
                <Radio className="h-3.5 w-3.5 animate-pulse" />
                <span>Calling Your iPhone…</span>
              </div>
              <span className="font-mono text-[10px] text-ink-3">/mobile</span>
            </div>
          ) : callCompleted ? (
            <div className="flex h-7 items-center justify-between rounded-lg border border-ok/40 bg-ok/10 px-2.5 text-[11.5px]">
              <div className="flex min-w-0 items-center gap-1.5 font-medium text-ok">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Resolution Committed · Claim {claimId}</span>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-ok">
                {isKappa ? (resolvedChoice === "redelivery" ? "AADE 9.3" : "AADE 5.1") : "ERP SYNCED"}
              </span>
            </div>
          ) : (
            /* Prominent Laptop Voice & iPhone Transfer Action Bar on Decision Gate */
            <div className="space-y-1.5 rounded-xl border border-cyan-500/35 bg-gradient-to-r from-cyan-950/40 via-surface/60 to-cyan-950/40 p-2 shadow-[0_0_16px_rgba(6,182,212,0.1)] ring-1 ring-cyan-500/20">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {/* 1. Talk on Laptop Button */}
                <button
                  type="button"
                  onClick={toggleLaptopMic}
                  className={cx(
                    "group flex items-center justify-between rounded-lg border p-2 text-left transition-all",
                    laptopMicOn
                      ? "border-emerald-500/60 bg-emerald-500/15 shadow-[0_0_12px_rgba(16,185,129,0.25)] ring-1 ring-emerald-500/50"
                      : "border-cyan-500/40 bg-cyan-500/10 hover:border-cyan-400 hover:bg-cyan-500/20 hover:shadow-[0_0_12px_rgba(6,182,212,0.2)]"
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={cx(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105",
                        laptopMicOn
                          ? "bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-400/50"
                          : "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-400/40"
                      )}
                    >
                      <Mic className={cx("h-4 w-4", laptopMicOn ? "animate-pulse text-emerald-400" : "text-cyan-300")} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-ink">
                        <span>{laptopMicOn ? "🎙️ Mic Active (Listening)" : "🎙️ Talk on Laptop"}</span>
                        {sttSubmitting && (
                          <span className="font-mono text-[9px] text-amber-300 animate-pulse">
                            (Transcribing…)
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[9px] text-ink-3">
                        {laptopMicOn ? "Hands-free Auto-VAD active" : "Ask or Approve by Voice"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-1.5 flex shrink-0 items-center gap-1">
                    {laptopMicOn ? (
                      <VoiceOrb variant="bars" tone="ok" className="h-3 w-8" />
                    ) : (
                      <span className="rounded bg-cyan-400/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-cyan-300 ring-1 ring-cyan-400/30">
                        Talk
                      </span>
                    )}
                  </div>
                </button>

                {/* 2. Call / Transfer to My iPhone Button */}
                <button
                  type="button"
                  disabled={isDialing}
                  onClick={handleTransferToPhone}
                  className="group flex items-center justify-between rounded-lg border border-purple-500/40 bg-purple-500/10 p-2 text-left transition-all hover:border-purple-400 hover:bg-purple-500/20 hover:shadow-[0_0_12px_rgba(168,85,247,0.2)] disabled:opacity-60"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-purple-500/20 text-purple-300 ring-1 ring-purple-400/40 transition-transform group-hover:scale-105">
                      <Smartphone className="h-4 w-4 text-purple-300" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-purple-200">
                        <span>📲 Transfer to iPhone</span>
                        {isDialing && (
                          <span className="font-mono text-[9px] font-semibold text-purple-300 animate-pulse">
                            (Dialing…)
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[9px] text-purple-300/80">
                        Continue on /mobile with Grok Voice
                      </p>
                    </div>
                  </div>
                  <div className="ml-1.5 flex shrink-0 items-center gap-1 rounded bg-purple-400/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-purple-300 ring-1 ring-purple-400/30">
                    <PhoneCall className="h-2.5 w-2.5" />
                    <span>{isDialing ? "Calling…" : "Call"}</span>
                  </div>
                </button>
              </div>

              {/* Quick-Ask Voice Hint Chips & Compact Quick-Ask Input */}
              <div className="pt-1 border-t border-line/40 space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] font-medium text-ink-3">Try speaking or click to ask:</span>
                  {laptopMicOn && (
                    <button
                      type="button"
                      onClick={() => vad.sendNow()}
                      className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300 hover:bg-emerald-500/30"
                    >
                      <Send className="h-2.5 w-2.5" />
                      Send Utterance
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {(isKappa
                    ? ["Break down the math", "Show invoices table", "Enforce the claim", "Take replacement hubs"]
                    : ["Break down the math", "Show invoices table", "Enforce the claim", "Hold off for now"]
                  ).map((hint) => (
                    <button
                      key={hint}
                      type="button"
                      onClick={() => {
                        stopSpeaking();
                        void handleProcessedText(hint);
                      }}
                      className="rounded-full border border-line/80 bg-sunken/80 px-2 py-0.5 text-[10px] text-ink-2 hover:border-accent/50 hover:bg-accent/10 hover:text-accent transition-colors"
                    >
                      💡 {hint}
                    </button>
                  ))}
                </div>

                {/* Compact text quick-ask input */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!quickAskText.trim()) return;
                    stopSpeaking();
                    void handleProcessedText(quickAskText.trim());
                    setQuickAskText("");
                  }}
                  className="flex items-center gap-1 pt-0.5"
                >
                  <input
                    type="text"
                    value={quickAskText}
                    onChange={(e) => setQuickAskText(e.target.value)}
                    placeholder="Ask Recoup anything or type approval command…"
                    className="h-6 flex-1 rounded border border-line bg-surface/80 px-2 text-[10.5px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!quickAskText.trim()}
                    className={cx(
                      btn("primary", "sm"),
                      "h-6 px-2 text-[10px] font-semibold disabled:opacity-40"
                    )}
                  >
                    <span>Ask</span>
                    <CornerDownLeft className="h-2.5 w-2.5 opacity-80" />
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* 2. Plain-English Scenario Summary (Dynamic: Kappa vs Custom/Atlas/Orion) */}
          {isKappa ? (
            <div className="rounded-lg border border-line bg-sunken/40 px-3 py-1.5 text-[11.5px] leading-snug text-ink">
              <span className="font-semibold text-danger">22 hubs arrived missing/broken</span> &amp; Invoice #7781 is overbilled.{" "}
              <span className="font-semibold text-ok">Kappa owes €587.30.</span>
            </div>
          ) : (
            <div className="rounded-lg border border-line bg-sunken/40 px-3 py-1.5 text-[11.5px] leading-snug text-ink">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10.5px] font-bold text-signal">{claimId}</span>
                {formattedClaimAmount && (
                  <span className="font-mono text-[11px] font-bold text-ok">{formattedClaimAmount}</span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-ink-2">
                {pendingApproval?.risk_reason ||
                  pendingApproval?.spoken_summary ||
                  pendingApproval?.diff_preview ||
                  `High-stakes audit discrepancy detected for claim ${claimId}. Operator verification required.`}
              </p>
            </div>
          )}

          {/* 3. 2 Big Clear Choice Buttons Side-by-Side (whenever unresolved) */}
          {(!callCompleted && !isExecutedLive) && (
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-2">
                {/* Button 1: Refund / Enforce */}
                <button
                  type="button"
                  disabled={callLive && Boolean(consult?.selectedChoice)}
                  onClick={() => {
                    soundFx.playUiClick();
                    onSelectResolution("refund", activeReqId, claimId);
                  }}
                  className={cx(
                    "group flex flex-col items-center justify-center rounded-xl border p-2 text-center transition-all",
                    resolvedChoice === "refund"
                      ? "border-ok bg-ok/15 text-ok ring-2 ring-ok/40"
                      : callEndedWithoutDecision
                      ? "border-ok/80 bg-ok/15 text-ink ring-2 ring-ok/70 shadow-sm animate-pulse hover:border-ok hover:bg-ok/20 hover:animate-none"
                      : "border-ok/45 bg-ok/[0.08] text-ink hover:border-ok hover:bg-ok/15"
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[12px] font-bold text-ok">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>{isKappa ? "Refund €587.30" : formattedClaimAmount ? `Enforce ${formattedClaimAmount}` : "Enforce Claim"}</span>
                  </div>
                  <span className="font-mono text-[9px] text-ink-2">
                    {isKappa ? "Freeze invoice + AADE tax credit" : "Approve recovery & ERP mutation"}
                  </span>
                </button>

                {/* Button 2: Replace / Hold */}
                <button
                  type="button"
                  disabled={callLive && Boolean(consult?.selectedChoice)}
                  onClick={() => {
                    soundFx.playUiClick();
                    onSelectResolution("redelivery", activeReqId, claimId);
                  }}
                  className={cx(
                    "group flex flex-col items-center justify-center rounded-xl border p-2 text-center transition-all",
                    resolvedChoice === "redelivery"
                      ? "border-signal bg-signal/15 text-signal ring-2 ring-signal/40"
                      : callEndedWithoutDecision
                      ? "border-signal/80 bg-signal/15 text-ink ring-2 ring-signal/70 shadow-sm animate-pulse hover:border-signal hover:bg-signal/20 hover:animate-none"
                      : "border-line bg-sunken/60 text-ink hover:border-signal/50 hover:bg-surface"
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[12px] font-bold text-ink">
                    <PackageCheck className="h-3.5 w-3.5 shrink-0 text-signal" />
                    <span>{isKappa ? "Replace 22 Units" : "Hold / Reject Claim"}</span>
                  </div>
                  <span className="font-mono text-[9px] text-ink-2">
                    {isKappa ? "Free delivery tomorrow + €202.30" : "Pause execution for operator audit"}
                  </span>
                </button>
              </div>

              {pendingApproval && onReject && (
                <div className="flex justify-end pt-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      soundFx.playUiClick();
                      onReject(pendingApproval.req_id);
                    }}
                    className="inline-flex items-center gap-1 font-mono text-[10.5px] text-danger/80 hover:text-danger hover:underline"
                  >
                    <XCircle className="h-3 w-3" />
                    Reject &amp; Roll Back
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 4. Compact Live Phone / Laptop Chat (max-h-[120px] overflow-y-auto scroll-thin) */}
          {consult && (consult.active || consult.ringing || sanitizedTurns.length > 0 || consult.end || laptopMicOn) && (
            <div
              ref={transcriptRef}
              className="scroll-thin max-h-[120px] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-sunken/40 p-2"
              aria-live="polite"
            >
              {sanitizedTurns.length === 0 && (
                <div className="flex items-center justify-center gap-1.5 py-2 font-mono text-[11px] text-ink-2">
                  <Dot tone={isPhoneTransferred ? "signal" : "accent"} live />
                  <span>
                    {isPhoneTransferred
                      ? "Ringing your iPhone… Hands-free Grok Voice ready"
                      : "Laptop Voice ready — ask a question or approve/reject by voice"}
                  </span>
                </div>
              )}

              <AnimatePresence initial={false}>
                {sanitizedTurns.map((turn, idx) => {
                  const isUser = turn.speaker === "user";
                  const isLatest = idx === sanitizedTurns.length - 1;
                  const isActiveAgentTurn =
                    !isUser &&
                    (consult.activeSpeaker === "agent" || speaking) &&
                    isLatest;

                  const isRevealing =
                    !isUser &&
                    isLatest &&
                    revealingSig === lastTurnSig &&
                    visibleWordCount < lastTurnWords.length;
                  return (
                    <motion.div
                      key={`${consult.callId}-turn-${idx}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18 }}
                      className={cx("flex flex-col", isUser ? "items-end" : "items-start")}
                    >
                      <div
                        className={cx(
                          "max-w-[88%] rounded-xl px-2.5 py-1 text-[11.5px] leading-relaxed transition-colors",
                          isUser
                            ? "rounded-tr-xs border border-signal/30 bg-signal/[0.12] text-ink"
                            : "rounded-tl-xs border border-ok/25 bg-ok/[0.08] text-ink",
                          isActiveAgentTurn && "ring-1 ring-ok/40"
                        )}
                      >
                        <div className="mb-0.5 flex items-center justify-between gap-1.5 text-[9.5px] font-semibold">
                          <span className={isUser ? "text-signal" : "text-ok"}>
                            {isUser ? (isPhoneTransferred ? "You (iPhone)" : "You (Laptop)") : brandName}
                          </span>
                          {!isUser && onReplayTurn && (
                            <button
                              type="button"
                              onClick={() => {
                                soundFx.playUiClick();
                                onReplayTurn(turn.text);
                              }}
                              title="Replay Voice turn"
                              aria-label="Replay Voice turn"
                              className="rounded p-0.5 text-ink-3 hover:bg-sunken hover:text-ink"
                            >
                              <Volume2 className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </div>
                        {isRevealing ? (
                          <p className="text-ink-2">
                            {visibleWordCount === 0 ? (
                              <span className="text-ink-3 italic">…</span>
                            ) : (
                              <span>{lastTurnWords.slice(0, visibleWordCount).join(" ")}</span>
                            )}
                            <span
                              className="ml-1 inline-flex items-center gap-1 font-mono text-[11px] text-emerald-400 select-none"
                              aria-hidden="true"
                            >
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                              <span className="animate-pulse text-cyan-400">▋</span>
                            </span>
                          </p>
                        ) : (
                          <p className="text-ink-2">{turn.text}</p>
                        )}
                        {isUser && turn.irisIntent && (
                          <div className="mt-1 flex items-center gap-1 font-mono text-[9px] text-emerald-400">
                            <span>⚡ Iris → {turn.irisIntent.intent} ({Math.round(turn.irisIntent.confidence * 100)}%) · 0 out-tok</span>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>
      </Panel>
    </motion.div>
  );
}
