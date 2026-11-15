import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnticipateOfferPayload,
  ApprovalNeededPayload,
  CallEndPayload,
  CallStartPayload,
  CallTurnPayload,
  ChangeReport,
  EvidencePayload,
  ForgeSpecPayload,
  ForgeTestPayload,
  PlanPayload,
  ServerEvent,
  UiActionPayload,
  VerifyPayload,
} from "../contracts";
import { brandOf } from "../lib/brand";
import { buildThoughtGraph } from "../lib/graph";
import { IDLE_NARRATION, briefingFor, callOf, idleNarration, narrate } from "../lib/narrate";
import { FALLBACK_FILES, FALLBACK_TABLES, offlineState } from "../lib/offline";
import { soundFx } from "../lib/sound";
import { PACE, type Speed } from "../lib/speed";
import { diffTables, rowKeyOf } from "../lib/tableDiff";
import {
  STAGES,
  type Brand,
  type DockTarget,
  type LiveWin,
  type OperatorChoice,
  type OperatorConsultState,
  type OperatorConsultTurn,
  type RewindState,
  type Row,
  type RowMark,
  type RunStatus,
  type StageId,
  type WorkspaceState,
} from "../lib/types";
import { usePersistentState } from "../lib/usePersistentState";
import { isMobileCallManagingAudio, speakBriefing, speakCallTurn, stopSpeaking } from "../lib/voice";

import { buildCommitWindows, diffWindow, fileWindow, forgeSpecWindow, forgeWindow, outboxWindow, toolWindow } from "../lib/windows";
import {
  buildDemoAadeXml,
  mockDecisionEvents,
  mockEvents,
  mockUserConsultRespondEvents,
  mockUserConsultStartEvents,
} from "../mockEvents";

function reconstructDiff(diff: string): string {
  const lines = diff.split("\n");
  const hasUnifiedHeaders = lines.some((l) => l.startsWith("@@") || l.startsWith("+++"));
  if (!hasUnifiedHeaders) return diff;
  return lines
    .filter((l) => !l.startsWith("+++") && !l.startsWith("---") && !l.startsWith("@@") && !l.startsWith("-"))
    .map((l) => (l.startsWith("+") ? l.slice(1) : l))
    .join("\n");
}

const EVENT_TYPES = [
  "plan",
  "replan",
  "rehearse_start",
  "evidence",
  "tool_call",
  "tool_done",
  "tool_error",
  "forge_spec",
  "forge_test",
  "forge_registered",
  "rehearse_report",
  "approval_needed",
  "approval_result",
  "replay_step_done",
  "undo_step",
  "verify",
  "call_start",
  "call_turn",
  "call_end",
  "offer",
  "run_done",
  "workspace_reset",
] as const;

const checkIsMobileRoute = (): boolean =>
  typeof window !== "undefined" &&
  (window.location.pathname.startsWith("/mobile") || window.location.hash === "#mobile");

const MAX_LIVE_WINDOWS = 6;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

const isWindowSpawningEvent = (type: string): boolean =>
  type === "tool_call" || type === "forge_spec" || type === "forge_test";

const getMinWindowGapMs = (s: Speed): number => {
  const profile = PACE[s];
  if (profile?.minWindowGapMs) return profile.minWindowGapMs;
  switch (s) {
    case "0.5x":
      return 3200;
    case "2x":
      return 1250;
    case "turbo":
      return 550;
    case "1x":
    default:
      return 2300;
  }
};

export function useRecoup(opts: { liveWindows: boolean } = { liveWindows: true }) {
  const windowsEnabledRef = useRef(opts.liveWindows);
  windowsEnabledRef.current = opts.liveWindows;
  const [speed, setSpeed] = usePersistentState<Speed>("recoup.speed", "1x");
  const [voiceOn, setVoiceOn] = usePersistentState<boolean>("recoup.voice", true);

  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [rehearsalActive, setRehearsalActive] = useState(false);
  const [plan, setPlan] = useState<PlanPayload | null>(null);
  const [forgeSpec, setForgeSpec] = useState<ForgeSpecPayload | null>(null);
  const [forgeTest, setForgeTest] = useState<ForgeTestPayload | null>(null);
  const [forgedCode, setForgedCode] = useState<Record<string, ForgeTestPayload>>({});
  const [report, setReport] = useState<ChangeReport | null>(null);
  const reportRef = useRef<ChangeReport | null>(report);
  reportRef.current = report;
  const [verify, setVerify] = useState<VerifyPayload | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalNeededPayload | null>(null);
  const pendingApprovalRef = useRef<ApprovalNeededPayload | null>(pendingApproval);
  pendingApprovalRef.current = pendingApproval;
  const [offer, setOffer] = useState<AnticipateOfferPayload | null>(null);
  const [wsState, setWsState] = useState<WorkspaceState | null>(null);
  const [connected, setConnected] = useState(false);
  const [mode, setModeState] = useState<"live" | "demo">("live");
  const [stage, setStage] = useState<StageId | null>(null);
  const [stageDone, setStageDone] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const runStatusRef = useRef<RunStatus>(runStatus);
  runStatusRef.current = runStatus;
  const replayCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [narration, setNarration] = useState(IDLE_NARRATION);
  const [windows, setWindows] = useState<LiveWin[]>([]);
  const windowsRef = useRef<LiveWin[]>([]);
  windowsRef.current = windows;
  const forgeFallbackTimerRef = useRef<number | null>(null);
  const forgeHeroUntilRef = useRef<number>(0);
  const forgeTestReceivedRef = useRef<boolean>(false);
  const lastWindowPopAtRef = useRef<number>(0);
  const lastEventPopAtRef = useRef<number>(0);
  const [pulses, setPulses] = useState<Record<DockTarget, number>>({ vault: 0, diff: 0, db: 0 });
  const [rowMarks, setRowMarks] = useState<Record<string, RowMark>>({});
  const [ghostRows, setGhostRows] = useState<Record<string, Row[]>>({});
  const [fileMarks, setFileMarks] = useState<Record<string, "new" | "changed" | "removed">>({});
  const [rewind, setRewind] = useState<RewindState | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [lastBriefing, setLastBriefing] = useState<string | null>(null);
  const [spokenText, setSpokenText] = useState<string | null>(null);
  const [speechProgress, setSpeechProgress] = useState(0);
  const [queued, setQueued] = useState(0);
  const [landing, setLanding] = useState<string[]>([]);
  const [evidenceItems, setEvidenceItems] = useState<EvidencePayload[]>([]);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [operatorConsult, setOperatorConsult] = useState<OperatorConsultState | null>(null);
  const [requestedDeckView, setRequestedDeckView] = useState<{ view: "graph" | "db" | "split"; seq: number } | null>(null);
  const [requestedDbTable, setRequestedDbTable] = useState<{ table: string; seq: number } | null>(null);
  const [resetSeq, setResetSeq] = useState(0);
  const executeUiActionRef = useRef<((uiAction: UiActionPayload) => void) | null>(null);
  const triggerGoalRef = useRef<((goalText: string) => Promise<void>) | null>(null);
  const acceptOfferRef = useRef<((offerId: string) => Promise<void>) | null>(null);
  const lastUiActionRef = useRef<{ key: string; ts: number } | null>(null);
  const lastPolledUiActionSigRef = useRef<string | null>(null);
  const lastSentVoiceTurnRef = useRef<{ text: string; ts: number } | null>(null);

  const queueRef = useRef<ServerEvent[]>([]);
  const liveCountRef = useRef(0);
  const prevTablesRef = useRef<Record<string, Row[]> | null>(null);
  const prevFilesRef = useRef<Record<string, string> | null>(null);
  const demoBaselineRef = useRef<{ tables: Record<string, Row[]>; files: Record<string, string> } | null>(null);
  const suppressDiffRef = useRef(true);
  const rewindingRef = useRef(false);
  const wsStateRef = useRef<WorkspaceState | null>(null);
  const modeRef = useRef<"live" | "demo">("live");
  const setMode = (m: "live" | "demo") => {
    modeRef.current = m;
    setModeState(m);
  };
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const deferredApprovalRef = useRef<ApprovalNeededPayload | null>(null);
  const phoneCallActiveRef = useRef(false);
  const phoneTransferredRef = useRef(false);
  const phoneCooldownTimerRef = useRef<number | null>(null);
  const lastAgentTurnSpokenAtRef = useRef<number>(0);
  const lastSpokenTurnKeyRef = useRef<string | null>(null);
  const [voiceInitiated, setVoiceInitiated] = useState(false);
  const userInitiatedVoiceRef = useRef(false);

  const markPhoneCallActive = useCallback(() => {
    if (phoneCooldownTimerRef.current !== null) {
      window.clearTimeout(phoneCooldownTimerRef.current);
      phoneCooldownTimerRef.current = null;
    }
    phoneCallActiveRef.current = true;
    phoneTransferredRef.current = true;
    if (windowsEnabledRef.current) {
      stopSpeaking();
      setSpeaking(false);
    }
  }, []);

  const markPhoneCallEnded = useCallback(() => {
    if (phoneCooldownTimerRef.current !== null) {
      window.clearTimeout(phoneCooldownTimerRef.current);
    }
    phoneCooldownTimerRef.current = window.setTimeout(() => {
      phoneCallActiveRef.current = false;
      phoneTransferredRef.current = false;
      phoneCooldownTimerRef.current = null;
    }, 8000);
  }, []);

  useEffect(() => {
    const isPhoneChannel =
      operatorConsult?.channel === "voice_call" ||
      operatorConsult?.channel === "iphone_transferred";
    const isConsultActive = Boolean(operatorConsult?.active || operatorConsult?.ringing);
    if (isConsultActive && isPhoneChannel) {
      markPhoneCallActive();
    } else if (operatorConsult?.end && (phoneCallActiveRef.current || isPhoneChannel)) {
      markPhoneCallEnded();
    }
  }, [operatorConsult?.active, operatorConsult?.ringing, operatorConsult?.channel, operatorConsult?.end, markPhoneCallActive, markPhoneCallEnded]);

  useEffect(() => {
    liveCountRef.current = windows.filter((w) => !w.pinned && !w.manual).length;
  }, [windows]);

  useEffect(() => {
    if (!opts.liveWindows) {
      setWindows([]);
      setLanding([]);
      liveCountRef.current = 0;
    }
  }, [opts.liveWindows]);

  // ---------------------------------------------------------------- voice
  const speechHooks = useCallback(
    (text: string) => ({
      onStart: () => {
        setSpokenText(text);
        setSpeechProgress(0);
        setSpeaking(true);
      },
      onEnd: () => {
        setSpeaking(false);
        setSpeechProgress(1);
      },
      onProgress: (f: number) => setSpeechProgress((p) => Math.max(p, f)),
    }),
    []
  );

  const brief = useCallback(
    (text: string, kind: string, interrupt = false) => {
      setLastBriefing(text);
      if (!userInitiatedVoiceRef.current) return;
      if (!voiceRef.current) return;
      if (checkIsMobileRoute() || !windowsEnabledRef.current || isMobileCallManagingAudio()) return;
      if (phoneCallActiveRef.current) return;
      speakBriefing(text, kind, speechHooks(text), interrupt);
    },
    [speechHooks]
  );

  const replayBriefing = useCallback(() => {
    if (!lastBriefing) return;
    if (checkIsMobileRoute() || !windowsEnabledRef.current || isMobileCallManagingAudio()) return;
    if (phoneCallActiveRef.current) return;
    speakBriefing(lastBriefing, "replay", speechHooks(lastBriefing), true);
  }, [lastBriefing, speechHooks]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((v) => {
      if (v) {
        stopSpeaking();
        setSpeaking(false);
      }
      return !v;
    });
  }, [setVoiceOn]);

  // ---------------------------------------------------------------- state sync
  const markTables = useCallback((next: Record<string, Row[]>) => {
    const prevTables = prevTablesRef.current;
    if (prevTables && !suppressDiffRef.current) {
      const { marks, ghosts } = diffTables(prevTables, next, rewindingRef.current);
      if (Object.keys(marks).length) {
        setRowMarks((m) => ({ ...m, ...marks }));
        if (Object.keys(ghosts).length) {
          setGhostRows((g) => ({ ...g, ...ghosts }));
        }
        setPulses((p) => ({ ...p, db: p.db + 1 }));
        const stamp = Object.values(marks)[0].at;
        window.setTimeout(() => {
          setRowMarks((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.at !== stamp)));
          if (Object.keys(ghosts).length) {
            setGhostRows((g) => {
              const copy = { ...g };
              for (const t of Object.keys(ghosts)) delete copy[t];
              return copy;
            });
          }
        }, 7000);
      }
    }
    prevTablesRef.current = next;
  }, []);

  const refreshState = useCallback(
    async (optsArg?: { initial?: boolean }): Promise<WorkspaceState | null> => {
      try {
        const res = await fetch("/api/state");
        if (!res.ok) return null;
        const data: WorkspaceState = await res.json();

        const prevFiles = prevFilesRef.current;
        markTables(data.tables);
        if (prevFiles && !suppressDiffRef.current) {
          const fm: Record<string, "new" | "changed" | "removed"> = {};
          for (const [p, c] of Object.entries(data.files)) {
            if (!(p in prevFiles)) fm[p] = "new";
            else if (prevFiles[p] !== c) fm[p] = "changed";
          }
          for (const p of Object.keys(prevFiles)) if (!(p in data.files)) fm[p] = "removed";
          if (Object.keys(fm).length) {
            setFileMarks(fm);
            window.setTimeout(() => setFileMarks({}), 7000);
          }
        }
        suppressDiffRef.current = false;
        prevFilesRef.current = data.files;

        wsStateRef.current = data;
        setWsState(data);

        // Hydrate pending approval (authoritative whenever backend PENDING holds an unresolved gate)
        const nextPending = data.pending_approval ?? (data.pending_approvals?.length ? data.pending_approvals[0] : null);
        if (nextPending && (modeRef.current === "live" || runStatusRef.current !== "committed")) {
          if (!windowsEnabledRef.current) {
            // On mobile: instant hydration so phone rings immediately
            if (queueRef.current.length > 0) {
              while (queueRef.current.length > 0) {
                const flushed = queueRef.current.shift();
                if (flushed) applyRef.current(flushed);
              }
              setQueued(0);
            }
            setPendingApproval(nextPending);
            setStage("gate");
            setRunStatus((curr) => (curr === "committing" ? curr : "awaiting"));
          } else {
            // On desktop: do NOT instant-flush if pacer queue still has live windows pacing out!
            const hasPendingPacerEvents = queueRef.current.some((e) =>
              ["forge_spec", "forge_test", "tool_call", "tool_done", "approval_needed"].includes(e.type)
            );
            if (hasPendingPacerEvents) {
              deferredApprovalRef.current = nextPending;
            } else {
              deferredApprovalRef.current = null;
              setPendingApproval(nextPending);
              setStage("gate");
              setRunStatus((curr) => (curr === "committing" ? curr : "awaiting"));
            }
          }
        } else if (modeRef.current === "live" || runStatusRef.current === "committed") {
          deferredApprovalRef.current = null;
          setPendingApproval(null);
        }

        // Hydrate active call
        if (data.active_call) {
          const ac = data.active_call;
          const isPhoneChannel = ac.channel === "voice_call" || ac.channel === "iphone_transferred";
          if (isPhoneChannel) {
            markPhoneCallActive();
          }
          const mappedTurns: OperatorConsultTurn[] = (ac.turns ?? []).map((t) => ({
            speaker: t.speaker,
            text: t.text,
            audioUrl: t.audio_url ?? null,
            ts: t.ts ?? Date.now() / 1000,
            irisIntent: t.iris_intent ?? null,
          }));
          const isConnected = ac.call_status === "connected" || (!ac.ringing && ac.active);
          setOperatorConsult((prev) => {
            return {
              active: Boolean(ac.active),
              ringing: Boolean(ac.ringing) && ac.call_status !== "connected",
              callStatus: ac.call_status ?? (isConnected ? "connected" : ac.ringing ? "ringing" : undefined),
              connectedAt: ac.connected_at ? ac.connected_at * 1000 : (isConnected ? (prev?.connectedAt ?? Date.now()) : null),
              mode: "user_consult",
              channel: ac.channel ?? prev?.channel ?? (isPhoneChannel ? "voice_call" : "desktop_voice"),
              callId: ac.call_id,
              reqId: ac.req_id ?? null,
              claimId: ac.claim_id,
              claimAmount: ac.claim_amount,
              counterparty: ac.counterparty,
              turns: mappedTurns,
              activeSpeaker: ac.active ? (mappedTurns[mappedTurns.length - 1]?.speaker ?? null) : null,
              selectedChoice: ac.selected_choice ?? null,
              lastUiAction: ac.last_ui_action
                ? {
                    action: ac.last_ui_action.action,
                    label: ac.last_ui_action.label || ac.last_ui_action.action,
                    ts: prev?.lastUiAction?.ts ?? Date.now(),
                  }
                : (prev?.lastUiAction ?? null),
              end: ac.end ?? null,
              irisGate: (ac as Record<string, unknown>)?.iris_gate ?? (data as unknown as Record<string, unknown>)?.iris_gate ?? null,
            } as OperatorConsultState;
          });

          if (ac.last_ui_action) {
            const polledSig = `${ac.call_id ?? ""}:${(ac.turns ?? []).length}:${ac.last_ui_action.action}:${ac.last_ui_action.path ?? ""}:${ac.last_ui_action.view ?? ""}:${ac.last_ui_action.table ?? ""}:${ac.last_ui_action.choice ?? ""}`;
            if (lastPolledUiActionSigRef.current !== polledSig) {
              lastPolledUiActionSigRef.current = polledSig;
              executeUiActionRef.current?.(ac.last_ui_action);
            }
          } else {
            lastPolledUiActionSigRef.current = null;
          }
        } else if (data.active_call === null && modeRef.current === "live") {
          setOperatorConsult((prev) =>
            prev?.active || runStatusRef.current === "running" || runStatusRef.current === "awaiting" ? null : prev
          );
        }

        // Hydrate latest offer
        const nextOffer = data.latest_offer ?? (data.pending_offers?.length ? data.pending_offers[data.pending_offers.length - 1] : null);
        if (nextOffer) {
          setOffer(nextOffer);
        }

        return data;
      } catch {
        return null;
      }
    },
    [markTables]
  );

  // 1500ms state poll sync for mobile and active runs
  useEffect(() => {
    const shouldPoll =
      !opts.liveWindows ||
      runStatus === "running" ||
      runStatus === "awaiting" ||
      runStatus === "committing";
    if (!shouldPoll) return;
    const interval = window.setInterval(() => {
      void refreshState();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [opts.liveWindows, refreshState, runStatus]);

  // iOS Safari Wake & Network Reconnect Refetch
  useEffect(() => {
    const onWakeOrFocus = () => {
      if (document.visibilityState === "visible") {
        void refreshState();
      }
    };
    document.addEventListener("visibilitychange", onWakeOrFocus);
    window.addEventListener("focus", onWakeOrFocus);
    window.addEventListener("online", onWakeOrFocus);
    return () => {
      document.removeEventListener("visibilitychange", onWakeOrFocus);
      window.removeEventListener("focus", onWakeOrFocus);
      window.removeEventListener("online", onWakeOrFocus);
    };
  }, [refreshState]);

  const ensureDemoBaseline = useCallback(() => {
    const baseTables = prevTablesRef.current ?? wsStateRef.current?.tables ?? FALLBACK_TABLES;
    const baseFiles = prevFilesRef.current ?? wsStateRef.current?.files ?? FALLBACK_FILES;
    if (!prevTablesRef.current) {
      prevTablesRef.current = baseTables;
      suppressDiffRef.current = false;
    }
    if (!prevFilesRef.current) {
      prevFilesRef.current = baseFiles;
    }
    demoBaselineRef.current ??= { tables: baseTables, files: { ...baseFiles } };
    return { baseTables, baseFiles };
  }, []);

  const applyDemoUpsert = useCallback(
    (args: Record<string, unknown>) => {
      const table = String(args.table ?? "");
      const pk = String(args.pk_col ?? "id");
      const row = (args.row ?? {}) as Row;
      const { baseTables, baseFiles } = ensureDemoBaseline();
      if (!table || !(table in baseTables)) return;
      const rows = baseTables[table];
      const idx = rows.findIndex((r, i) => rowKeyOf(r, i) === String(row[pk]) || r[pk] === row[pk]);
      const nextRows = idx >= 0 ? rows.map((r, i) => (i === idx ? { ...r, ...row } : r)) : [...rows, row];
      const next = { ...baseTables, [table]: nextRows };
      markTables(next);
      setWsState((ws) => {
        const updated = ws ? { ...ws, tables: next } : offlineState(next, baseFiles);
        wsStateRef.current = updated;
        return updated;
      });
    },
    [ensureDemoBaseline, markTables]
  );

  const applyDemoFileWrite = useCallback(
    (args: Record<string, unknown>) => {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!path) return;
      const { baseTables, baseFiles } = ensureDemoBaseline();
      const isNew = !(path in baseFiles);
      const nextFiles = { ...baseFiles, [path]: content };
      prevFilesRef.current = nextFiles;
      setFileMarks((prev) => ({ ...prev, [path]: isNew ? "new" : "changed" }));
      window.setTimeout(() => setFileMarks({}), 7000);
      setWsState((ws) => {
        const updated = ws ? { ...ws, files: nextFiles } : offlineState(baseTables, nextFiles);
        wsStateRef.current = updated;
        return updated;
      });
    },
    [ensureDemoBaseline]
  );

  const restoreDemoBaseline = useCallback(
    (animate: boolean) => {
      const baseline = demoBaselineRef.current;
      if (!baseline) return false;
      demoBaselineRef.current = null;
      if (animate) markTables(baseline.tables);
      else prevTablesRef.current = baseline.tables;
      prevFilesRef.current = baseline.files;
      setWsState((ws) => {
        const updated = ws ? { ...ws, tables: baseline.tables, files: baseline.files } : ws;
        wsStateRef.current = updated;
        return updated;
      });
      return true;
    },
    [markTables]
  );

  // ---------------------------------------------------------------- windows
  const suppressWindowSpawnRef = useRef(false);

  const spawnWindow = useCallback((w: LiveWin | null | undefined) => {
    if (!w || !windowsEnabledRef.current || (w.skipAutoPop && !w.manual) || (suppressWindowSpawnRef.current && !w.manual)) return;
    if (w.toolName && !w.manual) setLanding((l) => [...l, w.toolName!]);
    setWindows((ws) => {
      const withoutDup = ws.filter((x) => x.id !== w.id);
      let nextList = [...withoutDup, w];
      const nonManualUnpinned = nextList.filter((x) => !x.manual && !x.pinned);
      if (nonManualUnpinned.length > MAX_LIVE_WINDOWS) {
        const oldestTrimmableIdx = nextList.findIndex(
          (x) => !x.manual && !x.pinned && x.kind !== "forge" && x.id !== w.id
        );
        if (oldestTrimmableIdx >= 0) {
          nextList = nextList.filter((_, idx) => idx !== oldestTrimmableIdx);
        } else {
          const oldestIdx = nextList.findIndex((x) => !x.pinned && x.id !== w.id);
          if (oldestIdx >= 0) {
            nextList = nextList.filter((_, idx) => idx !== oldestIdx);
          }
        }
      }
      liveCountRef.current = nextList.filter((x) => !x.pinned && !x.manual).length;
      return nextList;
    });
    soundFx.playWindowPop();
  }, []);

  const dockWindow = useCallback((id: string, target: DockTarget | null) => {
    let existed = false;
    setWindows((ws) => {
      const w = ws.find((x) => x.id === id);
      if (w) existed = true;
      if (w?.toolName && !w.manual) setLanding((l) => l.filter((n) => n !== w.toolName));
      const next = ws.filter((x) => x.id !== id);
      liveCountRef.current = next.filter((x) => !x.pinned && !x.manual).length;
      return next;
    });
    if (target && existed) {
      setPulses((p) => ({ ...p, [target]: p[target] + 1 }));
      soundFx.playWindowDock();
    }
  }, []);

  const commitCelebratedRef = useRef(false);

  const triggerCommitCelebration = useCallback((choiceOverride?: OperatorChoice | null) => {
    if (!windowsEnabledRef.current) return;
    if (commitCelebratedRef.current) return;

    const rep = reportRef.current;
    const claimsSummary = rep?.db_summary?.claims;
    const repClaimsChanged = ((claimsSummary?.inserted ?? 0) + (claimsSummary?.updated ?? 0)) > 0;
    const repOutbox = (rep?.external_outbox?.length ?? 0) > 0;
    const hasClaimOrAction = Boolean(
      choiceOverride ||
        operatorConsult?.selectedChoice ||
        repClaimsChanged ||
        repOutbox
    );

    commitCelebratedRef.current = true;

    // On clean zero-discrepancy control runs (0 claims, 0 outbox), keep the user's chosen view (e.g. Thought Graph)
    // and never spawn fake claim celebration windows!
    if (!hasClaimOrAction) {
      soundFx.playCommitSuccess();
      return;
    }

    const choice: OperatorChoice =
      choiceOverride ??
      operatorConsult?.selectedChoice ??
      "refund";

    // 1. Pre-select claims table in case operator switches to Ledger & Schema (keep Thought Graph default!)
    setRequestedDbTable({ table: "claims", seq: Date.now() });

    // 2. Play commit success chime
    soundFx.playCommitSuccess();

    // 3. Spawn the 2 celebratory Live Commit Windows sequentially with dynamic claim context
    const activeClaimId = operatorConsult?.claimId || "CLM-D-1042";
    const isKappaCommit = activeClaimId === "CLM-D-1042" || /kappa|1042/i.test(activeClaimId);
    const claimsRows = (wsStateRef.current?.tables?.claims ?? []) as Record<string, unknown>[];
    const matchedClaim =
      claimsRows.find((r) => String(r.id ?? "") === activeClaimId) ??
      (claimsRows.length > 0 ? claimsRows[claimsRows.length - 1] : undefined);
    const [win1, win2] = buildCommitWindows(choice, {
      isKappa: isKappaCommit,
      claimId: activeClaimId,
      invoiceId: matchedClaim?.invoice_id ? String(matchedClaim.invoice_id) : undefined,
      supplierId: matchedClaim?.supplier_id ? String(matchedClaim.supplier_id) : undefined,
      amount: typeof operatorConsult?.claimAmount === "number" && operatorConsult.claimAmount > 0
        ? operatorConsult.claimAmount
        : matchedClaim?.amount
        ? Number(matchedClaim.amount)
        : undefined,
    });
    if (win1) {
      spawnWindow(win1);
      window.setTimeout(() => {
        dockWindow(win1.id, "db");
      }, 5200);
    }
    if (win2) {
      window.setTimeout(() => {
        spawnWindow(win2);
        window.setTimeout(() => {
          dockWindow(win2.id, "diff");
        }, 5200);
      }, 950);
    }
  }, [operatorConsult?.selectedChoice, operatorConsult?.claimId, operatorConsult?.claimAmount, spawnWindow, dockWindow]);

  const togglePin = useCallback((id: string) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w)));
  }, []);

  const openFile = useCallback((path: string, content: string) => spawnWindow(fileWindow(path, content)), [spawnWindow]);

  const openDiff = useCallback(
    (path: string, diff: string, created: boolean) => spawnWindow(diffWindow(path, diff, created)),
    [spawnWindow]
  );

  const openOutbox = useCallback(
    (item: Record<string, unknown>, index: number) => {
      setWindows((ws) => ws.filter((w) => !w.id.startsWith("outbox-inspector-")));
      spawnWindow(outboxWindow(item, index));
    },
    [spawnWindow]
  );

  const openForged = useCallback(
    (name: string) => {
      const ft = forgedCode[name];
      if (!ft) return;
      const inspectId = `forge-inspect-${ft.name}`;
      setWindows((ws) =>
        ws.filter((w) => w.id !== inspectId && !(w.kind === "forge" && w.toolName === ft.name))
      );
      spawnWindow({
        ...forgeWindow(ft),
        id: inspectId,
        manual: true,
        pinned: true,
        instant: true,
        origin: "vault",
        target: "vault",
      });
    },
    [forgedCode, spawnWindow]
  );

  const executeUiAction = useCallback(
    (uiAction: UiActionPayload) => {
      if (!uiAction || !uiAction.action) return;
      const actionKey = `${uiAction.action}:${uiAction.path || ""}:${uiAction.view || ""}:${uiAction.table || ""}:${uiAction.choice || ""}`;
      const now = Date.now();
      if (lastUiActionRef.current && lastUiActionRef.current.key === actionKey && now - lastUiActionRef.current.ts < 12000) {
        return;
      }
      lastUiActionRef.current = { key: actionKey, ts: now };

      const label =
        uiAction.label ||
        (uiAction.action === "open_file"
          ? `Opened ${uiAction.path ?? "file"} on Desktop`
          : uiAction.action === "switch_view"
          ? `Opened SQLite ${uiAction.table ? `table '${uiAction.table}'` : uiAction.view ?? "studio"} on Desktop`
          : `Committed ${uiAction.choice ?? "resolution"}`);

      setOperatorConsult((prev) =>
        prev
          ? {
              ...prev,
              lastUiAction: { action: uiAction.action, label, ts: now },
            }
          : prev
      );
      setNarration(`⚡ Live Voice Command: ${label}`);

      // Only trigger visual desktop window/view mutations when windowsEnabledRef.current === true (i.e. on the Desktop screen!)
      if (!windowsEnabledRef.current) return;

      if (uiAction.action === "open_file") {
        const path = uiAction.path || "aade/mydata_CLM-D-1042.xml";
        let content = uiAction.content;
        if (!content && wsStateRef.current?.files?.[path]) {
          content = wsStateRef.current.files[path];
        }
        if (!content && report?.files_modified) {
          const mod = report.files_modified.find((m) => m.path === path);
          if (mod) {
            content = reconstructDiff(mod.diff);
          }
        }
        if (!content && /aade|mydata/i.test(path)) {
          const m = path.match(/CLM-[A-Za-z0-9-]+/i);
          const claimId = m ? m[0] : "CLM-D-1042";
          content = buildDemoAadeXml(claimId, "refund");
        }
        if (!content) {
          content = "";
        }

        // Close duplicate window with same path first
        setWindows((ws) => ws.filter((w) => w.path !== path && w.path !== `workspace/${path}`));
        spawnWindow({
          ...fileWindow(path, content),
          manual: true,
          pinned: true,
          instant: false,
        });
      } else if (uiAction.action === "switch_view") {
        const targetView: "graph" | "db" | "split" =
          uiAction.view === "graph" ? "graph" : uiAction.view === "split" ? "split" : "db";
        setRequestedDeckView({ view: targetView, seq: now });
        if (uiAction.table) {
          setRequestedDbTable({ table: uiAction.table, seq: now });
        }
        soundFx.playStageTick(2);
        // Unpin floating windows blocking center view so SQLite invoices table is 100% visible on projector
        setWindows((ws) => ws.map((w) => (w.pinned ? { ...w, pinned: false } : w)));
      } else if (uiAction.action === "commit_resolution") {
        if (uiAction.choice) {
          const choice = uiAction.choice;
          setOperatorConsult((prev) => (prev ? { ...prev, selectedChoice: choice } : prev));
        }
        triggerCommitCelebration(uiAction.choice as OperatorChoice);
        window.setTimeout(() => {
          setWindows((ws) => ws.map((w) => (w.pinned ? { ...w, pinned: false } : w)));
          void refreshState();
        }, 400);
      } else if (uiAction.action === "trigger_goal") {
        const nextGoal = uiAction.goal?.trim();
        const nextOfferId = uiAction.offer_id?.trim();
        window.setTimeout(() => {
          if (nextOfferId && acceptOfferRef.current) {
            void acceptOfferRef.current(nextOfferId);
          } else if (nextGoal && triggerGoalRef.current) {
            void triggerGoalRef.current(nextGoal);
          }
        }, 1400);
      }
    },
    [report, spawnWindow, refreshState, triggerCommitCelebration]
  );
  executeUiActionRef.current = executeUiAction;

  // ---------------------------------------------------------------- reducer
  const markPlan = (toolName: string, status: "running" | "done" | "failed", forgeOnly = false) =>
    setPlan((prev) => {
      if (!prev) return prev;
      const missingKey = `MISSING:${toolName}`;
      const matchForge = (s: PlanPayload["steps"][number]) =>
        s.tool === missingKey || s.tool.endsWith(`:${toolName}`);
      const matchExact = (s: PlanPayload["steps"][number]) => s.tool === toolName;
      const matchAny = (s: PlanPayload["steps"][number]) => matchExact(s) || matchForge(s);

      let targetIdx = -1;
      if (forgeOnly) {
        targetIdx =
          status === "running"
            ? prev.steps.findIndex((s) => matchForge(s) && s.status !== "done")
            : prev.steps.findIndex((s) => matchForge(s) && s.status !== "done");
      } else {
        // Prefer exact non-MISSING step first so Step 4 never gets stolen by Step 3 (MISSING:...)
        targetIdx =
          status === "running"
            ? prev.steps.findIndex((s) => matchExact(s) && s.status !== "done")
            : prev.steps.findIndex((s) => matchExact(s) && s.status === "running");
        if (targetIdx < 0) {
          targetIdx = prev.steps.findIndex((s) => matchExact(s) && s.status !== "done");
        }
        if (targetIdx < 0) {
          targetIdx =
            status === "running"
              ? prev.steps.findIndex((s) => matchAny(s) && s.status !== "done")
              : prev.steps.findIndex((s) => matchAny(s) && s.status === "running");
        }
      }

      const fallbackIdx = targetIdx >= 0 ? targetIdx : prev.steps.findIndex(forgeOnly ? matchForge : matchAny);
      if (fallbackIdx < 0) return prev;
      return {
        ...prev,
        steps: prev.steps.map((s, idx) => (idx === fallbackIdx ? { ...s, status } : s)),
      };
    });

  const applyEvent = (ev: ServerEvent) => {
    if (isWindowSpawningEvent(ev.type)) {
      lastWindowPopAtRef.current = Date.now();
    }
    setEvents((prev) => [...prev.slice(-120), ev]);
    const activeBrandName = brandOf(wsStateRef.current?.domain).brand_name;
    const line = narrate(ev, activeBrandName);
    if (line) setNarration(line);
    const b = briefingFor(ev, activeBrandName);
    if (b) {
      if (
        checkIsMobileRoute() ||
        !windowsEnabledRef.current ||
        isMobileCallManagingAudio() ||
        phoneCallActiveRef.current
      ) {
        setLastBriefing(b);
      } else if (ev.type === "run_done") {
        const payload = ev.payload as { status?: string; outcome?: string };
        const isCommitted =
          payload?.status === "committed" ||
          payload?.outcome === "committed" ||
          payload?.status === "done" ||
          payload?.outcome === "done";
        if (isCommitted) {
          const recentlySpokeTurn = Date.now() - lastAgentTurnSpokenAtRef.current < 6000;
          if (recentlySpokeTurn || phoneCallActiveRef.current) {
            setLastBriefing(b);
          } else {
            brief(b, ev.type, false);
          }
        } else {
          setLastBriefing(b);
        }
      } else if (ev.type === "offer") {
        brief(b, ev.type, false);
      } else if (ev.type === "approval_needed") {
        // Keep Decision Gate silent until operator clicks Talk (or answers on iPhone)
        setLastBriefing(b);
      } else {
        brief(b, ev.type, false);
      }
    }

    switch (ev.type) {
      case "rehearse_start":
        userInitiatedVoiceRef.current = false;
        setVoiceInitiated(false);
        setRehearsalActive(true);
        setVerify(null);
        setStage("plan");
        setStageDone(false);
        setRunStatus("running");
        setRunStartedAt((t) => t ?? Date.now());
        setRequestedDeckView({ view: "graph", seq: Date.now() });
        break;
      case "evidence": {
        const evPayload = ev.payload as unknown as EvidencePayload;
        if (evPayload?.source) {
          setEvidenceItems((prev) => {
            const filtered = prev.filter((item) => item.source !== evPayload.source);
            return [evPayload, ...filtered].slice(0, 6);
          });
        }
        if (modeRef.current !== "demo") refreshState();
        break;
      }
      case "call_start": {
        const p = ev.payload as unknown as CallStartPayload;
        const isPhone = p.channel === "voice_call" || p.channel === "iphone_transferred";
        if (isPhone) {
          markPhoneCallActive();
          if (windowsEnabledRef.current && !checkIsMobileRoute() && !isMobileCallManagingAudio()) {
            stopSpeaking();
            setSpeaking(false);
          }
        }
        const callId = String(p.call_id ?? "CONSULT-CLM-D-1042");
        const isConnected = p.call_status === "connected";
        setOperatorConsult((prev) => ({
          active: true,
          ringing: !isConnected,
          callStatus: isConnected ? "connected" : (p.call_status ?? "ringing"),
          connectedAt: isConnected ? (prev?.connectedAt ?? Date.now()) : (prev?.connectedAt ?? null),
          mode: "user_consult",
          channel: p.channel ?? prev?.channel ?? (isPhone ? "voice_call" : "desktop_voice"),
          callId,
          reqId: p.req_id ?? null,
          claimId: String(p.claim_id ?? "CLM-D-1042"),
          claimAmount: Number(p.claim_amount ?? 587.3),
          counterparty: String(p.counterparty ?? "Operator Mobile"),
          turns: prev?.turns ?? [],
          activeSpeaker: prev?.activeSpeaker ?? null,
          selectedChoice: prev?.selectedChoice ?? null,
          lastUiAction: prev?.lastUiAction ?? null,
          end: null,
          irisGate: (p as unknown as Record<string, unknown>)?.iris_gate ?? (prev as unknown as Record<string, unknown>)?.irisGate ?? null,
        } as OperatorConsultState));
        if (!windowsEnabledRef.current && !isConnected && isPhone) {
          soundFx.playIncomingCall();
        }
        break;
      }
      case "call_turn": {
        const turn = ev.payload as unknown as CallTurnPayload;
        const isPhone = turn.channel === "voice_call" || turn.channel === "iphone_transferred";
        if (isPhone || phoneCallActiveRef.current) {
          markPhoneCallActive();
          if (windowsEnabledRef.current && !checkIsMobileRoute() && !isMobileCallManagingAudio()) {
            stopSpeaking();
            setSpeaking(false);
          }
        }
        const callId = String(turn.call_id ?? "");
        const inferredChoice: OperatorChoice | null =
          turn.speaker === "user"
            ? /redeliver|re-deliver|replace|22|hubs|tomorrow/i.test(turn.text)
              ? "redelivery"
              : "refund"
            : null;
        const isConnected = turn.call_status === "connected";
        setOperatorConsult((prev) => {
          const claimId = callId.replace(/^CONSULT-/, "").replace(/^CALL-/, "") || prev?.claimId || "CLM-D-1042";
          const base: OperatorConsultState = prev ?? {
            active: true,
            ringing: !isConnected,
            callStatus: isConnected ? "connected" : "ringing",
            connectedAt: isConnected ? Date.now() : null,
            mode: "user_consult",
            channel: turn.channel ?? (isPhone ? "voice_call" : "desktop_voice"),
            callId: callId || `CONSULT-${claimId}`,
            reqId: null,
            claimId,
            claimAmount: 587.3,
            counterparty: "Operator Mobile",
            turns: [],
            activeSpeaker: null,
            selectedChoice: null,
            lastUiAction: null,
            end: null,
            irisGate: (turn as unknown as Record<string, unknown>)?.iris_gate ?? null,
          } as OperatorConsultState;
          const nextConnected = isConnected || base.callStatus === "connected" || !base.ringing;
          return {
            ...base,
            channel: turn.channel ?? base.channel ?? "desktop_voice",
            active: turn.keep_call_open !== false,
            ringing: isConnected ? false : base.ringing,
            callStatus: turn.call_status ?? (nextConnected ? "connected" : base.callStatus),
            connectedAt: nextConnected ? (base.connectedAt ?? Date.now()) : base.connectedAt,
            selectedChoice: inferredChoice ?? base.selectedChoice,
            irisGate: (turn as unknown as Record<string, unknown>)?.iris_gate ?? (base as unknown as Record<string, unknown>)?.irisGate ?? null,
            turns: [
              ...base.turns,
              {
                speaker: turn.speaker,
                text: turn.text,
                audioUrl: turn.audio_url ?? null,
                ts: ev.ts || Date.now() / 1000,
                irisIntent: ((turn as unknown as Record<string, unknown>)?.iris_intent as string | null) ?? null,
              } as OperatorConsultTurn,
            ],
          } as OperatorConsultState;
        });

        if (turn.ui_action) {
          executeUiAction(turn.ui_action);
        }

        if (
          userInitiatedVoiceRef.current &&
          !isPhone &&
          !phoneCallActiveRef.current &&
          turn.speaker === "agent" &&
          turn.text &&
          voiceRef.current &&
          !checkIsMobileRoute() &&
          windowsEnabledRef.current &&
          !isMobileCallManagingAudio()
        ) {
          const turnKey = `agent:${turn.text.trim()}`;
          if (lastSpokenTurnKeyRef.current !== turnKey) {
            lastSpokenTurnKeyRef.current = turnKey;
            lastAgentTurnSpokenAtRef.current = Date.now();
            speakCallTurn(
              "agent",
              turn.text,
              {
                onStart: () => {
                  setSpokenText(turn.text);
                  setSpeechProgress(0);
                  setSpeaking(true);
                  setOperatorConsult((c) => (c ? { ...c, activeSpeaker: "agent" } : c));
                },
                onEnd: () => {
                  setSpeaking(false);
                  setSpeechProgress(1);
                  setOperatorConsult((c) => (c && c.activeSpeaker === "agent" ? { ...c, activeSpeaker: null } : c));
                },
                onProgress: (f) => setSpeechProgress((p) => Math.max(p, f)),
              },
              true
            );
          }
        }
        break;
      }
      case "call_end": {
        markPhoneCallEnded();
        const endPayload = ev.payload as unknown as CallEndPayload;
        const callId = String(endPayload.call_id ?? "");
        const consultClaimId = callId.replace(/^CONSULT-/, "").replace(/^CALL-/, "") || "CLM-D-1042";
        const aadePath = `aade/mydata_${consultClaimId}.xml`;
        setOperatorConsult((prev) =>
          prev
            ? {
                ...prev,
                active: false,
                ringing: false,
                callStatus: "ended",
                activeSpeaker: null,
                selectedChoice:
                  prev.selectedChoice ??
                  (typeof endPayload.agreed_amount === "number" && endPayload.agreed_amount < 350
                    ? "redelivery"
                    : "refund"),
                end: endPayload,
              }
            : prev
        );
        if (endPayload.outcome === "accepted") {
          if (replayCommitTimerRef.current !== null) {
            clearTimeout(replayCommitTimerRef.current);
            replayCommitTimerRef.current = null;
          }
          setRunStatus("committed");
          setStage("commit");
          setStageDone(true);
          setPendingApproval(null);
          const agreedChoice: OperatorChoice =
            (typeof endPayload.agreed_amount === "number" && endPayload.agreed_amount < 350)
              ? "redelivery"
              : "refund";
          triggerCommitCelebration(agreedChoice);
          soundFx.playCommitSuccess();
          if (modeRef.current !== "demo") {
            void refreshState().then((fresh) => {
              const xmlContent = fresh?.files?.[aadePath];
              if (xmlContent && windowsEnabledRef.current) {
                spawnWindow({ ...fileWindow(aadePath, xmlContent), manual: false, instant: false });
              }
            });
          }
        } else if (endPayload.outcome === "rejected") {
          if (replayCommitTimerRef.current !== null) {
            clearTimeout(replayCommitTimerRef.current);
            replayCommitTimerRef.current = null;
          }
          setRunStatus("aborted");
          setPendingApproval(null);
          soundFx.playRewindSweep(1);
        }
        break;
      }
      case "plan":
      case "replan":
        setPlan(ev.payload as unknown as PlanPayload);
        setStage("plan");
        break;
      case "forge_spec": {
        const spec = ev.payload as unknown as ForgeSpecPayload;
        setForgeSpec(spec);
        setForgeTest(null);
        setStage("forge");
        if (spec?.name) markPlan(spec.name, "running", true);
        forgeTestReceivedRef.current = false;
        soundFx.playForgeStart();
        if (windowsEnabledRef.current && spec?.name) {
          const liveId = `forge-live-${spec.name}`;
          setWindows((ws) => ws.filter((w) => w.id !== liveId));
          const specWin = forgeSpecWindow(spec);
          spawnWindow({
            ...specWin,
            id: liveId,
            pinned: false,
          });
          if (forgeFallbackTimerRef.current !== null) {
            window.clearTimeout(forgeFallbackTimerRef.current);
            forgeFallbackTimerRef.current = null;
          }
          forgeFallbackTimerRef.current = window.setTimeout(() => {
            const target = windowsRef.current.find((w) => w.id === liveId)?.target ?? null;
            dockWindow(liveId, target);
            forgeFallbackTimerRef.current = null;
          }, 15000);
        }
        break;
      }
      case "forge_test": {
        const ft = ev.payload as unknown as ForgeTestPayload;
        setForgeTest(ft);
        setForgedCode((m) => ({ ...m, [ft.name]: ft }));
        setStage("forge");
        if (ft?.name && ft.registered) markPlan(ft.name, "done", true);
        forgeTestReceivedRef.current = true;
        const heroMs = speedRef.current === "turbo" ? 450 : speedRef.current === "2x" ? 950 : speedRef.current === "0.5x" ? 2800 : 1800;
        forgeHeroUntilRef.current = Date.now() + heroMs;
        if (forgeFallbackTimerRef.current !== null) {
          window.clearTimeout(forgeFallbackTimerRef.current);
          forgeFallbackTimerRef.current = null;
        }
        if (ft.ast_passed && ft.test_results.length > 0 && ft.test_results.every((r) => r.passed)) soundFx.playForgePass();
        if (windowsEnabledRef.current) {
          const liveId = `forge-live-${ft.name}`;
          const existingWin = windowsRef.current.find((w) => w.id === liveId);
          const fresh = forgeWindow(ft, ev.latency_ms || undefined);

          if (existingWin) {
            setWindows((ws) =>
              ws.map((w) =>
                w.id === liveId
                  ? {
                      ...w,
                      ...fresh,
                      id: liveId,
                      pinned: false,
                      doneLabel: ft.registered ? "REGISTERED" : "REJECTED",
                      code: ft.code,
                      assertions: fresh.assertions,
                      toolName: fresh.toolName,
                      telemetry: fresh.telemetry,
                      latencyMs: ev.latency_ms || w.latencyMs,
                    }
                  : w
              )
            );
          } else {
            const winToSpawn = {
              ...fresh,
              id: liveId,
              pinned: false,
            };
            spawnWindow(winToSpawn);
          }

          forgeFallbackTimerRef.current = window.setTimeout(() => {
            const target = windowsRef.current.find((w) => w.id === liveId)?.target ?? null;
            dockWindow(liveId, target);
            forgeFallbackTimerRef.current = null;
          }, 14000);
        }
        break;
      }
      case "forge_registered": {
        const regName = String((ev.payload as { name?: string; tool?: string })?.name ?? (ev.payload as { tool?: string })?.tool ?? "");
        if (regName) markPlan(regName, "done", true);
        if (modeRef.current !== "demo") refreshState();
        break;
      }
      case "tool_call": {
        const call = callOf(ev);
        setStage("rehearse");
        if (call?.name) {
          markPlan(call.name, "running");
          const argPath = call.args?.path ? String(call.args.path) : "";
          const fileContent = argPath ? wsStateRef.current?.files?.[argPath] : undefined;
          spawnWindow(toolWindow(call, ev.latency_ms || undefined, fileContent));
        }
        break;
      }
      case "tool_done": {
        const call = callOf(ev);
        if (call?.name) markPlan(call.name, "done");
        if (call?.id && ev.latency_ms) {
          setWindows((ws) => ws.map((w) => (w.callId === call.id ? { ...w, latencyMs: ev.latency_ms } : w)));
        }
        if (modeRef.current === "demo" && call?.name) {
          if (call.name === "upsert_row" && call.args) applyDemoUpsert(call.args);
          if (call.name === "write_file" && call.args) applyDemoFileWrite(call.args);
          if (["upsert_row", "write_file", "patch_file", "delete_rows"].includes(call.name)) {
            const toolName = call.name;
            const callArgs = call.args;
            setWsState((ws) => {
              const base = ws ?? offlineState(prevTablesRef.current ?? FALLBACK_TABLES, prevFilesRef.current ?? FALLBACK_FILES);
              const nextEntry = { step: ev.step ?? 0, tool: toolName, args: callArgs, ts: Date.now() + ev.id };
              const updated: WorkspaceState = { ...base, undo_stack: [...base.undo_stack, nextEntry] };
              wsStateRef.current = updated;
              return updated;
            });
          }
        }
        break;
      }
      case "tool_error": {
        const name = callOf(ev)?.name;
        if (name) markPlan(name, "failed");
        break;
      }
      case "verify": {
        const vp = ev.payload as unknown as VerifyPayload;
        setVerify(vp);
        setStage("verify");
        if (vp?.passed) {
          setPlan((prev) =>
            prev
              ? {
                  ...prev,
                  steps: prev.steps.map((s) => (s.status === "failed" ? s : { ...s, status: "done" })),
                }
              : prev
          );
        }
        break;
      }
      case "rehearse_report":
        setReport((ev.payload as { report: ChangeReport }).report);
        setRehearsalActive(false);
        setStage("verify");
        break;
      case "approval_needed":
        if (replayCommitTimerRef.current !== null) {
          clearTimeout(replayCommitTimerRef.current);
          replayCommitTimerRef.current = null;
        }
        deferredApprovalRef.current = null;
        // Clear any ended/accepted consult leftover from a prior run so Decision Gate buttons always appear
        setOperatorConsult((prev) =>
          prev && (!prev.active || prev.end || prev.selectedChoice) ? null : prev
        );
        setPendingApproval(ev.payload as unknown as ApprovalNeededPayload);
        setStage("gate");
        setRunStatus("awaiting");
        // Auto-clear non-pinned rehearsal windows shortly after Gate opens so workspace & Decision Gate stay clean
        window.setTimeout(() => {
          setWindows((ws) => ws.filter((w) => w.pinned));
        }, 1600);
        if (windowsEnabledRef.current) soundFx.playRiskGateAlert();
        else soundFx.playIncomingCall();
        break;
      case "approval_result": {
        deferredApprovalRef.current = null;
        const ok = Boolean((ev.payload as { approved?: boolean }).approved);
        setPendingApproval(null);
        setStage(ok ? "commit" : "gate");
        setRunStatus(ok ? "committing" : "aborted");
        if (ok) {
          setPlan((prev) =>
            prev
              ? {
                  ...prev,
                  steps: prev.steps.map((s) => (s.status === "failed" ? s : { ...s, status: "done" })),
                }
              : prev
          );
          triggerCommitCelebration();
        } else {
          soundFx.playRewindSweep(1);
        }
        break;
      }
      case "replay_step_done": {
        // On live runs, auto-approved steps (< EUR 250) execute BEFORE ask_human() emits approval_needed!
        // Never prematurely mark the run committed or wipe pendingApproval while a Risk Gate is queued or active.
        const gatePendingOrQueued = Boolean(
          pendingApprovalRef.current ||
            deferredApprovalRef.current ||
            runStatusRef.current === "awaiting" ||
            queueRef.current.some((e) => e.type === "approval_needed")
        );
        if (!gatePendingOrQueued) {
          if (modeRef.current === "demo") {
            setStage((curr) => (curr === "commit" ? "commit" : curr ?? "commit"));
            setRunStatus((curr) => (curr === "committed" ? "committed" : "committing"));
            triggerCommitCelebration();
            if (replayCommitTimerRef.current !== null) {
              clearTimeout(replayCommitTimerRef.current);
            }
            replayCommitTimerRef.current = setTimeout(() => {
              replayCommitTimerRef.current = null;
              setRunStatus((curr) => {
                if (curr === "committing" && !pendingApprovalRef.current && !deferredApprovalRef.current) {
                  setStage("commit");
                  setStageDone(true);
                  setPendingApproval(null);
                  return "committed";
                }
                return curr;
              });
            }, 600);
          } else if (runStatusRef.current === "committing") {
            setStage("commit");
            triggerCommitCelebration();
          }
        }
        if (modeRef.current !== "demo") refreshState();
        break;
      }
      case "undo_step": {
        const p = ev.payload as { step?: number; tool?: string };
        setRewind((r) => (r ? { ...r, steps: [...r.steps, { step: Number(p.step ?? 0), tool: String(p.tool ?? "") }] } : r));
        break;
      }
      case "run_done": {
        if (replayCommitTimerRef.current !== null) {
          clearTimeout(replayCommitTimerRef.current);
          replayCommitTimerRef.current = null;
        }
        const payload = ev.payload as {
          status?: string;
          outcome?: string;
          choice?: OperatorChoice;
          clean_audit?: boolean;
        };
        const status = String(payload?.status ?? payload?.outcome ?? "");
        setRehearsalActive(false);
        if (status === "committed" || payload?.outcome === "committed" || status === "done" || payload?.outcome === "done") {
          setPlan((prev) =>
            prev
              ? {
                  ...prev,
                  steps: prev.steps.map((s) => (s.status === "failed" ? s : { ...s, status: "done" })),
                }
              : prev
          );
          setStage("commit");
          setStageDone(true);
          setRunStatus("committed");
          setPendingApproval(null);
          if (!payload?.clean_audit) {
            triggerCommitCelebration(payload?.choice);
          }
          soundFx.playCommitSuccess();
        } else if (status === "aborted_by_human" || status === "blocked" || status === "timed_out" || status === "aborted" || status === "rejected") {
          setRunStatus("aborted");
          setPendingApproval(null);
        } else if (status === "error") {
          setRunStatus("error");
          setPendingApproval(null);
        } else {
          setPlan((prev) =>
            prev
              ? {
                  ...prev,
                  steps: prev.steps.map((s) => (s.status === "failed" ? s : { ...s, status: "done" })),
                }
              : prev
          );
          setStage("commit");
          setStageDone(true);
          setRunStatus("committed");
          setPendingApproval(null);
        }
        if (modeRef.current !== "demo") refreshState();
        break;
      }
      case "offer":
        setOffer(ev.payload as unknown as AnticipateOfferPayload);
        setStage("anticipate");
        setStageDone(false);
        if (modeRef.current === "demo") setRunStatus("committed");
        if (modeRef.current !== "demo") refreshState();
        break;
      case "workspace_reset":
        clearWorkspaceUi();
        setMode("live");
        setResetSeq((n) => n + 1);
        void refreshState();
        break;
    }
  };
  const applyRef = useRef(applyEvent);
  applyRef.current = applyEvent;

  const prevStageRef = useRef<StageId | null>(null);
  useEffect(() => {
    if (stage && stage !== prevStageRef.current && !(stage === "gate" && pendingApproval)) {
      soundFx.playStageTick(STAGES.findIndex((s) => s.id === stage));
    }
    prevStageRef.current = stage;
  }, [stage, pendingApproval]);

  // ---------------------------------------------------------------- pacer
  useEffect(() => {
    const PACER_TICK_MS = 140;
    const timer = window.setInterval(() => {
      const next = queueRef.current[0];
      if (!next) {
        if (deferredApprovalRef.current && windowsEnabledRef.current) {
          if (runStatusRef.current === "committed") {
            deferredApprovalRef.current = null;
            return;
          }
          const forgeActive = windowsRef.current.some((w) => w.kind === "forge" && !w.manual);
          if (forgeActive || Date.now() < forgeHeroUntilRef.current) return;

          const deferred = deferredApprovalRef.current;
          deferredApprovalRef.current = null;
          setPendingApproval(deferred);
          setStage("gate");
          setRunStatus((curr) => (curr === "running" || curr === "idle" ? "awaiting" : curr));
        }
        return;
      }

      const now = Date.now();
      const currentSpeed = speedRef.current;
      const eventPaceMs = PACE[currentSpeed]?.eventMs ?? 950;
      const minWindowGapMs = getMinWindowGapMs(currentSpeed);
      const isWindowSpawn = isWindowSpawningEvent(next.type);

      // 1. If next is a window-spawning event, enforce minWindowGapMs from last window pop
      if (isWindowSpawn && lastWindowPopAtRef.current > 0) {
        if (now - lastWindowPopAtRef.current < minWindowGapMs) {
          return;
        }
      }

      // 2. Normal event pacing gap: enforce eventPaceMs since last popped event
      // Exception: call_start, call_turn, approval_needed have priority dispatch
      const isPriorityEvent =
        next.type === "call_start" ||
        next.type === "call_turn" ||
        next.type === "approval_needed";

      if (!isPriorityEvent && lastEventPopAtRef.current > 0) {
        if (now - lastEventPopAtRef.current < eventPaceMs) {
          return;
        }
      }

      // While forge_spec is waiting for forge_test, allow forge_test through.
      // Once forge_test has updated the window, wait until forgeHeroUntilRef before subsequent step cards cascade.
      const forgeActive = windowsRef.current.some((w) => w.kind === "forge" && !w.manual);
      if (forgeActive && !forgeTestReceivedRef.current && next.type !== "forge_test") {
        return;
      }
      if (now < forgeHeroUntilRef.current && next.type !== "forge_test") {
        return;
      }

      if (next.type === "approval_needed") {
        if (forgeActive || now < forgeHeroUntilRef.current) {
          return;
        }
        queueRef.current.shift();
        setQueued(queueRef.current.length);
        deferredApprovalRef.current = null;
        lastEventPopAtRef.current = now;
        applyRef.current(next);
        return;
      }

      if (next.type === "call_start" || next.type === "call_turn") {
        queueRef.current.shift();
        setQueued(queueRef.current.length);
        lastEventPopAtRef.current = now;
        applyRef.current(next);
        return;
      }

      const spawns = isWindowSpawn;
      const unpinnedCount = windowsRef.current.filter((w) => !w.pinned).length;
      if (spawns && unpinnedCount >= MAX_LIVE_WINDOWS && next.type !== "forge_test") return;

      queueRef.current.shift();
      setQueued(queueRef.current.length);
      lastEventPopAtRef.current = now;
      if (spawns) {
        lastWindowPopAtRef.current = now;
      }
      applyRef.current(next);
    }, PACER_TICK_MS);

    return () => window.clearInterval(timer);
  }, [speed]);

  const enqueue = (evs: ServerEvent[]) => {
    queueRef.current.push(...evs);
    setQueued(queueRef.current.length);
  };

  // ---------------------------------------------------------------- SSE
  useEffect(() => {
    refreshState({ initial: true });
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const t of EVENT_TYPES) {
      es.addEventListener(t, (e) => {
        try {
          const parsed: ServerEvent = JSON.parse((e as MessageEvent).data);
          // On mobile, dispatch ALL events immediately (<50ms) with zero queue delay
          if (!windowsEnabledRef.current) {
            applyRef.current(parsed);
            return;
          }
          // On desktop:
          const drainRehearsalQueueSilently = () => {
            if (queueRef.current.length === 0) return;
            const pending = queueRef.current.splice(0, queueRef.current.length);
            setQueued(0);
            suppressWindowSpawnRef.current = true;
            try {
              for (const q of pending) {
                if (q.type === "approval_needed") continue;
                applyRef.current(q);
              }
            } finally {
              suppressWindowSpawnRef.current = false;
            }
          };

          if (parsed.type === "workspace_reset") {
            queueRef.current.length = 0;
            setQueued(0);
            applyRef.current(parsed);
          } else if (parsed.type === "approval_result") {
            drainRehearsalQueueSilently();
            deferredApprovalRef.current = null;
            applyRef.current(parsed);
          } else if (parsed.type === "approval_needed") {
            // Do NOT instant-flush! Enqueue so prior tool/forge live windows pace out first!
            enqueue([parsed]);
          } else if (parsed.type === "call_start") {
            const p = parsed.payload as unknown as CallStartPayload;
            const isPhone = p?.channel === "voice_call" || p?.channel === "iphone_transferred";
            if (isPhone) {
              markPhoneCallActive();
              if (windowsEnabledRef.current && !checkIsMobileRoute() && !isMobileCallManagingAudio()) {
                stopSpeaking();
                setSpeaking(false);
              }
            }
            const hasPendingPacerEvents = queueRef.current.some((e) =>
              ["forge_spec", "forge_test", "tool_call", "tool_done", "approval_needed"].includes(e.type)
            );
            if (hasPendingPacerEvents) {
              enqueue([parsed]);
            } else {
              applyRef.current(parsed);
            }
          } else if (parsed.type === "call_turn") {
            const turn = parsed.payload as unknown as CallTurnPayload;
            const isPhone = turn?.channel === "voice_call" || turn?.channel === "iphone_transferred";
            if (isPhone) {
              markPhoneCallActive();
              if (windowsEnabledRef.current && !checkIsMobileRoute() && !isMobileCallManagingAudio()) {
                stopSpeaking();
                setSpeaking(false);
              }
            }
            // Keep opening call_turn ordered behind queued call_start; dispatch live phone turns immediately
            if (queueRef.current.some((e) => e.type === "call_start")) {
              enqueue([parsed]);
            } else {
              applyRef.current(parsed);
            }
          } else if (parsed.type === "run_done") {
            drainRehearsalQueueSilently();
            applyRef.current(parsed);
          } else if (
            parsed.type === "undo_step" ||
            parsed.type === "call_end" ||
            parsed.type === "offer"
          ) {
            applyRef.current(parsed);
          } else {
            enqueue([parsed]);
          }
        } catch {
          // ignore malformed frames
        }
      });
    }
    return () => {
      if (replayCommitTimerRef.current !== null) {
        clearTimeout(replayCommitTimerRef.current);
        replayCommitTimerRef.current = null;
      }
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- actions
  const clearRun = () => {
    phoneCallActiveRef.current = false;
    phoneTransferredRef.current = false;
    if (phoneCooldownTimerRef.current !== null) {
      window.clearTimeout(phoneCooldownTimerRef.current);
      phoneCooldownTimerRef.current = null;
    }
    lastAgentTurnSpokenAtRef.current = 0;
    lastSpokenTurnKeyRef.current = null;
    lastUiActionRef.current = null;
    lastPolledUiActionSigRef.current = null;
    lastSentVoiceTurnRef.current = null;
    commitCelebratedRef.current = false;
    forgeTestReceivedRef.current = false;
    forgeHeroUntilRef.current = 0;
    lastWindowPopAtRef.current = 0;
    lastEventPopAtRef.current = 0;
    if (replayCommitTimerRef.current !== null) {
      clearTimeout(replayCommitTimerRef.current);
      replayCommitTimerRef.current = null;
    }
    if (forgeFallbackTimerRef.current !== null) {
      window.clearTimeout(forgeFallbackTimerRef.current);
      forgeFallbackTimerRef.current = null;
    }
    deferredApprovalRef.current = null;
    restoreDemoBaseline(false);
    queueRef.current = [];
    setQueued(0);
    setWindows([]);
    setLanding([]);
    liveCountRef.current = 0;
    setEvents([]);
    setPlan(null);
    setForgeSpec(null);
    setForgeTest(null);
    setReport(null);
    setVerify(null);
    setPendingApproval(null);
    setOffer(null);
    setOperatorConsult(null);
    setRehearsalActive(false);
    setStage(null);
    setStageDone(false);
    setRunStatus("idle");
    setRunStartedAt(null);
    setGhostRows({});
    setNarration(idleNarration(brandOf(wsStateRef.current?.domain).brand_name));
  };

  const triggerGoal = async (goalText: string) => {
    clearRun();
    setRunStartedAt(Date.now());
    setRunStatus("running");
    const brandName = brandOf(wsStateRef.current?.domain).brand_name;
    setNarration(`Dispatching audit goal to ${brandName} safety runtime…`);
    let dispatched = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/goal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: goalText }),
        });
        if (res.ok) {
          dispatched = true;
          break;
        }
      } catch {
        // retry once below on transient network/Wi-Fi blip
      }
      if (attempt === 0) {
        await sleep(400);
      }
    }
    if (dispatched) {
      setMode("live");
      return;
    }
    const isKappaHeroGoal = /\b(1042|kappa)\b/i.test(goalText);
    if (isKappaHeroGoal) {
      setMode("demo");
      enqueue(mockEvents());
    } else {
      setRunStatus("error");
      setNarration(`Backend temporarily unreachable for "${goalText.slice(0, 60)}" — click Run Agent to retry.`);
    }
  };
  triggerGoalRef.current = triggerGoal;

  const runStageDemo = async () => {
    if (speedRef.current === "turbo" || speedRef.current === "2x") {
      setSpeed("1x");
      speedRef.current = "1x";
    }
    clearRun();
    setRunStartedAt(Date.now());
    setRunStatus("running");
    const brandName = brandOf(wsStateRef.current?.domain).brand_name;
    setNarration(`Running live stage audit demo for ${brandName} shipment D-1042…`);
    try {
      const res = await fetch("/api/demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pace_ms: 2300, anticipate_after: true }),
      });
      if (!res.ok) throw new Error(`Demo run failed with status ${res.status}`);
      setMode("live");
    } catch {
      setMode("demo");
      enqueue(mockEvents());
    }
  };

  const runDemo = runStageDemo;

  const decide = async (reqId: string, approved: boolean) => {
    deferredApprovalRef.current = null;
    setPendingApproval(null);
    setRunStatus(approved ? "committing" : "aborted");
    setStage(approved ? "commit" : "gate");
    if (approved) {
      triggerCommitCelebration();
    }
    if (!checkIsMobileRoute() && !isMobileCallManagingAudio()) {
      stopSpeaking();
    }
    if (modeRef.current === "demo" || reqId.startsWith("req_demo")) {
      if (!approved) {
        restoreDemoBaseline(true);
        setWsState((ws) => {
          const updated = ws ? { ...ws, undo_stack: [] } : ws;
          wsStateRef.current = updated;
          return updated;
        });
      }
      queueRef.current = queueRef.current.filter((q) => q.type !== "approval_needed");
      enqueue(mockDecisionEvents(approved));
      return;
    }
    try {
      const res = await fetch(`/api/approve/${reqId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      if (!res.ok) {
        setRunStatus("error");
        setNarration(`Risk Gate decision could not be delivered (HTTP ${res.status}). Workspace unchanged.`);
      }
    } catch {
      setRunStatus("error");
      setNarration("Backend unreachable while submitting Risk Gate decision. Workspace unchanged.");
    }
    refreshState();
  };

  const acceptOffer = async (offerId: string) => {
    const currentOffer = offer;
    setOffer(null);
    setNarration("Applying pre-rehearsed vendor recovery atomically…");
    if (modeRef.current === "demo" || offerId.startsWith("offer_demo")) {
      applyDemoUpsert({
        table: "claims",
        pk_col: "id",
        row: {
          id: "CLM-KAPPA-FOLLOWUP",
          supplier_id: "SUP-KAPPA",
          delivery_id: "D-1017,D-1031",
          invoice_id: "INV-7702,INV-7735",
          amount: 175.0,
          reason: "D-1017 6 short (EUR 105.00), D-1031 4 DOA (EUR 70.00)",
          status: "drafted",
        },
      });
      const created = currentOffer?.report.files_created ?? [];
      const modified = currentOffer?.report.files_modified ?? [];
      for (const f of modified) {
        const lines = f.diff
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1));
        applyDemoFileWrite({ path: f.path, content: lines.join("\n") || currentOffer?.prediction.need || "" });
      }
      if (created.length || modified.length) {
        const addedEntries = [
          {
            step: (wsStateRef.current?.undo_stack.length ?? 0) + 1,
            tool: "upsert_row",
            summary: "Inserted claims id=CLM-KAPPA-FOLLOWUP (EUR 175.00)",
            args: { table: "claims", pk_col: "id", row: { id: "CLM-KAPPA-FOLLOWUP", amount: 175.0 } },
            ts: Date.now(),
          },
          ...(modified.length ? modified : created.map((p) => ({ path: p, diff: "" }))).map((f, idx) => ({
            step: (wsStateRef.current?.undo_stack.length ?? 0) + idx + 2,
            tool: "write_file",
            summary: `Created ${f.path}`,
            args: { path: f.path },
            ts: Date.now() + idx + 1,
          })),
        ];
        setWsState((ws) => {
          if (!ws) return ws;
          const updated: WorkspaceState = {
            ...ws,
            undo_stack: [...ws.undo_stack, ...addedEntries],
          };
          wsStateRef.current = updated;
          return updated;
        });
      }
      setStage("commit");
      setStageDone(true);
      setRunStatus("committed");
      setNarration(`Applied proactive recovery: ${currentOffer?.prediction.need ?? offerId}.`);
      soundFx.playCommitSuccess();
      return;
    }
    clearRun();
    setRunStartedAt(Date.now());
    setRunStatus("running");
    setStage("plan");
    setNarration(`Launching follow-up audit loop: ${currentOffer?.prediction.need ?? offerId}…`);
    try {
      const res = await fetch(`/api/offers/${offerId}/accept`, { method: "POST" });
      if (res.ok) {
        setMode("live");
      } else if (currentOffer?.prediction?.goal_prompt) {
        await triggerGoal(currentOffer.prediction.goal_prompt);
      } else {
        await refreshState();
      }
    } catch {
      if (currentOffer?.prediction?.goal_prompt) {
        await triggerGoal(currentOffer.prediction.goal_prompt);
      } else {
        setNarration("Backend unreachable while applying proactive offer.");
      }
    }
  };
  acceptOfferRef.current = acceptOffer;

  const dismissOffer = async (offerId: string) => {
    setOffer(null);
    try {
      await fetch(`/api/offers/${offerId}/dismiss`, { method: "POST" });
    } catch {
      // ignore
    }
  };

  const undo = async (steps?: number) => {
    if (rewindingRef.current) return;
    const duration = PACE[speedRef.current].rewind;
    const id = Date.now();
    rewindingRef.current = true;
    soundFx.playRewindSweep(steps && steps > 0 ? steps : wsStateRef.current?.undo_stack.length ?? 1);
    setRewind({ id, steps: [], phase: "rewinding", duration, skipped: [] });
    setNarration(
      steps && steps > 0
        ? `Rewinding last ${steps} checkpoint(s) from pre-image receipts…`
        : "Rewinding all checkpoints and restoring baseline SHA-256 fingerprint…"
    );
    let skipped: string[] = [];
    try {
      const res = await fetch("/api/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps: steps ?? null }),
      });
      if (res.ok) skipped = ((await res.json()) as { irreversible_skipped?: string[] }).irreversible_skipped ?? [];
    } catch {
      // offline: animation still plays
    }
    await sleep(duration * 0.5);
    const live = modeRef.current !== "demo" ? await refreshState() : null;
    if (live) {
      demoBaselineRef.current = null;
    } else {
      setWsState((ws) => {
        if (!ws) return ws;
        const count = steps && steps > 0 ? steps : ws.undo_stack.length;
        const remaining = ws.undo_stack.slice(0, Math.max(0, ws.undo_stack.length - count));
        const updated = { ...ws, undo_stack: remaining };
        wsStateRef.current = updated;
        return updated;
      });
      restoreDemoBaseline(true);
    }
    await sleep(duration * 0.5);
    setRewind((r) => (r && r.id === id ? { ...r, phase: "restored", skipped } : r));
    if (!steps || (wsStateRef.current?.undo_stack.length ?? 0) === 0) {
      setReport(null);
      setStageDone(false);
    }
    setNarration(
      skipped.length
        ? `Rewind complete. ${skipped.length} external step(s) (${skipped.join(", ")}) require manual compensation.`
        : "Reversible undo complete. Workspace restored to selected checkpoint."
    );
    await sleep(1400);
    setRewind((r) => (r && r.id === id ? null : r));
    rewindingRef.current = false;
  };

  const clearWorkspaceUi = () => {
    clearRun();
    stopSpeaking();
    setSpeaking(false);
    setForgedCode({});
    setEvidenceItems([]);
    setRowMarks({});
    setGhostRows({});
    setFileMarks({});
    suppressDiffRef.current = true;
  };

  const uploadEvidence = async (file: File): Promise<EvidencePayload | null> => {
    setUploadingEvidence(true);
    setNarration(`Auditing uploaded evidence \`${file.name}\`…`);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/evidence/upload", { method: "POST", body: form });
      if (!res.ok) throw new Error(`upload status ${res.status}`);
      const payload = (await res.json()) as EvidencePayload;
      setEvidenceItems((prev) => [payload, ...prev.filter((x) => x.source !== payload.source)].slice(0, 6));
      await refreshState();
      return payload;
    } catch {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "evidence.txt";
      const relPath = `inbox/${safeName}`;
      const isPhoto = /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(safeName);
      let findings: string[] = [];
      if (!isPhoto) {
        try {
          const text = await file.text();
          findings = text
            .split(/\r?\n/)
            .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
            .filter(Boolean)
            .slice(0, 5);
          applyDemoFileWrite({ path: relPath, content: text });
        } catch {
          findings = [];
        }
      } else {
        applyDemoFileWrite({ path: relPath, content: `[Photo evidence: ${safeName} (${file.size} bytes)]` });
      }
      if (!findings.length) {
        findings = isPhoto
          ? [
              `Captured stockroom photo \`${relPath}\` (${file.size.toLocaleString()} bytes) in workspace inbox.`,
              "Visual packaging / hardware damage attachment linked for vendor claim verification.",
            ]
          : [`Stored workspace evidence document \`${relPath}\` (${file.size.toLocaleString()} bytes).`];
      }
      const fallback: EvidencePayload = {
        source: relPath,
        kind: isPhoto ? "photo" : "document",
        findings,
      };
      setEvidenceItems((prev) => [fallback, ...prev.filter((x) => x.source !== fallback.source)].slice(0, 6));
      setNarration(`Extracted ${fallback.findings.length} audit finding(s) from \`${relPath}\`.`);
      return fallback;
    } finally {
      setUploadingEvidence(false);
    }
  };

  const dismissEvidence = (source: string) => {
    setEvidenceItems((prev) => prev.filter((item) => item.source !== source));
  };

  const replayConsultTurn = (text: string) => {
    if (checkIsMobileRoute() || !windowsEnabledRef.current || isMobileCallManagingAudio()) return;
    speakCallTurn(
      "agent",
      text,
      {
        onStart: () => {
          setSpeaking(true);
          setOperatorConsult((c) => (c ? { ...c, activeSpeaker: "agent" } : c));
        },
        onEnd: () => {
          setSpeaking(false);
          setOperatorConsult((c) => (c && c.activeSpeaker === "agent" ? { ...c, activeSpeaker: null } : c));
        },
      },
      true
    );
  };

  const replayTurnAudio = (speaker: "agent" | "counterparty" | "user", text: string) => {
    if (checkIsMobileRoute() || !windowsEnabledRef.current || isMobileCallManagingAudio()) return;
    speakCallTurn(
      speaker,
      text,
      {
        onStart: () => {
          setSpeaking(true);
          setOperatorConsult((c) => (c ? { ...c, activeSpeaker: speaker } : c));
        },
        onEnd: () => {
          setSpeaking(false);
          setOperatorConsult((c) => (c && c.activeSpeaker === speaker ? { ...c, activeSpeaker: null } : c));
        },
      },
      true
    );
  };

  const escalateToPhone = async (reqIdArg?: string | null, claimIdArg?: string) => {
    stopSpeaking();
    setSpeaking(false);
    phoneTransferredRef.current = true;
    phoneCallActiveRef.current = true;
    markPhoneCallActive();
    setOperatorConsult((prev) => (prev ? { ...prev, channel: "iphone_transferred" } : prev));
    const pending = pendingApprovalRef.current ?? pendingApproval;
    const reqId = reqIdArg ?? pending?.req_id ?? null;

    // 1. Explicit argument
    let extractedClaimId: string | null = claimIdArg || null;
    let extractedClaimAmount: number | null = null;

    // 2. Extract from pendingApproval?.args (e.g. args.row?.id, args.claim_id, args.id, args.row?.amount, args.amount)
    const args = (pending?.args ?? {}) as Record<string, unknown>;
    const row = (args.row ?? {}) as Record<string, unknown>;

    if (!extractedClaimId) {
      if (typeof row.id === "string" && row.id.trim()) {
        extractedClaimId = row.id.trim();
      } else if (typeof args.claim_id === "string" && args.claim_id.trim()) {
        extractedClaimId = args.claim_id.trim();
      } else if (typeof args.id === "string" && args.id.trim()) {
        extractedClaimId = args.id.trim();
      }
    }

    if (extractedClaimAmount === null) {
      const rawAmt = row.amount ?? row.amount_eur ?? args.amount ?? args.amount_eur ?? args.claim_amount;
      if (typeof rawAmt === "number" && !Number.isNaN(rawAmt)) {
        extractedClaimAmount = rawAmt;
      } else if (typeof rawAmt === "string") {
        const parsed = parseFloat(rawAmt.replace(/[^0-9.]/g, ""));
        if (!Number.isNaN(parsed)) extractedClaimAmount = parsed;
      }
    }

    // 3. Regex fallback on pendingApproval?.diff_preview / risk_reason / spoken_summary
    const pendingText = [pending?.diff_preview, pending?.risk_reason, pending?.spoken_summary]
      .filter(Boolean)
      .join(" ");

    if (!extractedClaimId && pendingText) {
      const match = pendingText.match(/\b(CLM-[A-Z0-9-]+)\b/i);
      if (match) {
        extractedClaimId = match[1].toUpperCase();
      }
    }

    if (extractedClaimAmount === null && pendingText) {
      const match = pendingText.match(/(?:EUR|€)\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (match) {
        const parsed = parseFloat(match[1]);
        if (!Number.isNaN(parsed)) extractedClaimAmount = parsed;
      }
    }

    // 4. wsStateRef.current?.tables?.claims (matching claimId ONLY — do NOT blindly pick Kappa CLM-D-1042 if pendingApproval is for CLM-3005!)
    const claimsRows = (wsStateRef.current?.tables?.claims ?? []) as Record<string, unknown>[];
    if (extractedClaimId) {
      const matchingRow = claimsRows.find((r) => String(r.id ?? "").toUpperCase() === extractedClaimId?.toUpperCase());
      if (matchingRow && extractedClaimAmount === null) {
        const rowAmt = Number(matchingRow.amount ?? matchingRow.amount_eur ?? NaN);
        if (!Number.isNaN(rowAmt)) extractedClaimAmount = rowAmt;
      }
    } else {
      const latestClaim = claimsRows[claimsRows.length - 1];
      if (latestClaim) {
        extractedClaimId = String(latestClaim.id ?? "");
        extractedClaimAmount = Number(latestClaim.amount ?? latestClaim.amount_eur ?? 587.3);
      }
    }

    const claimId = extractedClaimId || "CLM-D-1042";
    const claimAmount = extractedClaimAmount !== null && !Number.isNaN(extractedClaimAmount) ? extractedClaimAmount : 587.3;

    stopSpeaking();
    setSpeaking(false);
    setNarration(`Operator away from desk — ringing mobile phone to resolve \`${claimId}\`…`);

    if (modeRef.current === "demo" || (reqId && reqId.startsWith("req_demo"))) {
      for (const ev of mockUserConsultStartEvents(reqId, claimId, claimAmount)) {
        applyRef.current(ev);
      }
      return;
    }
    try {
      const res = await fetch("/api/call/user-consult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ req_id: reqId, claim_id: claimId, claim_amount: claimAmount }),
      });
      if (!res.ok) throw new Error(`consult failed (${res.status})`);
    } catch {
      for (const ev of mockUserConsultStartEvents(reqId, claimId, claimAmount)) {
        applyRef.current(ev);
      }
    }
  };

  const respondOperatorConsult = async (
    choice: OperatorChoice,
    reqIdArg?: string | null,
    claimIdArg?: string
  ) => {
    const reqId = reqIdArg ?? pendingApprovalRef.current?.req_id ?? pendingApproval?.req_id ?? operatorConsult?.reqId ?? null;
    const claimId = claimIdArg || operatorConsult?.claimId || "CLM-D-1042";
    const agreedAmount = choice === "refund" ? 587.3 : 202.3;
    const aadePath = `aade/mydata_${claimId}.xml`;

    const activeChannel = phoneTransferredRef.current ? "iphone_transferred" : "desktop_voice";
    stopSpeaking();
    setOperatorConsult((prev) => (prev ? { ...prev, selectedChoice: choice, channel: activeChannel } : prev));

    const runDemoFallback = () => {
      if (reqId && (modeRef.current === "demo" || reqId.startsWith("req_demo"))) {
        void decide(reqId, true);
      }
      const xml = buildDemoAadeXml(claimId, choice);
      applyDemoFileWrite({ path: aadePath, content: xml });
      applyDemoUpsert({
        table: "claims",
        pk_col: "id",
        row: {
          id: claimId,
          supplier_id: "SUP-KAPPA",
          delivery_id: "D-1042",
          invoice_id: "INV-7781",
          amount: agreedAmount,
          reason:
            choice === "refund"
              ? "EUR 587.30 refund hold + AADE myDATA 5.1 credit note staged"
              : "22-unit next-day replacement + EUR 202.30 credit (AADE myDATA 9.3)",
          status: "settled",
        },
      });
      setWsState((ws) => {
        if (!ws) return ws;
        const baseStep = ws.undo_stack.length;
        const entries = [
          {
            step: baseStep + 1,
            tool: "write_file",
            summary: `Staged Greek AADE myDATA XML ${aadePath}`,
            args: { path: aadePath },
            ts: Date.now(),
          },
          {
            step: baseStep + 2,
            tool: "upsert_row",
            summary: `Updated claims #${claimId} (${choice}, EUR ${agreedAmount.toFixed(2)})`,
            args: { table: "claims", pk_col: "id", row: { id: claimId, status: "settled", amount: agreedAmount } },
            ts: Date.now() + 1,
          },
        ];
        const updated: WorkspaceState = { ...ws, undo_stack: [...ws.undo_stack, ...entries] };
        wsStateRef.current = updated;
        return updated;
      });
      spawnWindow({ ...fileWindow(aadePath, xml), manual: false, instant: false });
      for (const ev of mockUserConsultRespondEvents(choice, claimId)) {
        applyRef.current(ev);
      }
    };

    if (modeRef.current === "demo" || (reqId && reqId.startsWith("req_demo"))) {
      runDemoFallback();
      return;
    }

    try {
      const res = await fetch("/api/call/user-respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice, req_id: reqId, claim_id: claimId, channel: activeChannel }),
      });
      if (!res.ok) throw new Error(`respond failed (${res.status})`);
      const data = (await res.json().catch(() => null)) as { ok?: boolean; turn?: CallTurnPayload; keep_call_open?: boolean } | null;
      if (data?.turn?.ui_action) {
        executeUiAction(data.turn.ui_action);
      }
      await refreshState();
    } catch {
      runDemoFallback();
    }
  };

  const sendDesktopVoiceTurn = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    userInitiatedVoiceRef.current = true;
    setVoiceInitiated(true);

    const normVoice = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const nowVoice = Date.now();
    if (lastSentVoiceTurnRef.current && nowVoice - lastSentVoiceTurnRef.current.ts < 4200) {
      const a = normVoice(trimmed);
      const b = normVoice(lastSentVoiceTurnRef.current.text);
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (a && b && (a === b || (shorter.length >= 6 && longer.includes(shorter)))) {
        return;
      }
    }
    lastSentVoiceTurnRef.current = { text: trimmed, ts: nowVoice };

    phoneCallActiveRef.current = false;
    phoneTransferredRef.current = false;

    // Barge-in: stop any playing speech
    stopSpeaking();
    setSpeaking(false);

    const pending = pendingApprovalRef.current ?? pendingApproval;
    const reqId = pending?.req_id ?? operatorConsult?.reqId ?? null;

    // Smart claim extraction (identical to escalateToPhone)
    let extractedClaimId: string | null = operatorConsult?.claimId || null;
    let extractedClaimAmount: number | null = operatorConsult?.claimAmount || null;

    const args = (pending?.args ?? {}) as Record<string, unknown>;
    const row = (args.row ?? {}) as Record<string, unknown>;

    if (!extractedClaimId) {
      if (typeof row.id === "string" && row.id.trim()) {
        extractedClaimId = row.id.trim();
      } else if (typeof args.claim_id === "string" && args.claim_id.trim()) {
        extractedClaimId = args.claim_id.trim();
      } else if (typeof args.id === "string" && args.id.trim()) {
        extractedClaimId = args.id.trim();
      }
    }

    if (extractedClaimAmount === null) {
      const rawAmt = row.amount ?? row.amount_eur ?? args.amount ?? args.amount_eur ?? args.claim_amount;
      if (typeof rawAmt === "number" && !Number.isNaN(rawAmt)) {
        extractedClaimAmount = rawAmt;
      } else if (typeof rawAmt === "string") {
        const parsed = parseFloat(rawAmt.replace(/[^0-9.]/g, ""));
        if (!Number.isNaN(parsed)) extractedClaimAmount = parsed;
      }
    }

    const pendingText = [pending?.diff_preview, pending?.risk_reason, pending?.spoken_summary]
      .filter(Boolean)
      .join(" ");

    if (!extractedClaimId && pendingText) {
      const match = pendingText.match(/\b(CLM-[A-Z0-9-]+)\b/i);
      if (match) {
        extractedClaimId = match[1].toUpperCase();
      }
    }

    const claimsRows = (wsStateRef.current?.tables?.claims ?? []) as Record<string, unknown>[];
    if (extractedClaimId) {
      const matchingRow = claimsRows.find((r) => String(r.id ?? "").toUpperCase() === extractedClaimId?.toUpperCase());
      if (matchingRow && extractedClaimAmount === null) {
        const rowAmt = Number(matchingRow.amount ?? matchingRow.amount_eur ?? NaN);
        if (!Number.isNaN(rowAmt)) extractedClaimAmount = rowAmt;
      }
    } else {
      const latestClaim = claimsRows[claimsRows.length - 1];
      if (latestClaim) {
        extractedClaimId = String(latestClaim.id ?? "");
        extractedClaimAmount = Number(latestClaim.amount ?? latestClaim.amount_eur ?? 587.3);
      }
    }

    const claimId = extractedClaimId || "CLM-D-1042";

    const runDemoVoiceFallback = async () => {
      if (/\b(no\s+thanks|nothing\s+else|that'?s\s+all|that\s+is\s+all|all\s+good|all\s+set|all\s+done|we'?re\s+good|i'?m\s+good|bye|goodbye|hang\s*up)\b/i.test(trimmed)) {
        const closeReply = "Awesome—everything's applied and undo-protected. Talk soon!";
        setOperatorConsult((prev) =>
          prev
            ? {
                ...prev,
                active: false,
                ringing: false,
                callStatus: "ended",
                activeSpeaker: null,
                turns: [
                  ...prev.turns,
                  { speaker: "user", text: trimmed, audioUrl: null, ts: Date.now() / 1000 },
                  { speaker: "agent", text: closeReply, audioUrl: null, ts: Date.now() / 1000 + 0.05 },
                ],
                end: prev.end ?? {
                  call_id: prev.callId || `CONSULT-${claimId}`,
                  outcome: "accepted",
                  agreed_amount: prev.claimAmount ?? 587.3,
                  summary: "Operator consult session completed cleanly.",
                },
              }
            : prev
        );
        setNarration("✓ Audit & voice session finished cleanly — all changes committed to live ERP & one-click undo ready.");
        return;
      }
      if (/redeliver|replace|re-deliver|22|hubs|tomorrow/i.test(trimmed)) {
        await respondOperatorConsult("redelivery", reqId, claimId);
        return;
      }
      if (/approve|refund|enforce|confirm|accept|credit\s*note|hold/i.test(trimmed)) {
        await respondOperatorConsult("refund", reqId, claimId);
        return;
      }

      // Conversational inquiry turn
      const replyText = `Understood. Staging resolution for claim ${claimId}. Say 'approve' or 'refund' to commit EUR 587.30, or 'replace' for 22 units redelivery.`;
      const userTurn: OperatorConsultTurn = {
        speaker: "user",
        text: trimmed,
        audioUrl: null,
        ts: Date.now() / 1000,
      };
      const agentTurn: OperatorConsultTurn = {
        speaker: "agent",
        text: replyText,
        audioUrl: null,
        ts: Date.now() / 1000 + 0.1,
      };
      setOperatorConsult((prev) => {
        const base: OperatorConsultState = prev ?? {
          active: true,
          ringing: false,
          callStatus: "connected",
          connectedAt: Date.now(),
          mode: "user_consult",
          channel: "desktop_voice",
          callId: `CONSULT-${claimId}`,
          reqId,
          claimId,
          claimAmount: 587.3,
          counterparty: "Operator Desktop",
          turns: [],
          activeSpeaker: null,
          selectedChoice: null,
          lastUiAction: null,
          end: null,
          irisGate: null,
        };
        return {
          ...base,
          active: true,
          ringing: false,
          callStatus: "connected",
          channel: "desktop_voice",
          turns: [...base.turns, userTurn, agentTurn],
        };
      });

      const turnKey = `agent:${replyText.trim()}`;
      if (
        lastSpokenTurnKeyRef.current !== turnKey &&
        voiceRef.current &&
        !checkIsMobileRoute() &&
        windowsEnabledRef.current &&
        !isMobileCallManagingAudio() &&
        !phoneCallActiveRef.current
      ) {
        lastSpokenTurnKeyRef.current = turnKey;
        lastAgentTurnSpokenAtRef.current = Date.now();
        speakCallTurn(
          "agent",
          replyText,
          {
            onStart: () => {
              setSpokenText(replyText);
              setSpeechProgress(0);
              setSpeaking(true);
              setOperatorConsult((c) => (c ? { ...c, activeSpeaker: "agent" } : c));
            },
            onEnd: () => {
              setSpeaking(false);
              setSpeechProgress(1);
              setOperatorConsult((c) => (c && c.activeSpeaker === "agent" ? { ...c, activeSpeaker: null } : c));
            },
            onProgress: (f) => setSpeechProgress((p) => Math.max(p, f)),
          },
          true
        );
      }
    };

    if (modeRef.current === "demo" || (reqId && reqId.startsWith("req_demo"))) {
      await runDemoVoiceFallback();
      return;
    }

    try {
      const res = await fetch("/api/call/user-respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: trimmed,
          req_id: reqId,
          claim_id: claimId,
          channel: "desktop_voice",
        }),
      });
      if (!res.ok) throw new Error(`user-respond failed (${res.status})`);
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        keep_call_open?: boolean;
        call_status?: "ringing" | "connected" | "ended";
        outcome?: "accepted" | "rejected" | "escalated";
        agreed_amount?: number | null;
        reply_text?: string;
        confirmation_text?: string;
        ui_action?: UiActionPayload;
        turn?: CallTurnPayload;
      } | null;

      if (data?.keep_call_open === false || data?.call_status === "ended") {
        setOperatorConsult((prev) =>
          prev
            ? {
                ...prev,
                active: false,
                ringing: false,
                callStatus: "ended",
                activeSpeaker: null,
                end: prev.end ?? {
                  call_id: prev.callId || `CONSULT-${claimId}`,
                  outcome: data?.outcome ?? "accepted",
                  agreed_amount: data?.agreed_amount ?? prev.claimAmount ?? null,
                  summary: "Operator consult session completed cleanly.",
                },
              }
            : prev
        );
        if ((data?.outcome ?? "accepted") === "accepted") {
          setNarration("✓ Audit & voice session finished cleanly — all changes committed to live ERP & one-click undo ready.");
        }
      }

      if (data?.ui_action) {
        executeUiAction(data.ui_action);
      }

      const agentReply = data?.reply_text || data?.confirmation_text || data?.turn?.text;
      if (agentReply) {
        const turnKey = `agent:${agentReply.trim()}`;
        if (
          lastSpokenTurnKeyRef.current !== turnKey &&
          voiceRef.current &&
          !checkIsMobileRoute() &&
          windowsEnabledRef.current &&
          !isMobileCallManagingAudio() &&
          !phoneCallActiveRef.current
        ) {
          lastSpokenTurnKeyRef.current = turnKey;
          lastAgentTurnSpokenAtRef.current = Date.now();
          speakCallTurn(
            "agent",
            agentReply,
            {
              onStart: () => {
                setSpokenText(agentReply);
                setSpeechProgress(0);
                setSpeaking(true);
                setOperatorConsult((c) => (c ? { ...c, activeSpeaker: "agent" } : c));
              },
              onEnd: () => {
                setSpeaking(false);
                setSpeechProgress(1);
                setOperatorConsult((c) => (c && c.activeSpeaker === "agent" ? { ...c, activeSpeaker: null } : c));
              },
              onProgress: (f) => setSpeechProgress((p) => Math.max(p, f)),
            },
            true
          );
        }
      }
      await refreshState();
    } catch {
      await runDemoVoiceFallback();
    }
  };

  const startDesktopConsult = useCallback(
    (reqIdArg?: string | null, claimIdArg?: string, claimAmountArg?: number | null, isKappaArg?: boolean) => {
      userInitiatedVoiceRef.current = true;
      setVoiceInitiated(true);
      phoneCallActiveRef.current = false;
      phoneTransferredRef.current = false;

      const pending = pendingApprovalRef.current ?? pendingApproval;
      const reqId = reqIdArg ?? pending?.req_id ?? operatorConsult?.reqId ?? null;
      const claimId = claimIdArg || operatorConsult?.claimId || "CLM-D-1042";
      const amt =
        typeof claimAmountArg === "number" && claimAmountArg > 0
          ? claimAmountArg
          : operatorConsult?.claimAmount ?? 587.3;
      const isKappa =
        typeof isKappaArg === "boolean"
          ? isKappaArg
          : claimId === "CLM-D-1042" || /kappa|1042/i.test(claimId);

      const corpus = [pending?.risk_reason, pending?.diff_preview, pending?.spoken_summary]
        .filter(Boolean)
        .join(" ");

      let openingLine: string;
      if (isKappa) {
        openingLine =
          "Hey! Kappa's delivery is short 22 hubs—they owe us 587 euros. Should I demand the full refund, or take replacement hubs?";
      } else if (/atlas|d-3005|inv-9901/i.test(corpus) || /3005/i.test(claimId)) {
        openingLine =
          "Hey! We audited Atlas Paper & Stationery delivery D-3005 and found a 500 euro discrepancy on invoice INV-9901. Should I enforce the 500 euro claim and email the supplier, or hold off?";
      } else if (/orion|d-2010|inv-8801/i.test(corpus) || /2010/i.test(claimId)) {
        openingLine =
          "Hey! We audited Orion Breakroom Supplies Ltd. delivery D-2010 and found a 14.7 euro discrepancy on invoice INV-8801. Should I enforce the 14.7 euro claim and email the supplier, or hold off?";
      } else if (/d-1017|d-1031|followup/i.test(corpus) || /followup/i.test(claimId)) {
        openingLine =
          "Hey! I audited paid Kappa shipments D-1017 and D-1031 and rehearsed a 175 euro SLA credit recovery. Should I enforce the 175 euro claim and email Kappa, or hold off?";
      } else if (
        pending?.spoken_summary &&
        !/say approve to commit/i.test(pending.spoken_summary) &&
        pending.spoken_summary.trim().length > 12
      ) {
        openingLine = pending.spoken_summary.trim();
      } else {
        const amtText = amt > 0 ? ` for ${amt % 1 === 0 ? amt : amt.toFixed(2)} euros` : "";
        openingLine = `Hey! I staged claim ${claimId}${amtText} at the Decision Gate. Should I enforce the claim and email the supplier, or hold off?`;
      }

      setOperatorConsult((prev) => {
        const hasAgentTurn = Boolean(prev?.turns?.some((t) => t.speaker === "agent"));
        const nextTurns: OperatorConsultTurn[] = hasAgentTurn
          ? prev!.turns
          : [
              ...(prev?.turns ?? []),
              {
                speaker: "agent",
                text: openingLine,
                audioUrl: "/api/voice/turn-audio",
                ts: Date.now() / 1000,
              },
            ];
        return {
          active: true,
          ringing: false,
          callStatus: "connected",
          connectedAt: prev?.connectedAt ?? Date.now(),
          mode: "user_consult",
          channel: "desktop_voice",
          callId: prev?.callId || `CONSULT-${claimId}`,
          reqId,
          claimId,
          claimAmount: amt,
          counterparty: "Operator",
          turns: nextTurns,
          activeSpeaker: "agent",
          selectedChoice: prev?.selectedChoice ?? null,
          lastUiAction: prev?.lastUiAction ?? null,
          end: null,
          irisGate: prev?.irisGate ?? null,
        };
      });

      lastSpokenTurnKeyRef.current = `agent:${openingLine.trim()}`;
      lastAgentTurnSpokenAtRef.current = Date.now();
      speakCallTurn(
        "agent",
        openingLine,
        {
          onStart: () => {
            setSpokenText(openingLine);
            setSpeechProgress(0);
            setSpeaking(true);
            setOperatorConsult((c) => (c ? { ...c, activeSpeaker: "agent" } : c));
          },
          onEnd: () => {
            setSpeaking(false);
            setSpeechProgress(1);
            setOperatorConsult((c) => (c && c.activeSpeaker === "agent" ? { ...c, activeSpeaker: null } : c));
          },
          onProgress: (f) => setSpeechProgress((p) => Math.max(p, f)),
        },
        true
      );
    },
    [operatorConsult, pendingApproval]
  );

  const pickupCall = useCallback(async () => {
    phoneTransferredRef.current = true;
    phoneCallActiveRef.current = true;
    markPhoneCallActive();
    if (windowsEnabledRef.current) {
      stopSpeaking();
      setSpeaking(false);
    }
    try {
      const res = await fetch("/api/call/pickup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: operatorConsult?.callId }),
      });
      if (res.ok) {
        setOperatorConsult((prev) =>
          prev ? { ...prev, ringing: false, callStatus: "connected", connectedAt: prev.connectedAt ?? Date.now(), channel: "iphone_transferred" } : prev
        );
      }
    } catch {
      setOperatorConsult((prev) =>
        prev ? { ...prev, ringing: false, callStatus: "connected", connectedAt: prev.connectedAt ?? Date.now(), channel: "iphone_transferred" } : prev
      );
    }
  }, [markPhoneCallActive, operatorConsult?.callId]);

  const reset = async () => {
    phoneCallActiveRef.current = false;
    phoneTransferredRef.current = false;
    if (phoneCooldownTimerRef.current !== null) {
      window.clearTimeout(phoneCooldownTimerRef.current);
      phoneCooldownTimerRef.current = null;
    }
    lastAgentTurnSpokenAtRef.current = 0;
    lastSpokenTurnKeyRef.current = null;
    lastUiActionRef.current = null;
    lastPolledUiActionSigRef.current = null;
    lastSentVoiceTurnRef.current = null;
    deferredApprovalRef.current = null;
    clearWorkspaceUi();
    setMode("live");
    try {
      await fetch("/api/reset", { method: "POST" });
    } catch {
      // ignore
    }
    await refreshState();
  };

  // ---------------------------------------------------------------- derived
  const totalCost = useMemo(() => {
    const eventsSum = events.reduce((acc, e) => acc + (e.cost_eur || 0), 0);
    return Math.max(wsState?.metrics?.cost_eur ?? 0, eventsSum);
  }, [events, wsState?.metrics?.cost_eur]);
  const stepCount = useMemo(() => events.filter((e) => e.type === "tool_call").length, [events]);
  const forgedTools = useMemo(() => {
    let list: { name: string; description: string; uses: number }[] = [];
    if (wsState?.forged_tools && wsState.forged_tools.length > 0) list = wsState.forged_tools;
    else if (forgeTest?.registered && forgeSpec) list = [{ name: forgeSpec.name, description: forgeSpec.purpose, uses: 1 }];
    return list.filter((t) => !landing.includes(t.name));
  }, [wsState, forgeTest, forgeSpec, landing]);

  const brand: Brand = useMemo(() => brandOf(wsState?.domain), [wsState?.domain]);

  const graph = useMemo(
    () =>
      buildThoughtGraph({
        plan,
        events,
        forgeSpec,
        forgeTest,
        forgedTools,
        report,
        verify,
        pendingApproval,
        offer,
        wsState,
        runStatus,
      }),
    [plan, events, forgeSpec, forgeTest, forgedTools, report, verify, pendingApproval, offer, wsState, runStatus]
  );

  return {
    speed,
    setSpeed,
    voiceOn,
    voiceInitiated,
    toggleVoice,
    speaking,
    lastBriefing,
    spokenText,
    speechProgress,
    brand,
    replayBriefing,
    events,
    rehearsalActive,
    plan,
    forgeSpec,
    forgeTest,
    forgedCode,
    report,
    verify,
    pendingApproval,
    offer,
    wsState,
    connected,
    mode,
    stage,
    stageDone,
    runStatus,
    runStartedAt,
    narration,
    windows,
    pulses,
    rowMarks,
    ghostRows,
    fileMarks,
    rewind,
    queued,
    totalCost,
    stepCount,
    forgedTools,
    graph,
    evidenceItems,
    uploadingEvidence,
    uploadEvidence,
    dismissEvidence,
    replayTurnAudio,
    operatorConsult,
    startDesktopConsult,
    escalateToPhone,
    respondOperatorConsult,
    sendDesktopVoiceTurn,
    replayConsultTurn,
    triggerGoal,
    runStageDemo,
    runDemo,
    decide,
    acceptOffer,
    dismissOffer,
    undo,
    reset,
    openFile,
    openDiff,
    openOutbox,
    openForged,
    dockWindow,
    togglePin,
    requestedDeckView,
    requestedDbTable,
    resetSeq,
    pickupCall,
    executeUiAction,
  };
}

export type RecoupRuntime = ReturnType<typeof useRecoup>;
