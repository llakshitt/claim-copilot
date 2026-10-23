import unittest
from decimal import Decimal as D

from app.rules import BillLine, Claim, Policy, compute_payout


def line(desc, cat, amt, days=None):
    return BillLine(desc, cat, D(amt), days)


class RulesTest(unittest.TestCase):
    def test_proportionate_deduction_hand_computed(self):
        # cap 5000/day, actual 24000/3 = 8000/day -> ratio 0.625
        # room 15000 + doctor 12500 + surgery 31250 + pharmacy 10000 = 68750
        # 10% copay -> 61875 ; billed 106000 ; patient 44125
        policy = Policy(sum_insured=D(500000), room_rent_cap_per_day=D(5000), copay_pct=D(10))
        claim = Claim(lines=[
            line("Room", "room", 24000, days=3),
            line("Doctor", "doctor_fees", 20000),
            line("Surgery", "surgery", 50000),
            line("Pharmacy", "pharmacy", 10000),
            line("Gloves", "non_payable", 2000),
        ])
        r = compute_payout(policy, claim)
        self.assertEqual(r.total_billed, D("106000.00"))
        self.assertEqual(r.payable, D("61875.00"))
        self.assertEqual(r.patient_pays, D("44125.00"))
        self.assertEqual([s.rule for s in r.steps],
                         ["non_payable", "room_rent_proportionate", "copay"])

    def test_no_deduction_when_room_within_cap(self):
        policy = Policy(sum_insured=D(500000), room_rent_cap_per_day=D(5000))
        claim = Claim(lines=[line("Room", "room", 12000, days=3), line("Doctor", "doctor_fees", 8000)])
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("20000.00"))
        self.assertEqual(r.patient_pays, D("0.00"))
        self.assertEqual(r.steps, [])

    def test_cap_as_percent_of_sum_insured_uses_lower_cap(self):
        # 1% of 300000 = 3000 ; absolute cap 5000 ; lower (3000) applies
        policy = Policy(sum_insured=D(300000), room_rent_cap_per_day=D(5000),
                        room_rent_cap_pct_of_si=D(1))
        self.assertEqual(policy.effective_room_cap(), D(3000))
        claim = Claim(lines=[line("Room", "room", 12000, days=2),   # 6000/day, ratio 0.5
                             line("Doctor", "doctor_fees", 10000)])
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("11000.00"))  # 6000 room cap + 5000 doctor

    def test_sub_limit(self):
        policy = Policy(sum_insured=D(500000), sub_limits={"surgery": D(30000)})
        claim = Claim(lines=[line("Cataract", "surgery", 45000)])
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("30000.00"))
        self.assertEqual(r.patient_pays, D("15000.00"))

    def test_sum_insured_cap(self):
        policy = Policy(sum_insured=D(100000))
        claim = Claim(lines=[line("Surgery", "surgery", 150000)])
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("100000.00"))
        self.assertEqual(r.steps[-1].rule, "sum_insured")

    def test_waiting_period_blocks_claim(self):
        policy = Policy(sum_insured=D(500000), waiting_period_days={"hernia": 730})
        claim = Claim(lines=[line("Surgery", "surgery", 80000)], condition="Hernia",
                      days_since_policy_start=200)
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("0.00"))
        self.assertEqual(r.patient_pays, D("80000.00"))
        self.assertEqual(r.steps[0].rule, "waiting_period")

    def test_waiting_period_served(self):
        policy = Policy(sum_insured=D(500000), waiting_period_days={"hernia": 730})
        claim = Claim(lines=[line("Surgery", "surgery", 80000)], condition="hernia",
                      days_since_policy_start=900)
        self.assertEqual(compute_payout(policy, claim).payable, D("80000.00"))

    def test_unknown_policy_age_warns_not_blocks(self):
        policy = Policy(sum_insured=D(500000), waiting_period_days={"hernia": 730})
        claim = Claim(lines=[line("Surgery", "surgery", 80000)], condition="hernia")
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("80000.00"))
        self.assertTrue(r.warnings)

    def test_exclusion(self):
        policy = Policy(sum_insured=D(500000), exclusions=frozenset({"cosmetic surgery"}))
        claim = Claim(lines=[line("Procedure", "surgery", 60000)], condition="Cosmetic surgery")
        self.assertEqual(compute_payout(policy, claim).payable, D("0.00"))

    def test_deductible_and_copay_order(self):
        # copay first (10% of 50000 -> 45000), then deductible 5000 -> 40000
        policy = Policy(sum_insured=D(500000), copay_pct=D(10), deductible=D(5000))
        claim = Claim(lines=[line("Surgery", "surgery", 50000)])
        self.assertEqual(compute_payout(policy, claim).payable, D("40000.00"))

    def test_room_without_days_warns(self):
        policy = Policy(sum_insured=D(500000), room_rent_cap_per_day=D(5000))
        claim = Claim(lines=[line("Room", "room", 24000)])
        r = compute_payout(policy, claim)
        self.assertEqual(r.payable, D("24000.00"))
        self.assertTrue(r.warnings)

    def test_steps_cite_clauses(self):
        from app.rules import Clause
        policy = Policy(sum_insured=D(500000), copay_pct=D(20),
                        clauses={"copay": Clause("Section 6.1", "Insured bears 20% of each claim", 12)})
        r = compute_payout(policy, Claim(lines=[line("Surgery", "surgery", 10000)]))
        self.assertEqual(r.steps[0].clause.ref, "Section 6.1")


if __name__ == "__main__":
    unittest.main()
