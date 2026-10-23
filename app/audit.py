"""Bill audit. Findings are prompts to ask the hospital, never accusations."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

# Items insurers commonly treat as non-payable. Always check against the policy's own list.
COMMON_NON_PAYABLE = (
    "gloves", "mask", "admission kit", "registration", "service charge", "surcharge",
    "attendant", "toiletries", "diaper", "sanitizer", "thermometer", "cotton", "bandage",
    "food for attendant", "telephone", "tv", "laundry", "file charge", "medical record",
)

REFERENCE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "reference_rates.json")


@dataclass
class Finding:
    kind: str
    description: str
    detail: str
    severity: str = "check"   # "check" | "info"


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def load_reference(path: str = REFERENCE_PATH) -> dict:
    """procedure(lowercase) -> {"low","high","source"}. Empty if file absent."""
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return {r["procedure"].lower(): r for r in data.get("rates", [])}


def audit_bill(lines: list, procedure: Optional[str] = None, reference: Optional[dict] = None) -> list:
    findings: list = []

    seen: dict = {}
    for l in lines:
        key = (_norm(l.description), Decimal(str(l.amount)))
        seen.setdefault(key, []).append(l)
    for (name, amt), group in seen.items():
        if len(group) > 1:
            findings.append(Finding(
                "possible_duplicate", group[0].description,
                f"'{group[0].description}' appears {len(group)} times at Rs {amt}. "
                "Ask the hospital whether each is a separate service."))

    for l in lines:
        if l.category == "non_payable":
            continue
        n = _norm(l.description)
        for kw in COMMON_NON_PAYABLE:
            if kw in n:
                findings.append(Finding(
                    "likely_non_payable", l.description,
                    f"'{l.description}' (Rs {l.amount}) is often treated as non-payable. "
                    "Check the policy's non-payable list before expecting it to be covered.",
                    "info"))
                break

    reference = reference if reference is not None else load_reference()
    if procedure:
        ref = reference.get(procedure.lower())
        total = sum((Decimal(str(l.amount)) for l in lines), Decimal(0))
        if ref is None:
            findings.append(Finding(
                "no_reference", procedure,
                f"No reference range is loaded for '{procedure}', so price was not compared.", "info"))
        else:
            low, high = Decimal(str(ref["low"])), Decimal(str(ref["high"]))
            if total > high:
                findings.append(Finding(
                    "above_reference_range", procedure,
                    f"Total Rs {total} is above the reference range Rs {low} to Rs {high} "
                    f"({ref.get('source', 'source not stated')}). Ranges differ by city, hospital type "
                    "and room category; use this as a question for the hospital, not proof of overcharging."))
    return findings
