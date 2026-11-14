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
  channel?: "notification" | "voice_call";
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

export interface UiActionPayload {
  action: "open_file" | "switch_view" | "commit_resolution";
  path?: string | null;
  content?: string | null;
  view?: string | null;
  table?: string | null;
  choice?: "refund" | "redelivery" | null;
  label?: string;
}

export interface OumiIrisGate {
  live: boolean;
  model: string;
  latency_ms: number;
  gate_probability: number;
  route: string;
  route_confidence: number;
  risk_score: number;
  risk_max: number;
  input_tokens: number;
  output_tokens: number;
}

export interface OumiIrisIntent {
  live: boolean;
  model: string;
  latency_ms: number;
  intent: string;
  confidence: number;
  probabilities?: Record<string, number>;
  is_binding_authorization: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CallStartPayload {
  call_id: string;
  mode?: "vendor" | "user_consult";
  channel?: "notification" | "voice_call";
  counterparty?: string;
  req_id?: string | null;
  claim_id?: string;
  claim_amount?: number;
  opening_pct?: number | null;
  floor_pct?: number | null;
  call_status?: "ringing" | "connected" | "ended";
  iris_gate?: OumiIrisGate | null;
  irisGate?: OumiIrisGate | null;
}

export interface CallTurnPayload {
  call_id: string;
  speaker: "agent" | "counterparty" | "user";
  text: string;
  audio_url?: string | null;
  offer_pct?: number | null;
  keep_call_open?: boolean;
  call_status?: "ringing" | "connected" | "ended" | null;
  ui_action?: UiActionPayload | null;
  iris_intent?: OumiIrisIntent | null;
  irisIntent?: OumiIrisIntent | null;
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
