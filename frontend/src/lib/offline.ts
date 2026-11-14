import type { Row, WorkspaceState } from "./types";

export const FALLBACK_FILES: Record<string, string> = {
  "inbox/D-1042_receiving_note.md":
    "# IT Receiving Log: Shipment D-1042\n\n" +
    "- Vendor: Kappa Office Systems S.A.\n" +
    "- SLA promised date: 2026-11-10, delivered: 2026-11-12\n" +
    "- PO quantity: 120 units of HUB-USBC; IT stockroom counted 104 units delivered.\n" +
    "- 6 units arrived with crushed enclosures / DOA ports, quarantined for RMA.\n" +
    "- Logged by: Workplace IT Operations, HQ Floor 4\n",
  "contracts/kappa_foods_terms.md":
    "# Master Procurement Agreement: Kappa Office Systems S.A.\n\n" +
    "1. HUB-USBC contracted unit price: EUR 17.50 per unit for FY2026.\n" +
    "2. Short-shipped units are credited at the contracted unit price.\n" +
    "3. DOA / transit-damaged hardware is credited at the contracted unit price.\n" +
    "4. Late SLA delivery penalty: 1% of accepted hardware value per day late, capped at 10%.\n" +
    "5. Credit claims must be submitted within 14 days of delivery.\n",
  "policies/claims_policy.md":
    "# Enterprise Agent Safety & Governance Policy\n\n" +
    "- Every database write, file edit, and outbound action must be rehearsed in an isolated copy first.\n" +
    "- Any vendor claim of EUR 250 or more requires human manager approval at the Risk Gate.\n" +
    "- Any external communication (email, webhook, or voice call) requires human approval.\n" +
    "- During vendor negotiation calls, accept credit settlements >= 85% of claim value; escalate lower offers.\n",
};

/** Seed rows shown when the backend is unreachable (mirrors backend/app/domain_config.py). */
export const FALLBACK_TABLES: Record<string, Row[]> = {
  claims: [],
  invoices: [
    { id: "INV-7702", supplier_id: "SUP-KAPPA", delivery_id: "D-1017", qty_billed: 80, unit_price: 17.5, amount: 1400.0, status: "paid" },
    { id: "INV-7735", supplier_id: "SUP-KAPPA", delivery_id: "D-1031", qty_billed: 60, unit_price: 17.5, amount: 1050.0, status: "paid" },
    { id: "INV-7781", supplier_id: "SUP-KAPPA", delivery_id: "D-1042", qty_billed: 120, unit_price: 18.9, amount: 2268.0, status: "unpaid" },
    { id: "INV-7790", supplier_id: "SUP-NOVA", delivery_id: "D-1050", qty_billed: 40, unit_price: 14.2, amount: 568.0, status: "unpaid" },
  ],
  deliveries: [
    { id: "D-1017", supplier_id: "SUP-KAPPA", sku: "HUB-USBC", qty_ordered: 80, qty_received: 74, qty_damaged: 0, promised_date: "2026-11-02", delivered_date: "2026-11-02", status: "received" },
    { id: "D-1031", supplier_id: "SUP-KAPPA", sku: "HUB-USBC", qty_ordered: 60, qty_received: 60, qty_damaged: 4, promised_date: "2026-11-06", delivered_date: "2026-11-06", status: "received" },
    { id: "D-1042", supplier_id: "SUP-KAPPA", sku: "HUB-USBC", qty_ordered: 120, qty_received: 104, qty_damaged: 6, promised_date: "2026-11-10", delivered_date: "2026-11-12", status: "received" },
    { id: "D-1050", supplier_id: "SUP-NOVA", sku: "KEY-MECH", qty_ordered: 40, qty_received: 40, qty_damaged: 0, promised_date: "2026-11-11", delivered_date: "2026-11-11", status: "received" },
  ],
  contract_prices: [
    { id: 1, supplier_id: "SUP-KAPPA", sku: "HUB-USBC", item: "USB-C Enterprise Workstation Hub", unit_price: 17.5, late_penalty_pct_per_day: 1.0, max_penalty_pct: 10.0 },
    { id: 2, supplier_id: "SUP-NOVA", sku: "KEY-MECH", item: "Wireless Office Keyboard", unit_price: 14.2, late_penalty_pct_per_day: 0.5, max_penalty_pct: 5.0 },
  ],
  suppliers: [
    { id: "SUP-KAPPA", name: "Kappa Office Systems S.A.", email: "accounts@kappaoffice.example", phone: "+30 210 000 0001" },
    { id: "SUP-NOVA", name: "Nova Workplace Cloud", email: "billing@novacloud.example", phone: "+30 210 000 0002" },
  ],
};

/** Minimal workspace snapshot so offline demo replays render row-level and file-level diffs. */
export function offlineState(tables: Record<string, Row[]> = FALLBACK_TABLES, files: Record<string, string> = FALLBACK_FILES): WorkspaceState {
  return {
    fingerprint: "offline-seed",
    files: { ...files },
    tables: Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))])),
    outbox: [],
    undo_stack: [],
    forged_tools: [],
    pending_approvals: [],
    pending_offers: [],
    metrics: { steps: 0, cost_eur: 0, forged_count: 0, unapproved_high_risk: 0 },
  };
}
