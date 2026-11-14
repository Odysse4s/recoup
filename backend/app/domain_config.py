"""Domain definition for Recoup: schema, seed data, brand and the scripted offline run.

Everything domain-specific lives here so the safety runtime, agent and HUD stay generic:
- the seeder builds the SQLite database and workspace files from `tables_sql`, `seed_rows` and `files`;
- the offline provider (`LLM_PROVIDER=fake`) replays `demo` step by step;
- `GET /api/state` exposes the brand and presets to the HUD.
"""
from __future__ import annotations

from typing import Any

BRAND_COLORS = ("indigo", "emerald", "amber", "rose", "cyan", "violet")

BRAND: dict[str, str] = {
    "brand_name": "Recoup",
    "brand_tagline": "Safety-first enterprise agent for vendor audits, staged ERP changes & reversible recovery.",
    "primary_color": "emerald",
}

PERSONA = "Finance & Workplace Operations Lead at a 350-person enterprise office"
HERO_GOAL = "Audit shipment D-1042 against our Kappa Office Systems contract, hold the overbilled invoice, and send the credit claim"
FOLLOW_UP_GOAL = "Recover unclaimed vendor credits across earlier Kappa Office Systems shipments D-1017 and D-1031"

CLAIM_LETTER_PATH = "claims/CLM-D-1042.md"
FOLLOW_UP_PATH = "claims/CLM-KAPPA-FOLLOWUP.md"

_FORGE_CODE = '''def compute_supplier_claim(args: dict) -> dict:
    billed = int(args.get("qty_billed", 0))
    received = int(args.get("qty_received", 0))
    damaged = int(args.get("qty_damaged", 0))
    billed_price = float(args.get("billed_unit_price", 0))
    contract_price = float(args.get("contract_unit_price", 0))
    days_late = max(0, int(args.get("days_late", 0)))
    pct_per_day = float(args.get("late_penalty_pct_per_day", 0))
    max_pct = float(args.get("max_penalty_pct", 0))

    overcharge = max(0.0, billed_price - contract_price) * billed
    shortage = max(0, billed - received) * contract_price
    damaged_credit = max(0, damaged) * contract_price
    accepted_value = max(0, received - damaged) * contract_price
    late_penalty = accepted_value * min(days_late * pct_per_day, max_pct) / 100
    total = overcharge + shortage + damaged_credit + late_penalty
    return {
        "overcharge": round(overcharge, 2),
        "shortage": round(shortage, 2),
        "damaged": round(damaged_credit, 2),
        "late_penalty": round(late_penalty, 2),
        "total": round(total, 2),
    }
'''

_CLAIM_LETTER = """# Vendor Credit Claim CLM-D-1042: Kappa Office Systems S.A.

**Shipment:** D-1042 (USB-C Enterprise Workstation Hub, SKU HUB-USBC)
**Invoice:** INV-7781 (billed EUR 2,268.00)

| Line item | Basis | Amount |
|---|---|---|
| Rate above master contract | 120 units x (EUR 18.90 - EUR 17.50) | EUR 168.00 |
| Short-shipped units | 16 units x EUR 17.50 | EUR 280.00 |
| Damaged in transit (DOA) | 6 units x EUR 17.50 | EUR 105.00 |
| SLA late-delivery penalty | 2 days x 1% of EUR 1,715.00 accepted goods | EUR 34.30 |
| **Total credit note requested** | | **EUR 587.30** |

Per clauses 2-4 of our Master Procurement Agreement, please issue a credit note for EUR 587.30
against INV-7781 within 7 business days. IT receiving log and inspection notes are attached.
"""

_FOLLOW_UP = """# Follow-up Vendor Audit: Kappa Office Systems S.A.

| Shipment | Invoice | Discrepancy | Amount |
|---|---|---|---|
| D-1017 | INV-7702 (paid) | 6 units short-shipped x EUR 17.50 | EUR 105.00 |
| D-1031 | INV-7735 (paid) | 4 units DOA damaged x EUR 17.50 | EUR 70.00 |
| **Total** | | | **EUR 175.00** |
"""

DOMAIN: dict[str, Any] = {
    "label": "Enterprise Vendor Ops",
    **BRAND,
    "persona": PERSONA,
    "vertical": "Safety-first enterprise back-office procurement & AP dispute automation",
    "primary_table": "claims",
    "default_goal": HERO_GOAL,
    "presets": [
        {
            "title": "Audit IT Shipment Discrepancy, Stage ERP Hold & Gate Vendor Claim",
            "badge": "HERO RUN",
            "goal": HERO_GOAL,
            "desc": (
                "Cross-checks IT receiving log against the master contract, synthesizes a sandboxed SLA "
                "calculator, stages the ERP invoice hold + credit claim as a diff, and gates outbound dispatch."
            ),
        },
        {
            "title": "Sweep Paid AP Ledger for Unclaimed Vendor SLA Credits",
            "badge": "FOLLOW-UP",
            "goal": FOLLOW_UP_GOAL,
            "desc": "Finds short-shipped and DOA units on already-paid invoices and stages one consolidated claim.",
        },
    ],
    "files": {
        "inbox/D-1042_receiving_note.md": (
            "# IT Receiving Log: Shipment D-1042\n\n"
            "- Vendor: Kappa Office Systems S.A.\n"
            "- SLA promised date: 2026-11-10, delivered: 2026-11-12\n"
            "- PO quantity: 120 units of HUB-USBC; IT stockroom counted 104 units delivered.\n"
            "- 6 units arrived with crushed enclosures / DOA ports, quarantined for RMA.\n"
            "- Logged by: Workplace IT Operations, HQ Floor 4\n"
        ),
        "contracts/kappa_foods_terms.md": (
            "# Master Procurement Agreement: Kappa Office Systems S.A.\n\n"
            "1. HUB-USBC contracted unit price: EUR 17.50 per unit for FY2026.\n"
            "2. Short-shipped units are credited at the contracted unit price.\n"
            "3. DOA / transit-damaged hardware is credited at the contracted unit price.\n"
            "4. Late SLA delivery penalty: 1% of accepted hardware value per day late, capped at 10%.\n"
            "5. Credit claims must be submitted within 14 days of delivery.\n"
        ),
        "policies/claims_policy.md": (
            "# Enterprise Agent Safety & Governance Policy\n\n"
            "- Every database write, file edit, and outbound action must be rehearsed in an isolated copy first.\n"
            "- Any vendor claim of EUR 250 or more requires human manager approval at the Risk Gate.\n"
            "- Any external communication (email, webhook, or voice call) requires human approval.\n"
            "- During vendor negotiation calls, accept credit settlements >= 85% of claim value; escalate lower offers.\n"
        ),
    },
    "tables_sql": [
        """
        CREATE TABLE suppliers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE contract_prices (
            id INTEGER PRIMARY KEY,
            supplier_id TEXT NOT NULL,
            sku TEXT NOT NULL,
            item TEXT NOT NULL,
            unit_price REAL NOT NULL,
            late_penalty_pct_per_day REAL NOT NULL,
            max_penalty_pct REAL NOT NULL
        )
        """,
        """
        CREATE TABLE deliveries (
            id TEXT PRIMARY KEY,
            supplier_id TEXT NOT NULL,
            sku TEXT NOT NULL,
            qty_ordered INTEGER NOT NULL,
            qty_received INTEGER NOT NULL,
            qty_damaged INTEGER NOT NULL,
            promised_date TEXT NOT NULL,
            delivered_date TEXT NOT NULL,
            status TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE invoices (
            id TEXT PRIMARY KEY,
            supplier_id TEXT NOT NULL,
            delivery_id TEXT NOT NULL,
            qty_billed INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            amount REAL NOT NULL,
            status TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE claims (
            id TEXT PRIMARY KEY,
            supplier_id TEXT NOT NULL,
            delivery_id TEXT NOT NULL,
            invoice_id TEXT NOT NULL,
            amount REAL NOT NULL,
            reason TEXT NOT NULL,
            status TEXT NOT NULL
        )
        """,
    ],
    "seed_rows": {
        "suppliers": [
            ("SUP-KAPPA", "Kappa Office Systems S.A.", "accounts@kappaoffice.example", "+30 210 000 0001"),
            ("SUP-NOVA", "Nova Workplace Cloud", "billing@novacloud.example", "+30 210 000 0002"),
        ],
        "contract_prices": [
            (1, "SUP-KAPPA", "HUB-USBC", "USB-C Enterprise Workstation Hub", 17.50, 1.0, 10.0),
            (2, "SUP-NOVA", "KEY-MECH", "Wireless Office Keyboard", 14.20, 0.5, 5.0),
        ],
        "deliveries": [
            ("D-1017", "SUP-KAPPA", "HUB-USBC", 80, 74, 0, "2026-11-02", "2026-11-02", "received"),
            ("D-1031", "SUP-KAPPA", "HUB-USBC", 60, 60, 4, "2026-11-06", "2026-11-06", "received"),
            ("D-1042", "SUP-KAPPA", "HUB-USBC", 120, 104, 6, "2026-11-10", "2026-11-12", "received"),
            ("D-1050", "SUP-NOVA", "KEY-MECH", 40, 40, 0, "2026-11-11", "2026-11-11", "received"),
        ],
        "invoices": [
            ("INV-7702", "SUP-KAPPA", "D-1017", 80, 17.50, 1400.00, "paid"),
            ("INV-7735", "SUP-KAPPA", "D-1031", 60, 17.50, 1050.00, "paid"),
            ("INV-7781", "SUP-KAPPA", "D-1042", 120, 18.90, 2268.00, "unpaid"),
            ("INV-7790", "SUP-NOVA", "D-1050", 40, 14.20, 568.00, "unpaid"),
        ],
        "claims": [],
    },
    "risk_rules": {
        "external_tools": ["send_email", "place_call", "trigger_webhook"],
        "money_table": "claims",
        "money_column": "amount",
        "approval_threshold_eur": 250.0,
        "max_auto_deleted_rows": 0,
    },
    "negotiation": {
        "counterparty": "Kappa Office Systems AR desk",
        "claim_id": "CLM-D-1042",
        "claim_amount": 587.30,
        "accept_floor_pct": 85,
        "opening_counter_pct": 70,
    },
    "demo": {
        "evidence": {
            "intent": "Read IT receiving log for shipment D-1042",
            "path": "inbox/D-1042_receiving_note.md",
            "thought": "Checking stockroom receiving log against the vendor purchase order.",
        },
        "lookup": {
            "intent": "Cross-check shipment, AP invoice and master contract rates",
            "sql": (
                "SELECT d.id, d.qty_ordered, d.qty_received, d.qty_damaged, d.promised_date, "
                "d.delivered_date, i.id AS invoice_id, i.qty_billed, i.unit_price AS billed_unit_price, "
                "i.amount, c.unit_price AS contract_unit_price, c.late_penalty_pct_per_day, "
                "c.max_penalty_pct FROM deliveries d JOIN invoices i ON i.delivery_id = d.id "
                "JOIN contract_prices c ON c.supplier_id = d.supplier_id AND c.sku = d.sku "
                "WHERE d.id = 'D-1042'"
            ),
        },
        "forge": {
            "name": "compute_supplier_claim",
            "trigger_keywords": ["recover", "claim", "owes", "credit", "audit"],
            "step_title": "Synthesize & verify SLA contract claim calculator",
            "purpose": (
                "Compute unit overcharge, short-shipped, DOA damaged and capped SLA late-delivery credits "
                "for an office vendor shipment and return each line item plus total rounded to cents"
            ),
            "signature": "def compute_supplier_claim(args: dict) -> dict",
            "code": _FORGE_CODE,
            "examples": [
                {
                    "in": {
                        "qty_billed": 120, "qty_received": 104, "qty_damaged": 6,
                        "billed_unit_price": 18.90, "contract_unit_price": 17.50, "days_late": 2,
                        "late_penalty_pct_per_day": 1.0, "max_penalty_pct": 10.0,
                    },
                    "out": {
                        "overcharge": 168.0, "shortage": 280.0, "damaged": 105.0,
                        "late_penalty": 34.3, "total": 587.3,
                    },
                },
                {
                    "in": {
                        "qty_billed": 40, "qty_received": 40, "qty_damaged": 0,
                        "billed_unit_price": 14.20, "contract_unit_price": 14.20, "days_late": 0,
                        "late_penalty_pct_per_day": 0.5, "max_penalty_pct": 5.0,
                    },
                    "out": {
                        "overcharge": 0.0, "shortage": 0.0, "damaged": 0.0,
                        "late_penalty": 0.0, "total": 0.0,
                    },
                },
                {
                    "in": {
                        "qty_billed": 10, "qty_received": 10, "qty_damaged": 0,
                        "billed_unit_price": 10.0, "contract_unit_price": 10.0, "days_late": 15,
                        "late_penalty_pct_per_day": 1.0, "max_penalty_pct": 10.0,
                    },
                    "out": {
                        "overcharge": 0.0, "shortage": 0.0, "damaged": 0.0,
                        "late_penalty": 10.0, "total": 10.0,
                    },
                },
            ],
            "call_args": {
                "qty_billed": 120, "qty_received": 104, "qty_damaged": 6,
                "billed_unit_price": 18.90, "contract_unit_price": 17.50, "days_late": 2,
                "late_penalty_pct_per_day": 1.0, "max_penalty_pct": 10.0,
            },
        },
        "mutations": [
            {
                "intent": "Stage vendor credit claim CLM-D-1042 for EUR 587.30",
                "table": "claims",
                "pk_col": "id",
                "row": {
                    "id": "CLM-D-1042", "supplier_id": "SUP-KAPPA", "delivery_id": "D-1042",
                    "invoice_id": "INV-7781", "amount": 587.30,
                    "reason": "overcharge 168.00, short 280.00, damaged 105.00, late 34.30",
                    "status": "drafted",
                },
                "thought": "Staging EUR 587.30 vendor credit claim against shipment D-1042.",
            },
            {
                "intent": "Place AP payment hold (`disputed`) on invoice INV-7781",
                "table": "invoices",
                "pk_col": "id",
                "row": {"id": "INV-7781", "status": "disputed"},
                "thought": "Holding INV-7781 in AP so finance does not auto-pay the overbilled invoice.",
            },
        ],
        "report": {
            "intent": "Draft formal vendor credit claim memo",
            "path": CLAIM_LETTER_PATH,
            "content": _CLAIM_LETTER,
        },
        "notify": {
            "intent": "Dispatch credit claim notice to Kappa Office Systems AR desk",
            "criterion": "claim email queued for Kappa Office Systems",
            "to": "accounts@kappaoffice.example",
            "subject": "Credit Claim CLM-D-1042 on Invoice INV-7781: EUR 587.30",
            "body": (
                "Hello Kappa Office Systems AR team,\n\nShipment D-1042 arrived 2 days past SLA with "
                "16 units short, 6 DOA units, and unit pricing above our FY2026 Master Agreement. "
                "Please issue a credit note of EUR 587.30 against INV-7781. Full audit attached.\n\nRegards,\nFinance & Workplace Ops"
            ),
        },
        "anticipate": {
            "need": "Recover EUR 175.00 in unclaimed credits across two paid AP invoices",
            "goal_prompt": FOLLOW_UP_GOAL,
            "evidence": (
                "Shipments D-1017 (6 units short) and D-1031 (4 DOA units) were paid in full "
                "on INV-7702 and INV-7735 without credit notes"
            ),
            "path": FOLLOW_UP_PATH,
            "content": _FOLLOW_UP,
        },
    },
}


def get_domain() -> dict[str, Any]:
    """Return the full domain definition used by the seeder, offline provider and HUD."""
    return DOMAIN


def brand() -> dict[str, str]:
    """Brand identity for the HUD, mobile approval screen and spoken briefings."""
    color = BRAND["primary_color"] if BRAND["primary_color"] in BRAND_COLORS else "emerald"
    return {**BRAND, "primary_color": color}
