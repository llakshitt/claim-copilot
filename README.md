# claim-copilot

Independent health-claim helper for India: policy extraction, payout estimate, bill audit, grievance drafts.

- `app/rules.py`: deterministic payout engine (no LLM). Order of operations is documented at the top.
- `app/extract.py`: LLM policy extraction; a value is kept only if its quote really appears in the policy text.
- `app/audit.py`: duplicate and likely-non-payable flags; price check against `data/reference_rates.json` (empty until CGHS / PM-JAY rates are loaded).
- `app/grievance.py`: letter drafts and escalation ladder. Statutory deadlines are intentionally unset until verified.
- `app/server.py` + `app/static/index.html`: standard-library web server and page. No dependencies.

Run: `python3 -m app.server` (PORT env var, default 8000). Test: `python3 -m unittest discover`.

Secrets come from environment variables only (`GEMINI_API_KEY`); never commit keys.
