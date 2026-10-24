"""Browser smoke test (needs: pip install playwright). Run the API on :8000 and serve ./frontend
with config.js pointing at it, then: python3 tests/e2e_smoke.py http://127.0.0.1:8002/"""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8002/"
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(url)
    pg.wait_for_selector("#api-status[data-state=ready]", timeout=90000)
    pg.click("#sample")
    pg.locator(".r-sum.pay .amt").filter(has_text="63,315").wait_for(timeout=15000)
    assert not errors, errors
    print("ok")
    b.close()
