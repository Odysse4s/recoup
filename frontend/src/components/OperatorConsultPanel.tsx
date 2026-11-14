import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  Hand,
  MonitorCheck,
  PackageCheck,
  PhoneForwarded,
  PhoneIncoming,
  Radio,
  Smartphone,
  Volume2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalNeededPayload } from "../contracts";
import { soundFx } from "../lib/sound";
import type { OperatorChoice, OperatorConsultState } from "../lib/types";
import { btn, Chip, cx, Dot, Panel } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

export type { OperatorChoice, OperatorConsultState, OperatorConsultTurn } from "../lib/types";

interface ExtendedConsultState extends OperatorConsultState {
  callStatus?: "ringing" | "connected" | "ended";
  connectedAt?: number | null;
  lastUiAction?: { action: string; label: string; ts: number } | null;
}

const COUNTDOWN_TOTAL_MS = 3000;

export interface OperatorConsultPanelProps {
  brandName?: string;
  consult: OperatorConsultState | null;
  pendingApproval: ApprovalNeededPayload | null;
  committedClaimId?: string | null;
  voiceOn: boolean;
  speaking: boolean;
  onEscalateToPhone: (reqId?: string | null, claimId?: string) => void;
  onSelectResolution: (choice: OperatorChoice, reqId?: string | null, claimId?: string) => void;
  onReject?: (reqId: string) => void;
  onReplayTurn?: (text: string) => void;
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
  onEscalateToPhone,
  onSelectResolution,
  onReject,
  onReplayTurn,
}: OperatorConsultPanelProps) {
  const extConsult = consult as ExtendedConsultState | null;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const escalatedReqIdRef = useRef<string | null>(null);
  const connectedMomentRef = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [stayAtDesk, setStayAtDesk] = useState(false);
  const [remainingMs, setRemainingMs] = useState(COUNTDOWN_TOTAL_MS);
  const [timerTick, setTimerTick] = useState(0);

  const claimId = useMemo(() => {
    if (consult?.claimId) return consult.claimId;
    if (committedClaimId) return committedClaimId;
    const argRow = pendingApproval?.args?.row as Record<string, unknown> | undefined;
    const rawId = pendingApproval?.args?.claim_id ?? argRow?.id;
    return typeof rawId === "string" && rawId.trim() ? rawId : "CLM-D-1042";
  }, [committedClaimId, consult?.claimId, pendingApproval]);

  const activeReqId = pendingApproval?.req_id ?? consult?.reqId ?? null;

  // Determine Call Status states
  const isRinging = Boolean(
    consult?.ringing &&
      extConsult?.callStatus !== "connected" &&
      consult.turns.length <= 1
  );

  const isConnected = Boolean(
    consult &&
      (extConsult?.callStatus === "connected" ||
        consult.turns.some((t) => t.speaker === "user") ||
        (!consult.ringing && consult.active))
  );

  const callLive = isRinging || isConnected;
  const callCompleted = Boolean(consult?.end || (!pendingApproval && committedClaimId));

  const isHighStakesApproval = Boolean(
    pendingApproval &&
      (pendingApproval.channel === "voice_call" ||
        Number((pendingApproval.args?.row as Record<string, unknown> | undefined)?.amount ?? pendingApproval.args?.claim_amount ?? 587.3) >= 250 ||
        /1042|d-1042|kappa/i.test(pendingApproval.risk_reason || pendingApproval.diff_preview || pendingApproval.spoken_summary || ""))
  );
  const hasConsultActivity = Boolean(
    consult && (consult.active || consult.ringing || consult.turns.length > 0 || consult.end || consult.selectedChoice)
  );
  const visible = Boolean(isHighStakesApproval || hasConsultActivity);

  const countdownActive = Boolean(
    pendingApproval &&
      !callLive &&
      !consult?.end &&
      !consult?.selectedChoice
  );
  const countdownPaused = hovered || stayAtDesk;
  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));

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

  // Reset 3-second countdown whenever a fresh approval request arrives
  useEffect(() => {
    if (!pendingApproval?.req_id) return;
    setRemainingMs(COUNTDOWN_TOTAL_MS);
    setStayAtDesk(false);
  }, [pendingApproval?.req_id]);

  // Tick countdown when operator hasn't hovered or locked desktop mode
  useEffect(() => {
    if (!countdownActive || countdownPaused || !pendingApproval) return;
    const reqId = pendingApproval.req_id;
    if (escalatedReqIdRef.current === reqId) return;

    const timer = window.setInterval(() => {
      setRemainingMs((prev) => Math.max(0, prev - 100));
    }, 100);
    return () => window.clearInterval(timer);
  }, [countdownActive, countdownPaused, pendingApproval]);

  // Fire phone escalation once when countdown hits 0s
  useEffect(() => {
    if (!countdownActive || countdownPaused || !pendingApproval) return;
    if (remainingMs > 0) return;
    const reqId = pendingApproval.req_id;
    if (escalatedReqIdRef.current === reqId) return;
    escalatedReqIdRef.current = reqId;
    onEscalateToPhone(reqId, claimId);
  }, [claimId, countdownActive, countdownPaused, onEscalateToPhone, pendingApproval, remainingMs]);

  const turnsCount = consult?.turns.length ?? 0;
  useEffect(() => {
    if (transcriptRef.current && turnsCount > 0) {
      transcriptRef.current.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [turnsCount, consult?.end]);

  if (!visible) return null;

  const resolvedChoice = inferChoice(consult, committedClaimId);

  const panelTitle = isConnected
    ? `On Call with You · ${callDurationStr}`
    : isRinging
    ? "Calling Your iPhone…"
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
        icon={isConnected ? <Smartphone className="text-ok" /> : isRinging ? <Radio className="animate-pulse text-signal" /> : <PhoneIncoming className="text-signal" />}
        meta={
          isConnected ? (
            <Chip tone="ok" className="font-mono text-[10px]">
              <Dot tone="ok" live /> LIVE CALL
            </Chip>
          ) : isRinging ? (
            <Chip tone="signal" className="font-mono text-[10px]">
              <Dot tone="signal" live /> RINGING
            </Chip>
          ) : callCompleted ? (
            <Chip tone="ok" className="font-mono text-[10px]">
              RESOLVED
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
        pulseTone={callCompleted ? "ok" : isConnected ? "ok" : isRinging ? "signal" : "danger"}
      >
        <div className="space-y-2 p-2.5">
          {/* 1. 1-Line Live Call Banner */}
          {isConnected ? (
            <div className="flex h-7 items-center justify-between rounded-lg border border-ok/40 bg-ok/10 px-2.5 text-[11.5px]">
              <div className="flex items-center gap-1.5 font-medium text-ok">
                <Dot tone="ok" live />
                <span>On Call with You · {callDurationStr}</span>
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
                {resolvedChoice === "redelivery" ? "AADE 9.3" : "AADE 5.1"}
              </span>
            </div>
          ) : (
            <div className="flex h-7 items-center justify-between rounded-lg border border-warn/35 bg-warn/[0.08] px-2.5 text-[11.5px]">
              <div className="flex min-w-0 items-center gap-1.5 font-medium text-ink">
                <Smartphone className="h-3.5 w-3.5 shrink-0 text-signal" />
                <span className="truncate">
                  {countdownActive && !countdownPaused
                    ? `Calling Your iPhone in ${secondsLeft}s…`
                    : "Ready to Call Your iPhone"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    soundFx.playUiClick();
                    setStayAtDesk((v) => !v);
                  }}
                  className={cx(btn(stayAtDesk ? "ok" : "outline", "sm"), "h-5 px-1.5 text-[10px]")}
                >
                  {stayAtDesk ? <MonitorCheck className="h-2.5 w-2.5" /> : <Hand className="h-2.5 w-2.5" />}
                  {stayAtDesk ? "At Desk" : "Stay"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    soundFx.playUiClick();
                    if (pendingApproval?.req_id) escalatedReqIdRef.current = pendingApproval.req_id;
                    onEscalateToPhone(activeReqId, claimId);
                  }}
                  className={cx(btn("signal", "sm"), "h-5 px-2 text-[10px] font-semibold")}
                >
                  <PhoneForwarded className="h-2.5 w-2.5" />
                  Call Now
                </button>
              </div>
            </div>
          )}

          {/* 2. Plain-English 2-Line Summary */}
          <div className="rounded-lg border border-line bg-sunken/40 px-3 py-1.5 text-[11.5px] leading-snug text-ink">
            <span className="font-semibold text-danger">22 hubs arrived missing/broken</span> &amp; Invoice #7781 is overbilled.{" "}
            <span className="font-semibold text-ok">Kappa owes €587.30.</span>
          </div>

          {/* 3. 2 Big Clear Choice Buttons Side-by-Side (whenever unresolved) */}
          {(!callCompleted || pendingApproval) && (
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-2">
                {/* Button 1: ✅ Refund €587.30 */}
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
                      : "border-ok/45 bg-ok/[0.08] text-ink hover:border-ok hover:bg-ok/15"
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-ok">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>Refund €587.30</span>
                  </div>
                  <span className="font-mono text-[9.5px] text-ink-2">Freeze invoice + AADE tax credit</span>
                </button>

                {/* Button 2: 📦 Replace 22 Units */}
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
                      : "border-line bg-sunken/60 text-ink hover:border-signal/50 hover:bg-surface"
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink">
                    <PackageCheck className="h-3.5 w-3.5 shrink-0 text-signal" />
                    <span>Replace 22 Units</span>
                  </div>
                  <span className="font-mono text-[9.5px] text-ink-2">Free delivery tomorrow + €202.30</span>
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

          {/* 4. Compact Live Phone Chat (max-h-[120px] overflow-y-auto scroll-thin) */}
          {consult && (consult.active || consult.ringing || consult.turns.length > 0 || consult.end) && (
            <div
              ref={transcriptRef}
              className="scroll-thin max-h-[120px] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-sunken/40 p-2"
              aria-live="polite"
            >
              {consult.turns.length === 0 && (consult.ringing || consult.active) && (
                <div className="flex items-center justify-center gap-1.5 py-2 font-mono text-[11px] text-ink-2">
                  <Dot tone="signal" live />
                  <span>Ringing your iPhone… Hands-free Grok Voice ready</span>
                </div>
              )}

              <AnimatePresence initial={false}>
                {consult.turns.map((turn, idx) => {
                  const isUser = turn.speaker === "user";
                  const isActiveAgentTurn =
                    !isUser &&
                    (consult.activeSpeaker === "agent" || speaking) &&
                    idx === consult.turns.length - 1;
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
                            {isUser ? "You" : brandName}
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
                        <p className="text-ink-2">{turn.text}</p>
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
