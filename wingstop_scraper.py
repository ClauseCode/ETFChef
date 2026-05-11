"""
Wingstop country-domain location counter.

Usage:
    pip install playwright
    playwright install chromium
    python wingstop_scraper.py

Each entry in SITES defines:
    country   – display label
    url       – page to load
    selector  – CSS selector whose match count = # of store locations
                OR None to fall back to text-pattern extraction
    pattern   – optional regex to pull a number from page text
                (used when selector is None or returns 0)
"""

import re
import sys
from dataclasses import dataclass

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    sys.exit("Playwright not installed. Run:  pip install playwright && playwright install chromium")


@dataclass
class Site:
    country: str
    url: str
    # CSS selector that, when counted, gives location count.
    # Set to None to skip and rely on pattern only.
    selector: str | None = None
    # Regex applied to full page text as a fallback/override.
    # Group 1 should capture the number.
    pattern: str | None = None
    # Extra ms to wait after page load (for lazy-loaded lists)
    extra_wait_ms: int = 1500


SITES = [
    Site(
        country="France",
        url="https://www.wingstopfrance.com/locations",
        selector="[class*='location-item'], [class*='store-item'], .location, .store",
        pattern=r"(\d+)\s+(?:restaurants?|locations?)",
    ),
    Site(
        country="UAE",
        url="https://wingstop.ae/store-locations/",
        selector="[class*='location'], [class*='store'], .wpsl-store-location",
        pattern=r"(\d+)\s+(?:stores?|locations?|branches?)",
    ),
    Site(
        country="Indonesia",
        url="https://wingstop.id/location",
        selector="[class*='location'], [class*='store'], li.branch",
        pattern=r"(\d+)\s+(?:lokasi|stores?|locations?)",
    ),
    Site(
        country="Mexico",
        url="https://wingstopmexico.com/sucursales/",
        selector="[class*='sucursal'], [class*='location'], [class*='store'], .wpsl-store-location",
        pattern=r"(\d+)\s+(?:sucursales?|ubicaciones?|locations?)",
    ),
    # Add more entries here following the same pattern, e.g.:
    # Site(
    #     country="Saudi Arabia",
    #     url="https://wingstop.com.sa/locations/",
    #     selector="[class*='location'], [class*='store']",
    # ),
]

TIMEOUT_MS = 20_000
COL_W = {"country": 14, "url": 46, "count": 8, "method": 18}


def extract_count(page, site: Site) -> tuple[int, str]:
    """Return (count, method_used)."""

    # 1. Try CSS selector
    if site.selector:
        selectors = [s.strip() for s in site.selector.split(",")]
        for sel in selectors:
            try:
                elements = page.query_selector_all(sel)
                if elements:
                    return len(elements), f"selector({sel[:30]})"
            except Exception:
                pass

    # 2. Try regex on visible text
    if site.pattern:
        text = page.inner_text("body")
        m = re.search(site.pattern, text, re.IGNORECASE)
        if m:
            return int(m.group(1)), f"pattern({site.pattern[:30]})"

    # 3. Generic number-near-keyword fallback
    text = page.inner_text("body")
    generic = re.search(
        r"(\d+)\s{0,3}(?:stores?|locations?|branches?|restaurants?|outlets?)",
        text, re.IGNORECASE,
    )
    if generic:
        return int(generic.group(1)), "generic-text"

    return 0, "not-found"


def run():
    results = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        )

        for site in SITES:
            print(f"  Fetching {site.country} ({site.url}) …", end=" ", flush=True)
            page = ctx.new_page()
            try:
                page.goto(site.url, wait_until="networkidle", timeout=TIMEOUT_MS)
                if site.extra_wait_ms:
                    page.wait_for_timeout(site.extra_wait_ms)
                count, method = extract_count(page, site)
                results.append((site.country, site.url, count, method))
                print(f"{count}  [{method}]")
            except PWTimeout:
                results.append((site.country, site.url, -1, "timeout"))
                print("TIMEOUT")
            except Exception as e:
                results.append((site.country, site.url, -1, f"error: {e}"))
                print(f"ERROR: {e}")
            finally:
                page.close()

        browser.close()

    # Print summary table
    cw = COL_W
    header = (
        f"{'Country':<{cw['country']}} "
        f"{'URL':<{cw['url']}} "
        f"{'Locations':>{cw['count']}} "
        f"{'Method':<{cw['method']}}"
    )
    sep = "-" * len(header)
    print(f"\n{sep}")
    print(header)
    print(sep)
    for country, url, count, method in results:
        count_str = str(count) if count >= 0 else "ERR"
        print(
            f"{country:<{cw['country']}} "
            f"{url:<{cw['url']}} "
            f"{count_str:>{cw['count']}} "
            f"{method:<{cw['method']}}"
        )
    print(sep)
    print(f"{'TOTAL':<{cw['country']}} {'':>{cw['url']}} "
          f"{sum(c for _, _, c, _ in results if c > 0):>{cw['count']}}")


if __name__ == "__main__":
    print("Wingstop location scraper\n")
    run()
