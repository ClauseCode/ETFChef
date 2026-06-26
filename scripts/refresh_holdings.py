#!/usr/bin/env python3
"""
Refresh ETF holdings cache from provider websites.

Run manually:   ALPHA_VANTAGE_KEY=<key> python scripts/refresh_holdings.py
GitHub Actions: triggered weekly; ALPHA_VANTAGE_KEY set as repo secret

Providers
---------
ishares       iShares (BlackRock) — Playwright loads product page, then fetches CSV
              via in-browser fetch() to bypass Cloudflare bot detection
ssga          SSGA/SPDR — direct XLSX download from ssga.com (no bot detection)
vanguard      Vanguard — Playwright loads portal page, then fetches CSV via
              in-browser fetch() (download endpoint requires browser session)
invesco       Invesco — Playwright loads ETF page, then fetches CSV via
              in-browser fetch() (direct requests return 406)
ark           ARK Invest public CSV — no auth, no browser
alphavantage  Alpha Vantage ETF_PROFILE API — fallback for niche ETFs
              (25 calls/day on free tier)

To add a new ETF, add one line to ETF_CONFIG below and pick a provider.
"""

import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

# ── Config ───────────────────────────────────────────────────────────────────

CACHE_FILE = Path(__file__).parent.parent / "holdings-cache.json"
AV_KEY     = os.environ.get("ALPHA_VANTAGE_KEY", "")
UA         = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# ── ETF list ──────────────────────────────────────────────────────────────────
# Providers: ishares | ssga | vanguard | invesco | ark | alphavantage
# Add a new ETF by inserting one line here.

ETF_CONFIG = {

    # ── iShares (BlackRock) ───────────────────────────────────────────────────
    "IVV":  "ishares",   # iShares Core S&P 500
    "IJH":  "ishares",   # iShares Core S&P Mid-Cap
    "IJR":  "ishares",   # iShares Core S&P Small-Cap
    "IWM":  "alphavantage",   # iShares Russell 2000
    "IWB":  "ishares",   # iShares Russell 1000
    "IWF":  "ishares",   # iShares Russell 1000 Growth
    "IWD":  "ishares",   # iShares Russell 1000 Value
    "EFA":  "ishares",   # iShares MSCI EAFE
    "EEM":  "ishares",   # iShares MSCI Emerging Markets
    "IEMG": "ishares",   # iShares Core MSCI Emerging Markets
    "AGG":  "ishares",   # iShares Core US Aggregate Bond
    "LQD":  "ishares",   # iShares iBoxx IG Corporate Bond
    "HYG":  "ishares",   # iShares iBoxx HY Corporate Bond
    "TLT":  "ishares",   # iShares 20+ Year Treasury Bond
    "IAU":  "ishares",   # iShares Gold Trust
    "IBB":  "ishares",   # iShares Biotechnology
    "SOXX": "alphavantage",   # iShares Semiconductor

    # ── SSGA / SPDR ───────────────────────────────────────────────────────────
    # Core / broad
    "SPY":  "ssga",   # SPDR S&P 500
    "MDY":  "ssga",   # SPDR S&P MidCap 400
    # GLD omitted — physical gold fund, no equity holdings file on SSGA
    # Select Sector XL series
    "XLC":  "ssga",   # Communication Services Select Sector
    "XLP":  "ssga",   # Consumer Staples Select Sector
    "XLY":  "ssga",   # Consumer Discretionary Select Sector
    "XLE":  "ssga",   # Energy Select Sector
    "XLF":  "ssga",   # Financial Select Sector
    "XLV":  "ssga",   # Health Care Select Sector
    "XLI":  "ssga",   # Industrial Select Sector
    "XLB":  "ssga",   # Materials Select Sector
    "XLRE": "ssga",   # Real Estate Select Sector
    "XLK":  "ssga",   # Technology Select Sector
    "XLU":  "ssga",   # Utilities Select Sector
    "XLSR": "ssga",   # SPDR US Sector Rotation
    # Select Sector SPDR Premium Income series
    "XLCI": "ssga",   # Communication Services Premium Income
    "XLYI": "ssga",   # Consumer Discretionary Premium Income
    "XLSI": "ssga",   # Consumer Staples Premium Income
    "XLEI": "ssga",   # Energy Premium Income
    "XLFI": "ssga",   # Financial Premium Income
    "XLVI": "ssga",   # Health Care Premium Income
    "XLII": "ssga",   # Industrial Premium Income
    "XLBI": "ssga",   # Materials Premium Income
    "XLRI": "ssga",   # Real Estate Premium Income
    "XLKI": "ssga",   # Technology Premium Income
    "XLUI": "ssga",   # Utilities Premium Income
    # Kensho / New Economies
    "KOMP": "ssga",   # SPDR S&P Kensho New Economies Composite
    "SIMS": "ssga",   # SPDR S&P Kensho Intelligent Structures
    "HAIL": "ssga",   # SPDR S&P Kensho Smart Mobility
    "FITE": "ssga",   # SPDR S&P Kensho Future Security
    "ROKT": "ssga",   # SPDR S&P Kensho Final Frontiers
    "CNRG": "ssga",   # SPDR S&P Kensho Clean Power
    # Industry (modified equal weighted)
    "KBE":  "ssga",   # SPDR S&P Bank
    "KRE":  "ssga",   # SPDR S&P Regional Banking
    "KCE":  "ssga",   # SPDR S&P Capital Markets
    "KIE":  "ssga",   # SPDR S&P Insurance
    "XAR":  "ssga",   # SPDR S&P Aerospace & Defense
    "XTN":  "ssga",   # SPDR S&P Transportation
    "XBI":  "ssga",   # SPDR S&P Biotech
    "XPH":  "ssga",   # SPDR S&P Pharmaceuticals
    "XHE":  "ssga",   # SPDR S&P Health Care Equipment
    "XHS":  "ssga",   # SPDR S&P Health Care Services
    "XOP":  "ssga",   # SPDR S&P Oil & Gas Exploration & Production
    "XES":  "ssga",   # SPDR S&P Oil & Gas Equipment & Services
    "XME":  "ssga",   # SPDR S&P Metals & Mining
    "XRT":  "ssga",   # SPDR S&P Retail
    "XHB":  "ssga",   # SPDR S&P Homebuilders
    "XSD":  "ssga",   # SPDR S&P Semiconductor
    "XSW":  "ssga",   # SPDR S&P Software & Services
    "XNTK": "ssga",   # SPDR NYSE Technology
    "XITK": "ssga",   # SPDR FactSet Innovative Technology
    "XTL":  "ssga",   # SPDR S&P Telecom

    # ── Vanguard ──────────────────────────────────────────────────────────────
    "VOO":  "vanguard",   # Vanguard S&P 500
    "VTI":  "vanguard",   # Vanguard Total Stock Market
    "VEA":  "vanguard",   # Vanguard FTSE Developed Markets
    "VWO":  "vanguard",   # Vanguard FTSE Emerging Markets
    "BND":  "vanguard",   # Vanguard Total Bond Market
    "BNDX": "vanguard",   # Vanguard Total International Bond
    "VNQ":  "vanguard",   # Vanguard Real Estate
    "VIG":  "vanguard",   # Vanguard Dividend Appreciation
    "VYM":  "vanguard",   # Vanguard High Dividend Yield
    "VGT":  "vanguard",   # Vanguard Information Technology
    "VUG":  "vanguard",   # Vanguard Growth
    "VTV":  "vanguard",   # Vanguard Value
    "VB":   "vanguard",   # Vanguard Small-Cap
    "VO":   "vanguard",   # Vanguard Mid-Cap
    "VXUS": "vanguard",   # Vanguard Total International Stock

    # ── Invesco ───────────────────────────────────────────────────────────────
    "QQQ":  "alphavantage",   # Invesco QQQ (Nasdaq-100)
    "QQQM": "alphavantage",   # Invesco Nasdaq-100 (smaller share class)
    "RSP":  "alphavantage",   # Invesco S&P 500 Equal Weight

    # ── ARK Invest — direct CSV download ─────────────────────────────────────
    "ARKK": "ark",   # ARK Innovation
    "ARKW": "ark",   # ARK Next Generation Internet
    "ARKG": "ark",   # ARK Genomic Revolution
    "ARKF": "ark",   # ARK Fintech Innovation

    # ── Alpha Vantage — niche / custom ETFs ──────────────────────────────────
    # Each call costs 1 of your 25 free daily API calls.
    "ARTY": "alphavantage",
    "IETC": "alphavantage",
    "KWEB": "alphavantage",   # KraneShares China Internet
    "QBIG": "alphavantage",
    "RTH":  "alphavantage",   # VanEck Retail
    "TOLL": "alphavantage",
    "TOPT": "alphavantage",
    "XMAG": "alphavantage",
    "SCHD": "alphavantage",   # Schwab US Dividend Equity
    "JEPI": "alphavantage",   # JPMorgan Equity Premium Income
    "JEPQ": "alphavantage",   # JPMorgan Nasdaq Equity Premium Income
}

# ── Provider data maps ────────────────────────────────────────────────────────

ARK_FILENAMES = {
    "ARKK": "ARK_INNOVATION_ETF_ARKK_HOLDINGS",
    "ARKW": "ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS",
    "ARKG": "ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS",
    "ARKF": "ARK_FINTECH_INNOVATION_ETF_ARKF_HOLDINGS",
}

# portIds from the Vanguard internal API URL (visible in prior error messages)
VANGUARD_PORT_IDS = {
    "VOO":  "0968", "VTI":  "0970", "VEA":  "0936", "VWO":  "0964",
    "BND":  "0928", "BNDX": "3711", "VNQ":  "0986", "VIG":  "0920",
    "VYM":  "0923", "VGT":  "0958", "VUG":  "0967", "VTV":  "0966",
    "VB":   "0969", "VO":   "0939", "VXUS": "3369",
}

# iShares product page IDs (from ishares.com/us/products/{id}/)
ISHARES_PRODUCT_IDS = {
    "IVV":  "239726", "IJH":  "239764", "IJR":  "239774", "IWM":  "239710",
    "IWB":  "239707", "IWF":  "239708", "IWD":  "239706", "EFA":  "239623",
    "EEM":  "239637", "IEMG": "244048", "AGG":  "239458", "LQD":  "239566",
    "HYG":  "239565", "TLT":  "239454", "IAU":  "239597", "IBB":  "239699",
    "SOXX": "239705",
}

# ── Shared Playwright state ───────────────────────────────────────────────────
# One browser process; separate browser contexts per provider so that cookies
# don't cross-contaminate.  page.evaluate(fetch(...)) is used rather than
# page.request.get() because the former runs inside the browser's JS engine
# (full Cloudflare / bot-detection fingerprint), while the latter is an
# out-of-process HTTP request that Cloudflare can distinguish and block.

_pw_instance = None
_pw_browser  = None

def _get_pw_browser():
    global _pw_instance, _pw_browser
    if _pw_browser is None:
        from playwright.sync_api import sync_playwright
        _pw_instance = sync_playwright().start()
        _pw_browser = _pw_instance.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--window-size=1920,1080",
            ],
        )
    return _pw_browser


def _make_ctx(warmup_url: str):
    """Create a new browser context and pre-warm it by loading warmup_url."""
    ctx = _get_pw_browser().new_context(
        user_agent=UA,
        viewport={"width": 1920, "height": 1080},
        locale="en-US",
        timezone_id="America/New_York",
        extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
    )
    # Patch navigator.webdriver so Cloudflare/bot-detection sees a real browser
    ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
    page = ctx.new_page()
    try:
        page.goto(warmup_url, wait_until="domcontentloaded", timeout=60_000)
    finally:
        page.close()
    return ctx


def _browser_fetch(ctx, navigate_url: str, fetch_url: str) -> str:
    """Navigate to navigate_url, then fetch fetch_url from within the browser.

    Uses page.evaluate(fetch()) instead of page.request.get() so the request
    runs inside the browser's JS engine — full TLS fingerprint, Cloudflare
    cookies, and bot-challenge tokens all apply automatically.
    """
    page = ctx.new_page()
    try:
        page.goto(navigate_url, wait_until="domcontentloaded", timeout=60_000)
        result = page.evaluate(
            """
            async (url) => {
                try {
                    const r = await fetch(url, {credentials: 'include'});
                    const text = await r.text();
                    return {ok: true, status: r.status, text};
                } catch (e) {
                    return {ok: false, error: e.toString()};
                }
            }
            """,
            fetch_url,
        )
    finally:
        page.close()

    if not result["ok"]:
        raise ValueError(f"in-browser fetch() threw: {result['error']}")
    status = result["status"]
    text   = result["text"]
    if status != 200:
        preview = repr(text[:300])
        raise ValueError(f"HTTP {status} from fetch() — preview: {preview}")
    return text


_ishares_ctx = None
_vanguard_ctx = None
_invesco_ctx  = None


def _get_ishares_ctx():
    global _ishares_ctx
    if _ishares_ctx is None:
        _ishares_ctx = _make_ctx("https://www.ishares.com/us/")
    return _ishares_ctx


def _get_vanguard_ctx():
    global _vanguard_ctx
    if _vanguard_ctx is None:
        # investor.vanguard.com is the public-facing site (no login required);
        # www.vanguard.com/us/portal/ is their authenticated investor portal.
        _vanguard_ctx = _make_ctx("https://investor.vanguard.com/")
    return _vanguard_ctx


def _get_invesco_ctx():
    global _invesco_ctx
    if _invesco_ctx is None:
        _invesco_ctx = _make_ctx("https://www.invesco.com/us/")
    return _invesco_ctx


# ── Shared helpers ────────────────────────────────────────────────────────────

def _df_to_holdings(df: pd.DataFrame) -> list:
    """Normalize a DataFrame to [{asset, name, weightPercentage}]."""
    col_lower = {c.lower().strip(): c for c in df.columns}

    def find(*candidates):
        for name in candidates:
            if name in col_lower:
                return col_lower[name]
        return None

    sym_col    = find("ticker", "holding ticker", "symbol", "stock_ticker")
    name_col   = find("name", "security name", "description", "company name", "company")
    weight_col = find("weight (%)", "weight(%)", "weight", "weighting", "% of net assets")

    if sym_col is None or weight_col is None:
        raise ValueError(f"Unrecognised columns: {list(df.columns)}")

    holdings = []
    for _, row in df.iterrows():
        sym = str(row[sym_col]).strip().upper() if pd.notna(row[sym_col]) else ""
        if not sym or sym in {"N/A", "NA", "-", "NAN", "NONE", ""}:
            continue
        try:
            weight = float(row[weight_col])
        except (ValueError, TypeError):
            continue
        if abs(weight) < 1e-9:
            continue
        name = str(row[name_col]).strip() if name_col and pd.notna(row.get(name_col)) else ""
        holdings.append({"asset": sym, "name": name, "weightPercentage": weight})

    if holdings:
        total = sum(h["weightPercentage"] for h in holdings)
        if total < 5:  # decimal fractions → convert to percentages
            for h in holdings:
                h["weightPercentage"] = round(h["weightPercentage"] * 100, 6)
        else:
            for h in holdings:
                h["weightPercentage"] = round(h["weightPercentage"], 6)

    return holdings


def _find_csv_header(lines: list) -> int:
    """Return the index of the line that looks like a CSV column header."""
    KEYS = ("ticker", "symbol", "weight", "cusip", "isin", "holding", "shares")
    for i, line in enumerate(lines):
        lower = line.lower()
        if sum(1 for k in KEYS if k in lower) >= 2:
            return i
    return 0


# ── Provider fetchers ─────────────────────────────────────────────────────────

def fetch_ishares(ticker: str) -> list:
    prod_id = ISHARES_PRODUCT_IDS.get(ticker)
    if not prod_id:
        raise ValueError(f"No product ID for iShares {ticker}")

    product_url = f"https://www.ishares.com/us/products/{prod_id}/"
    csv_url = (
        f"https://www.ishares.com/us/products/{prod_id}/{ticker.lower()}"
        f"/1467271812596.ajax?tab=all&fileType=csv&dataType=fund"
    )

    content = _browser_fetch(_get_ishares_ctx(), product_url, csv_url)

    if "<html" in content[:200].lower():
        raise ValueError("Got HTML — Cloudflare still blocking CSV endpoint")

    lines = content.splitlines()
    header = _find_csv_header(lines)
    df = pd.read_csv(io.StringIO("\n".join(lines[header:])), on_bad_lines="skip", engine="python")
    return _df_to_holdings(df)


def fetch_ssga(ticker: str) -> list:
    """Direct XLSX download from ssga.com — no bot detection on this endpoint."""
    url = (
        f"https://www.ssga.com/library-content/products/fund-data/etfs/us"
        f"/holdings-daily-us-en-{ticker.lower()}.xlsx"
    )
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    buf = io.BytesIO(r.content)
    # SSGA XLSXs have 3–4 metadata rows before the column header; try each.
    for skip in (3, 4, 2, 5, 1, 0):
        buf.seek(0)
        try:
            df = pd.read_excel(buf, skiprows=skip, engine="openpyxl")
            if df.empty or len(df.columns) < 2:
                continue
            holdings = _df_to_holdings(df)
            if holdings:
                return holdings
        except Exception:
            pass
    raise ValueError(f"Could not parse SSGA XLSX for {ticker}")


def fetch_vanguard(ticker: str) -> list:
    port_id = VANGUARD_PORT_IDS.get(ticker)
    if not port_id:
        raise ValueError(f"No portId mapping for Vanguard {ticker}")

    # The authenticated portal download URL is auth-walled.
    # Instead: load the PUBLIC investor profile page and intercept the XHR
    # calls it makes for portfolio composition data.
    profile_url = f"https://investor.vanguard.com/investment-products/etfs/profile/{ticker.lower()}"

    ctx = _get_vanguard_ctx()
    page = ctx.new_page()
    captured: list = []

    def on_response(response):
        url = response.url
        # Capture any JSON response that mentions "holding" or "portfolio"
        # from Vanguard's API domain.
        if "vanguard.com" in url and response.status == 200:
            if any(k in url.lower() for k in ("holding", "portfolio", "composition")):
                try:
                    captured.append(response.json())
                except Exception:
                    pass

    page.on("response", on_response)
    try:
        page.goto(profile_url, wait_until="networkidle", timeout=90_000)
    finally:
        page.close()

    # Look for a holdings-like structure in any captured JSON
    for blob in captured:
        holdings = _parse_vanguard_json(blob)
        if holdings:
            return holdings

    raise ValueError(
        f"No holdings data captured from Vanguard profile page "
        f"(captured {len(captured)} JSON responses — "
        f"may need a different URL pattern)"
    )


def _parse_vanguard_json(blob) -> list:
    """Try to extract [{asset, name, weightPercentage}] from Vanguard API JSON."""
    if not isinstance(blob, dict):
        return []

    # Common Vanguard API shapes:
    # {"fundHoldings": [...]}
    # {"portfolioHoldings": [...]}
    # {"holdings": [...]}
    for key in ("fundHoldings", "portfolioHoldings", "holdings", "equityHoldings"):
        raw = blob.get(key)
        if isinstance(raw, list) and raw:
            return _normalise_vanguard_holdings(raw)

    # Recurse one level into nested dicts
    for val in blob.values():
        if isinstance(val, dict):
            result = _parse_vanguard_json(val)
            if result:
                return result

    return []


def _normalise_vanguard_holdings(rows: list) -> list:
    """Normalise a list of Vanguard holding dicts."""
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = (
            row.get("ticker") or row.get("symbol") or row.get("securityTicker") or ""
        ).strip().upper()
        if not sym or sym in {"N/A", "CASH", ""}:
            continue
        weight = None
        for wkey in ("percentWeight", "weight", "percentOfFund", "pctFund", "holdingPercent"):
            v = row.get(wkey)
            if v is not None:
                try:
                    weight = float(v)
                    break
                except (ValueError, TypeError):
                    pass
        if weight is None or abs(weight) < 1e-9:
            continue
        name = (row.get("longName") or row.get("name") or row.get("securityName") or "").strip()
        result.append({"asset": sym, "name": name, "weightPercentage": round(weight, 6)})

    if result:
        total = sum(h["weightPercentage"] for h in result)
        if total < 5:  # decimal fractions → percentages
            for h in result:
                h["weightPercentage"] = round(h["weightPercentage"] * 100, 6)

    return result


def fetch_invesco(ticker: str) -> list:
    etf_url = (
        f"https://www.invesco.com/us/financial-products/etfs/etf-details"
        f"?audienceType=Investor&ticker={ticker}"
    )
    csv_url = (
        f"https://www.invesco.com/us/financial-products/etfs/holdings"
        f"/main/holdings/0?audienceType=Investor&ticker={ticker}"
    )

    content = _browser_fetch(_get_invesco_ctx(), etf_url, csv_url)

    lines = content.splitlines()
    header = _find_csv_header(lines)
    df = pd.read_csv(io.StringIO("\n".join(lines[header:])), on_bad_lines="skip", engine="python")
    return _df_to_holdings(df)


def fetch_ark(ticker: str) -> list:
    filename = ARK_FILENAMES.get(ticker)
    if not filename:
        raise ValueError(f"No ARK filename mapping for {ticker}")
    url = f"https://assets.ark-funds.com/fund-documents/funds-etf-csv/{filename}.csv"
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()

    holdings = []
    for row in csv.DictReader(io.StringIO(r.text)):
        sym = (row.get("ticker") or "").strip()
        if not sym or sym in {"-", "N/A", "n/a"}:
            continue
        try:
            weight_pct = float((row.get("weight (%)") or "0").strip().rstrip("%"))
        except ValueError:
            continue
        if abs(weight_pct) < 1e-9:
            continue
        name = (row.get("company") or "").strip()
        holdings.append({"asset": sym.upper(), "name": name, "weightPercentage": round(weight_pct, 6)})
    return holdings


def fetch_alphavantage(ticker: str) -> list:
    if not AV_KEY:
        raise ValueError("ALPHA_VANTAGE_KEY not set")
    url  = f"https://www.alphavantage.co/query?function=ETF_PROFILE&symbol={ticker}&apikey={AV_KEY}"
    data = requests.get(url, timeout=30).json()
    if "Error Message" in data:
        raise ValueError(data["Error Message"])
    if "Information" in data:
        raise ValueError(data["Information"])
    if not isinstance(data.get("holdings"), list):
        raise ValueError("no holdings array returned")
    holdings = []
    for h in data["holdings"]:
        sym = (h.get("symbol") or "").strip().upper()
        if not sym or sym == "N/A":
            continue
        holdings.append({
            "asset": sym,
            "name":  h.get("description", ""),
            "weightPercentage": round(float(h.get("weight", 0)) * 100, 6),
        })
    return holdings


# ── Main ──────────────────────────────────────────────────────────────────────

FETCHERS = {
    "ishares":      fetch_ishares,
    "ssga":         fetch_ssga,
    "vanguard":     fetch_vanguard,
    "invesco":      fetch_invesco,
    "ark":          fetch_ark,
    "alphavantage": fetch_alphavantage,
}


def main():
    if CACHE_FILE.exists():
        raw = CACHE_FILE.read_bytes().lstrip(b"\xef\xbb\xbf")
        cache = json.loads(raw.decode("utf-8"))
    else:
        cache = {"version": 1, "holdings": {}}

    now      = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    av_calls = 0
    success, failed = [], []

    seen, etf_list = set(), []
    for ticker, provider in ETF_CONFIG.items():
        if ticker not in seen:
            seen.add(ticker)
            etf_list.append((ticker, provider))

    for ticker, provider in etf_list:
        print(f"  [{provider:>12}] {ticker:<6} ... ", end="", flush=True)
        try:
            if provider == "alphavantage":
                if av_calls > 0:
                    time.sleep(13)  # stay under 5 calls/min on free tier
                av_calls += 1

            holdings = FETCHERS[provider](ticker)
            if not holdings:
                raise ValueError("empty holdings returned")

            cache["holdings"][ticker] = {"holdings": holdings, "fetchedAt": now}
            print(f"✓  {len(holdings)} holdings")
            success.append(ticker)

        except Exception as exc:
            print(f"✗  {exc}")
            failed.append((ticker, str(exc)))

    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)

    print(f"\n{'─'*52}")
    print(f"Updated: {len(success)}   Failed: {len(failed)}")
    if failed:
        print("Failed:")
        for t, err in failed:
            print(f"  {t}: {err}")

    if len(success) == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
