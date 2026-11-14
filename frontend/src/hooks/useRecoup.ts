import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnticipateOfferPayload,
  ApprovalNeededPayload,
  CallEndPayload,
  CallTurnPayload,
  ChangeReport,
  EvidencePayload,
  ForgeSpecPayload,
  ForgeTestPayload,
  PlanPayload,
  ServerEvent,
  VerifyPayload,
} from "../contracts";
import type { VendorCallState } from "../components/VendorCallPanel";
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
import { diffWindow, fileWindow, forgeWindow, outboxWindow, toolWindow } from "../lib/windows";
import {
  buildDemoAadeXml,
  mockDecisionEvents,
  mockEvents,
  mockUserConsultRespondEvents,
  mockUserConsultStartEvents,
  mockVendorCallEvents,
} from "../mockEvents";

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

const MAX_LIVE_WINDOWS = 2;
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
  const [vendorCall, setVendorCall] = useState<VendorCallState | null>(null);
  const [operatorConsult, setOperatorConsult] = useState<OperatorConsultState | null>(null);

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
      speakBriefing(text, kind, speechHooks(text), interrupt);
    },
    [speechHooks]
  );

  const replayBriefing = useCallback(() => {
    if (!lastBriefing) return;
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
        if (data.pending_offers.length > 0) setOffer(data.pending_offers[data.pending_offers.length - 1]);
        if (optsArg?.initial && data.pending_approvals.length > 0) {
          setPendingApproval(data.pending_approvals[0]);
          setStage("gate");
          setRunStatus("awaiting");
        }
        return data;
      } catch {
        return null;
      }
    },
    [markTables]
  );

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
    setWindows((ws) => {
      const w = ws.find((x) => x.id === id);
      if (w?.toolName && !w.manual) setLanding((l) => l.filter((n) => n !== w.toolName));
      return ws.filter((x) => x.id !== id);
    });
    if (target) {
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
    if (b) brief(b, ev.type, ev.type === "approval_needed");

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
        const p = ev.payload as {
          call_id?: string;
          mode?: "vendor" | "user_consult";
          req_id?: string | null;
          claim_id?: string;
          counterparty?: string;
          claim_amount?: number;
          opening_pct?: number;
          floor_pct?: number;
        };
        const callId = String(p.call_id ?? "CONSULT-CLM-D-1042");
        const isUserConsult = p.mode === "user_consult" || callId.startsWith("CONSULT-");
        if (isUserConsult) {
          setOperatorConsult({
            active: true,
            ringing: true,
            mode: "user_consult",
            callId,
            reqId: p.req_id ?? null,
            claimId: String(p.claim_id ?? "CLM-D-1042"),
            claimAmount: Number(p.claim_amount ?? 587.3),
            counterparty: String(p.counterparty ?? "Operator Mobile"),
            turns: [],
            activeSpeaker: null,
            selectedChoice: null,
            end: null,
          });
        } else {
          setVendorCall({
            active: true,
            dialing: false,
            callId,
            claimId: String(p.claim_id ?? "CLM-D-1042"),
            counterparty: String(p.counterparty ?? "Kappa Office Systems AR desk"),
            claimAmount: Number(p.claim_amount ?? 587.3),
            openingPct: Number(p.opening_pct ?? 70),
            floorPct: Number(p.floor_pct ?? 85),
            turns: [],
            activeSpeaker: null,
            end: null,
          });
        }
        break;
      }
      case "call_turn": {
        const turn = ev.payload as unknown as CallTurnPayload;
        const callId = String(turn.call_id ?? "");
        const isUserConsult = callId.startsWith("CONSULT-") || turn.speaker === "user";
        if (isUserConsult) {
          const inferredChoice: OperatorChoice | null =
            turn.speaker === "user"
              ? /redeliver|re-deliver|replace|22|hubs|tomorrow/i.test(turn.text)
                ? "redelivery"
                : "refund"
              : null;
          setOperatorConsult((prev) => {
            const claimId = callId.replace(/^CONSULT-/, "") || prev?.claimId || "CLM-D-1042";
            const base: OperatorConsultState = prev ?? {
              active: true,
              ringing: false,
              mode: "user_consult",
              callId: callId || `CONSULT-${claimId}`,
              reqId: null,
              claimId,
              claimAmount: 587.3,
              counterparty: "Operator Mobile",
              turns: [],
              activeSpeaker: null,
              selectedChoice: null,
              end: null,
            };
            return {
              ...base,
              active: true,
              ringing: false,
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
          if (voiceRef.current && turn.speaker === "agent" && turn.text) {
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
        } else {
          setVendorCall((prev) => {
            const base: VendorCallState = prev ?? {
              active: true,
              dialing: false,
              callId: turn.call_id || "CALL-CLM-D-1042",
              claimId: turn.call_id?.replace(/^CALL-/, "") || "CLM-D-1042",
              counterparty: "Kappa Office Systems AR desk",
              claimAmount: 587.3,
              openingPct: 70,
              floorPct: 85,
              turns: [],
              activeSpeaker: null,
              end: null,
            };
            return { ...base, active: true, dialing: false, turns: [...base.turns, turn] };
          });
          if (voiceRef.current && turn.text) {
            speakCallTurn(turn.speaker, turn.text, {
              onStart: () => {
                setSpeaking(true);
                setVendorCall((c) => (c ? { ...c, activeSpeaker: turn.speaker } : c));
              },
              onEnd: () => {
                setSpeaking(false);
                setVendorCall((c) => (c && c.activeSpeaker === turn.speaker ? { ...c, activeSpeaker: null } : c));
              },
            });
          }
        }
        break;
      }
      case "call_end": {
        const endPayload = ev.payload as unknown as CallEndPayload;
        const callId = String(endPayload.call_id ?? "");
        const isUserConsult = callId.startsWith("CONSULT-");
        if (isUserConsult) {
          const consultClaimId = callId.replace(/^CONSULT-/, "") || "CLM-D-1042";
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
        } else {
          const settledClaimId = endPayload.call_id?.replace(/^CALL-/, "") || "CLM-D-1042";
          setVendorCall((prev) => (prev ? { ...prev, active: false, dialing: false, end: endPayload } : prev));
          if (endPayload.outcome === "accepted") {
            soundFx.playCommitSuccess();
            if (modeRef.current === "demo") {
              applyDemoUpsert({
                table: "claims",
                pk_col: "id",
                row: { id: settledClaimId, status: "settled" },
              });
              setWsState((ws) => {
                if (!ws) return ws;
                const nextStep = {
                  step: ws.undo_stack.length + 1,
                  tool: "upsert_row",
                  summary: `Settled claim #${settledClaimId} (${(endPayload.agreed_amount ?? 499.21).toFixed(2)} EUR)`,
                  args: { table: "claims", pk_col: "id", row: { id: settledClaimId, status: "settled" } },
                  ts: Date.now(),
                };
                const updated: WorkspaceState = { ...ws, undo_stack: [...ws.undo_stack, nextStep] };
                wsStateRef.current = updated;
                return updated;
              });
            } else {
              refreshState();
            }
          }
        }
        break;
      }
      case "plan":
      case "replan":
        setPlan(ev.payload as unknown as PlanPayload);
        setStage("plan");
        break;
      case "forge_spec":
        setForgeSpec(ev.payload as unknown as ForgeSpecPayload);
        setForgeTest(null);
        setStage("forge");
        break;
      case "forge_test": {
        const ft = ev.payload as unknown as ForgeTestPayload;
        setForgeTest(ft);
        setForgedCode((m) => ({ ...m, [ft.name]: ft }));
        setStage("forge");
        if (ft.ast_passed && ft.test_results.length > 0 && ft.test_results.every((r) => r.passed)) soundFx.playForgePass();
        spawnWindow(forgeWindow(ft, ev.latency_ms || undefined));
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
        setPendingApproval(ev.payload as unknown as ApprovalNeededPayload);
        setStage("gate");
        setRunStatus("awaiting");
        if (windowsEnabledRef.current) soundFx.playRiskGateAlert();
        else soundFx.playIncomingCall();
        break;
      case "approval_result": {
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
      if (!next) return;
      const callName = next.type === "tool_call" ? callOf(next)?.name ?? "" : "";
      const spawns =
        next.type === "forge_test" ||
        (next.type === "tool_call" && !["read_file", "query_db"].includes(callName));
      if (spawns && liveCountRef.current >= MAX_LIVE_WINDOWS) return;
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
          if (parsed.type === "approval_result") {
            queueRef.current = queueRef.current.filter((q) => q.type !== "approval_needed");
            enqueue([parsed]);
          } else if (
            parsed.type === "undo_step" ||
            parsed.type === "call_start" ||
            parsed.type === "call_turn" ||
            parsed.type === "call_end"
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
    setVendorCall(null);
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

  const runDemo = () => {
    clearRun();
    setMode("demo");
    setRunStartedAt(Date.now());
    setRunStatus("running");
    const brandName = brandOf(wsStateRef.current?.domain).brand_name;
    setNarration(`Replaying ${brandName} shipment D-1042 vendor audit trace…`);
    enqueue(mockEvents());
  };

  const decide = async (reqId: string, approved: boolean) => {
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

  const negotiateVendorCall = async (claimIdArg?: string) => {
    const claimsRows = wsStateRef.current?.tables?.claims ?? [];
    const latestClaim = claimsRows[claimsRows.length - 1];
    const claimId = claimIdArg || String(latestClaim?.id ?? "CLM-D-1042");
    const claimAmount = Number(latestClaim?.amount ?? 587.3);

    stopSpeaking();
    setVendorCall({
      active: true,
      dialing: true,
      callId: `CALL-${claimId}`,
      claimId,
      counterparty: "Kappa Office Systems AR desk",
      claimAmount,
      openingPct: 70,
      floorPct: 85,
      turns: [],
      activeSpeaker: null,
      end: null,
    });
    setNarration(`Dialing Kappa Office Systems AR Desk to negotiate \`${claimId}\`…`);

    if (modeRef.current === "demo") {
      enqueue(mockVendorCallEvents(claimId, claimAmount));
      return;
    }
    try {
      const res = await fetch("/api/call/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_id: claimId }),
      });
      if (!res.ok) throw new Error("negotiate failed");
      await refreshState();
    } catch {
      enqueue(mockVendorCallEvents(claimId, claimAmount));
    }
  };

  const replayTurnAudio = (speaker: "agent" | "counterparty" | "user", text: string) => {
    speakCallTurn(
      speaker,
      text,
      {
        onStart: () => {
          setSpeaking(true);
          setVendorCall((c) => (c ? { ...c, activeSpeaker: speaker } : c));
        },
        onEnd: () => {
          setSpeaking(false);
          setVendorCall((c) => (c && c.activeSpeaker === speaker ? { ...c, activeSpeaker: null } : c));
        },
      },
      true
    );
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

  const escalateToPhone = async (reqIdArg?: string | null, claimIdArg?: string) => {
    const reqId = reqIdArg ?? pendingApproval?.req_id ?? null;
    const claimsRows = wsStateRef.current?.tables?.claims ?? [];
    const latestClaim = claimsRows[claimsRows.length - 1];
    const claimId = claimIdArg || String(latestClaim?.id ?? "CLM-D-1042");
    const claimAmount = Number(latestClaim?.amount ?? 587.3);

    stopSpeaking();
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
      await refreshState();
    } catch {
      runDemoFallback();
    }
  };

  const reset = async () => {
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
    vendorCall,
    negotiateVendorCall,
    replayTurnAudio,
    operatorConsult,
    escalateToPhone,
    respondOperatorConsult,
    replayConsultTurn,
    triggerGoal,
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
  };
}

export type RecoupRuntime = ReturnType<typeof useRecoup>;
