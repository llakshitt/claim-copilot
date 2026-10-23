import json
import threading
import unittest
import urllib.error
import urllib.request
from decimal import Decimal as D

from app import audit, grievance, server
from app.extract import extract_policy
from app.llm import FakeLLM
from app.rules import BillLine

POLICY_TEXT = """Section 4.2: Room rent is limited to Rs 5,000 per day.
Section 6.1: The insured bears 10% of every admissible claim.
Section 3: Sum insured under this policy is Rs 5,00,000.
Section 8: Hernia is subject to a waiting period of 730 days."""


def good_response():
    return json.dumps({
        "sum_insured": {"value": 500000, "quote": "Sum insured under this policy is Rs 5,00,000", "page": 2},
        "room_rent_cap_per_day": {"value": 5000, "quote": "Room rent is limited to Rs 5,000 per day", "page": 7},
        "copay_pct": {"value": 10, "quote": "The insured bears 10% of every admissible claim", "page": 9},
        "waiting_period_days": [{"condition": "hernia", "value": 730,
                                 "quote": "Hernia is subject to a waiting period of 730 days"}],
    })


class ExtractTest(unittest.TestCase):
    def test_accepts_supported_fields_with_citations(self):
        ex = extract_policy(POLICY_TEXT, FakeLLM(good_response()))
        self.assertEqual(ex.policy.sum_insured, D(500000))
        self.assertEqual(ex.policy.room_rent_cap_per_day, D(5000))
        self.assertEqual(ex.policy.copay_pct, D(10))
        self.assertEqual(ex.policy.waiting_period_days, {"hernia": 730})
        self.assertEqual(ex.policy.clauses["copay"].page, 9)
        self.assertEqual(ex.rejected, [])

    def test_rejects_hallucinated_quote(self):
        bad = json.loads(good_response())
        bad["copay_pct"]["quote"] = "The insured bears 25% of every admissible claim"
        ex = extract_policy(POLICY_TEXT, FakeLLM(json.dumps(bad)))
        self.assertEqual(ex.policy.copay_pct, D(0))          # default, not the invented 25
        self.assertIn(("copay_pct", "quote not found in policy text"), ex.rejected)

    def test_rejects_missing_quote(self):
        bad = json.loads(good_response())
        del bad["room_rent_cap_per_day"]["quote"]
        ex = extract_policy(POLICY_TEXT, FakeLLM(json.dumps(bad)))
        self.assertIsNone(ex.policy.room_rent_cap_per_day)

    def test_no_sum_insured_returns_no_policy(self):
        ex = extract_policy(POLICY_TEXT, FakeLLM("{}"))
        self.assertIsNone(ex.policy)
        self.assertEqual(ex.missing, ["sum_insured"])

    def test_invalid_json(self):
        ex = extract_policy(POLICY_TEXT, FakeLLM("not json"))
        self.assertIsNone(ex.policy)

    def test_fenced_json_is_parsed(self):
        ex = extract_policy(POLICY_TEXT, FakeLLM("```json\n" + good_response() + "\n```"))
        self.assertEqual(ex.policy.sum_insured, D(500000))


class AuditTest(unittest.TestCase):
    def test_duplicates_and_non_payable(self):
        lines = [BillLine("Gloves", "other", D(800)), BillLine("Gloves", "other", D(800)),
                 BillLine("Room", "room", D(5000), 1)]
        kinds = [f.kind for f in audit.audit_bill(lines, reference={})]
        self.assertIn("possible_duplicate", kinds)
        self.assertIn("likely_non_payable", kinds)

    def test_above_reference_range_is_worded_as_a_question(self):
        ref = {"knee replacement": {"procedure": "knee replacement", "low": 100000, "high": 200000, "source": "test"}}
        lines = [BillLine("Package", "surgery", D(350000))]
        f = [x for x in audit.audit_bill(lines, "Knee replacement", ref) if x.kind == "above_reference_range"][0]
        self.assertIn("not proof of overcharging", f.detail)

    def test_missing_reference_does_not_guess(self):
        lines = [BillLine("Package", "surgery", D(350000))]
        kinds = [f.kind for f in audit.audit_bill(lines, "Unknown", {})]
        self.assertEqual(kinds, ["no_reference"])


class GrievanceTest(unittest.TestCase):
    def test_draft_contains_clause_and_does_not_invent_deadline(self):
        t = grievance.draft("insurer_grievance_officer", reason="room rent cap", clause_ref="Section 4.2",
                            clause_text="Room rent is limited to Rs 5,000 per day")
        self.assertIn("Section 4.2", t)
        self.assertIn("to be verified", t)
        self.assertIn("IRDAI", t)          # next step named

    def test_last_level_has_no_next_step(self):
        self.assertNotIn("next step", grievance.draft("ombudsman"))

    def test_unknown_level(self):
        with self.assertRaises(ValueError):
            grievance.draft("court")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.make_server(0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def post(self, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_health_and_index(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health") as r:
            self.assertEqual(json.load(r), {"ok": True})
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/") as r:
            self.assertIn(b"Claim Copilot", r.read())

    def test_estimate_matches_hand_computation(self):
        body = {"policy": {"sum_insured": 500000, "room_rent_cap_per_day": 5000, "copay_pct": 10},
                "claim": {"lines": [
                    {"description": "Room", "category": "room", "amount": 24000, "days": 3},
                    {"description": "Doctor", "category": "doctor_fees", "amount": 20000},
                    {"description": "Surgery", "category": "surgery", "amount": 50000},
                    {"description": "Pharmacy", "category": "pharmacy", "amount": 10000},
                    {"description": "Gloves", "category": "non_payable", "amount": 2000}]}}
        code, data = self.post("/api/estimate", body)
        self.assertEqual(code, 200)
        self.assertEqual(data["payable"], "61875.00")
        self.assertEqual(data["patient_pays"], "44125.00")

    def test_bad_request_is_400_not_500(self):
        code, data = self.post("/api/estimate", {"policy": {}})
        self.assertEqual(code, 400)

    def test_extract_without_key_is_503(self):
        import os
        os.environ.pop("GEMINI_API_KEY", None)
        code, data = self.post("/api/extract", {"text": "x"})
        self.assertEqual(code, 503)

    def test_grievance_endpoint(self):
        code, data = self.post("/api/grievance", {"level": "irdai", "reason": "r"})
        self.assertEqual(code, 200)
        self.assertIn("Subject", data["letter"])


if __name__ == "__main__":
    unittest.main()
