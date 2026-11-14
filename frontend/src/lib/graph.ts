import type {
  AnticipateOfferPayload,
  ApprovalNeededPayload,
  ChangeReport,
  ForgeSpecPayload,
  ForgeTestPayload,
  PlanPayload,
  PlanStep,
  ServerEvent,
  VerifyPayload,
} from "../contracts";
import { callOf } from "./narrate";
import type { RunStatus, WorkspaceState } from "./types";

/* ---------------------------------------------------------------------------
   Thought Graph model: derives a live DAG from the run state and lays it
   out top → bottom (goal → plan branches → sub-branches → gate → commit → anticipate).
   Projector-scaled geometry so reasoning chains & security seals read from 15m.
   Pure + deterministic so React can memoise it per render.
   --------------------------------------------------------------------------- */

export type GraphStage = "root" | "forge" | "rehearse" | "gate" | "hold" | "commit" | "anticipate";

export const STAGE_COLOR: Record<GraphStage, string> = {
  root: "#3B82F6",
  forge: "#A855F7",
  rehearse: "#3B82F6",
  gate: "#F59E0B",
  hold: "#F43F5E",
  commit: "#10B981",
  anticipate: "#06B6D4",
};

export const SECURITY_SEAL_BADGES = ["python -I", "0 env secrets", "SHA-256", "AST + unit tests"] as const;

export type NodeStatus = "pending" | "running" | "done" | "failed" | "held" | "approved" | "rejected" | "ghost";
export type NodeKind = "root" | "step" | "ast" | "tests" | "vault" | "mutation" | "diff" | "outbox" | "gate" | "commit" | "anticipate";
export type EdgeState = "idle" | "ready" | "active" | "done" | "held" | "failed" | "ghost";

export interface InspectorFact {
  label: string;
  value: string;
  mono?: boolean;
}

export interface InspectorDetail {
  title: string;
  summary?: string;
  facts: InspectorFact[];
  argsLabel?: string;
  args?: unknown;
  code?: string;
  latencyMs?: number | null;
  costEur?: number | null;
  receipt?: unknown;
  action?: { kind: "approval"; reqId: string; tool: string } | { kind: "offer"; offerId: string };
}

export interface GNode {
  id: string;
  kind: NodeKind;
  stage: GraphStage;
  size: "lg" | "md" | "sm";
  status: NodeStatus;
  eyebrow?: string;
  label: string;
  sub?: string;
  badge?: string;
  securityBadges?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  detail: InspectorDetail;
}

export interface GEdge {
  id: string;
  from: string;
  to: string;
  stage: GraphStage;
  state: EdgeState;
  d: string;
}

export interface ThoughtGraph {
  nodes: GNode[];
  edges: GEdge[];
  width: number;
  height: number;
  empty: boolean;
}

export interface GraphInput {
  plan: PlanPayload | null;
  events: ServerEvent[];
  forgeSpec: ForgeSpecPayload | null;
  forgeTest: ForgeTestPayload | null;
  forgedTools: { name: string }[];
  report: ChangeReport | null;
  verify: VerifyPayload | null;
  pendingApproval: ApprovalNeededPayload | null;
  offer: AnticipateOfferPayload | null;
  wsState: WorkspaceState | null;
  runStatus: RunStatus;
}

interface CallInfo {
  args: Record<string, unknown>;
  callId?: string;
  latencyMs: number | null;
  costEur: number;
  status: "running" | "done" | "failed";
  error?: string;
  thought?: string;
  preview?: string;
}

const cleanThought = (s?: string | null): string =>
  s ? s.replace(/`/g, "").replace(/\s+/g, " ").trim() : "";

function indexEvents(events: ServerEvent[]) {
  const calls = new Map<string, CallInfo>();
  const callsByTool = new Map<string, CallInfo[]>();
  const stepThoughts = new Map<number, string>();
  const receipts = new Map<string, unknown>();
  const decisions: { tool: string; approved: boolean }[] = [];
  let plan: ServerEvent | null = null;
  let forgeSpec: ServerEvent | null = null;
  let forgeTest: ServerEvent | null = null;
  let forgeRegistered: ServerEvent | null = null;
  let verifyEv: ServerEvent | null = null;
  let offer: AnticipateOfferPayload | null = null;
  let runDone: { status?: string; fingerprint?: string } | null = null;
  let forgeCost = 0;
  for (const ev of events) {
    if (typeof ev.step === "number" && ev.thought) {
      stepThoughts.set(ev.step, ev.thought);
    }
    switch (ev.type) {
      case "plan":
      case "replan":
        plan = ev;
        break;
      case "forge_spec":
        forgeSpec = ev;
        forgeCost += ev.cost_eur || 0;
        break;
      case "forge_test":
        forgeTest = ev;
        forgeCost += ev.cost_eur || 0;
        break;
      case "forge_registered":
        forgeRegistered = ev;
        break;
      case "verify":
        verifyEv = ev;
        break;
      case "tool_call": {
        const c = callOf(ev) as { id?: string; name?: string; args?: Record<string, unknown>; thought?: string | null } | undefined;
        if (c?.name) {
          const info: CallInfo = {
            args: c.args ?? {},
            callId: c.id,
            latencyMs: null,
            costEur: ev.cost_eur || 0,
            status: "running",
            thought: ev.thought || c.thought || undefined,
          };
          calls.set(c.name, info);
          const list = callsByTool.get(c.name) ?? [];
          list.push(info);
          callsByTool.set(c.name, list);
        }
        break;
      }
      case "tool_done":
      case "tool_error": {
        const c = callOf(ev) as { id?: string; name?: string; args?: Record<string, unknown>; thought?: string | null } | undefined;
        if (c?.name) {
          const list = callsByTool.get(c.name) ?? [];
          const target = (c.id ? list.find((x) => x.callId === c.id) : undefined) ?? list.at(-1) ?? calls.get(c.name);
          const payloadObj = ev.payload as { error?: unknown; preview?: unknown };
          const preview = typeof payloadObj.preview === "string" ? payloadObj.preview : target?.preview;
          const nextInfo: CallInfo = {
            args: target?.args ?? c.args ?? {},
            callId: c.id ?? target?.callId,
            latencyMs: ev.latency_ms || target?.latencyMs || null,
            costEur: (target?.costEur ?? 0) + (ev.cost_eur || 0),
            status: ev.type === "tool_done" ? "done" : "failed",
            error: ev.type === "tool_error" ? String(payloadObj.error ?? "") : undefined,
            thought: ev.thought || c.thought || target?.thought,
            preview,
          };
          calls.set(c.name, nextInfo);
          if (target) Object.assign(target, nextInfo);
          else {
            list.push(nextInfo);
            callsByTool.set(c.name, list);
          }
        }
        break;
      }
      case "approval_result": {
        const p = ev.payload as { approved?: boolean; tool?: string };
        decisions.push({ tool: String(p.tool ?? ""), approved: Boolean(p.approved) });
        break;
      }
      case "replay_step_done": {
        const p = ev.payload as { tool?: string; receipt?: unknown };
        if (p.tool) receipts.set(p.tool, p.receipt ?? null);
        break;
      }
      case "run_done":
        runDone = ev.payload as { status?: string; fingerprint?: string };
        break;
      case "offer":
        offer = ev.payload as unknown as AnticipateOfferPayload;
        break;
    }
  }
  return {
    calls,
    callsByTool,
    stepThoughts,
    receipts,
    decisions,
    plan,
    forgeSpec,
    forgeTest,
    forgeRegistered,
    verifyEv,
    offer,
    runDone,
    forgeCost,
  };
}

/* Projector-legible dimensions & spacing (readable from 15 meters away) */
const PAD = 24;
const STEP = { w: 162, h: 76 };
const SUB = { w: 162, h: 46, sealH: 84, gap: 12 };
const COL = 182;
const LG = { h: 60, root: 298, gate: 306, commit: 296, ant: 296 };
const PAIR_GAP = 32;
const ROW_GAP = 38;
const MIN_CONTENT_W = 480;

const r1 = (n: number) => Math.round(n * 10) / 10;
const vpath = (x1: number, y1: number, x2: number, y2: number) => {
  const dy = (y2 - y1) * 0.55;
  return `M ${r1(x1)} ${r1(y1)} C ${r1(x1)} ${r1(y1 + dy)}, ${r1(x2)} ${r1(y2 - dy)}, ${r1(x2)} ${r1(y2)}`;
};
const arcPath = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = (x2 - x1) * 0.5;
  return `M ${r1(x1)} ${r1(y1)} C ${r1(x1 + dx)} ${r1(y1 - 24)}, ${r1(x2 - dx)} ${r1(y2 - 24)}, ${r1(x2)} ${r1(y2)}`;
};
const spreadX = (cx: number, i: number, n: number, width: number) =>
  n <= 1 ? cx : cx + (i - (n - 1) / 2) * Math.min(42, (width - 72) / (n - 1));

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const MUTATING_DB = new Set(["upsert_row", "delete_rows"]);
const FILE_TOOLS = new Set(["write_file", "patch_file"]);
const EXTERNAL = new Set(["send_email", "place_call", "trigger_webhook"]);

function edgeStateFor(child: NodeStatus, parentDone: boolean): EdgeState {
  if (child === "running") return "active";
  if (child === "done" || child === "approved") return "done";
  if (child === "failed" || child === "rejected") return "failed";
  if (child === "held") return "held";
  if (child === "ghost") return "ghost";
  return parentDone ? "ready" : "idle";
}

const isDone = (s: NodeStatus) => s === "done" || s === "approved";

type NodeSpec = Omit<GNode, "x" | "y" | "w" | "h">;

export function buildThoughtGraph(inp: GraphInput): ThoughtGraph {
  const ix = indexEvents(inp.events);
  const steps = inp.plan?.steps ?? [];
  const domain = inp.wsState?.domain;
  const tables = Object.keys(inp.wsState?.tables ?? {});
  const decision = ix.decisions.at(-1);
  const runStatus = ix.runDone?.status;
  const committed = runStatus === "committed";
  const errored = runStatus === "error" || inp.runStatus === "error";
  const aborted = runStatus === "aborted_by_human" || runStatus === "blocked" || inp.runStatus === "aborted";
  const registered =
    !!ix.forgeRegistered || !!inp.forgeTest?.registered || (!!inp.forgeSpec && inp.forgedTools.some((t) => t.name === inp.forgeSpec?.name));

  const goal = inp.plan?.goal ?? "";
  const cleanGoal = cleanThought(goal.includes("Goal:") ? goal.split("Goal:").pop()! : goal);
  const planThought = cleanThought(ix.plan?.thought);
  const rootSub =
    planThought ||
    cleanGoal ||
    `${domain?.label ?? "Enterprise Vendor Ops"} · ${plural(tables.length || 5, "table")} cloned in rehearsal`;

  const root: NodeSpec = {
    id: "root",
    kind: "root",
    stage: "root",
    size: "lg",
    status: inp.plan ? "done" : errored ? "failed" : inp.runStatus === "running" ? "running" : "pending",
    label: "Goal & Ledger Scan",
    sub: rootSub,
    badge: inp.plan ? plural(steps.length, "step") : errored ? "error" : inp.runStatus === "running" ? "scanning" : "idle",
    detail: {
      title: "Goal & Ledger Scan",
      summary: cleanGoal || "Waiting for a vendor audit goal.",
      facts: [
        { label: "Domain", value: domain?.label ?? "Enterprise Vendor Ops", mono: true },
        { label: "Schema", value: tables.length ? tables.join(", ") : "suppliers, contract_prices, deliveries, invoices, claims", mono: true },
        { label: "Success criteria", value: String(inp.plan?.success_criteria.length ?? 0) },
        ...(planThought ? [{ label: "Reasoning", value: planThought }] : []),
      ],
      argsLabel: "Plan",
      args: inp.plan ? { success_criteria: inp.plan.success_criteria, steps: steps.map((s) => s.tool) } : undefined,
      latencyMs: ix.plan?.latency_ms ?? null,
      costEur: ix.plan?.cost_eur ?? null,
    },
  };

  const toolCursor = new Map<string, number>();
  const columns = steps.map((s) => {
    const rawTool = s.tool.startsWith("MISSING:") ? s.tool.slice(8) : s.tool;
    const idx = toolCursor.get(rawTool) ?? 0;
    toolCursor.set(rawTool, idx + 1);
    return buildColumn(s, inp, ix, registered, decision, idx);
  });

  const held = inp.pendingApproval;
  const verify = inp.verify;
  const verifyPassed = verify ? verify.criteria.filter((c) => c.passed).length : 0;
  const gateStatus: NodeStatus = held
    ? "held"
    : decision
    ? decision.approved
      ? "approved"
      : "rejected"
    : errored
    ? "failed"
    : aborted
    ? "rejected"
    : committed
    ? "done"
    : verify || inp.report
    ? "running"
    : "pending";

  const verifyThought = cleanThought(ix.verifyEv?.thought);
  const gateSub = held
    ? cleanThought(`${held.tool_name}: ${held.risk_reason}`)
    : decision
    ? `${decision.approved ? "Manager approved" : "Manager rejected"} · ${decision.tool || "staged changes"}`
    : verify
    ? `Verified ${verifyPassed}/${verify.criteria.length} criteria · deterministic Python policy`
    : verifyThought || "Deterministic Python policy · AUTO / ASK / BLOCK";

  const gate: NodeSpec = {
    id: "gate",
    kind: "gate",
    stage: held ? "hold" : gateStatus === "approved" || gateStatus === "done" ? "commit" : "gate",
    size: "lg",
    status: gateStatus,
    label: "Deterministic Risk Gate",
    sub: gateSub,
    badge: held
      ? `HOLD: ${held.tool_name}`
      : gateStatus === "approved"
      ? "APPROVED"
      : gateStatus === "rejected"
      ? "REJECTED"
      : gateStatus === "done"
      ? "AUTO"
      : gateStatus === "running"
      ? "EVALUATING"
      : "ARMED",
    detail: {
      title: "Verification & Risk Gate",
      summary: held
        ? `Paused ${held.tool_name}() — ${held.risk_reason}. Live ERP stays untouched until you decide.`
        : decision
        ? `${decision.tool || "Action"} was ${decision.approved ? "approved" : "rejected"} by manager.`
        : "Deterministic Python policy rules — never LLM judgment — decide AUTO, ASK or BLOCK for every staged change.",
      facts: [
        ...(verify?.criteria ?? []).map((c) => ({ label: c.passed ? "Pass" : "Fail", value: c.criterion })),
        ...(held ? [{ label: "Risk reason", value: held.risk_reason }] : []),
        { label: "Decision", value: gateStatus === "held" ? "awaiting manager" : gateStatus },
      ],
      argsLabel: held ? `${held.tool_name} arguments` : undefined,
      args: held?.args,
      code: held?.diff_preview || undefined,
      action: held ? { kind: "approval", reqId: held.req_id, tool: held.tool_name } : undefined,
    },
  };

  const fingerprint = ix.runDone?.fingerprint ?? inp.wsState?.fingerprint ?? "————";
  const checkpoints = inp.wsState?.undo_stack.length ?? ix.receipts.size;
  const commitStatus: NodeStatus = committed
    ? "done"
    : inp.runStatus === "committing"
    ? "running"
    : errored || aborted || gateStatus === "rejected"
    ? "failed"
    : "pending";
  const commitSub =
    commitStatus === "done"
      ? `sha256 ${fingerprint.slice(0, 12)} · ${plural(checkpoints, "undo receipt")} sealed`
      : commitStatus === "failed"
      ? "Rolled back cleanly from pre-image receipts"
      : `sha256 ${fingerprint.slice(0, 12)} · OCC fingerprint check`;

  const commit: NodeSpec = {
    id: "commit",
    kind: "commit",
    stage: "commit",
    size: "lg",
    status: commitStatus,
    label: "SHA-256 Atomic Commit",
    sub: commitSub,
    badge: commitStatus === "failed" ? "rolled back" : `undo ×${checkpoints}`,
    detail: {
      title: "SHA-256 Atomic Commit",
      summary:
        commitStatus === "done"
          ? "Staged changes replayed onto live workspace after an OCC fingerprint check. Every step recorded a pre-image receipt."
          : commitStatus === "failed"
          ? "Nothing committed — every staged mutation was rolled back from its pre-image receipt."
          : "Replays rehearsed changes onto the live workspace only if the SHA-256 fingerprint still matches.",
      facts: [
        { label: "Fingerprint", value: fingerprint, mono: true },
        { label: "Undo checkpoints", value: String(checkpoints) },
        { label: "Receipts", value: String(ix.receipts.size) },
      ],
      argsLabel: ix.receipts.size ? "Replay receipts" : undefined,
      args: ix.receipts.size ? Object.fromEntries(ix.receipts) : undefined,
      receipt: ix.receipts.size ? Object.fromEntries(ix.receipts) : undefined,
    },
  };

  const offer = inp.offer ?? ix.offer;
  const anticipate: NodeSpec | null = offer
    ? {
        id: "anticipate",
        kind: "anticipate",
        stage: "anticipate",
        size: "lg",
        status: inp.offer ? "ghost" : "done",
        label: "Anticipate · Proactive Sweep",
        sub: cleanThought(offer.prediction.need),
        badge: inp.offer ? `${Math.round(offer.prediction.confidence * 100)}%` : "applied",
        detail: {
          title: "Anticipate · Proactive Recovery",
          summary: offer.prediction.need,
          facts: [
            { label: "Evidence", value: offer.prediction.evidence },
            { label: "Confidence", value: `${Math.round(offer.prediction.confidence * 100)}%` },
            { label: "Mutations", value: String(offer.mutations_count) },
          ],
          argsLabel: "Pre-rehearsed goal",
          args: { goal_prompt: offer.prediction.goal_prompt, files: offer.report.files_created },
          code: offer.report.files_modified[0]?.diff,
          action: inp.offer ? { kind: "offer", offerId: inp.offer.offer_id } : undefined,
        },
      }
    : null;

  return layout(root, columns, gate, commit, anticipate, held?.tool_name ?? null);
}

function buildColumn(
  s: PlanStep,
  inp: GraphInput,
  ix: ReturnType<typeof indexEvents>,
  registered: boolean,
  decision: { tool: string; approved: boolean } | undefined,
  occurrence = 0
): { step: NodeSpec; chain: NodeSpec[]; tool: string } {
  const missing = s.tool.startsWith("MISSING:");
  const tool = missing ? s.tool.slice(8) : s.tool;
  const isSynthesized = missing || inp.forgedTools.some((t) => t.name === tool);
  const toolList = ix.callsByTool.get(tool);
  const info = toolList?.[occurrence] ?? ix.calls.get(tool);
  const forging = missing && inp.forgeSpec?.name === tool && !registered;
  const heldHere = inp.pendingApproval?.tool_name === tool;
  let status: NodeStatus = s.status === "pending" && info ? info.status : s.status;
  if (forging && status === "pending") status = "running";
  if (heldHere) status = "held";
  const external = EXTERNAL.has(tool);
  const stage: GraphStage = missing || isSynthesized ? "forge" : external ? "gate" : "rehearse";
  const id = `step-${s.id}`;
  const receipt = ix.receipts.get(tool);

  const rawThought =
    info?.thought ??
    ix.stepThoughts.get(s.id) ??
    (missing ? ix.forgeTest?.thought ?? ix.forgeSpec?.thought : undefined) ??
    info?.preview;
  const liveThought = cleanThought(rawThought);
  const cleanIntent = cleanThought(s.intent);
  const stepSub = liveThought || cleanIntent;

  const step: NodeSpec = {
    id,
    kind: "step",
    stage,
    size: "md",
    status,
    eyebrow: `STEP ${String(s.id).padStart(2, "0")}`,
    label: missing ? `forge:${tool}` : tool,
    sub: stepSub,
    badge: info?.latencyMs ? `${info.latencyMs}ms` : undefined,
    securityBadges: isSynthesized ? [...SECURITY_SEAL_BADGES] : undefined,
    detail: {
      title: `Step ${s.id} · ${tool}`,
      summary: liveThought && liveThought !== cleanIntent ? `${s.intent} — ${liveThought}` : s.intent,
      facts: [
        { label: "Tool", value: isSynthesized ? `${tool} (synthesized)` : tool, mono: true },
        { label: "Status", value: status },
        ...(info?.preview ? [{ label: "Outcome", value: cleanThought(info.preview) }] : []),
        ...(info?.callId ? [{ label: "Call id", value: info.callId, mono: true }] : []),
        ...(info?.error ? [{ label: "Error", value: info.error }] : []),
      ],
      argsLabel: "Tool arguments",
      args: info?.args,
      latencyMs: info?.latencyMs ?? null,
      costEur: (info?.costEur ?? 0) + (missing ? ix.forgeCost : 0) || null,
      receipt,
    },
  };

  const chain: NodeSpec[] = [];
  const sub = (n: Omit<NodeSpec, "size" | "stage"> & { stage?: GraphStage }): NodeSpec => ({ size: "sm", stage: n.stage ?? stage, ...n });

  if (missing) {
    const ft = inp.forgeTest?.name === tool ? inp.forgeTest : null;
    const spec = inp.forgeSpec?.name === tool ? inp.forgeSpec : null;
    const passed = ft ? ft.test_results.filter((r) => r.passed).length : 0;
    const total = ft ? ft.test_results.length : spec?.examples.length ?? 0;
    const astStatus: NodeStatus = ft ? (ft.ast_passed ? "done" : "failed") : spec ? "running" : "pending";
    const testStatus: NodeStatus = ft ? (passed === total && ft.ast_passed ? "done" : "failed") : "pending";
    const vaultStatus: NodeStatus = registered ? "done" : testStatus === "done" ? "running" : testStatus === "failed" ? "failed" : "pending";
    chain.push(
      sub({
        id: `${id}-ast`,
        kind: "ast",
        status: astStatus,
        label: "AST safety scan",
        sub: ft ? (ft.ast_errors.length ? `${ft.ast_errors.length} AST violations` : "0 disallowed imports") : "static AST guard",
        badge: ft ? (ft.ast_errors.length ? `${ft.ast_errors.length} viol.` : "clean") : undefined,
        detail: {
          title: "AST Safety Scan",
          summary: "Static guard rejects disallowed imports, dunder access, exec/eval and file or network I/O before any code runs.",
          facts: [
            { label: "Attempt", value: String(ft?.attempt ?? "—") },
            { label: "Violations", value: ft ? String(ft.ast_errors.length) : "—" },
            ...(ft?.ast_errors ?? []).map((e) => ({ label: "Error", value: e })),
          ],
          latencyMs: ix.forgeTest?.latency_ms ?? null,
        },
      }),
      sub({
        id: `${id}-tests`,
        kind: "tests",
        status: testStatus,
        label: "Sandbox unit tests",
        sub: total ? `${passed}/${total} python -I tests` : "isolated subprocess",
        badge: total ? `${passed}/${total} pass` : undefined,
        detail: {
          title: "Sandbox Unit Tests",
          summary: "Spec examples executed inside an isolated `python -I` subprocess with CPU and file-size rlimits and zero environment secrets.",
          facts: [
            { label: "Passed", value: `${passed}/${total}` },
            { label: "Sandbox", value: "subprocess python -I · 0 env secrets · RLIMIT_CPU 2s", mono: true },
          ],
          argsLabel: "Test results",
          args: ft?.test_results ?? spec?.examples,
          latencyMs: ix.forgeTest?.latency_ms ?? null,
          costEur: ix.forgeTest?.cost_eur ?? null,
        },
      }),
      sub({
        id: `${id}-vault`,
        kind: "vault",
        status: vaultStatus,
        label: "Vault seal",
        sub: registered ? "verified & sealed" : "awaiting sandbox pass",
        badge: registered ? "sealed" : undefined,
        securityBadges: [...SECURITY_SEAL_BADGES],
        detail: {
          title: `Vault Registration · ${tool}`,
          summary: spec?.purpose ?? "Registers the verified pure function in the tool registry with SHA-256 integrity seal.",
          facts: [
            { label: "Signature", value: `def ${tool}(args: dict) -> dict`, mono: true },
            { label: "Security seal", value: SECURITY_SEAL_BADGES.join(" · "), mono: true },
            { label: "Registered", value: registered ? "yes" : "no" },
          ],
          code: ft?.code,
          latencyMs: ix.forgeRegistered?.latency_ms ?? null,
          receipt: ft?.code,
        },
      })
    );
  } else if (MUTATING_DB.has(tool)) {
    const table = String(info?.args.table ?? "table");
    const c = inp.report?.db_summary?.[table];
    const badge = c
      ? [c.inserted ? `+INSERT ${c.inserted}` : "", c.updated ? `~UPDATE ${c.updated}` : "", c.deleted ? `−DELETE ${c.deleted}` : ""].filter(Boolean)[0]
      : info
      ? tool === "delete_rows"
        ? "−DELETE"
        : "~STAGE"
      : undefined;
    chain.push(
      sub({
        id: `${id}-db`,
        kind: "mutation",
        status: status === "held" ? "running" : status,
        label: "SQLite staged",
        sub: `table ${table}`,
        badge,
        detail: {
          title: "SQLite Rehearsal Mutation",
          summary: `Executed against an online-backup clone of ${table}; a pre-image receipt guarantees reversible undo.`,
          facts: [
            { label: "Table", value: table, mono: true },
            ...(c ? [{ label: "Row diff", value: `+${c.inserted || 0} ~${c.updated || 0} −${c.deleted || 0}`, mono: true }] : []),
          ],
          argsLabel: "Row",
          args: info?.args.row ?? info?.args,
          latencyMs: info?.latencyMs ?? null,
          receipt,
        },
      })
    );
  } else if (FILE_TOOLS.has(tool)) {
    const path = String(info?.args.path ?? "claims/*.md");
    const diff = inp.report?.files_modified.find((f) => f.path === path)?.diff;
    const patchFallback =
      typeof info?.args.target === "string"
        ? `- ${info.args.target}\n+ ${String(info.args.replacement ?? "")}`
        : undefined;
    const adds = diff ? diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length : 0;
    chain.push(
      sub({
        id: `${id}-diff`,
        kind: "diff",
        status: status === "held" ? "running" : status,
        label: "File diff",
        sub: path,
        badge: diff ? `+${adds} ln · ${clip(path.split("/").pop() ?? path, 14)}` : path,
        detail: {
          title: "Staged File Diff",
          summary: "Written inside the isolated rehearsal copy; live workspace sees it only after Risk Gate commit.",
          facts: [{ label: "Path", value: path, mono: true }],
          code: diff ?? (typeof info?.args.content === "string" ? info.args.content : patchFallback),
          latencyMs: info?.latencyMs ?? null,
          receipt,
        },
      })
    );
  } else if (external) {
    const target = String(info?.args.to ?? info?.args.counterparty ?? info?.args.endpoint ?? "external");
    const decided = decision && decision.tool === tool ? decision : undefined;
    chain.push(
      sub({
        id: `${id}-outbox`,
        kind: "outbox",
        stage: heldHere ? "hold" : "gate",
        status: heldHere ? "held" : decided ? (decided.approved ? "approved" : "rejected") : status,
        label: "Dry-run outbox",
        sub: target,
        badge: heldHere ? `held · ${clip(target, 14)}` : decided ? (decided.approved ? "sent" : "dropped") : info ? "intercepted" : target,
        detail: {
          title: "Dry-run Outbox",
          summary: "External side-effect captured in dry-run outbox instead of dispatched; held for Risk Gate authorization.",
          facts: [
            { label: "Tool", value: tool, mono: true },
            { label: "Target", value: target, mono: true },
          ],
          argsLabel: "Payload",
          args: info?.args,
          latencyMs: info?.latencyMs ?? null,
          receipt,
        },
      })
    );
  } else if (isSynthesized) {
    chain.push(
      sub({
        id: `${id}-exec`,
        kind: "vault",
        stage: "forge",
        status,
        label: "Vault sandbox exec",
        sub: clip(tool, 22),
        badge: info?.status === "done" ? "sealed · ok" : info?.status === "failed" ? "err" : "sealed",
        securityBadges: [...SECURITY_SEAL_BADGES],
        detail: {
          title: `Synthesized Tool Execution · ${tool}`,
          summary: "Verified Vault tool executed inside an isolated `python -I` subprocess with 0 env secrets.",
          facts: [
            { label: "Tool", value: tool, mono: true },
            { label: "Security seal", value: SECURITY_SEAL_BADGES.join(" · "), mono: true },
          ],
          argsLabel: "Arguments",
          args: info?.args,
          latencyMs: info?.latencyMs ?? null,
          receipt,
        },
      })
    );
  } else if (info) {
    chain.push(
      sub({
        id: `${id}-exec`,
        kind: "vault",
        status,
        label: "Rehearsal exec",
        sub: info.preview ? clip(cleanThought(info.preview), 24) : clip(tool, 22),
        badge: info.status === "done" ? `ok · ${clip(tool, 14)}` : info.status === "failed" ? "err" : undefined,
        detail: {
          title: `Tool Execution · ${tool}`,
          summary: info.preview ? cleanThought(info.preview) : "Executed inside the isolated rehearsal runtime.",
          facts: [{ label: "Tool", value: tool, mono: true }],
          argsLabel: "Arguments",
          args: info.args,
          latencyMs: info.latencyMs ?? null,
          receipt,
        },
      })
    );
  }
  return { step, chain, tool };
}

function layout(
  root: NodeSpec,
  columns: { step: NodeSpec; chain: NodeSpec[]; tool: string }[],
  gate: NodeSpec,
  commit: NodeSpec,
  anticipate: NodeSpec | null,
  heldTool: string | null
): ThoughtGraph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const n = columns.length;
  const gridW = n ? n * COL - (COL - STEP.w) : 0;
  const pairW = LG.commit + PAIR_GAP + LG.ant;
  const contentW = Math.max(gridW, MIN_CONTENT_W, anticipate ? pairW + 8 : 0);
  const width = contentW + PAD * 2;
  const cx = width / 2;
  const colX = (i: number) => PAD + (contentW - gridW) / 2 + i * COL + STEP.w / 2;

  let y = PAD;
  const rootNode: GNode = { ...root, x: cx, y: y + LG.h / 2, w: LG.root, h: LG.h };
  nodes.push(rootNode);
  y += LG.h + ROW_GAP;

  const lastOfColumn: GNode[] = [];
  if (n) {
    const stepY = y + STEP.h / 2;
    y += STEP.h;
    const subTop = y + 18;
    let maxColBottom = y;
    columns.forEach((c, i) => {
      const x = colX(i);
      const stepNode: GNode = { ...c.step, x, y: stepY, w: STEP.w, h: STEP.h };
      nodes.push(stepNode);
      edges.push({
        id: `root>${stepNode.id}`,
        from: "root",
        to: stepNode.id,
        stage: stepNode.stage === "gate" ? "rehearse" : stepNode.stage,
        state: edgeStateFor(stepNode.status, true),
        d: vpath(spreadX(cx, i, n, LG.root), rootNode.y + LG.h / 2, x, stepY - STEP.h / 2),
      });
      let parent = stepNode;
      let curTop = subTop;
      c.chain.forEach((spec) => {
        const nh = spec.securityBadges?.length ? SUB.sealH : SUB.h;
        const node: GNode = { ...spec, x, y: curTop + nh / 2, w: SUB.w, h: nh };
        nodes.push(node);
        edges.push({
          id: `${parent.id}>${node.id}`,
          from: parent.id,
          to: node.id,
          stage: node.stage,
          state: edgeStateFor(node.status, isDone(parent.status)),
          d: vpath(x, parent.y + parent.h / 2, x, node.y - node.h / 2),
        });
        parent = node;
        curTop += nh + SUB.gap;
      });
      if (c.chain.length > 0) {
        maxColBottom = Math.max(maxColBottom, curTop - SUB.gap);
      }
      lastOfColumn.push(parent);
    });
    y = maxColBottom + ROW_GAP;
  }

  const gateNode: GNode = { ...gate, x: cx, y: y + LG.h / 2, w: LG.gate, h: LG.h };
  nodes.push(gateNode);
  const gateTop = gateNode.y - LG.h / 2;
  const fanIn = lastOfColumn.length ? lastOfColumn : [rootNode];
  fanIn.forEach((src, i) => {
    const srcDone = isDone(src.status);
    const isHeldBranch = gate.status === "held" && (src.id.endsWith("-outbox") || columns[i]?.tool === heldTool);
    const state: EdgeState =
      gate.status === "held"
        ? isHeldBranch
          ? "held"
          : srcDone
          ? "done"
          : "idle"
        : gate.status === "running"
        ? "active"
        : gate.status === "approved" || gate.status === "done"
        ? "done"
        : gate.status === "rejected"
        ? "failed"
        : srcDone
        ? "ready"
        : "idle";
    edges.push({
      id: `${src.id}>gate`,
      from: src.id,
      to: "gate",
      stage: state === "held" ? "hold" : gate.status === "approved" || gate.status === "done" ? "commit" : "gate",
      state,
      d: vpath(src.x, src.y + src.h / 2, spreadX(cx, i, fanIn.length, LG.gate), gateTop),
    });
  });
  y += LG.h + ROW_GAP;

  const commitX = anticipate ? cx - pairW / 2 + LG.commit / 2 : cx;
  const commitNode: GNode = { ...commit, x: commitX, y: y + LG.h / 2, w: LG.commit, h: LG.h };
  nodes.push(commitNode);
  edges.push({
    id: "gate>commit",
    from: "gate",
    to: "commit",
    stage: commit.status === "failed" ? "hold" : "commit",
    state: edgeStateFor(commit.status, isDone(gate.status)),
    d: vpath(cx, gateNode.y + LG.h / 2, commitX, commitNode.y - LG.h / 2),
  });

  if (anticipate) {
    const antX = cx + pairW / 2 - LG.ant / 2;
    const antNode: GNode = { ...anticipate, x: antX, y: commitNode.y, w: LG.ant, h: LG.h };
    nodes.push(antNode);
    edges.push({
      id: "commit>anticipate",
      from: "commit",
      to: "anticipate",
      stage: "anticipate",
      state: anticipate.status === "ghost" ? "ghost" : "done",
      d: arcPath(commitX + LG.commit / 2, commitNode.y, antX - LG.ant / 2, antNode.y),
    });
  }
  y += LG.h + PAD;

  return { nodes, edges, width, height: y, empty: n === 0 };
}

export function connectedTo(id: string, edges: GEdge[]): Set<string> {
  const keep = new Set([id]);
  const walk = (dir: "up" | "down", from: string) => {
    for (const e of edges) {
      const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
      if (a === from && !keep.has(b)) {
        keep.add(b);
        walk(dir, b);
      }
    }
  };
  walk("up", id);
  walk("down", id);
  return keep;
}
