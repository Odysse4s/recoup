import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  FileCheck2,
  Hand,
  MonitorCheck,
  PackageCheck,
  PhoneForwarded,
  PhoneIncoming,
  ShieldCheck,
  Smartphone,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalNeededPayload } from "../contracts";
import { soundFx } from "../lib/sound";
import type { OperatorChoice, OperatorConsultState } from "../lib/types";
import { btn, Chip, cx, Dot, Panel } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

export type { OperatorChoice, OperatorConsultState, OperatorConsultTurn } from "../lib/types";

const COUNTDOWN_TOTAL_MS = 8000;

export interface OperatorConsultPanelProps {
  brandName?: string;
  consult: OperatorConsultState | null;
  pendingApproval: ApprovalNeededPayload | null;
  committedClaimId?: string | null;
  voiceOn: boolean;
  speaking: boolean;
  onEscalateToPhone: (reqId?: string | null, claimId?: string) => void;
  onSelectResolution: (choice: OperatorChoice, reqId?: string | null, claimId?: string) => void;
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
  onReplayTurn,
}: OperatorConsultPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const escalatedReqIdRef = useRef<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [stayAtDesk, setStayAtDesk] = useState(false);
  const [remainingMs, setRemainingMs] = useState(COUNTDOWN_TOTAL_MS);

  const claimId = useMemo(() => {
    if (consult?.claimId) return consult.claimId;
    if (committedClaimId) return committedClaimId;
    const argRow = pendingApproval?.args?.row as Record<string, unknown> | undefined;
    const rawId = pendingApproval?.args?.claim_id ?? argRow?.id;
    return typeof rawId === "string" && rawId.trim() ? rawId : "CLM-D-1042";
  }, [committedClaimId, consult?.claimId, pendingApproval]);

  const activeReqId = pendingApproval?.req_id ?? consult?.reqId ?? null;
  const hasConsultActivity = Boolean(
    consult && (consult.active || consult.ringing || consult.turns.length > 0 || consult.end || consult.selectedChoice)
  );
  const visible = Boolean(pendingApproval || hasConsultActivity || committedClaimId);

  const countdownActive = Boolean(
    pendingApproval &&
      !consult?.active &&
      !consult?.ringing &&
      !consult?.end &&
      !consult?.selectedChoice
  );
  const countdownPaused = hovered || stayAtDesk;
  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));

  // Reset 8-second countdown whenever a fresh approval request arrives
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
      setRemainingMs((prev) => {
        const next = Math.max(0, prev - 100);
        return next;
      });
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
  const callLive = Boolean(consult?.active || consult?.ringing);
  const callCompleted = Boolean(consult?.end || (!pendingApproval && committedClaimId));

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28 }}
      className="shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Panel
        title="Shipment D-1042 Resolution & Operator Escalation"
        icon={<PhoneIncoming />}
        meta={
          callLive ? (
            <Chip tone="signal">
              <Dot tone="signal" live /> live mobile call
            </Chip>
          ) : callCompleted ? (
            <Chip tone="ok">
              {resolvedChoice === "redelivery" ? "AADE 9.3 staged" : "AADE 5.1 staged"} · {claimId}
            </Chip>
          ) : (
            <Chip tone="danger">
              <Dot tone="danger" live /> decision gate · {claimId}
            </Chip>
          )
        }
        actions={
          <div className="flex items-center gap-1.5">
            <Chip tone={voiceOn ? "accent" : "neutral"} className="hidden sm:inline-flex">
              <Volume2 className="h-2.5 w-2.5" />
              fal.ai Voice
            </Chip>
            {(pendingApproval || !callLive) && !callCompleted && (
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  if (pendingApproval?.req_id) {
                    escalatedReqIdRef.current = pendingApproval.req_id;
                  }
                  onEscalateToPhone(activeReqId, claimId);
                }}
                className={cx(btn("signal", "sm"), "h-7 px-2.5")}
              >
                <PhoneForwarded className="h-3.5 w-3.5" />
                Step Away · Ring Phone Now
              </button>
            )}
          </div>
        }
        pulseTone={callCompleted ? "ok" : callLive ? "signal" : "danger"}
      >
        <div className="space-y-3 p-3.5">
          {/* 8-Second Desktop Presence Countdown Banner */}
          <AnimatePresence initial={false}>
            {countdownActive && (
              <motion.div
                key="presence-countdown"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden rounded-xl border border-warn/40 bg-warn/[0.07] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Chip tone={countdownPaused ? "ok" : "warn"}>
                      <Dot tone={countdownPaused ? "ok" : "warn"} live={!countdownPaused} />
                      {countdownPaused ? "Desktop Active" : "Auto-Escalate"}
                    </Chip>
                    <span className="text-[12px] font-semibold text-ink">
                      {countdownPaused
                        ? `Desktop presence confirmed — auto-call paused (${secondsLeft}s remaining)`
                        : `Operator at desk? Auto-calling mobile phone in ${secondsLeft}s…`}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      aria-pressed={stayAtDesk}
                      onClick={() => {
                        soundFx.playUiClick();
                        setStayAtDesk((v) => !v);
                      }}
                      className={cx(
                        btn(stayAtDesk ? "ok" : "outline", "sm"),
                        "h-7 px-2.5 text-[11.5px]"
                      )}
                    >
                      {stayAtDesk ? <MonitorCheck className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
                      I&apos;m Here · Decide on Desktop
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playUiClick();
                        if (pendingApproval?.req_id) {
                          escalatedReqIdRef.current = pendingApproval.req_id;
                        }
                        onEscalateToPhone(activeReqId, claimId);
                      }}
                      className={cx(btn("signal", "sm"), "h-7 px-2.5 text-[11.5px]")}
                    >
                      <Smartphone className="h-3.5 w-3.5" />
                      Step Away · Ring Phone Now
                    </button>
                  </div>
                </div>

                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                  <div
                    className={cx(
                      "h-full rounded-full transition-[width] duration-100",
                      countdownPaused ? "bg-ok" : "bg-warn"
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, (remainingMs / COUNTDOWN_TOTAL_MS) * 100))}%` }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Clean Resolution Comparison Cards */}
          <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
            {/* Option A: 22-Unit Re-Delivery */}
            <button
              type="button"
              disabled={callLive && Boolean(consult?.selectedChoice)}
              onClick={() => {
                soundFx.playUiClick();
                onSelectResolution("redelivery", activeReqId, claimId);
              }}
              className={cx(
                "group flex flex-col justify-between rounded-xl border p-3 text-left transition-all",
                resolvedChoice === "redelivery"
                  ? "border-signal bg-signal/10 ring-2 ring-signal/25"
                  : "border-line bg-sunken/60 hover:border-signal/50 hover:bg-surface"
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                    Option A · Physical Replacement
                  </span>
                  <Chip tone={resolvedChoice === "redelivery" ? "signal" : "neutral"}>
                    {resolvedChoice === "redelivery" ? "Selected" : "AADE 9.3"}
                  </Chip>
                </div>
                <div className="mt-1.5 flex items-start gap-2">
                  <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
                  <div className="text-[12.5px] font-semibold leading-snug text-ink">
                    Accept 22-Unit Re-Delivery (€202.30 SLA/Price Credit)
                  </div>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">
                  Next-day replacement of 22 missing/damaged USB-C hubs + AADE <code className="font-mono text-[11px]">myDATA</code> Type{" "}
                  <code className="font-mono text-[11px]">9.3</code> discrepancy note for unit-price &amp; SLA variance.
                </p>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-line/70 pt-2 font-mono text-[10.5px] text-ink-3">
                <span>22 hubs restocked + €202.30 credit</span>
                <span className="font-semibold text-signal group-hover:underline">
                  {resolvedChoice === "redelivery" ? "Committed" : "Choose Option A →"}
                </span>
              </div>
            </button>

            {/* Option B: Enforce €587.30 Refund + Stage AADE myDATA 5.1 Credit Note (Recommended / Emerald highlight) */}
            <button
              type="button"
              disabled={callLive && Boolean(consult?.selectedChoice)}
              onClick={() => {
                soundFx.playUiClick();
                onSelectResolution("refund", activeReqId, claimId);
              }}
              className={cx(
                "group flex flex-col justify-between rounded-xl border p-3 text-left transition-all",
                resolvedChoice === "refund"
                  ? "border-ok bg-ok/12 ring-2 ring-ok/30"
                  : "border-ok/45 bg-ok/[0.06] hover:border-ok hover:bg-ok/10"
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ok">
                    Option B · Full Financial Recovery
                  </span>
                  <Chip tone="ok" solid={resolvedChoice === "refund"}>
                    {resolvedChoice === "refund" ? "Selected · AADE 5.1" : "Recommended · AADE 5.1"}
                  </Chip>
                </div>
                <div className="mt-1.5 flex items-start gap-2">
                  <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                  <div className="text-[12.5px] font-semibold leading-snug text-ink">
                    Enforce €587.30 Refund + Stage AADE myDATA 5.1 Credit Note
                  </div>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">
                  Full AP hold on <code className="font-mono text-[11px]">INV-7781</code> + Greek AADE{" "}
                  <code className="font-mono text-[11px]">myDATA</code> Type <code className="font-mono text-[11px]">5.1</code> credit note (€587.30 net + €140.95 24% VAT = €728.25 gross).
                </p>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-ok/25 pt-2 font-mono text-[10.5px]">
                <span className="font-semibold text-ok">€587.30 net · €728.25 gross</span>
                <span className="font-semibold text-ok group-hover:underline">
                  {resolvedChoice === "refund" ? "Committed" : "Enforce Option B →"}
                </span>
              </div>
            </button>
          </div>

          {/* Live Two-Way Escalation Transcript (Recoup AI <-> You (Mobile)) */}
          {consult && (consult.active || consult.ringing || consult.turns.length > 0 || consult.end) && (
            <div className="space-y-2.5 rounded-xl border border-line bg-sunken/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                      consult.activeSpeaker === "agent" || speaking
                        ? "border-ok/50 bg-ok/15 text-ok"
                        : "border-ok/25 bg-ok/8 text-ink"
                    )}
                  >
                    <ShieldCheck className="h-3 w-3 text-ok" />
                    {brandName} AI
                  </span>
                  <Chip tone="accent" className="h-4 px-1.5 text-[9.5px]">
                    fal.ai Voice
                  </Chip>
                  <span className="font-mono text-[10px] text-ink-3">↔</span>
                  <span
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                      consult.activeSpeaker === "user"
                        ? "border-signal/50 bg-signal/15 text-signal"
                        : "border-line bg-surface text-ink-2"
                    )}
                  >
                    <Smartphone className="h-3 w-3 text-signal" />
                    You (Mobile)
                  </span>
                </div>

                {speaking || consult.activeSpeaker ? (
                  <VoiceOrb
                    variant="bars"
                    tone={consult.activeSpeaker === "user" ? "signal" : "ok"}
                    className="h-4 w-16 shrink-0"
                  />
                ) : (
                  <span className="font-mono text-[10.5px] text-ink-3 tabular">
                    {claimId} · €{(consult.claimAmount || 587.3).toFixed(2)}
                  </span>
                )}
              </div>

              <div
                ref={transcriptRef}
                className="scroll-thin max-h-[220px] space-y-2 overflow-y-auto pr-0.5"
                aria-live="polite"
              >
                {consult.turns.length === 0 && (consult.ringing || consult.active) && (
                  <div className="flex items-center justify-center gap-2 py-3 font-mono text-[11.5px] text-ink-2">
                    <Dot tone="signal" live />
                    Ringing operator mobile (/mobile) · awaiting spoken decision…
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
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22 }}
                        className={cx("flex flex-col", isUser ? "items-end" : "items-start")}
                      >
                        <div
                          className={cx(
                            "w-[92%] rounded-xl border px-3 py-2 text-[12px] leading-relaxed transition-colors",
                            isUser
                              ? "border-signal/35 bg-signal/[0.08] text-ink"
                              : "border-ok/30 bg-ok/[0.06] text-ink",
                            isActiveAgentTurn && "ring-2 ring-ok/30"
                          )}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold">
                              <span className={isUser ? "text-signal" : "text-ok"}>
                                {isUser ? "You (Mobile)" : `${brandName} AI`}
                              </span>
                              <Chip
                                tone={isUser ? "signal" : "accent"}
                                className="h-4 px-1.5 text-[9px]"
                              >
                                {isUser ? "Wizper STT" : "fal.ai Voice"}
                              </Chip>
                              {isActiveAgentTurn && (
                                <VoiceOrb variant="bars" tone="ok" className="h-3.5 w-10" />
                              )}
                            </div>
                            {!isUser && onReplayTurn && (
                              <button
                                type="button"
                                onClick={() => {
                                  soundFx.playUiClick();
                                  onReplayTurn(turn.text);
                                }}
                                title="Replay fal.ai Voice turn"
                                aria-label="Replay fal.ai Voice turn"
                                className="rounded p-0.5 text-ink-3 hover:bg-sunken hover:text-ink"
                              >
                                <Volume2 className="h-3 w-3" />
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
            </div>
          )}

          {/* Resolution Summary Banner */}
          {(consult?.end || (!pendingApproval && committedClaimId)) && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-start gap-2.5 rounded-xl border border-ok/40 bg-ok/10 px-3.5 py-2.5 text-[12px] text-ink"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                  <span>
                    {resolvedChoice === "redelivery"
                      ? "22-Unit Re-Delivery + AADE 9.3 Staged"
                      : "AADE myDATA 5.1 Credit Note Staged"}
                  </span>
                  <span className="font-mono text-[10px] text-ok">
                    {claimId} · reversible receipt ready
                  </span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-ink-2">
                  {consult?.end?.summary ??
                    `Full AP hold placed on INV-7781 and Greek AADE myDATA Type 5.1 credit note (€587.30 net / €728.25 gross) staged for ${claimId}.`}
                </p>
              </div>
            </motion.div>
          )}
        </div>
      </Panel>
    </motion.div>
  );
}
