import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  FileCheck2,
  Hand,
  MonitorCheck,
  PackageCheck,
  PhoneForwarded,
  PhoneIncoming,
  Radio,
  ShieldCheck,
  Smartphone,
  Volume2,
  Zap,
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
    ? `Live Grok Voice Call Connected · ${callDurationStr}`
    : isRinging
    ? "Ringing Operator's iPhone · Live Call Active"
    : pendingApproval
    ? "Shipment D-1042 Decision Gate — Live ERP & Supplier Email Held"
    : "Shipment D-1042 Resolution Committed";

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
        title={panelTitle}
        icon={isConnected ? <Smartphone className="text-ok" /> : isRinging ? <PhoneIncoming className="text-signal" /> : <PhoneIncoming />}
        meta={
          isConnected ? (
            <Chip tone="ok" className="font-mono text-[10.5px]">
              <Dot tone="ok" live /> LIVE CALL · {callDurationStr}
            </Chip>
          ) : isRinging ? (
            <Chip tone="signal" className="font-mono text-[10.5px]">
              <Dot tone="signal" live /> RINGING iPHONE
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
              Grok Voice · fal.ai
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
                className={cx(btn("signal", "sm"), "h-7 px-2.5 font-semibold shadow-sm")}
              >
                <PhoneForwarded className="h-3.5 w-3.5" />
                Call My iPhone Now
              </button>
            )}
          </div>
        }
        pulseTone={callCompleted ? "ok" : isConnected ? "ok" : isRinging ? "signal" : "danger"}
      >
        <div className="space-y-3 p-3.5">
          {/* STATE A: Ringing iPhone Dramatic Hero Banner */}
          <AnimatePresence initial={false}>
            {isRinging && (
              <motion.div
                key="banner-ringing"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, height: 0 }}
                className="relative overflow-hidden rounded-xl border border-signal/50 bg-gradient-to-r from-signal/15 via-warn/15 to-signal/15 p-3.5 shadow-md"
              >
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-signal text-white">
                      <span className="absolute inset-0 animate-ping rounded-lg bg-signal/60" />
                      <Radio className="relative h-4 w-4" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2 font-mono text-[13px] font-bold tracking-wide text-ink">
                        RINGING OPERATOR&apos;S iPHONE…
                        <Dot tone="signal" live />
                      </div>
                      <div className="text-[12px] font-medium text-ink-2">
                        Tap <strong className="font-semibold text-signal">Accept Call</strong> on iPhone for hands-free Grok Voice
                      </div>
                    </div>
                  </div>
                  <Chip tone="signal" className="font-mono text-[10.5px]">
                    Hands-Free Grok Voice Ready · /mobile
                  </Chip>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* STATE B: Connected iPhone Live Call Monitor Hero Banner */}
          <AnimatePresence initial={false}>
            {isConnected && (
              <motion.div
                key="banner-connected"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, height: 0 }}
                className="relative overflow-hidden rounded-xl border border-ok/50 bg-gradient-to-r from-ok/15 via-emerald-500/10 to-ok/15 p-3.5 shadow-md ring-1 ring-ok/30"
              >
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ok text-white">
                      <span className="absolute inset-0 animate-ping rounded-lg bg-ok/40" />
                      <Smartphone className="relative h-4 w-4" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2 font-mono text-[13px] font-bold tracking-wide text-ok">
                        LIVE GROK VOICE CALL CONNECTED · {callDurationStr}
                        <Dot tone="ok" live />
                      </div>
                      <div className="text-[12px] font-medium text-ink-2">
                        Two-way hands-free audio streaming · Desktop synchronized live
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <VoiceOrb variant="bars" tone="ok" className="h-4 w-16" />
                    <Chip tone="ok" className="font-mono text-[10px] font-semibold">
                      Hands-Free Auto-VAD
                    </Chip>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bright Live Voice-Triggered Desktop Action Pill */}
          <AnimatePresence initial={false}>
            {extConsult?.lastUiAction && (
              <motion.div
                key={`${extConsult.lastUiAction.action}-${extConsult.lastUiAction.ts}`}
                initial={{ opacity: 0, scale: 0.98, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-2.5 rounded-xl border border-signal/50 bg-signal/[0.12] px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-sm"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-signal text-white">
                  <Zap className="h-3 w-3" />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  ⚡ Live Voice Action: <span className="font-bold text-signal">{extConsult.lastUiAction.label}</span>
                </span>
                <Chip tone="signal" className="shrink-0 font-mono text-[10px]">
                  Desktop Synced
                </Chip>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 3-Second Desktop Presence Countdown Banner */}
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
                        : `Operator away from desk? Calling iPhone in ${secondsLeft}…`}
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
                      I&apos;m at My Desk · Decide Here
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
                      className={cx(btn("signal", "sm"), "h-7 px-2.5 text-[11.5px] font-semibold shadow-sm")}
                    >
                      <Smartphone className="h-3.5 w-3.5" />
                      Call My iPhone Now
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

          {/* 3-Bullet Plain-English Executive Summary */}
          <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              <span>Executive Decision Brief</span>
              <span className="font-mono text-[10px] text-ink-3">{claimId}</span>
            </div>
            <div className="grid grid-cols-1 gap-2 text-[12px] leading-snug">
              <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.04] p-2 text-ink">
                <span className="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase text-danger">
                  1. Problem Found
                </span>
                <span className="min-w-0 flex-1 font-medium">
                  Ordered 120 hubs → 22 arrived missing/broken + invoice overcharged = <span className="font-semibold text-danger">€587.30 owed back</span>
                </span>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/[0.04] p-2 text-ink">
                <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase text-warn">
                  2. Staged in Safe Clone
                </span>
                <span className="min-w-0 flex-1 font-medium">
                  Invoice INV-7781 frozen · Greek AADE myDATA €587.30 tax credit ready · Supplier email drafted
                </span>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-ok/25 bg-ok/[0.04] p-2 text-ink">
                <span className="shrink-0 rounded bg-ok/15 px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase text-ok">
                  3. Your Decision
                </span>
                <span className="min-w-0 flex-1 font-medium">
                  <strong className="font-semibold text-ok">Enforce €587.30 Refund + AADE Tax Credit</strong> OR <strong className="font-semibold text-signal">Accept Free Replacement Delivery (22 Units Tomorrow)</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Clean Resolution Comparison Cards */}
          <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
            {/* Option A: Free Replacement Delivery (22 Units Tomorrow) */}
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
                  <div className="text-[13.5px] font-semibold leading-snug text-ink">
                    Accept Free Replacement Delivery (<span className="text-signal">22 Units Tomorrow</span>)
                  </div>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">
                  Next-day replacement of 22 missing/damaged hubs + Greek AADE <code className="font-mono text-[11px]">myDATA 9.3</code> discrepancy note + supplier email drafted to <code className="font-mono text-[11px]">accounts@kappaoffice.example</code>.
                </p>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-line/70 pt-2 font-mono text-[13px] text-ink">
                <span>22 hubs restocked · <span className="font-semibold text-signal">€202.30 credit</span></span>
                <span className="font-semibold text-signal group-hover:underline">
                  {resolvedChoice === "redelivery" ? "Committed" : "Choose Option A →"}
                </span>
              </div>
            </button>

            {/* Option B: Enforce €587.30 Refund + AADE Tax Credit (Recommended) */}
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
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ok">
                    Option B · Full Financial Recovery
                  </span>
                  <Chip tone="ok" solid={resolvedChoice === "refund"}>
                    {resolvedChoice === "refund" ? "Selected · Recommended" : "Recommended · AADE 5.1"}
                  </Chip>
                </div>
                <div className="mt-1.5 flex items-start gap-2">
                  <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                  <div className="text-[13.5px] font-semibold leading-snug text-ink">
                    Enforce <span className="text-ok">€587.30</span> Refund + AADE Tax Credit
                  </div>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">
                  Freeze overcharged invoice <code className="font-mono text-[11px]">INV-7781</code> + stage Greek AADE <code className="font-mono text-[11px]">myDATA 5.1</code> credit note (€587.30 net + €140.95 24% VAT = €728.25 gross) + supplier email drafted to <code className="font-mono text-[11px]">accounts@kappaoffice.example</code>.
                </p>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-ok/25 pt-2 font-mono text-[13px]">
                <span className="font-semibold text-ok">€587.30 net · €728.25 gross</span>
                <span className="font-semibold text-ok group-hover:underline">
                  {resolvedChoice === "refund" ? "Committed" : "Enforce Option B →"}
                </span>
              </div>
            </button>
          </div>

          {pendingApproval && onReject && (
            <div className="flex items-center justify-between border-t border-line/60 pt-2 text-[11.5px] text-ink-3">
              <span>Holding ERP changes &amp; outbound supplier email until authorized.</span>
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  onReject(pendingApproval.req_id);
                }}
                className="font-medium text-ink-3 transition-colors hover:text-danger hover:underline"
              >
                Cancel &amp; Roll Back
              </button>
            </div>
          )}

          {/* Live Two-Way Real-Time Subtitles & Transcript (Recoup AI <-> You on iPhone) */}
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
                    Grok Voice · fal.ai
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
                    You (on iPhone)
                  </span>
                  <Chip tone="signal" className="h-4 px-1.5 text-[9.5px]">
                    Wizper STT · Auto-VAD
                  </Chip>
                </div>

                {speaking || consult.activeSpeaker ? (
                  <VoiceOrb
                    variant="bars"
                    tone={consult.activeSpeaker === "user" ? "signal" : "ok"}
                    className="h-4 w-16 shrink-0"
                  />
                ) : (
                  <span className="font-mono text-[13px] font-semibold text-ink tabular">
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
                  <div className="flex items-center justify-center gap-2 py-3 font-mono text-[12px] font-semibold text-ink">
                    <Dot tone="signal" live />
                    Ringing operator iPhone (/mobile) · live Grok Voice call ready…
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
                            "w-[92%] rounded-xl border px-3 py-2 text-[13px] leading-relaxed transition-colors",
                            isUser
                              ? "border-signal/35 bg-signal/[0.08] text-ink"
                              : "border-ok/30 bg-ok/[0.06] text-ink",
                            isActiveAgentTurn && "ring-2 ring-ok/30"
                          )}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold">
                              <span className={isUser ? "text-signal" : "text-ok"}>
                                {isUser ? "You (on iPhone)" : `${brandName} AI`}
                              </span>
                              <Chip
                                tone={isUser ? "signal" : "accent"}
                                className="h-4 px-1.5 text-[9px]"
                              >
                                {isUser ? "Wizper STT" : "Grok Voice · fal.ai"}
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
                                title="Replay Grok Voice turn"
                                aria-label="Replay Grok Voice turn"
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
                      ? "Free Replacement Delivery (22 Units Tomorrow) + AADE 9.3 Staged"
                      : "Enforce €587.30 Refund + AADE myDATA 5.1 Credit Note Staged"}
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
