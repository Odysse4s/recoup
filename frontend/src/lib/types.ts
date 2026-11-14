import type { AnticipateOfferPayload, ApprovalNeededPayload } from "../contracts";

export type BrandColor = "indigo" | "emerald" | "amber" | "rose" | "cyan" | "violet";

export interface Brand {
  brand_name: string;
  brand_tagline: string;
  primary_color: BrandColor;
}

export const DEFAULT_BRAND: Brand = {
  brand_name: "Recoup",
  brand_tagline: "Safety-first enterprise agent for vendor audits, staged ERP changes & reversible recovery.",
  primary_color: "emerald",
};

export interface WorkspaceState {
  fingerprint: string;
  domain?: Partial<Brand> & {
    label?: string;
    persona?: string;
    vertical: string;
    primary_table: string;
    default_goal?: string;
    presets: Preset[];
    negotiation?: Record<string, unknown>;
  };
  files: Record<string, string>;
  tables: Record<string, Record<string, unknown>[]>;
  schema_sql?: Record<string, string>;
  outbox: Record<string, unknown>[];
  undo_stack: { step: number; tool: string; summary?: string; args?: Record<string, unknown>; ts: number }[];
  forged_tools: { name: string; description: string; uses: number }[];
  pending_approvals: ApprovalNeededPayload[];
  pending_offers: AnticipateOfferPayload[];
  metrics: {
    steps: number;
    cost_eur: number;
    forged_count: number;
    unapproved_high_risk: number;
  };
}

export interface Preset {
  title: string;
  badge: string;
  goal: string;
  desc: string;
}

export type Row = Record<string, unknown>;

export type WindowKind = "forge" | "editor" | "sqlite" | "exec";
export type DockTarget = "vault" | "diff" | "db";
export type CodeLang = "python" | "markdown" | "sql" | "shell" | "diff" | "text";

export interface LiveWin {
  id: string;
  kind: WindowKind;
  title: string;
  path: string;
  liveLabel: string;
  doneLabel: string;
  code: string;
  lang: CodeLang;
  assertions: { label: string; ok: boolean }[];
  target: DockTarget;
  origin: string;
  pinned: boolean;
  manual?: boolean;
  /** Inspector windows render their full content immediately instead of typing it out. */
  instant?: boolean;
  /** Real execution latency from the originating event, shown in the telemetry strip. */
  latencyMs?: number;
  /** Tool call id, so `tool_done` can attach its measured latency to the window. */
  callId?: string;
  /** Two-line live rehearsal telemetry strip: static facts + lifecycle steps revealed with progress. */
  telemetry?: { facts: string[]; steps: string[] };
  toolName?: string;
  /** High-visibility projector archetype banner label (e.g., SANDBOX · FORGING PYTHON TOOL). */
  categoryBadge?: string;
  /** Security seal pills shown on forged/sandbox windows. */
  securitySeal?: string[];
  /** Suppresses automatic popup during automated runs while still allowing manual click inspection. */
  skipAutoPop?: boolean;
}

export type OperatorChoice = "refund" | "redelivery";

export interface OperatorConsultTurn {
  speaker: "agent" | "counterparty" | "user";
  text: string;
  audioUrl?: string | null;
  ts: number;
}

export interface OperatorConsultState {
  active: boolean;
  ringing: boolean;
  mode: "user_consult" | "vendor";
  callId: string;
  reqId: string | null;
  claimId: string;
  claimAmount: number;
  counterparty: string;
  turns: OperatorConsultTurn[];
  activeSpeaker: "agent" | "counterparty" | "user" | null;
  selectedChoice: OperatorChoice | null;
  end: {
    outcome: "accepted" | "escalated" | "rejected" | "no_answer";
    agreed_amount?: number | null;
    summary: string;
  } | null;
}

export const STAGES = [
  { id: "plan", num: "01", label: "Plan" },
  { id: "forge", num: "02", label: "Forge" },
  { id: "rehearse", num: "03", label: "Rehearse" },
  { id: "verify", num: "04", label: "Verify" },
  { id: "gate", num: "05", label: "Risk Gate" },
  { id: "commit", num: "06", label: "Commit" },
  { id: "anticipate", num: "07", label: "Anticipate" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export type RunStatus = "idle" | "running" | "awaiting" | "committing" | "committed" | "aborted" | "error";

export interface RowMark {
  kind: "inserted" | "updated" | "deleted" | "restored";
  cols: string[];
  prev?: Row;
  at: number;
}

export interface RewindState {
  id: number;
  steps: { step: number; tool: string }[];
  phase: "rewinding" | "restored";
  duration: number;
  skipped: string[];
}
