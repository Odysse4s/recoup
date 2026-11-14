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
  type RewindState,
  type Row,
  type RowMark,
  type RunStatus,
  type StageId,
  type WorkspaceState,
} from "../lib/types";
import { usePersistentState } from "../lib/usePersistentState";
import { speakBriefing, speakCallTurn, stopSpeaking } from "../lib/voice";
import { diffWindow, fileWindow, forgeSpecWindow, forgeWindow, outboxWindow, toolWindow } from "../lib/windows";
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
] as const;

const MAX_LIVE_WINDOWS = 3;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

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
  const [verify, setVerify] = useState<VerifyPayload | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalNeededPayload | null>(null);
  const [offer, setOffer] = useState<AnticipateOfferPayload | null>(null);
  const [wsState, setWsState] = useState<WorkspaceState | null>(null);
  const [connected, setConnected] = useState(false);
  const [mode, setModeState] = useState<"live" | "demo">("live");
  const [stage, setStage] = useState<StageId | null>(null);
  const [stageDone, setStageDone] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [narration, setNarration] = useState(IDLE_NARRATION);
  const [windows, setWindows] = useState<LiveWin[]>([]);
  const windowsRef = useRef<LiveWin[]>([]);
  windowsRef.current = windows;
  const forgeFallbackTimerRef = useRef<number | null>(null);
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
  const executeUiActionRef = useRef<((uiAction: UiActionPayload) => void) | null>(null);
  const lastUiActionRef = useRef<{ key: string; ts: number } | null>(null);

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
  const phoneCooldownTimerRef = useRef<number | null>(null);

  const markPhoneCallActive = useCallback(() => {
    if (phoneCooldownTimerRef.current !== null) {
      window.clearTimeout(phoneCooldownTimerRef.current);
      phoneCooldownTimerRef.current = null;
    }
    phoneCallActiveRef.current = true;
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
      phoneCooldownTimerRef.current = null;
    }, 8000);
  }, []);

  useEffect(() => {
    const isConsultActive = Boolean(operatorConsult?.active || operatorConsult?.ringing);
    if (isConsultActive) {
      markPhoneCallActive();
    } else if (operatorConsult?.end) {
      markPhoneCallEnded();
    }
  }, [operatorConsult?.active, operatorConsult?.ringing, operatorConsult?.end, markPhoneCallActive, markPhoneCallEnded]);

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
      if (!voiceRef.current) return;
      if (windowsEnabledRef.current && phoneCallActiveRef.current) return;
      speakBriefing(text, kind, speechHooks(text), interrupt);
    },
    [speechHooks]
  );

  const replayBriefing = useCallback(() => {
    if (!lastBriefing) return;
    if (windowsEnabledRef.current && phoneCallActiveRef.current) return;
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

        // Hydrate pending approval
        const nextPending = data.pending_approval ?? (data.pending_approvals?.length ? data.pending_approvals[0] : null);
        if (nextPending) {
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
            setRunStatus((curr) => (curr === "running" || curr === "idle" ? "awaiting" : curr));
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
              setRunStatus((curr) => (curr === "running" || curr === "idle" ? "awaiting" : curr));
            }
          }
        } else if (modeRef.current === "live") {
          deferredApprovalRef.current = null;
          setPendingApproval(null);
        }

        // Hydrate active call
        if (data.active_call) {
          const ac = data.active_call;
          const mappedTurns = (ac.turns ?? []).map((t) => ({
            speaker: t.speaker,
            text: t.text,
            audioUrl: t.audio_url ?? null,
            ts: t.ts ?? Date.now() / 1000,
          }));
          const isConnected = ac.call_status === "connected" || (!ac.ringing && ac.active);
          setOperatorConsult((prev) => {
            const prevCount = prev?.turns.length ?? 0;
            if (!windowsEnabledRef.current && voiceRef.current && mappedTurns.length > prevCount) {
              const newTurn = mappedTurns[mappedTurns.length - 1];
              if (newTurn && newTurn.speaker === "agent" && newTurn.text) {
                speakCallTurn("agent", newTurn.text, {
                  onStart: () => setSpeaking(true),
                  onEnd: () => setSpeaking(false),
                });
              }
            }
            return {
              active: Boolean(ac.active),
              ringing: Boolean(ac.ringing) && ac.call_status !== "connected",
              callStatus: ac.call_status ?? (isConnected ? "connected" : ac.ringing ? "ringing" : undefined),
              connectedAt: ac.connected_at ? ac.connected_at * 1000 : (isConnected ? (prev?.connectedAt ?? Date.now()) : null),
              mode: "user_consult",
              channel: ac.channel ?? "voice_call",
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
            };
          });

          if (ac.last_ui_action) {
            executeUiActionRef.current?.(ac.last_ui_action);
          }
        } else if (data.active_call === null && modeRef.current === "live") {
          setOperatorConsult((prev) => (prev?.active ? null : prev));
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
  const spawnWindow = useCallback((w: LiveWin | null | undefined) => {
    if (!w || !windowsEnabledRef.current || (w.skipAutoPop && !w.manual)) return;
    if (!w.manual) liveCountRef.current += 1;
    if (w.toolName && !w.manual) setLanding((l) => [...l, w.toolName!]);
    setWindows((ws) => [...ws, w]);
    soundFx.playWindowPop();
  }, []);

  const dockWindow = useCallback((id: string, target: DockTarget | null) => {
    let existed = false;
    setWindows((ws) => {
      const w = ws.find((x) => x.id === id);
      if (w) existed = true;
      if (w?.toolName && !w.manual) setLanding((l) => l.filter((n) => n !== w.toolName));
      return ws.filter((x) => x.id !== id);
    });
    if (target && existed) {
      setPulses((p) => ({ ...p, [target]: p[target] + 1 }));
      soundFx.playWindowDock();
    }
  }, []);

  const togglePin = useCallback((id: string) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w)));
  }, []);

  const openFile = useCallback((path: string, content: string) => spawnWindow(fileWindow(path, content)), [spawnWindow]);

  const openDiff = useCallback(
    (path: string, diff: string, created: boolean) => spawnWindow(diffWindow(path, diff, created)),
    [spawnWindow]
  );

  const openOutbox = useCallback(
    (item: Record<string, unknown>, index: number) => spawnWindow(outboxWindow(item, index)),
    [spawnWindow]
  );

  const openForged = useCallback(
    (name: string) => {
      const ft = forgedCode[name];
      if (ft) spawnWindow({ ...forgeWindow(ft), manual: true, origin: "vault" });
    },
    [forgedCode, spawnWindow]
  );

  const executeUiAction = useCallback(
    (uiAction: UiActionPayload) => {
      if (!uiAction || !uiAction.action) return;
      const actionKey = `${uiAction.action}:${uiAction.path || ""}:${uiAction.view || ""}:${uiAction.table || ""}:${uiAction.choice || ""}`;
      const now = Date.now();
      if (lastUiActionRef.current && lastUiActionRef.current.key === actionKey && now - lastUiActionRef.current.ts < 3000) {
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
        soundFx.playWindowPop();
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
        window.setTimeout(() => {
          setWindows((ws) => ws.map((w) => (w.pinned ? { ...w, pinned: false } : w)));
          void refreshState();
        }, 400);
      }
    },
    [report, spawnWindow, refreshState]
  );
  executeUiActionRef.current = executeUiAction;

  // ---------------------------------------------------------------- reducer
  const markPlan = (toolName: string, status: "running" | "done" | "failed") =>
    setPlan((prev) => {
      if (!prev) return prev;
      const match = (s: PlanPayload["steps"][number]) => s.tool === toolName || s.tool.endsWith(`:${toolName}`);
      const targetIdx =
        status === "running"
          ? prev.steps.findIndex((s) => match(s) && s.status !== "done")
          : prev.steps.findIndex((s) => match(s) && s.status === "running");
      const fallbackIdx = targetIdx >= 0 ? targetIdx : prev.steps.findIndex(match);
      if (fallbackIdx < 0) return prev;
      return {
        ...prev,
        steps: prev.steps.map((s, idx) => (idx === fallbackIdx ? { ...s, status } : s)),
      };
    });

  const applyEvent = (ev: ServerEvent) => {
    setEvents((prev) => [...prev.slice(-120), ev]);
    const activeBrandName = brandOf(wsStateRef.current?.domain).brand_name;
    const line = narrate(ev, activeBrandName);
    if (line) setNarration(line);
    const b = briefingFor(ev, activeBrandName);
    if (b) {
      const isVoiceCallApproval =
        ev.type === "approval_needed" &&
        ((ev.payload as unknown as ApprovalNeededPayload)?.channel === "voice_call" ||
          phoneCallActiveRef.current);
      if (windowsEnabledRef.current && (phoneCallActiveRef.current || isVoiceCallApproval)) {
        setLastBriefing(b);
      } else {
        brief(b, ev.type, ev.type === "approval_needed");
      }
    }

    switch (ev.type) {
      case "rehearse_start":
        setRehearsalActive(true);
        setVerify(null);
        setStage("plan");
        setStageDone(false);
        setRunStatus("running");
        setRunStartedAt((t) => t ?? Date.now());
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
        const isUserConsult = p.mode === "user_consult" || p.channel === "voice_call" || !p.mode;
        if (isUserConsult) {
          markPhoneCallActive();
          if (windowsEnabledRef.current) {
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
          channel: p.channel ?? "voice_call",
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
        }));
        if (!windowsEnabledRef.current && !isConnected) {
          soundFx.playIncomingCall();
        }
        break;
      }
      case "call_turn": {
        const turn = ev.payload as unknown as CallTurnPayload;
        markPhoneCallActive();
        if (windowsEnabledRef.current) {
          stopSpeaking();
          setSpeaking(false);
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
            channel: "voice_call",
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
          };
          const nextConnected = isConnected || base.callStatus === "connected" || !base.ringing;
          return {
            ...base,
            active: turn.keep_call_open !== false,
            ringing: isConnected ? false : base.ringing,
            callStatus: turn.call_status ?? (nextConnected ? "connected" : base.callStatus),
            connectedAt: nextConnected ? (base.connectedAt ?? Date.now()) : base.connectedAt,
            selectedChoice: inferredChoice ?? base.selectedChoice,
            turns: [
              ...base.turns,
              {
                speaker: turn.speaker,
                text: turn.text,
                audioUrl: turn.audio_url ?? null,
                ts: ev.ts || Date.now() / 1000,
              },
            ],
          };
        });

        if (turn.ui_action) {
          executeUiAction(turn.ui_action);
        }

        const shouldAutoSpeakTurn =
          voiceRef.current &&
          turn.speaker === "agent" &&
          Boolean(turn.text) &&
          !windowsEnabledRef.current;

        if (shouldAutoSpeakTurn && turn.text) {
          speakCallTurn("agent", turn.text, {
            onStart: () => {
              setSpeaking(true);
              setOperatorConsult((c) => (c ? { ...c, activeSpeaker: "agent" } : c));
            },
            onEnd: () => {
              setSpeaking(false);
              setOperatorConsult((c) => (c && c.activeSpeaker === "agent" ? { ...c, activeSpeaker: null } : c));
            },
          });
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
          soundFx.playCommitSuccess();
          if (modeRef.current !== "demo") {
            void refreshState().then((fresh) => {
              const xmlContent = fresh?.files?.[aadePath];
              if (xmlContent && windowsEnabledRef.current) {
                spawnWindow({ ...fileWindow(aadePath, xmlContent), manual: false, instant: false });
              }
            });
          }
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
            dockWindow(liveId, "vault");
            forgeFallbackTimerRef.current = null;
          }, 12000);
        }
        break;
      }
      case "forge_test": {
        const ft = ev.payload as unknown as ForgeTestPayload;
        setForgeTest(ft);
        setForgedCode((m) => ({ ...m, [ft.name]: ft }));
        setStage("forge");
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
            window.setTimeout(() => {
              dockWindow(liveId, "vault");
            }, 1600);
          } else {
            const winToSpawn = {
              ...fresh,
              id: liveId,
              pinned: false,
            };
            spawnWindow(winToSpawn);
            window.setTimeout(() => {
              dockWindow(liveId, "vault");
            }, 1600);
          }
        }
        break;
      }
      case "forge_registered":
        if (modeRef.current !== "demo") refreshState();
        break;
      case "tool_call": {
        const call = callOf(ev);
        setStage("rehearse");
        if (call?.name) {
          markPlan(call.name, "running");
          spawnWindow(toolWindow(call, ev.latency_ms || undefined));
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
      case "verify":
        setVerify(ev.payload as unknown as VerifyPayload);
        setStage("verify");
        break;
      case "rehearse_report":
        setReport((ev.payload as { report: ChangeReport }).report);
        setRehearsalActive(false);
        setStage("verify");
        break;
      case "approval_needed":
        deferredApprovalRef.current = null;
        setPendingApproval(ev.payload as unknown as ApprovalNeededPayload);
        setStage("gate");
        setRunStatus("awaiting");
        if (windowsEnabledRef.current) soundFx.playRiskGateAlert();
        else soundFx.playIncomingCall();
        break;
      case "approval_result": {
        deferredApprovalRef.current = null;
        const ok = Boolean((ev.payload as { approved?: boolean }).approved);
        setPendingApproval(null);
        setStage(ok ? "commit" : "gate");
        setRunStatus(ok ? "committing" : "aborted");
        if (!ok) soundFx.playRewindSweep(1);
        break;
      }
      case "replay_step_done":
        setStage("commit");
        setRunStatus("committing");
        if (modeRef.current !== "demo") refreshState();
        break;
      case "undo_step": {
        const p = ev.payload as { step?: number; tool?: string };
        setRewind((r) => (r ? { ...r, steps: [...r.steps, { step: Number(p.step ?? 0), tool: String(p.tool ?? "") }] } : r));
        break;
      }
      case "run_done": {
        const status = String((ev.payload as { status?: string }).status ?? "");
        setRehearsalActive(false);
        if (status === "committed") {
          setStage("commit");
          setStageDone(true);
          setRunStatus("committed");
          soundFx.playCommitSuccess();
        } else if (status === "aborted_by_human" || status === "blocked" || status === "timed_out") {
          setRunStatus("aborted");
        } else if (status === "error") {
          setRunStatus("error");
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
    const timer = window.setInterval(() => {
      const next = queueRef.current[0];
      if (!next) {
        if (deferredApprovalRef.current && windowsEnabledRef.current) {
          const deferred = deferredApprovalRef.current;
          deferredApprovalRef.current = null;
          setPendingApproval(deferred);
          setStage("gate");
          setRunStatus((curr) => (curr === "running" || curr === "idle" ? "awaiting" : curr));
        }
        return;
      }
      if (next.type === "approval_needed") {
        queueRef.current.shift();
        setQueued(queueRef.current.length);
        deferredApprovalRef.current = null;
        applyRef.current(next);
        return;
      }
      if (next.type === "call_start" || next.type === "call_turn") {
        queueRef.current.shift();
        setQueued(queueRef.current.length);
        applyRef.current(next);
        return;
      }
      const spawns =
        next.type === "forge_test" ||
        next.type === "forge_spec" ||
        next.type === "tool_call";
      const unpinnedCount = windowsRef.current.filter((w) => !w.pinned).length;
      if (spawns && unpinnedCount >= MAX_LIVE_WINDOWS) return;
      queueRef.current.shift();
      setQueued(queueRef.current.length);
      applyRef.current(next);
    }, PACE[speed].eventMs);
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
          if (parsed.type === "approval_result") {
            queueRef.current = queueRef.current.filter((q) => q.type !== "approval_needed");
            deferredApprovalRef.current = null;
            applyRef.current(parsed);
          } else if (parsed.type === "approval_needed") {
            // Do NOT instant-flush! Enqueue so prior tool/forge live windows pace out first!
            enqueue([parsed]);
          } else if (parsed.type === "call_start") {
            const p = parsed.payload as unknown as CallStartPayload;
            const isUserConsult = p?.mode === "user_consult" || p?.channel === "voice_call" || !p?.mode;
            if (isUserConsult) {
              markPhoneCallActive();
              stopSpeaking();
              setSpeaking(false);
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
            // Keep opening call_turn ordered behind queued call_start; dispatch live phone turns immediately
            if (queueRef.current.some((e) => e.type === "call_start")) {
              enqueue([parsed]);
            } else {
              applyRef.current(parsed);
            }
          } else if (
            parsed.type === "undo_step" ||
            parsed.type === "call_end" ||
            parsed.type === "run_done" ||
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
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- actions
  const clearRun = () => {
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
    try {
      const res = await fetch("/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goalText }),
      });
      if (!res.ok) throw new Error("backend error");
      setMode("live");
    } catch {
      setMode("demo");
      enqueue(mockEvents());
    }
  };

  const runStageDemo = async () => {
    clearRun();
    setRunStartedAt(Date.now());
    setRunStatus("running");
    const brandName = brandOf(wsStateRef.current?.domain).brand_name;
    setNarration(`Running fast live stage audit demo for ${brandName} shipment D-1042…`);
    try {
      const res = await fetch("/api/demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pace_ms: 900, anticipate_after: true }),
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
    stopSpeaking();
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
    try {
      const res = await fetch(`/api/offers/${offerId}/accept`, { method: "POST" });
      if (res.ok) {
        await refreshState();
      } else {
        setNarration(`Could not apply proactive offer (${res.status}). Workspace unchanged.`);
      }
    } catch {
      setNarration("Backend unreachable while applying proactive offer.");
    }
  };

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
    markPhoneCallActive();
    const reqId = reqIdArg ?? pendingApproval?.req_id ?? null;
    const claimsRows = wsStateRef.current?.tables?.claims ?? [];
    const latestClaim = claimsRows[claimsRows.length - 1];
    const claimId = claimIdArg || String(latestClaim?.id ?? "CLM-D-1042");
    const claimAmount = Number(latestClaim?.amount ?? 587.3);

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
        body: JSON.stringify({ req_id: reqId, claim_id: claimId }),
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
    const reqId = reqIdArg ?? pendingApproval?.req_id ?? operatorConsult?.reqId ?? null;
    const claimId = claimIdArg || operatorConsult?.claimId || "CLM-D-1042";
    const agreedAmount = choice === "refund" ? 587.3 : 202.3;
    const aadePath = `aade/mydata_${claimId}.xml`;

    stopSpeaking();
    setOperatorConsult((prev) => (prev ? { ...prev, selectedChoice: choice } : prev));

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
        body: JSON.stringify({ choice, req_id: reqId, claim_id: claimId }),
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

  const pickupCall = useCallback(async () => {
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
          prev ? { ...prev, ringing: false, callStatus: "connected", connectedAt: prev.connectedAt ?? Date.now() } : prev
        );
      }
    } catch {
      setOperatorConsult((prev) =>
        prev ? { ...prev, ringing: false, callStatus: "connected", connectedAt: prev.connectedAt ?? Date.now() } : prev
      );
    }
  }, [markPhoneCallActive, operatorConsult?.callId]);

  const reset = async () => {
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
    escalateToPhone,
    respondOperatorConsult,
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
    pickupCall,
    executeUiAction,
  };
}

export type RecoupRuntime = ReturnType<typeof useRecoup>;
