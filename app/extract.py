"""Policy extraction with verified citations.

The model proposes values, each with a verbatim quote from the policy text. We keep
a value ONLY if its quote really appears in the document. A field the model cannot
back with a real quote is rejected, so a hallucinated clause never reaches the
rules engine.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .rules import Clause, Policy
from .schema import policy_from_dict

PROMPT = """You are extracting terms from a health insurance policy. Return ONLY JSON.
For every item include "quote": the exact words copied from the policy that support it,
"section": the clause number as printed (for example "Section 3.1") if shown, and "page" if known.
Omit anything the policy does not state. Never guess.
A room rent limit written as a percentage of the sum insured goes in room_rent_cap_pct_of_si
(for "1%" the value is 1); one written in rupees goes in room_rent_cap_per_day.
For sub_limits, "category" must be one of: room, doctor_fees, surgery, ot_charges, nursing,
diagnostics, procedure, pharmacy, consumables.

Schema:
{{
 "sum_insured": {{"value": number, "quote": str, "section": str, "page": int}},
 "room_rent_cap_per_day": {{"value": number, "quote": str, "section": str, "page": int}},
 "room_rent_cap_pct_of_si": {{"value": number, "quote": str, "section": str, "page": int}},
 "copay_pct": {{"value": number, "quote": str, "section": str, "page": int}},
 "deductible": {{"value": number, "quote": str, "section": str, "page": int}},
 "sub_limits": [{{"category": str, "value": number, "quote": str, "section": str, "page": int}}],
 "waiting_period_days": [{{"condition": str, "value": number, "quote": str, "section": str, "page": int}}],
 "exclusions": [{{"condition": str, "quote": str, "section": str, "page": int}}]
}}

POLICY TEXT:
{text}
"""

SCALARS = ["sum_insured", "room_rent_cap_per_day", "room_rent_cap_pct_of_si", "copay_pct", "deductible"]


CATEGORY_WORDS = [  # (category, substrings that identify it)
    ("diagnostics", ("diagnos", "investigat", "test", "scan", "lab", "radiolog", "imaging", "pathology")),
    ("pharmacy", ("pharmac", "medicine", "drug")),
    ("consumables", ("consumable", "disposable")),
    ("ot_charges", ("ot_", "theatre", "theater", "ot charge")),
    ("nursing", ("nursing",)),
    ("surgery", ("surg",)),
    ("doctor_fees", ("doctor", "consult", "physician", "specialist", "professional")),
    ("procedure", ("procedure",)),
    ("room", ("room", "bed", "boarding")),
]
LABELS = {"sum_insured": "Sum insured", "room_rent_cap_per_day": "Room rent", "room_rent_cap_pct_of_si": "Room rent",
          "copay_pct": "Co-payment", "deductible": "Deductible"}


def normalize_category(raw: str):
    s = _norm(raw).replace("-", "_")
    for cat, words in CATEGORY_WORDS:
        if s == cat or any(w in s for w in words):
            return cat
    return None


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def quote_in_text(quote: str, text: str) -> bool:
    q = _norm(quote)
    return len(q) >= 8 and q in _norm(text)


@dataclass
class Extraction:
    policy: Policy | None
    rejected: list = field(default_factory=list)   # (field, reason)
    missing: list = field(default_factory=list)


def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    return json.loads(raw)


def extract_policy(text: str, llm) -> Extraction:
    try:
        data = _parse_json(llm.generate(PROMPT.format(text=text)))
    except (json.JSONDecodeError, TypeError) as e:
        return Extraction(None, rejected=[("response", f"not valid JSON: {e}")])

    out: dict = {}
    clauses: dict = {}
    rejected: list = []

    def accept(item: dict, field_name: str, clause_name: str) -> bool:
        if not isinstance(item, dict) or "quote" not in item:
            rejected.append((field_name, "no supporting quote"))
            return False
        if not quote_in_text(item["quote"], text):
            rejected.append((field_name, "quote not found in policy text"))
            return False
        label = item.get("section") or LABELS.get(field_name) or field_name.replace("_", " ").replace(":", ": ").capitalize()
        clauses[clause_name] = {"ref": str(label)[:60], "text": item["quote"], "page": item.get("page")}
        return True

    for f in SCALARS:
        if f in data and data[f] is not None:
            if accept(data[f], f, {"room_rent_cap_per_day": "room_rent", "room_rent_cap_pct_of_si": "room_rent",
                                   "sum_insured": "sum_insured", "copay_pct": "copay",
                                   "deductible": "deductible"}[f]):
                out[f] = data[f].get("value")

    for it in data.get("sub_limits") or []:
        cat = normalize_category(str(it.get("category", ""))) if isinstance(it, dict) else None
        if cat is None:
            rejected.append((f"sub_limit:{it.get('category') if isinstance(it, dict) else it}", "category not supported"))
            continue
        if accept(it, f"sub_limit:{cat}", f"sub_limit:{cat}"):
            out.setdefault("sub_limits", {})[cat] = it["value"]
    for it in data.get("waiting_period_days") or []:
        if accept(it, f"waiting_period:{it.get('condition')}", "waiting_period"):
            out.setdefault("waiting_period_days", {})[it["condition"]] = it["value"]
    for it in data.get("exclusions") or []:
        if accept(it, f"exclusion:{it.get('condition')}", "exclusion"):
            out.setdefault("exclusions", []).append(it["condition"])

    if "sum_insured" not in out:
        return Extraction(None, rejected, missing=["sum_insured"])
    out["clauses"] = clauses
    return Extraction(policy_from_dict(out), rejected, [])
