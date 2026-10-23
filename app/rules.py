"""Deterministic claim-payout rules engine.

No LLM is involved here. Every number comes from the policy terms and bill lines
passed in, and every step is recorded in a trace so a flag can be explained and
cited to the policy clause it came from.

ASSUMPTIONS (verify against the actual policy wording; they differ by insurer):
  Order of operations:
    1. waiting period / exclusion check  -> payable 0 if the condition is excluded
    2. remove non-payable lines
    3. room-rent proportionate deduction (applies only to categories listed in
       policy.proportionate_categories)
    4. category sub-limits
    5. co-pay percentage
    6. deductible
    7. cap at sum insured
  Money is Decimal throughout. Amounts are in rupees.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

PAISE = Decimal("0.01")

# Categories a typical proportionate deduction scales. Policy-specific: override in Policy.
DEFAULT_PROPORTIONATE = frozenset(
    {"doctor_fees", "surgery", "ot_charges", "nursing", "diagnostics", "procedure"}
)


def D(value) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def money(value: Decimal) -> Decimal:
    return value.quantize(PAISE, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class Clause:
    """Where in the policy a rule came from, so every flag can cite it."""
    ref: str = ""        # e.g. "Section 4.2"
    text: str = ""       # quoted wording
    page: Optional[int] = None


@dataclass
class Policy:
    sum_insured: Decimal
    room_rent_cap_per_day: Optional[Decimal] = None      # absolute rupees per day
    room_rent_cap_pct_of_si: Optional[Decimal] = None    # e.g. Decimal("1") for 1% of SI
    copay_pct: Decimal = Decimal("0")
    deductible: Decimal = Decimal("0")
    sub_limits: dict = field(default_factory=dict)       # category -> max rupees
    non_payable_categories: frozenset = frozenset({"non_payable"})
    proportionate_categories: frozenset = DEFAULT_PROPORTIONATE
    waiting_period_days: dict = field(default_factory=dict)  # condition -> days
    exclusions: frozenset = frozenset()                  # conditions never covered
    clauses: dict = field(default_factory=dict)          # rule name -> Clause

    def effective_room_cap(self) -> Optional[Decimal]:
        caps = []
        if self.room_rent_cap_per_day is not None:
            caps.append(D(self.room_rent_cap_per_day))
        if self.room_rent_cap_pct_of_si is not None:
            caps.append(D(self.sum_insured) * D(self.room_rent_cap_pct_of_si) / Decimal(100))
        return min(caps) if caps else None


@dataclass
class BillLine:
    description: str
    category: str
    amount: Decimal
    days: Optional[int] = None   # for room lines: number of days charged


@dataclass
class Claim:
    lines: list
    condition: Optional[str] = None
    days_since_policy_start: Optional[int] = None


@dataclass
class Step:
    rule: str
    effect: Decimal          # change to the payable total (negative = reduction)
    explanation: str
    clause: Optional[Clause] = None


@dataclass
class Result:
    total_billed: Decimal
    payable: Decimal
    patient_pays: Decimal
    steps: list
    warnings: list


def _clause(policy: Policy, name: str) -> Optional[Clause]:
    return policy.clauses.get(name)


def compute_payout(policy: Policy, claim: Claim) -> Result:
    lines = [BillLine(l.description, l.category, D(l.amount), l.days) for l in claim.lines]
    total_billed = money(sum((l.amount for l in lines), Decimal(0)))
    steps: list = []
    warnings: list = []

    # 1. exclusions and waiting periods
    if claim.condition:
        cond = claim.condition.lower()
        if cond in {c.lower() for c in policy.exclusions}:
            steps.append(Step(
                "exclusion", -total_billed,
                f"'{claim.condition}' is excluded, so nothing is payable.",
                _clause(policy, "exclusion")))
            return Result(total_billed, Decimal("0.00"), total_billed, steps, warnings)
        waits = {k.lower(): v for k, v in policy.waiting_period_days.items()}
        if cond in waits:
            if claim.days_since_policy_start is None:
                warnings.append(
                    f"Waiting period of {waits[cond]} days applies to '{claim.condition}' "
                    "but policy age is unknown; result assumes it has been served.")
            elif claim.days_since_policy_start < waits[cond]:
                steps.append(Step(
                    "waiting_period", -total_billed,
                    f"'{claim.condition}' has a {waits[cond]}-day waiting period; the policy "
                    f"is only {claim.days_since_policy_start} days old, so nothing is payable.",
                    _clause(policy, "waiting_period")))
                return Result(total_billed, Decimal("0.00"), total_billed, steps, warnings)

    # 2. non-payable lines
    payable_lines = []
    removed = Decimal(0)
    for l in lines:
        if l.category in policy.non_payable_categories:
            removed += l.amount
        else:
            payable_lines.append(l)
    if removed:
        steps.append(Step(
            "non_payable", -money(removed),
            f"Items the insurer does not pay (Rs {money(removed)}) are removed.",
            _clause(policy, "non_payable")))
    running = sum((l.amount for l in payable_lines), Decimal(0))

    # 3. room-rent proportionate deduction
    cap = policy.effective_room_cap()
    room_lines = [l for l in payable_lines if l.category == "room"]
    if cap is not None and room_lines:
        total_days = sum((l.days or 0) for l in room_lines)
        if total_days == 0:
            warnings.append("Room lines have no day count; room-rent cap not applied.")
        else:
            room_total = sum((l.amount for l in room_lines), Decimal(0))
            actual_per_day = room_total / total_days
            if actual_per_day > cap:
                ratio = cap / actual_per_day
                before = running
                new_lines = []
                for l in payable_lines:
                    if l.category == "room":
                        l = BillLine(l.description, l.category, cap * (l.days or 0), l.days)
                    elif l.category in policy.proportionate_categories:
                        l = BillLine(l.description, l.category, l.amount * ratio, l.days)
                    new_lines.append(l)
                payable_lines = new_lines
                running = sum((l.amount for l in payable_lines), Decimal(0))
                steps.append(Step(
                    "room_rent_proportionate", money(running - before),
                    f"Your room costs Rs {actual_per_day:,.0f} a day but the policy caps it at Rs {cap:,.0f}. "
                    f"The room is limited to the cap and related charges "
                    f"({', '.join(sorted(c.replace('_', ' ') for c in policy.proportionate_categories))}) "
                    f"are reduced to {ratio * 100:.1f}%.",
                    _clause(policy, "room_rent")))

    # 4. category sub-limits
    by_cat: dict = {}
    for l in payable_lines:
        by_cat[l.category] = by_cat.get(l.category, Decimal(0)) + l.amount
    for cat, limit in policy.sub_limits.items():
        limit = D(limit)
        if by_cat.get(cat, Decimal(0)) > limit:
            cut = by_cat[cat] - limit
            running -= cut
            by_cat[cat] = limit
            steps.append(Step(
                f"sub_limit:{cat}", -money(cut),
                f"'{cat}' charges are limited to Rs {money(limit)}.",
                _clause(policy, f"sub_limit:{cat}")))

    # 5. co-pay
    copay = D(policy.copay_pct)
    if copay > 0 and running > 0:
        cut = running * copay / Decimal(100)
        running -= cut
        steps.append(Step(
            "copay", -money(cut),
            f"{copay}% co-payment is borne by the patient.",
            _clause(policy, "copay")))

    # 6. deductible
    ded = D(policy.deductible)
    if ded > 0 and running > 0:
        cut = min(ded, running)
        running -= cut
        steps.append(Step(
            "deductible", -money(cut),
            f"Deductible of Rs {money(ded)} applies.",
            _clause(policy, "deductible")))

    # 7. sum insured cap
    si = D(policy.sum_insured)
    if running > si:
        cut = running - si
        running = si
        steps.append(Step(
            "sum_insured", -money(cut),
            f"Payable is capped at the sum insured of Rs {money(si)}.",
            _clause(policy, "sum_insured")))

    payable = money(max(running, Decimal(0)))
    return Result(total_billed, payable, money(total_billed - payable), steps, warnings)
