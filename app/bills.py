"""Turn the text of a hospital bill into bill rows.

The model proposes rows. A row is kept ONLY if its amount really appears as a number
in the document text, so an invented charge never reaches the estimate. Everything is
shown to the person for checking before it is used.
"""
from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation

CATEGORIES = ["room", "doctor_fees", "surgery", "ot_charges", "nursing", "diagnostics", "procedure",
              "pharmacy", "consumables", "non_payable", "other"]
MAX_LINES = 200

PROMPT = """You are reading an itemized hospital bill. Return ONLY JSON:
{{"lines": [{{"description": str, "category": str, "amount": number, "days": int|null}}]}}
Rules:
- One entry per charge line, with the amount charged for that line exactly as printed.
- Do NOT include subtotals, grand totals, taxes summaries, advances, discounts or payments received.
- category must be one of: {cats}. Use "other" if unsure. Use "room" only for room/bed/ward rent
  and give "days" (number of days) when the bill shows it, otherwise null.
- Copy descriptions as written on the bill. Never invent a line or an amount.

BILL TEXT:
{text}
"""


def numbers_in(text: str) -> set:
    found = set()
    for m in re.finditer(r"\d[\d,]*(?:\.\d+)?", text or ""):
        raw = m.group(0).replace(",", "")
        try:
            found.add(Decimal(raw).normalize())
        except InvalidOperation:
            pass
    return found


def _parse_json(raw: str) -> dict:
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
    return json.loads(raw)


def parse_bill(text: str, llm) -> dict:
    text = (text or "")[:60000]
    data = _parse_json(llm.generate(PROMPT.format(cats=", ".join(CATEGORIES), text=text)))
    present = numbers_in(text)
    lines, rejected = [], 0
    for item in (data.get("lines") or [])[:MAX_LINES]:
        try:
            amount = Decimal(str(item.get("amount"))).normalize()
        except (InvalidOperation, ValueError, TypeError):
            rejected += 1
            continue
        if amount <= 0 or amount not in present:
            rejected += 1
            continue
        cat = item.get("category") if item.get("category") in CATEGORIES else "other"
        row = {"description": str(item.get("description") or "Item")[:120].strip() or "Item",
               "category": cat, "amount": format(amount, "f")}
        days = item.get("days")
        if cat == "room" and isinstance(days, (int, float)) and 0 < days <= 365 and int(days) == days:
            row["days"] = int(days)
        lines.append(row)
    return {"lines": lines, "rejected": rejected}
