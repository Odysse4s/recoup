"""Domain definition for Recoup: schema, seed data, brand and the scripted offline run.

Everything domain-specific lives here so the engine, agent and HUD stay generic:
- the seeder builds the SQLite database and workspace files from `tables_sql`, `seed_rows` and `files`;
- the offline provider (`LLM_PROVIDER=fake`) replays `demo` step by step;
- `GET /api/state` exposes the brand and presets to the HUD.
"""
from __future__ import annotations

from typing import Any

BRAND_COLORS = ("indigo", "emerald", "amber", "rose", "cyan", "violet")

BRAND: dict[str, str] = {
    "brand_name": "Recoup",
    "brand_tagline": "Makes the supplier call you avoid. Rehearsed, approved, reversible.",
    "primary_color": "emerald",
}

PERSONA = "Operations manager at a six-location restaurant group in Athens"
HERO_GOAL = "Recover what Kappa Foods owes us for delivery D-1042 and send them the claim"
FOLLOW_UP_GOAL = "Recover what Kappa Foods owes us for deliveries D-1017 and D-1031"

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

_CLAIM_LETTER = """# Claim CLM-D-1042: Kappa Foods S.A.

**Delivery:** D-1042 (Extra virgin olive oil 5L, SKU OIL-5L)
**Invoice:** INV-7781 (billed EUR 2,268.00)

| Line item | Basis | Amount |
|---|---|---|
| Price above contract | 120 cases x (EUR 18.90 - EUR 17.50) | EUR 168.00 |
| Short delivery | 16 cases x EUR 17.50 | EUR 280.00 |
| Damaged on arrival | 6 cases x EUR 17.50 | EUR 105.00 |
| Late delivery penalty | 2 days x 1% of EUR 1,715.00 accepted goods | EUR 34.30 |
| **Total credit requested** | | **EUR 587.30** |

Per clauses 2-4 of our supply terms, please issue a credit note for EUR 587.30 against INV-7781
within 7 days. Receiving note and photos are attached.
"""

_FOLLOW_UP = """# Follow-up claim: Kappa Foods S.A.

| Delivery | Invoice | Issue | Amount |
|---|---|---|---|
| D-1017 | INV-7702 (paid) | 6 cases short x EUR 17.50 | EUR 105.00 |
| D-1031 | INV-7735 (paid) | 4 cases damaged x EUR 17.50 | EUR 70.00 |
| **Total** | | | **EUR 175.00** |
"""

DOMAIN: dict[str, Any] = {
    "label": "Supplier Claims",
    **BRAND,
    "persona": PERSONA,
    "vertical": "Supplier dispute recovery for restaurant groups",
    "primary_table": "claims",
    "default_goal": HERO_GOAL,
    "presets": [
        {
            "title": "Recover a short, damaged and overpriced delivery",
            "badge": "HERO RUN",
            "goal": HERO_GOAL,
            "desc": (
                "Reads the receiving note, checks the contract, builds a claim calculator on the fly, "
                "stages the claim and invoice dispute, and holds the supplier email for approval."
            ),
        },
        {
            "title": "Sweep earlier deliveries for unclaimed credits",
            "badge": "FOLLOW-UP",
            "goal": FOLLOW_UP_GOAL,
            "desc": "Finds shortages and damages on already-paid invoices and drafts one bundled claim.",
        },
    ],
    "files": {
        "inbox/D-1042_receiving_note.md": (
            "# Receiving note: delivery D-1042\n\n"
            "- Supplier: Kappa Foods S.A.\n"
            "- Promised: 2026-11-10, arrived: 2026-11-12\n"
            "- Ordered 120 cases of OIL-5L, counted 104 on the pallet.\n"
            "- 6 cases crushed and leaking, set aside for return.\n"
            "- Signed by: kitchen receiving, Kolonaki branch\n"
        ),
        "contracts/kappa_foods_terms.md": (
            "# Supply terms: Kappa Foods S.A.\n\n"
            "1. OIL-5L contract price: EUR 17.50 per case for 2026.\n"
            "2. Short deliveries are credited at the contract price.\n"
            "3. Goods damaged on arrival are credited at the contract price.\n"
            "4. Late delivery: 1% of accepted goods value per day late, capped at 10%.\n"
            "5. Claims must be raised within 14 days of delivery.\n"
        ),
        "policies/claims_policy.md": (
            "# Supplier claims policy\n\n"
            "- Any claim of EUR 250 or more needs manager approval before it is sent.\n"
            "- Any outbound supplier contact (email or call) needs manager approval.\n"
            "- Accept settlement offers of 85% of the claim or more; escalate anything lower.\n"
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
            ("SUP-KAPPA", "Kappa Foods S.A.", "accounts@kappafoods.example", "+30 210 000 0001"),
            ("SUP-THESS", "Thessaly Dairy", "billing@thessalydairy.example", "+30 241 000 0002"),
        ],
        "contract_prices": [
            (1, "SUP-KAPPA", "OIL-5L", "Extra virgin olive oil 5L", 17.50, 1.0, 10.0),
            (2, "SUP-THESS", "FETA-2KG", "PDO feta 2kg tin", 14.20, 0.5, 5.0),
        ],
        "deliveries": [
            ("D-1017", "SUP-KAPPA", "OIL-5L", 80, 74, 0, "2026-11-02", "2026-11-02", "received"),
            ("D-1031", "SUP-KAPPA", "OIL-5L", 60, 60, 4, "2026-11-06", "2026-11-06", "received"),
            ("D-1042", "SUP-KAPPA", "OIL-5L", 120, 104, 6, "2026-11-10", "2026-11-12", "received"),
            ("D-1050", "SUP-THESS", "FETA-2KG", 40, 40, 0, "2026-11-11", "2026-11-11", "received"),
        ],
        "invoices": [
            ("INV-7702", "SUP-KAPPA", "D-1017", 80, 17.50, 1400.00, "paid"),
            ("INV-7735", "SUP-KAPPA", "D-1031", 60, 17.50, 1050.00, "paid"),
            ("INV-7781", "SUP-KAPPA", "D-1042", 120, 18.90, 2268.00, "unpaid"),
            ("INV-7790", "SUP-THESS", "D-1050", 40, 14.20, 568.00, "unpaid"),
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
        "counterparty": "Kappa Foods accounts team",
        "claim_id": "CLM-D-1042",
        "claim_amount": 587.30,
        "accept_floor_pct": 85,
        "opening_counter_pct": 70,
    },
    "demo": {
        "evidence": {
            "intent": "Read the receiving note for delivery D-1042",
            "path": "inbox/D-1042_receiving_note.md",
            "thought": "Checking what the kitchen actually received against the order.",
        },
        "lookup": {
            "intent": "Look up the delivery, invoice and contract price",
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
            "trigger_keywords": ["recover", "claim", "owes", "credit"],
            "step_title": "Calculate the claim under the supply contract",
            "purpose": (
                "Compute overcharge, shortage, damage and capped late-delivery credits for one delivery "
                "and return each line item plus the total, rounded to cents"
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
                "intent": "Open claim CLM-D-1042 for EUR 587.30",
                "table": "claims",
                "pk_col": "id",
                "row": {
                    "id": "CLM-D-1042", "supplier_id": "SUP-KAPPA", "delivery_id": "D-1042",
                    "invoice_id": "INV-7781", "amount": 587.30,
                    "reason": "overcharge 168.00, short 280.00, damaged 105.00, late 34.30",
                    "status": "drafted",
                },
                "thought": "Recording the EUR 587.30 claim against delivery D-1042.",
            },
            {
                "intent": "Mark invoice INV-7781 as disputed so it is not paid in full",
                "table": "invoices",
                "pk_col": "id",
                "row": {"id": "INV-7781", "status": "disputed"},
                "thought": "Holding INV-7781 so accounts payable does not pay the overbilled amount.",
            },
        ],
        "report": {
            "intent": "Write the claim letter",
            "path": CLAIM_LETTER_PATH,
            "content": _CLAIM_LETTER,
        },
        "notify": {
            "intent": "Email the claim to Kappa Foods",
            "criterion": "claim email queued for Kappa Foods",
            "to": "accounts@kappafoods.example",
            "subject": "Claim CLM-D-1042 for delivery D-1042: EUR 587.30",
            "body": (
                "Hello Kappa Foods team,\n\nDelivery D-1042 arrived 2 days late with 16 cases short, "
                "6 damaged, and was invoiced above our contract price. Please issue a credit note of "
                "EUR 587.30 against INV-7781. The full breakdown is attached.\n\nThank you."
            ),
        },
        "anticipate": {
            "need": "Bundle a EUR 175.00 follow-up claim for two earlier Kappa Foods deliveries",
            "goal_prompt": FOLLOW_UP_GOAL,
            "evidence": (
                "D-1017 arrived 6 cases short and D-1031 had 4 damaged cases, "
                "but invoices INV-7702 and INV-7735 were paid in full"
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
