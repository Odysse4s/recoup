// Mirror of backend/app/contracts.py. Keep EventType values identical in both files.
export type EventType =
  | "plan"
  | "replan"
  | "rehearse_start"
  | "evidence"
  | "tool_call"
  | "tool_done"
  | "tool_error"
  | "forge_spec"
  | "forge_test"
  | "forge_registered"
  | "rehearse_report"
  | "approval_needed"
  | "approval_result"
  | "replay_step_done"
  | "undo_step"
  | "verify"
  | "call_start"
  | "call_turn"
  | "call_end"
  | "offer"
  | "run_done";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thought?: string | null;
}

export interface PlanStep {
  id: number;
  intent: string;
  tool: string;
  status: "pending" | "running" | "done" | "failed";
}

export interface PlanPayload {
  goal: string;
  steps: PlanStep[];
  success_criteria: string[];
}

export interface EvidencePayload {
  source: string;
  kind: "document" | "photo" | "audio";
  findings: string[];
}

export interface ForgeExample {
  in: Record<string, unknown>;
  out: unknown;
}

export interface ForgeSpecPayload {
  name: string;
  purpose: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  examples: ForgeExample[];
}

export interface ForgeTestPayload {
  name: string;
  attempt: number;
  code: string;
  ast_passed: boolean;
  ast_errors: string[];
  test_results: { index: number; passed: boolean; actual: unknown }[];
  registered: boolean;
}

export interface FileDiffItem {
  path: string;
  diff: string;
}

export interface ChangeReport {
  files_created: string[];
  files_modified: FileDiffItem[];
  files_deleted: string[];
  db_summary: Record<string, Record<string, number>>;
  db_max_deleted: number;
  external_outbox: Record<string, unknown>[];
}

export interface ApprovalNeededPayload {
  req_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  diff_preview: string;
  risk_reason: string;
  spoken_summary: string;
  report?: ChangeReport | null;
}

export interface VerifyCriterionResult {
  criterion: string;
  passed: boolean;
  detail: string;
}

export interface VerifyPayload {
  passed: boolean;
  criteria: VerifyCriterionResult[];
}

export interface CallTurnPayload {
  call_id: string;
  speaker: "agent" | "counterparty";
  text: string;
  audio_url?: string | null;
  offer_pct?: number | null;
}

export interface CallEndPayload {
  call_id: string;
  outcome: "accepted" | "escalated" | "rejected" | "no_answer";
  agreed_amount?: number | null;
  summary: string;
}

export interface AnticipatePrediction {
  need: string;
  goal_prompt: string;
  evidence: string;
  confidence: number;
  kind: "info" | "draft" | "report" | "precompute";
}

export interface AnticipateOfferPayload {
  offer_id: string;
  prediction: AnticipatePrediction;
  report: ChangeReport;
  mutations_count: number;
}

export interface ServerEvent<P = Record<string, unknown>> {
  id: number;
  run_id: string;
  ts: number;
  type: EventType;
  step: number | null;
  thought: string | null;
  cost_eur: number;
  latency_ms: number;
  payload: P;
}
