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
ORION_GOAL = (
    "Audit shipment D-2010 against our Orion Breakroom Supplies contract for the SLA "
    "late-delivery penalty and stage the credit claim on invoice INV-8801."
)
ATLAS_GOAL = (
    "Audit shipment D-3005 against our Atlas Paper & Stationery volume-discount contract for the "
    "correct tiered pricing and stage the credit claim on invoice INV-9901."
)

CLAIM_LETTER_PATH = "claims/CLM-D-1042.md"
FOLLOW_UP_PATH = "claims/CLM-KAPPA-FOLLOWUP.md"
ORION_CLAIM_LETTER_PATH = "claims/CLM-D-2010.md"
ATLAS_CLAIM_LETTER_PATH = "claims/CLM-D-3005.md"

# Goal-text markers used to dispatch the offline FakeProvider script to the right seeded
# scenario. Checked in order; the first match wins. Anything that matches none of these
# (including the hero/follow-up goals) falls back to the original hero `demo` dict below -
# this is what keeps every existing hero/follow-up test byte-for-byte unaffected.
GOAL_SCENARIO_MARKERS: dict[str, tuple[str, ...]] = {
    "orion": ("d-2010", "orion"),
    "atlas": ("d-3005", "atlas"),
}

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

_ORION_CLAIM_LETTER = """# Vendor Credit Claim CLM-D-2010: Orion Breakroom Supplies Ltd.

**Shipment:** D-2010 (Premium Coffee Beans 1kg Bag, SKU COF-BEAN)
**Invoice:** INV-8801 (billed EUR 980.00)

| Line item | Basis | Amount |
|---|---|---|
| SLA late-delivery penalty | 3 days x 0.5% of EUR 980.00 accepted goods | EUR 14.70 |
| **Total credit note requested** | | **EUR 14.70** |

Per clause 2 of our Master Supply Agreement, please issue a credit note for EUR 14.70
against INV-8801 within 7 business days. Facilities receiving log attached.
"""

# No overcharge/shortage/damage; every line item in compute_supplier_claim collapses to zero
# except the late penalty, so D-2010 reuses the same sandbox-verified tool rather than forging
# a second one that would just be `compute_supplier_claim` with half its arguments at zero.
_ORION_FORGE_CALL_ARGS = {
    "qty_billed": 100, "qty_received": 100, "qty_damaged": 0,
    "billed_unit_price": 9.80, "contract_unit_price": 9.80, "days_late": 3,
    "late_penalty_pct_per_day": 0.5, "max_penalty_pct": 5.0,
}

_ATLAS_FORGE_CODE = '''def compute_tiered_discount_claim(args: dict) -> dict:
    qty = int(args.get("qty", 0))
    billed_unit_price = float(args.get("billed_unit_price", 0))
    list_unit_price = float(args.get("list_unit_price", 0))
    tier_1_min_qty = int(args.get("tier_1_min_qty", 0))
    tier_1_discount_pct = float(args.get("tier_1_discount_pct", 0))
    tier_2_min_qty = int(args.get("tier_2_min_qty", 0))
    tier_2_discount_pct = float(args.get("tier_2_discount_pct", 0))

    if qty >= tier_2_min_qty and tier_2_min_qty > 0:
        correct_discount_pct = tier_2_discount_pct
    elif qty >= tier_1_min_qty and tier_1_min_qty > 0:
        correct_discount_pct = tier_1_discount_pct
    else:
        correct_discount_pct = 0.0

    correct_unit_price = list_unit_price * (1 - correct_discount_pct / 100)
    overcharge_per_unit = max(0.0, billed_unit_price - correct_unit_price)
    total = round(overcharge_per_unit * qty, 2)
    return {
        "correct_discount_pct": correct_discount_pct,
        "correct_unit_price": round(correct_unit_price, 2),
        "overcharge_per_unit": round(overcharge_per_unit, 2),
        "total": total,
    }
'''

_ATLAS_CLAIM_LETTER = """# Vendor Credit Claim CLM-D-3005: Atlas Paper & Stationery Co.

**Shipment:** D-3005 (Premium A4 Copy Paper, SKU PPR-A4)
**Invoice:** INV-9901 (billed EUR 9,500.00)

| Line item | Basis | Amount |
|---|---|---|
| Wrong volume-discount tier | 1,000 cases x (EUR 9.50 billed - EUR 9.00 correct 10%-tier price) | EUR 500.00 |
| **Total credit note requested** | | **EUR 500.00** |

Per clause 2 of our Master Supply Agreement, a 1,000-case order qualifies for the 10% volume
tier (EUR 9.00/case), not the 5% tier (EUR 9.50/case) applied on this invoice. Please issue a
credit note for EUR 500.00 against INV-9901 within 14 days. Facilities receiving log attached.
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
        {
            "title": "Audit Late Coffee Delivery & Auto-Stage Small SLA Credit",
            "badge": "AUTO-RESOLVE",
            "goal": ORION_GOAL,
            "desc": (
                "Shows the risk gate's threshold in action: a EUR 14.70 late-delivery credit is small "
                "enough to auto-commit to the ERP, while dispatching the vendor email still pauses for "
                "a human tap."
            ),
        },
        {
            "title": "Forge a Tiered-Discount Calculator & Catch the Wrong Pricing Tier",
            "badge": "NEW TOOL",
            "goal": ATLAS_GOAL,
            "desc": (
                "No existing calculator fits: the agent forges a brand-new tiered volume-discount "
                "reconciliation tool from scratch, sandbox-verifies it, and uses it to catch a "
                "EUR 500.00 pricing-tier shortfall on a 1,000-case paper order."
            ),
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
        "inbox/D-2010_receiving_note.md": (
            "# Facilities Receiving Log: Shipment D-2010\n\n"
            "- Vendor: Orion Breakroom Supplies Ltd.\n"
            "- SLA promised date: 2026-11-12, delivered: 2026-11-15.\n"
            "- PO quantity: 100 units of COF-BEAN; Facilities stockroom counted 100 units delivered, "
            "all accepted in good condition, no damage.\n"
            "- Logged by: Workplace Facilities, HQ Ground Floor\n"
        ),
        "contracts/orion_breakroom_terms.md": (
            "# Master Supply Agreement: Orion Breakroom Supplies Ltd.\n\n"
            "1. COF-BEAN contracted unit price: EUR 9.80 per unit for FY2026.\n"
            "2. Late SLA delivery penalty: 0.5% of accepted goods value per day late, capped at 5%.\n"
            "3. Credit claims must be submitted within 14 days of delivery.\n"
        ),
        "inbox/D-3005_receiving_note.md": (
            "# Facilities Receiving Log: Shipment D-3005\n\n"
            "- Vendor: Atlas Paper & Stationery Co.\n"
            "- SLA promised date: 2026-11-08, delivered: 2026-11-08 (on time).\n"
            "- PO quantity: 1000 cases of PPR-A4; Facilities stockroom counted 1000 cases delivered, "
            "all accepted in good condition, no damage.\n"
            "- Logged by: Workplace Facilities, HQ Ground Floor\n"
        ),
        "contracts/atlas_paper_terms.md": (
            "# Master Supply Agreement: Atlas Paper & Stationery Co.\n\n"
            "1. PPR-A4 list price: EUR 10.00 per case (10 reams) for FY2026.\n"
            "2. Volume discount tiers apply to the per-case price based on total cases ordered on a "
            "single PO: 500-999 cases -> 5% off (EUR 9.50/case); 1000+ cases -> 10% off (EUR 9.00/case).\n"
            "3. Credit claims for pricing/tier discrepancies must be submitted within 14 days of delivery.\n"
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
            ("SUP-ORION", "Orion Breakroom Supplies Ltd.", "accounts@orionbreakroom.example", "+30 210 000 0003"),
            ("SUP-ATLAS", "Atlas Paper & Stationery Co.", "accounts@atlaspaper.example", "+30 210 000 0004"),
        ],
        "contract_prices": [
            (1, "SUP-KAPPA", "HUB-USBC", "USB-C Enterprise Workstation Hub", 17.50, 1.0, 10.0),
            (2, "SUP-NOVA", "KEY-MECH", "Wireless Office Keyboard", 14.20, 0.5, 5.0),
            (3, "SUP-ORION", "COF-BEAN", "Premium Coffee Beans 1kg Bag", 9.80, 0.5, 5.0),
            (4, "SUP-ATLAS", "PPR-A4", "Premium A4 Copy Paper (Case of 10 Reams)", 10.00, 0.0, 0.0),
        ],
        "deliveries": [
            ("D-1017", "SUP-KAPPA", "HUB-USBC", 80, 74, 0, "2026-11-02", "2026-11-02", "received"),
            ("D-1031", "SUP-KAPPA", "HUB-USBC", 60, 60, 4, "2026-11-06", "2026-11-06", "received"),
            ("D-1042", "SUP-KAPPA", "HUB-USBC", 120, 104, 6, "2026-11-10", "2026-11-12", "received"),
            ("D-1050", "SUP-NOVA", "KEY-MECH", 40, 40, 0, "2026-11-11", "2026-11-11", "received"),
            ("D-2010", "SUP-ORION", "COF-BEAN", 100, 100, 0, "2026-11-12", "2026-11-15", "received"),
            ("D-3005", "SUP-ATLAS", "PPR-A4", 1000, 1000, 0, "2026-11-08", "2026-11-08", "received"),
        ],
        "invoices": [
            ("INV-7702", "SUP-KAPPA", "D-1017", 80, 17.50, 1400.00, "paid"),
            ("INV-7735", "SUP-KAPPA", "D-1031", 60, 17.50, 1050.00, "paid"),
            ("INV-7781", "SUP-KAPPA", "D-1042", 120, 18.90, 2268.00, "unpaid"),
            ("INV-7790", "SUP-NOVA", "D-1050", 40, 14.20, 568.00, "unpaid"),
            ("INV-8801", "SUP-ORION", "D-2010", 100, 9.80, 980.00, "unpaid"),
            ("INV-9901", "SUP-ATLAS", "D-3005", 1000, 9.50, 9500.00, "unpaid"),
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
        "delivery_id": "D-1042",
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

# Orion (D-2010): a deliberately small, SLA-penalty-only claim under the EUR 250 auto-approval
# threshold. Reuses the already sandbox-verified `compute_supplier_claim` tool (see comment on
# `_ORION_FORGE_CALL_ARGS` above) instead of forging a redundant second calculator.
_ORION_DEMO: dict[str, Any] = {
    "delivery_id": "D-2010",
    "evidence": {
        "intent": "Read Facilities receiving log for shipment D-2010",
        "path": "inbox/D-2010_receiving_note.md",
        "thought": "Checking Facilities receiving log against the Orion purchase order.",
    },
    "lookup": {
        "intent": "Cross-check shipment, AP invoice and master contract rates",
        "sql": (
            "SELECT d.id, d.qty_ordered, d.qty_received, d.qty_damaged, d.promised_date, "
            "d.delivered_date, i.id AS invoice_id, i.qty_billed, i.unit_price AS billed_unit_price, "
            "i.amount, c.unit_price AS contract_unit_price, c.late_penalty_pct_per_day, "
            "c.max_penalty_pct FROM deliveries d JOIN invoices i ON i.delivery_id = d.id "
            "JOIN contract_prices c ON c.supplier_id = d.supplier_id AND c.sku = d.sku "
            "WHERE d.id = 'D-2010'"
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
        "examples": DOMAIN["demo"]["forge"]["examples"],
        "call_args": _ORION_FORGE_CALL_ARGS,
    },
    "mutations": [
        {
            "intent": "Stage vendor credit claim CLM-D-2010 for EUR 14.70",
            "table": "claims",
            "pk_col": "id",
            "row": {
                "id": "CLM-D-2010", "supplier_id": "SUP-ORION", "delivery_id": "D-2010",
                "invoice_id": "INV-8801", "amount": 14.70,
                "reason": "late 14.70",
                "status": "drafted",
            },
            "thought": "Staging EUR 14.70 vendor credit claim against shipment D-2010.",
        },
        {
            "intent": "Place AP payment hold (`disputed`) on invoice INV-8801",
            "table": "invoices",
            "pk_col": "id",
            "row": {"id": "INV-8801", "status": "disputed"},
            "thought": "Holding INV-8801 in AP so finance does not auto-pay before the credit lands.",
        },
    ],
    "report": {
        "intent": "Draft formal vendor credit claim memo",
        "path": ORION_CLAIM_LETTER_PATH,
        "content": _ORION_CLAIM_LETTER,
    },
    "notify": {
        "intent": "Dispatch credit claim notice to Orion Breakroom Supplies AR desk",
        "criterion": "claim email queued for Orion Breakroom Supplies",
        "to": "accounts@orionbreakroom.example",
        "subject": "Credit Claim CLM-D-2010 on Invoice INV-8801: EUR 14.70",
        "body": (
            "Hello Orion Breakroom Supplies AR team,\n\nShipment D-2010 arrived 3 days past SLA. "
            "Please issue a credit note of EUR 14.70 against INV-8801. Full audit attached.\n\n"
            "Regards,\nFinance & Workplace Ops"
        ),
    },
}

# Atlas (D-3005): no existing tool fits a tiered volume-discount reconciliation, so this scenario
# forges a brand-new `compute_tiered_discount_claim` tool from scratch and sandbox-verifies it.
_ATLAS_DEMO: dict[str, Any] = {
    "delivery_id": "D-3005",
    "evidence": {
        "intent": "Read Facilities receiving log for shipment D-3005",
        "path": "inbox/D-3005_receiving_note.md",
        "thought": "Checking Facilities receiving log against the Atlas purchase order.",
    },
    "lookup": {
        "intent": "Cross-check shipment, AP invoice and master contract volume-discount tiers",
        "sql": (
            "SELECT d.id, d.qty_ordered, d.qty_received, i.id AS invoice_id, i.qty_billed, "
            "i.unit_price AS billed_unit_price, i.amount, c.unit_price AS list_unit_price "
            "FROM deliveries d JOIN invoices i ON i.delivery_id = d.id "
            "JOIN contract_prices c ON c.supplier_id = d.supplier_id AND c.sku = d.sku "
            "WHERE d.id = 'D-3005'"
        ),
    },
    "forge": {
        "name": "compute_tiered_discount_claim",
        "trigger_keywords": ["recover", "claim", "owes", "credit", "audit", "tier", "pricing", "discount"],
        "step_title": "Synthesize & verify tiered volume-discount reconciliation calculator",
        "purpose": (
            "Determine the correct volume-discount tier for a bulk order, compare it against the "
            "billed unit price, and return the per-unit overcharge and total credit owed"
        ),
        "signature": "def compute_tiered_discount_claim(args: dict) -> dict",
        "code": _ATLAS_FORGE_CODE,
        "input_schema": {
            "type": "object",
            "properties": {
                "qty": {"type": "integer"},
                "billed_unit_price": {"type": "number"},
                "list_unit_price": {"type": "number"},
                "tier_1_min_qty": {"type": "integer"},
                "tier_1_discount_pct": {"type": "number"},
                "tier_2_min_qty": {"type": "integer"},
                "tier_2_discount_pct": {"type": "number"},
            },
            "required": [
                "qty", "billed_unit_price", "list_unit_price",
                "tier_1_min_qty", "tier_1_discount_pct", "tier_2_min_qty", "tier_2_discount_pct",
            ],
        },
        "examples": [
            {
                "in": {
                    "qty": 1000, "billed_unit_price": 9.50, "list_unit_price": 10.00,
                    "tier_1_min_qty": 500, "tier_1_discount_pct": 5.0,
                    "tier_2_min_qty": 1000, "tier_2_discount_pct": 10.0,
                },
                "out": {
                    "correct_discount_pct": 10.0, "correct_unit_price": 9.0,
                    "overcharge_per_unit": 0.5, "total": 500.0,
                },
            },
            {
                "in": {
                    "qty": 600, "billed_unit_price": 10.00, "list_unit_price": 10.00,
                    "tier_1_min_qty": 500, "tier_1_discount_pct": 5.0,
                    "tier_2_min_qty": 1000, "tier_2_discount_pct": 10.0,
                },
                "out": {
                    "correct_discount_pct": 5.0, "correct_unit_price": 9.5,
                    "overcharge_per_unit": 0.5, "total": 300.0,
                },
            },
            {
                "in": {
                    "qty": 200, "billed_unit_price": 10.00, "list_unit_price": 10.00,
                    "tier_1_min_qty": 500, "tier_1_discount_pct": 5.0,
                    "tier_2_min_qty": 1000, "tier_2_discount_pct": 10.0,
                },
                "out": {
                    "correct_discount_pct": 0.0, "correct_unit_price": 10.0,
                    "overcharge_per_unit": 0.0, "total": 0.0,
                },
            },
        ],
        "call_args": {
            "qty": 1000, "billed_unit_price": 9.50, "list_unit_price": 10.00,
            "tier_1_min_qty": 500, "tier_1_discount_pct": 5.0,
            "tier_2_min_qty": 1000, "tier_2_discount_pct": 10.0,
        },
    },
    "mutations": [
        {
            "intent": "Stage vendor credit claim CLM-D-3005 for EUR 500.00",
            "table": "claims",
            "pk_col": "id",
            "row": {
                "id": "CLM-D-3005", "supplier_id": "SUP-ATLAS", "delivery_id": "D-3005",
                "invoice_id": "INV-9901", "amount": 500.00,
                "reason": "wrong volume-discount tier applied: billed 5% tier instead of 10% tier",
                "status": "drafted",
            },
            "thought": "Staging EUR 500.00 vendor credit claim against shipment D-3005.",
        },
        {
            "intent": "Place AP payment hold (`disputed`) on invoice INV-9901",
            "table": "invoices",
            "pk_col": "id",
            "row": {"id": "INV-9901", "status": "disputed"},
            "thought": "Holding INV-9901 in AP so finance does not auto-pay the mispriced invoice.",
        },
    ],
    "report": {
        "intent": "Draft formal vendor credit claim memo",
        "path": ATLAS_CLAIM_LETTER_PATH,
        "content": _ATLAS_CLAIM_LETTER,
    },
    "notify": {
        "intent": "Dispatch credit claim notice to Atlas Paper & Stationery AR desk",
        "criterion": "claim email queued for Atlas Paper & Stationery",
        "to": "accounts@atlaspaper.example",
        "subject": "Credit Claim CLM-D-3005 on Invoice INV-9901: EUR 500.00",
        "body": (
            "Hello Atlas Paper & Stationery AR team,\n\nShipment D-3005 (1,000 cases) was billed at "
            "the 5% volume-discount tier (EUR 9.50/case) instead of the 10% tier (EUR 9.00/case) our "
            "order volume qualifies for. Please issue a credit note of EUR 500.00 against INV-9901. "
            "Full audit attached.\n\nRegards,\nFinance & Workplace Ops"
        ),
    },
}

# Scenario registry + goal dispatch for the offline FakeProvider script. `DOMAIN["demo"]` is left
# completely untouched above so every existing hero/follow-up test keeps reading exactly what it
# always has; this is purely additive.
DOMAIN["demo_scenarios"] = {
    "hero": DOMAIN["demo"],
    "orion": _ORION_DEMO,
    "atlas": _ATLAS_DEMO,
}


def resolve_demo_for_goal(goal: str) -> dict[str, Any]:
    """Pick the seeded `demo` script matching a submitted goal's text; defaults to the hero D-1042
    scenario for the hero goal itself, the D-1017/D-1031 follow-up goal, and anything unrecognized."""
    low = (goal or "").lower()
    for scenario_id, markers in GOAL_SCENARIO_MARKERS.items():
        if any(marker in low for marker in markers):
            return DOMAIN["demo_scenarios"][scenario_id]
    return DOMAIN["demo"]


def get_domain() -> dict[str, Any]:
    """Return the full domain definition used by the seeder, offline provider and HUD."""
    return DOMAIN


def brand() -> dict[str, str]:
    """Brand identity for the HUD, mobile approval screen and spoken briefings."""
    color = BRAND["primary_color"] if BRAND["primary_color"] in BRAND_COLORS else "emerald"
    return {**BRAND, "primary_color": color}
