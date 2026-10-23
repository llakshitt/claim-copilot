"""Grievance letter drafts and the escalation ladder.

Statutory time limits are deliberately NOT hardcoded: they must be verified against
the current IRDAI regulations and Insurance Ombudsman rules before use. Fill them in
LIMITS (with verified=True) once checked; drafts then cite them, otherwise they say
the period must be confirmed.
"""
from __future__ import annotations

from typing import Optional

LADDER = [
    ("insurer_grievance_officer", "Insurer's grievance officer"),
    ("irdai", "IRDAI's grievance system"),
    ("ombudsman", "Insurance Ombudsman"),
]

# level -> {"days": int, "verified": bool, "note": str}. Intentionally empty until verified.
LIMITS: dict = {}


def limit_text(level: str) -> str:
    lim = LIMITS.get(level)
    if lim and lim.get("verified"):
        return f"{lim['days']} days ({lim.get('note', '')})".strip()
    return "the period set by current IRDAI rules (to be verified before sending)"


def next_level(level: str) -> Optional[str]:
    keys = [k for k, _ in LADDER]
    i = keys.index(level)
    return keys[i + 1] if i + 1 < len(keys) else None


def draft(level: str, *, insurer: str = "[Insurer name]", policy_no: str = "[Policy number]",
          claim_no: str = "[Claim number]", name: str = "[Your name]", reason: str = "",
          clause_ref: str = "", clause_text: str = "", disputed_amount: str = "",
          facts: str = "") -> str:
    if level not in dict(LADDER):
        raise ValueError(f"unknown level: {level}")
    to = dict(LADDER)[level]
    lines = [
        f"To: {to}, {insurer}" if level == "insurer_grievance_officer" else f"To: {to}",
        f"Subject: Complaint regarding claim {claim_no} under policy {policy_no}",
        "",
        "Dear Sir or Madam,",
        "",
        f"I am {name}, the insured/claimant under policy {policy_no}. My claim {claim_no} "
        + (f"was rejected or reduced with the stated reason: \"{reason}\"." if reason
           else "was rejected or reduced."),
    ]
    if facts:
        lines += ["", facts]
    if clause_ref or clause_text:
        lines += ["", "The policy wording relevant to this decision is "
                  + (f"{clause_ref}" if clause_ref else "the clause below")
                  + (f": \"{clause_text}\"" if clause_text else ".")
                  + " I request you to review whether it supports the decision taken."]
    if disputed_amount:
        lines += ["", f"The amount in dispute is Rs {disputed_amount}."]
    lines += [
        "",
        "I request a written, reasoned response within " + limit_text(level)
        + ", and reconsideration of the claim.",
        "",
        "Enclosed: policy copy, claim documents, rejection or deduction letter, itemized bill.",
        "",
        "Yours faithfully,", name,
    ]
    nxt = next_level(level)
    if nxt:
        lines += ["", f"[If unresolved, the next step is: {dict(LADDER)[nxt]}.]"]
    return "\n".join(lines)
