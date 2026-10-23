# claim-copilot

Independent health-claim helper for India: policy checks, payout estimates, bill audit and grievance drafts.

- `app/rules.py`: deterministic payout engine (no LLM). Order of operations is documented at the top of the file.
- Tests: `python3 -m unittest discover -v`
- Secrets are read from environment variables only; never commit keys.
