"""Record the console's API responses into src/console/fixtures for DEMO MODE (static hosting).

Needs the API, a console build pointed at it (vite preview on 4173) and, for live chain reads, anvil.
Usage: python scripts/capture-fixtures.py [console_url] [api_url]
"""
import json
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

CONSOLE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/console.html"
API = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8010").rstrip("/")
OUT = Path(__file__).resolve().parents[1] / "src" / "console" / "fixtures"


def key(method: str, path: str) -> str:
    """Same as fixtureKey() in src/console/api/client.ts."""
    return re.sub(r"_+$", "", re.sub(r"[^A-Za-z0-9]+", "_", f"{method}_{path}"))


registry = json.load(urllib.request.urlopen(f"{API}/api/v1/certificates"))["data"]
lots = list(dict.fromkeys(e["lot_id"] for e in registry if e.get("lot_id")))
ROUTES = ["#/overview", "#/map", "#/ranches", "#/ranches/R0120", "#/ranches/R0291", "#/movements", "#/shipments",
          "#/shipments/SHP-D-001677", "#/shipments/SHP-D-000006", "#/shipments/SHP-D-000080", "#/investigations",
          "#/certificates", "#/ledger", "#/evaluation", "#/sources"] + [f"#/certificates/{lot}" for lot in lots]

saved: dict[str, int] = {}
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})

    def on_response(resp):
        u = urlsplit(resp.url)
        if not resp.url.startswith(API) or not u.path.startswith("/api/v1/") or resp.status != 200:
            return
        if "json" not in (resp.headers.get("content-type") or ""):
            return
        path = u.path + (f"?{u.query}" if u.query else "")
        k = key(resp.request.method, path)
        body = resp.body()
        (OUT / f"{k}.json").write_bytes(body)
        saved[k] = len(body)

    page.on("response", on_response)
    for r in ROUTES:
        page.goto("about:blank")  # a fresh document per route, so networkidle waits for its requests
        page.goto(CONSOLE + r)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1000)
        if r.startswith("#/certificates/"):
            btn = page.get_by_role("button", name="Verify this certificate")
            if btn.count():
                btn.click()
                page.get_by_role("button", name="Verify", exact=True).click()
                page.wait_for_load_state("networkidle")
                page.wait_for_timeout(1000)
    browser.close()

print(f"{len(saved)} responses, {sum(saved.values()) // 1024} KB")
