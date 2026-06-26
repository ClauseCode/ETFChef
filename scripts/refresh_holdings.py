#!/usr/bin/env python3
"""
Refresh ETF holdings cache from provider websites.

Run manually:   ALPHA_VANTAGE_KEY=<key> python scripts/refresh_holdings.py
GitHub Actions: triggered weekly; ALPHA_VANTAGE_KEY set as repo secret

Providers
---------
etf_scraper   etf-scraper library — covers iShares, SSGA/SPDR, Vanguard, Invesco
              Uses headless Chromium when needed (iShares bot-detection bypass)
ark           ARK Invest public CSV — no auth, no browser
alphavantage  Alpha Vantage ETF_PROFILE API — fallback for niche ETFs not covered
              by the above (25 calls/day on free tier)

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
from etf_scraper import ETFScraper

# ── Config ──────────────────────────────────────────────────────────────────

CACHE_FILE = Path(__file__).parent.parent / "holdings-cache.json"
AV_KEY     = os.environ.get("ALPHA_VANTAGE_KEY", "")
UA         = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# ── ETF list ─────────────────────────────────────────────────────────────────
# Providers: etf_scraper | ark | alphavantage
# Add a new ETF by inserting one line here.

ETF_CONFIG = {

    # ── iShares (BlackRock) ───────────────────────────────────────────────────
    "IVV":  "etf_scraper",   # iShares Core S&P 500
    "IJH":  "etf_scraper",   # iShares Core S&P Mid-Cap
    "IJR":  "etf_scraper",   # iShares Core S&P Small-Cap
    "IWM":  "etf_scraper",   # iShares Russell 2000
    "IWB":  "etf_scraper",   # iShares Russell 1000
    "IWF":  "etf_scraper",   # iShares Russell 1000 Growth
    "IWD":  "etf_scraper",   # iShares Russell 1000 Value
    "EFA":  "etf_scraper",   # iShares MSCI EAFE
    "EEM":  "etf_scraper",   # iShares MSCI Emerging Markets
    "IEMG": "etf_scraper",   # iShares Core MSCI Emerging Markets
    "AGG":  "etf_scraper",   # iShares Core US Aggregate Bond
    "LQD":  "etf_scraper",   # iShares iBoxx IG Corporate Bond
    "HYG":  "etf_scraper",   # iShares iBoxx HY Corporate Bond
    "TLT":  "etf_scraper",   # iShares 20+ Year Treasury Bond
    "IAU":  "etf_scraper",   # iShares Gold Trust
    "IBB":  "etf_scraper",   # iShares Biotechnology
    "SOXX": "etf_scraper",   # iShares Semiconductor
    "IETC": "etf_scraper",   # iShares U.S. Tech Independence

    # ── SSGA / SPDR ───────────────────────────────────────────────────────────
    # Core / broad
    "SPY":  "etf_scraper",   # SPDR S&P 500
    "MDY":  "etf_scraper",   # SPDR S&P MidCap 400
    "GLD":  "etf_scraper",   # SPDR Gold Shares
    # Select Sector XL series
    "XLC":  "etf_scraper",   # Communication Services Select Sector
    "XLP":  "etf_scraper",   # Consumer Staples Select Sector
    "XLY":  "etf_scraper",   # Consumer Discretionary Select Sector
    "XLE":  "etf_scraper",   # Energy Select Sector
    "XLF":  "etf_scraper",   # Financial Select Sector
    "XLV":  "etf_scraper",   # Health Care Select Sector
    "XLI":  "etf_scraper",   # Industrial Select Sector
    "XLB":  "etf_scraper",   # Materials Select Sector
    "XLRE": "etf_scraper",   # Real Estate Select Sector
    "XLK":  "etf_scraper",   # Technology Select Sector
    "XLU":  "etf_scraper",   # Utilities Select Sector
    "XLSR": "etf_scraper",   # SPDR US Sector Rotation
    # Select Sector SPDR Premium Income series
    "XLCI": "etf_scraper",   # Communication Services Premium Income
    "XLYI": "etf_scraper",   # Consumer Discretionary Premium Income
    "XLSI": "etf_scraper",   # Consumer Staples Premium Income
    "XLEI": "etf_scraper",   # Energy Premium Income
    "XLFI": "etf_scraper",   # Financial Premium Income
    "XLVI": "etf_scraper",   # Health Care Premium Income
    "XLII": "etf_scraper",   # Industrial Premium Income
    "XLBI": "etf_scraper",   # Materials Premium Income
    "XLRI": "etf_scraper",   # Real Estate Premium Income
    "XLKI": "etf_scraper",   # Technology Premium Income
    "XLUI": "etf_scraper",   # Utilities Premium Income
    # Kensho / New Economies
    "KOMP": "etf_scraper",   # SPDR S&P Kensho New Economies Composite
    "SIMS": "etf_scraper",   # SPDR S&P Kensho Intelligent Structures
    "HAIL": "etf_scraper",   # SPDR S&P Kensho Smart Mobility
    "FITE": "etf_scraper",   # SPDR S&P Kensho Future Security
    "ROKT": "etf_scraper",   # SPDR S&P Kensho Final Frontiers
    "CNRG": "etf_scraper",   # SPDR S&P Kensho Clean Power
    # Industry (modified equal weighted)
    "KBE":  "etf_scraper",   # SPDR S&P Bank
    "KRE":  "etf_scraper",   # SPDR S&P Regional Banking
    "KCE":  "etf_scraper",   # SPDR S&P Capital Markets
    "KIE":  "etf_scraper",   # SPDR S&P Insurance
    "XAR":  "etf_scraper",   # SPDR S&P Aerospace & Defense
    "XTN":  "etf_scraper",   # SPDR S&P Transportation
    "XBI":  "etf_scraper",   # SPDR S&P Biotech
    "XPH":  "etf_scraper",   # SPDR S&P Pharmaceuticals
    "XHE":  "etf_scraper",   # SPDR S&P Health Care Equipment
    "XHS":  "etf_scraper",   # SPDR S&P Health Care Services
    "XOP":  "etf_scraper",   # SPDR S&P Oil & Gas Exploration & Production
    "XES":  "etf_scraper",   # SPDR S&P Oil & Gas Equipment & Services
    "XME":  "etf_scraper",   # SPDR S&P Metals & Mining
    "XRT":  "etf_scraper",   # SPDR S&P Retail
    "XHB":  "etf_scraper",   # SPDR S&P Homebuilders
    "XSD":  "etf_scraper",   # SPDR S&P Semiconductor
    "XSW":  "etf_scraper",   # SPDR S&P Software & Services
    "XNTK": "etf_scraper",   # SPDR NYSE Technology
    "XITK": "etf_scraper",   # SPDR FactSet Innovative Technology
    "XTL":  "etf_scraper",   # SPDR S&P Telecom

    # ── Vanguard ──────────────────────────────────────────────────────────────
    "VOO":  "etf_scraper",   # Vanguard S&P 500
    "VTI":  "etf_scraper",   # Vanguard Total Stock Market
    "VEA":  "etf_scraper",   # Vanguard FTSE Developed Markets
    "VWO":  "etf_scraper",   # Vanguard FTSE Emerging Markets
    "BND":  "etf_scraper",   # Vanguard Total Bond Market
    "BNDX": "etf_scraper",   # Vanguard Total International Bond
    "VNQ":  "etf_scraper",   # Vanguard Real Estate
    "VIG":  "etf_scraper",   # Vanguard Dividend Appreciation
    "VYM":  "etf_scraper",   # Vanguard High Dividend Yield
    "VGT":  "etf_scraper",   # Vanguard Information Technology
    "VUG":  "etf_scraper",   # Vanguard Growth
    "VTV":  "etf_scraper",   # Vanguard Value
    "VB":   "etf_scraper",   # Vanguard Small-Cap
    "VO":   "etf_scraper",   # Vanguard Mid-Cap
    "VXUS": "etf_scraper",   # Vanguard Total International Stock

    # ── Invesco ───────────────────────────────────────────────────────────────
    "QQQ":  "etf_scraper",   # Invesco QQQ (Nasdaq-100)
    "QQQM": "etf_scraper",   # Invesco Nasdaq-100 (smaller share class)
    "RSP":  "etf_scraper",   # Invesco S&P 500 Equal Weight

    # ── ARK Invest — direct CSV download ─────────────────────────────────────
    "ARKK": "ark",           # ARK Innovation
    "ARKW": "ark",           # ARK Next Generation Internet
    "ARKG": "ark",           # ARK Genomic Revolution
    "ARKF": "ark",           # ARK Fintech Innovation
    "ARKQ": "ark",           # ARK Autonomous Technology & Robotics

    # ── Alpha Vantage — niche / custom ETFs ──────────────────────────────────
    # These aren't covered by etf-scraper (smaller or non-standard providers).
    # Each call costs 1 of your 25 free daily API calls.
    "ARTY": "alphavantage",
    "IETC": "alphavantage",  # will be tried via etf_scraper first above;
    "KWEB": "alphavantage",  # KraneShares China Internet
    "QBIG": "alphavantage",
    "RTH":  "alphavantage",  # VanEck Retail
    "TOLL": "alphavantage",
    "TOPT": "alphavantage",
    "XMAG": "alphavantage",
    "SCHD": "alphavantage",  # Schwab US Dividend Equity
    "JEPI": "alphavantage",  # JPMorgan Equity Premium Income
    "JEPQ": "alphavantage",  # JPMorgan Nasdaq Equity Premium Income
}

ARK_FILENAMES = {
    "ARKK": "ARK_INNOVATION_ETF_ARKK_HOLDINGS",
    "ARKW": "ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS",
    "ARKG": "ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS",
    "ARKF": "ARK_FINTECH_INNOVATION_ETF_ARKF_HOLDINGS",
    "ARKQ": "ARK_AUTONOMOUS_TECHNOLOGY_%26_ROBOTICS_ETF_ARKQ_HOLDINGS",
}

# ── Provider fetchers ────────────────────────────────────────────────────────

_scraper = None  # lazy-init so import-time errors don't block the whole script

def get_scraper():
    global _scraper
    if _scraper is None:
        _scraper = ETFScraper()
    return _scraper


def _df_to_holdings(df: pd.DataFrame) -> list:
    """Normalize an etf-scraper DataFrame to {asset, name, weightPercentage}."""
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

    # Some providers return decimal fractions (0.0721) rather than percentages (7.21).
    # Detect by checking whether the total across all holdings is close to 1 vs 100.
    if holdings:
        total = sum(h["weightPercentage"] for h in holdings)
        if total < 5:  # looks like decimals
            for h in holdings:
                h["weightPercentage"] = round(h["weightPercentage"] * 100, 6)
        else:
            for h in holdings:
                h["weightPercentage"] = round(h["weightPercentage"], 6)

    return holdings


def fetch_etf_scraper(ticker: str) -> list:
    df = get_scraper().query_holdings(ticker)
    if df is None or df.empty:
        raise ValueError("empty DataFrame returned")
    return _df_to_holdings(df)


def fetch_ark(ticker: str) -> list:
    filename = ARK_FILENAMES.get(ticker)
    if not filename:
        raise ValueError(f"No ARK filename mapping for {ticker}")
    url = f"https://assets.ark-funds.com/fund-documents/funds-etf-csv/{filename}.csv"
    r   = requests.get(url, headers={"User-Agent": UA}, timeout=30)
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


# ── Main ─────────────────────────────────────────────────────────────────────

FETCHERS = {
    "etf_scraper":  fetch_etf_scraper,
    "ark":          fetch_ark,
    "alphavantage": fetch_alphavantage,
}


def main():
    if CACHE_FILE.exists():
        raw = CACHE_FILE.read_bytes().lstrip(b'\xef\xbb\xbf')  # strip UTF-8 BOM if present
        cache = json.loads(raw.decode('utf-8'))
    else:
        cache = {"version": 1, "holdings": {}}

    now      = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    av_calls = 0
    success, failed = [], []

    # Deduplicate — IETC appears in both etf_scraper and alphavantage sections
    # above; etf_scraper wins because it comes first in the dict.
    seen = set()
    etf_list = []
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
