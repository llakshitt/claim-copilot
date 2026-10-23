"""JSON <-> dataclass conversion shared by the extractor, the server and tests."""
from __future__ import annotations

from decimal import Decimal

from .rules import BillLine, Claim, Clause, Policy, Result


def _d(v):
    return None if v is None else Decimal(str(v))


def policy_from_dict(d: dict) -> Policy:
    clauses = {}
    for name, c in (d.get("clauses") or {}).items():
        clauses[name] = Clause(c.get("ref", ""), c.get("text", ""), c.get("page"))
    kwargs = dict(
        sum_insured=_d(d["sum_insured"]),
        room_rent_cap_per_day=_d(d.get("room_rent_cap_per_day")),
        room_rent_cap_pct_of_si=_d(d.get("room_rent_cap_pct_of_si")),
        copay_pct=_d(d.get("copay_pct", 0)),
        deductible=_d(d.get("deductible", 0)),
        sub_limits={k: _d(v) for k, v in (d.get("sub_limits") or {}).items()},
        waiting_period_days=dict(d.get("waiting_period_days") or {}),
        exclusions=frozenset(d.get("exclusions") or []),
        clauses=clauses,
    )
    if d.get("proportionate_categories"):
        kwargs["proportionate_categories"] = frozenset(d["proportionate_categories"])
    return Policy(**kwargs)


def claim_from_dict(d: dict) -> Claim:
    lines = [BillLine(l["description"], l.get("category", "other"), _d(l["amount"]), l.get("days"))
             for l in d["lines"]]
    return Claim(lines=lines, condition=d.get("condition"),
                 days_since_policy_start=d.get("days_since_policy_start"))


def result_to_dict(r: Result) -> dict:
    return {
        "total_billed": str(r.total_billed),
        "payable": str(r.payable),
        "patient_pays": str(r.patient_pays),
        "warnings": r.warnings,
        "steps": [{
            "rule": s.rule,
            "effect": str(s.effect),
            "explanation": s.explanation,
            "clause": ({"ref": s.clause.ref, "text": s.clause.text, "page": s.clause.page}
                       if s.clause else None),
        } for s in r.steps],
    }
