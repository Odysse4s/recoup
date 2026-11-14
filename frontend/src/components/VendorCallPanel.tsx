import { AnimatePresence, motion } from "framer-motion";
import { Building2, CheckCircle2, PhoneCall, PhoneForwarded, ShieldAlert, ShieldCheck, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { CallEndPayload, CallTurnPayload } from "../contracts";
import { soundFx } from "../lib/sound";
import { btn, Chip, cx, Dot, Panel } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

export interface VendorCallState {
  active: boolean;
  dialing: boolean;
  callId: string;
  claimId: string;
  counterparty: string;
  claimAmount: number;
  openingPct: number;
  floorPct: number;
  turns: CallTurnPayload[];
  activeSpeaker: "agent" | "counterparty" | null;
  end: CallEndPayload | null;
}

export function VendorCallPanel({
  call,
  canNegotiate,
  defaultClaimId = "CLM-D-1042",
  defaultAmount = 587.3,
  claimSettled = false,
  onNegotiate,
  onReplayTurnAudio,
}: {
  call: VendorCallState | null;
  canNegotiate: boolean;
  defaultClaimId?: string;
  defaultAmount?: number;
  claimSettled?: boolean;
  onNegotiate: (claimId: string) => void;
  onReplayTurnAudio: (speaker: "agent" | "counterparty", text: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const turnsCount = call?.turns.length ?? 0;

  useEffect(() => {
    if (transcriptRef.current && turnsCount > 0) {
      transcriptRef.current.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [turnsCount, call?.end]);

  const claimId = call?.claimId ?? defaultClaimId;
  const claimAmount = call?.claimAmount ?? defaultAmount;
  const floorPct = call?.floorPct ?? 85;
  const openingPct = call?.openingPct ?? 70;
  const counterpartyLabel = call?.counterparty
    ? call.counterparty.replace(/\bar desk\b/i, "AR Desk")
    : "Kappa Office Systems AR Desk";

  const offerMetrics = useMemo(() => {
    const turns = call?.turns ?? [];
    const counterpartyOffers = turns
      .filter((t) => t.speaker === "counterparty" && typeof t.offer_pct === "number")
      .map((t) => Number(t.offer_pct));
    const latestCounterPct = counterpartyOffers.length ? counterpartyOffers[counterpartyOffers.length - 1] : null;
    const latestAnyOffer = [...turns]
      .reverse()
      .find((t) => typeof t.offer_pct === "number")?.offer_pct;
    const currentPct =
      call?.end?.outcome === "accepted" && call.end.agreed_amount && claimAmount > 0
        ? Math.round((call.end.agreed_amount / claimAmount) * 1000) / 10
        : latestCounterPct ?? (typeof latestAnyOffer === "number" ? latestAnyOffer : 0);
    const meetsFloor = currentPct >= floorPct && (latestCounterPct !== null || call?.end?.outcome === "accepted");
    const currentEur =
      call?.end?.agreed_amount ??
      (currentPct > 0 ? Math.round(claimAmount * currentPct) / 100 : 0);
    const openingEur = Math.round(claimAmount * openingPct) / 100;
    const floorEur = Math.round(claimAmount * floorPct) / 100;
    return {
      latestCounterPct,
      currentPct,
      meetsFloor,
      currentEur,
      openingEur,
      floorEur,
    };
  }, [call, claimAmount, floorPct, openingPct]);

  if (!canNegotiate && !call) return null;

  const busy = Boolean(call?.active || call?.dialing);
  const accepted = call?.end?.outcome === "accepted" || claimSettled;
  const escalated = call?.end?.outcome === "escalated" || call?.end?.outcome === "rejected";

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="shrink-0"
    >
      <Panel
        title="Vendor AR Voice Negotiation"
        icon={<PhoneCall />}
        meta={
          busy ? (
            <Chip tone="signal">
              <Dot tone="signal" live /> live call
            </Chip>
          ) : accepted ? (
            <Chip tone="ok">settled · ≥{floorPct}% floor</Chip>
          ) : escalated ? (
            <Chip tone="warn">escalated</Chip>
          ) : (
            <Chip tone="accent">ready · {claimId}</Chip>
          )
        }
        actions={
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              soundFx.playUiClick();
              onNegotiate(claimId);
            }}
            className={cx(btn(call ? "outline" : "ok", "sm"), "h-7 px-2.5")}
          >
            {busy ? (
              <>
                <PhoneForwarded className="h-3.5 w-3.5 animate-pulse" />
                Negotiating…
              </>
            ) : call ? (
              <>
                <PhoneCall className="h-3.5 w-3.5" />
                Redial Vendor AR
              </>
            ) : (
              <>
                <PhoneCall className="h-3.5 w-3.5" />
                Negotiate with Vendor AR
              </>
            )}
          </button>
        }
        pulseTone="signal"
      >
        <div className="space-y-3 p-3.5">
          {/* Participants strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-sunken/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                  call?.activeSpeaker === "agent"
                    ? "border-ok/50 bg-ok/15 text-ok"
                    : "border-ok/25 bg-ok/8 text-ink"
                )}
              >
                <ShieldCheck className="h-3 w-3 text-ok" />
                Recoup Negotiator
              </span>
              <span className="font-mono text-[10px] text-ink-3">↔</span>
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 truncate rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                  call?.activeSpeaker === "counterparty"
                    ? "border-signal/50 bg-signal/15 text-signal"
                    : "border-line bg-surface text-ink-2"
                )}
              >
                <Building2 className="h-3 w-3 shrink-0 text-signal" />
                <span className="truncate">{counterpartyLabel}</span>
              </span>
            </div>
            {call?.activeSpeaker ? (
              <VoiceOrb
                variant="bars"
                tone={call.activeSpeaker === "agent" ? "ok" : "signal"}
                className="h-4 w-14 shrink-0"
              />
            ) : (
              <span className="font-mono text-[10.5px] text-ink-3 tabular">
                {claimId} · €{claimAmount.toFixed(2)}
              </span>
            )}
          </div>

          {/* Live settlement offer % meter */}
          <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-ink-2">Settlement Governance Meter</span>
              <span
                className={cx(
                  "font-mono text-[11px] font-semibold tabular",
                  offerMetrics.meetsFloor
                    ? "text-ok"
                    : offerMetrics.latestCounterPct !== null
                    ? "text-warn"
                    : "text-ink-3"
                )}
              >
                {offerMetrics.latestCounterPct !== null || accepted
                  ? `${offerMetrics.currentPct}% (€${offerMetrics.currentEur.toFixed(2)}) ${
                      offerMetrics.meetsFloor ? `≥ ${floorPct}% floor` : `< ${floorPct}% floor`
                    }`
                  : `Policy floor ≥ ${floorPct}% (€${offerMetrics.floorEur.toFixed(2)})`}
              </span>
            </div>

            <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-full bg-sunken">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, Math.max(0, offerMetrics.currentPct))}%` }}
                transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
                className={cx(
                  "h-full rounded-full transition-colors duration-300",
                  offerMetrics.meetsFloor
                    ? "bg-ok"
                    : offerMetrics.latestCounterPct !== null
                    ? "bg-warn"
                    : "bg-accent/50"
                )}
              />
              {/* 70% opening counter marker */}
              <span
                title={`Opening counter ${openingPct}% (€${offerMetrics.openingEur.toFixed(2)})`}
                style={{ left: `${openingPct}%` }}
                className="pointer-events-none absolute inset-y-0 w-[1.5px] bg-warn/80"
              />
              {/* 85% policy floor marker */}
              <span
                title={`Policy governance floor ${floorPct}% (€${offerMetrics.floorEur.toFixed(2)})`}
                style={{ left: `${floorPct}%` }}
                className="pointer-events-none absolute inset-y-0 w-[2px] bg-ok"
              />
            </div>

            <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-ink-3 tabular">
              <span>0%</span>
              <span className="text-warn">{openingPct}% counter (€{offerMetrics.openingEur.toFixed(2)})</span>
              <span className="font-semibold text-ok">≥{floorPct}% floor (€{offerMetrics.floorEur.toFixed(2)})</span>
              <span>100%</span>
            </div>
          </div>

          {/* Pre-call CTA card when no call started yet */}
          {!call && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-ok/35 bg-ok/[0.05] px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold text-ink">
                  Claim {claimId} committed — ready for live AR settlement
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  Dials {counterpartyLabel}, enforces the ≥{floorPct}% procurement policy floor, and records a reversible settlement receipt.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  soundFx.playUiClick();
                  onNegotiate(claimId);
                }}
                className={cx(btn("ok", "md"), "shrink-0")}
              >
                <PhoneCall className="h-3.5 w-3.5" />
                Negotiate with Vendor AR
              </button>
            </div>
          )}

          {/* Live two-speaker call transcript */}
          {call && (
            <div
              ref={transcriptRef}
              className="scroll-thin max-h-[250px] space-y-2 overflow-y-auto pr-0.5"
              aria-live="polite"
            >
              {call.turns.length === 0 && call.dialing && (
                <div className="py-4 text-center font-mono text-[11.5px] text-ink-3">
                  Connecting to {counterpartyLabel}…
                </div>
              )}
              <AnimatePresence initial={false}>
                {call.turns.map((turn, idx) => {
                  const isAgent = turn.speaker === "agent";
                  const speakingNow =
                    call.activeSpeaker === turn.speaker && idx === call.turns.length - 1;
                  return (
                    <motion.div
                      key={`${turn.call_id}-${idx}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25 }}
                      className={cx("flex flex-col", isAgent ? "items-start" : "items-end")}
                    >
                      <div
                        className={cx(
                          "w-[92%] rounded-xl border px-3 py-2 text-[12px] leading-relaxed transition-colors",
                          isAgent
                            ? "border-ok/30 bg-ok/[0.06] text-ink"
                            : "border-signal/30 bg-signal/[0.06] text-ink",
                          speakingNow && "ring-2 ring-accent/35"
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-[10.5px] font-semibold">
                            <span className={isAgent ? "text-ok" : "text-signal"}>
                              {isAgent ? "Recoup Negotiator" : counterpartyLabel}
                            </span>
                            {typeof turn.offer_pct === "number" && (
                              <Chip
                                tone={
                                  turn.offer_pct >= floorPct
                                    ? "ok"
                                    : turn.speaker === "counterparty"
                                    ? "warn"
                                    : "neutral"
                                }
                                className="h-4 px-1.5 text-[9.5px]"
                              >
                                {turn.offer_pct}% · €{((claimAmount * turn.offer_pct) / 100).toFixed(2)}
                              </Chip>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              soundFx.playUiClick();
                              onReplayTurnAudio(turn.speaker, turn.text);
                            }}
                            title="Replay turn audio"
                            aria-label="Replay turn audio"
                            className="rounded p-0.5 text-ink-3 hover:bg-sunken hover:text-ink"
                          >
                            <Volume2 className="h-3 w-3" />
                          </button>
                        </div>
                        <p className="text-ink-2">{turn.text}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {/* Call outcome banner */}
          {call?.end && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className={cx(
                "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12px]",
                call.end.outcome === "accepted"
                  ? "border-ok/40 bg-ok/10 text-ink"
                  : "border-warn/40 bg-warn/10 text-ink"
              )}
            >
              {call.end.outcome === "accepted" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              ) : (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                  <span>
                    {call.end.outcome === "accepted"
                      ? `Settlement Accepted · EUR ${(call.end.agreed_amount ?? offerMetrics.currentEur).toFixed(2)}`
                      : `Escalated to Procurement Lead`}
                  </span>
                  {call.end.outcome === "accepted" && (
                    <span className="font-mono text-[10px] text-ok">claims.status = settled · reversible</span>
                  )}
                </div>
                <p className="mt-0.5 text-[11.5px] text-ink-2">{call.end.summary}</p>
              </div>
            </motion.div>
          )}
        </div>
      </Panel>
    </motion.div>
  );
}
