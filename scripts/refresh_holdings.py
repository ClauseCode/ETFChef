#!/usr/bin/env python3
"""
Refresh ETF holdings cache from provider websites.

Run manually:   ALPHA_VANTAGE_KEY=<key> python scripts/refresh_holdings.py
GitHub Actions: triggered weekly; ALPHA_VANTAGE_KEY set as repo secret

Providers
---------
ssga          SSGA/SPDR — direct XLSX download from ssga.com
vanguard      Vanguard — public JSON API on investor.vanguard.com
              (/vmf/api/{TICKER}/portfolio-holding/stock.json, paginated)
ark           ARK Invest public CSV
alphavantage  Alpha Vantage ETF_PROFILE API — used for providers whose sites
              block scraping (iShares/Akamai, Invesco). Free tier allows
              25 calls/day; the script refreshes the stalest 25 per run and
              defers the rest to the next run.

No browser automation: iShares and Invesco direct scraping were abandoned —
Akamai serves the product page instead of the CSV no matter what (headless
browsers get "Access Denied"; plain requests get a soft fallback), and those
tickers work fine through Alpha Vantage. Bond/commodity funds (GLD, AGG, TLT,
LQD, HYG, IAU, BND, BNDX) are omitted entirely: they hold no stocks, so they
contribute nothing to stock-level exposure.

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

    # ── iShares (BlackRock) — via Alpha Vantage (ishares.com blocks scraping) ─
    # AGG/LQD/HYG/TLT (bonds) and IAU (gold) omitted: no stock holdings.
    "IVV":  "alphavantage",   # iShares Core S&P 500
    "IJH":  "alphavantage",   # iShares Core S&P Mid-Cap
    "IJR":  "alphavantage",   # iShares Core S&P Small-Cap
    "IWM":  "alphavantage",   # iShares Russell 2000
    "IWB":  "alphavantage",   # iShares Russell 1000
    "IWF":  "alphavantage",   # iShares Russell 1000 Growth
    "IWD":  "alphavantage",   # iShares Russell 1000 Value
    "EFA":  "alphavantage",   # iShares MSCI EAFE
    "EEM":  "alphavantage",   # iShares MSCI Emerging Markets
    "IEMG": "alphavantage",   # iShares Core MSCI Emerging Markets
    "IBB":  "alphavantage",   # iShares Biotechnology
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

    # ── Vanguard — public JSON API ────────────────────────────────────────────
    # BND/BNDX (bond funds) omitted: no stock holdings.
    "VOO":  "vanguard",   # Vanguard S&P 500
    "VTI":  "vanguard",   # Vanguard Total Stock Market
    "VEA":  "vanguard",   # Vanguard FTSE Developed Markets
    "VWO":  "vanguard",   # Vanguard FTSE Emerging Markets
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
    """Public JSON API used by investor.vanguard.com fund profile pages.

    Plain requests, no auth, no browser. Paginated at 500 rows;
    percentWeight is already a percentage string (e.g. "7.89").
    """
    url = f"https://investor.vanguard.com/vmf/api/{ticker.upper()}/portfolio-holding/stock.json"
    headers = {"User-Agent": UA, "Accept": "application/json"}

    holdings, start = [], 1
    while True:
        r = requests.get(url, params={"start": start, "count": 500},
                         headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
        rows = (data.get("fund") or {}).get("entity") or []
        if not rows:
            break
        for row in rows:
            sym = (row.get("ticker") or "").strip().upper()
            if not sym or sym in {"N/A", "CASH"}:
                continue
            try:
                weight = float(row.get("percentWeight") or 0)
            except (ValueError, TypeError):
                continue
            if abs(weight) < 1e-9:
                continue
            name = (row.get("longName") or row.get("shortName") or "").strip()
            holdings.append({"asset": sym, "name": name, "weightPercentage": round(weight, 6)})
        size = int(data.get("size") or 0)
        start += len(rows)
        if start > size:
            break
    return holdings


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
    "ssga":         fetch_ssga,
    "vanguard":     fetch_vanguard,
    "ark":          fetch_ark,
    "alphavantage": fetch_alphavantage,
}

# Alpha Vantage free tier allows 25 calls/day. If more AV tickers are
# configured, each run refreshes the stalest 25 and defers the rest to the
# next run — with the twice-weekly schedule everything stays under a week old.
MAX_AV_PER_RUN = 25


def main():
    if CACHE_FILE.exists():
        raw = CACHE_FILE.read_bytes().lstrip(b"\xef\xbb\xbf")
        cache = json.loads(raw.decode("utf-8"))
    else:
        cache = {"version": 1, "holdings": {}}

    now      = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    av_calls = 0
    success, failed, deferred = [], [], []

    seen, etf_list = set(), []
    for ticker, provider in ETF_CONFIG.items():
        if ticker not in seen:
            seen.add(ticker)
            etf_list.append((ticker, provider))

    # AV budget: refresh the stalest tickers first (never-fetched sorts first)
    av_tickers = [t for t, p in etf_list if p == "alphavantage"]
    av_sorted  = sorted(av_tickers,
                        key=lambda t: cache["holdings"].get(t, {}).get("fetchedAt", ""))
    av_budget  = set(av_sorted[:MAX_AV_PER_RUN])

    for ticker, provider in etf_list:
        print(f"  [{provider:>12}] {ticker:<6} ... ", end="", flush=True)

        if provider == "alphavantage" and ticker not in av_budget:
            print("deferred (AV daily quota)")
            deferred.append(ticker)
            continue

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
    print(f"Updated: {len(success)}   Failed: {len(failed)}   Deferred: {len(deferred)}")
    if failed:
        print("Failed:")
        for t, err in failed:
            print(f"  {t}: {err}")
    if deferred:
        print(f"Deferred to next run (AV quota): {' '.join(deferred)}")

    if len(success) == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
