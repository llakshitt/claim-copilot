"""Dependency-free HTTP server (standard library only). Run: python3 -m app.server"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import audit, grievance
from .extract import extract_policy
from .llm import LLMError, default_client
from .rules import compute_payout
from .schema import claim_from_dict, policy_from_dict, result_to_dict

MAX_BODY = 1_000_000
STATIC = os.path.join(os.path.dirname(__file__), "static", "index.html")


def handle_estimate(body: dict) -> dict:
    policy = policy_from_dict(body["policy"])
    claim = claim_from_dict(body["claim"])
    return result_to_dict(compute_payout(policy, claim))


def handle_audit(body: dict) -> dict:
    claim = claim_from_dict(body["claim"])
    findings = audit.audit_bill(claim.lines, body.get("procedure"))
    return {"findings": [f.__dict__ for f in findings]}


def handle_grievance(body: dict) -> dict:
    args = {k: v for k, v in body.items() if k != "level"}
    return {"letter": grievance.draft(body["level"], **args)}


def handle_extract(body: dict, llm=None) -> dict:
    llm = llm or default_client()
    ex = extract_policy(body["text"], llm)
    return {
        "policy": None if ex.policy is None else {
            "sum_insured": str(ex.policy.sum_insured),
            "room_rent_cap_per_day": None if ex.policy.room_rent_cap_per_day is None
            else str(ex.policy.room_rent_cap_per_day),
            "room_rent_cap_pct_of_si": None if ex.policy.room_rent_cap_pct_of_si is None
            else str(ex.policy.room_rent_cap_pct_of_si),
            "copay_pct": str(ex.policy.copay_pct),
            "deductible": str(ex.policy.deductible),
            "sub_limits": {k: str(v) for k, v in ex.policy.sub_limits.items()},
            "waiting_period_days": ex.policy.waiting_period_days,
            "exclusions": sorted(ex.policy.exclusions),
            "clauses": {k: {"ref": c.ref, "text": c.text, "page": c.page}
                        for k, c in ex.policy.clauses.items()},
        },
        "rejected": ex.rejected,
        "missing": ex.missing,
    }


ROUTES = {
    "/api/estimate": handle_estimate,
    "/api/audit": handle_audit,
    "/api/grievance": handle_grievance,
    "/api/extract": handle_extract,
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload, ctype="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", os.environ.get("ALLOWED_ORIGIN", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if self.path in ("/", "/index.html"):
            with open(STATIC, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        self._send(404, {"error": "not found"})

    def do_POST(self):
        fn = ROUTES.get(self.path)
        if fn is None:
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._send(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            return self._send(200, fn(body))
        except LLMError as e:
            return self._send(503, {"error": str(e)})
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
            return self._send(400, {"error": f"bad request: {e}"})

    def log_message(self, fmt, *args):  # do not log request bodies or documents
        pass


def make_server(port: int = 0) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("0.0.0.0", port), Handler)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"listening on {port}")
    make_server(port).serve_forever()
