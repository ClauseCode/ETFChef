#!/usr/bin/env python3
"""
Refresh ETF holdings cache from provider websites.

Run manually:   python scripts/refresh_holdings.py
GitHub Actions: triggered weekly; ALPHA_VANTAGE_KEY set as repo secret

Providers
---------
ssga          State Street SPDR XLSX  (SPY, XL* sector ETFs)
ark           ARK Invest CSV          (ARKK, ARKW, ARKG, ARKF, ARKQ)
alphavantage  Alpha Vantage API       (everything else; 25 calls/day free)

To add a new ETF, add one line to ETF_CONFIG below.
"""

import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
import requests

# ── Config ──────────────────────────────────────────────────────────────────

CACHE_FILE = Path(__file__).parent.parent / "holdings-cache.json"
AV_KEY     = os.environ.get("ALPHA_VANTAGE_KEY", "")
UA         = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Add or remove ETFs here — pick ssga / ark / alphavantage as the provider.
ETF_CONFIG = {
    # SSGA / SPDR — direct XLSX, no API key needed
    "SPY":  "ssga",
    "XLB":  "ssga",
    "XLC":  "ssga",
    "XLE":  "ssga",
    "XLF":  "ssga",
    "XLI":  "ssga",
    "XLK":  "ssga",
    "XLP":  "ssga",
    "XLRE": "ssga",
    "XLU":  "ssga",
    "XLY":  "ssga",
    "XRT":  "ssga",
    # ARK Invest — direct CSV, no API key needed
    "ARKK": "ark",
    "ARKW": "ark",
    "ARKG": "ark",
    "ARKF": "ark",
    "ARKQ": "ark",
    # Alpha Vantage — needs ALPHA_VANTAGE_KEY (25 calls/day on free tier)
    "ARTY": "alphavantage",
    "IETC": "alphavantage",
    "IWM":  "alphavantage",
    "KWEB": "alphavantage",
    "QBIG": "alphavantage",
    "QQQ":  "alphavantage",
    "RTH":  "alphavantage",
    "SOXX": "alphavantage",
    "TOLL": "alphavantage",
    "TOPT": "alphavantage",
    "XMAG": "alphavantage",
}

ARK_FILENAMES = {
    "ARKK": "ARK_INNOVATION_ETF_ARKK_HOLDINGS",
    "ARKW": "ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS",
    "ARKG": "ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS",
    "ARKF": "ARK_FINTECH_INNOVATION_ETF_ARKF_HOLDINGS",
    "ARKQ": "ARK_AUTONOMOUS_TECHNOLOGY_%26_ROBOTICS_ETF_ARKQ_HOLDINGS",
}

# ── Provider fetchers ────────────────────────────────────────────────────────

def fetch_ssga(ticker: str) -> list:
    """Fetch holdings from SSGA XLSX direct download."""
    url = (
        "https://www.ssga.com/library-content/products/fund-data/etfs/us/"
        f"holdings-daily-us-en-{ticker.lower()}.xlsx"
    )
    r = requests.get(url, headers={"User-Agent": UA, "Referer": "https://www.ssga.com"}, timeout=30)
    r.raise_for_status()

    wb  = openpyxl.load_workbook(io.BytesIO(r.content), read_only=True, data_only=True)
    ws  = wb.active
    rows = list(ws.iter_rows(values_only=True))

    # Find the data header row dynamically (row containing "Ticker" and "Weight")
    header_idx = None
    for i, row in enumerate(rows):
        cells = [str(c).strip() if c is not None else "" for c in row]
        if "Ticker" in cells and any("Weight" in c for c in cells):
            header_idx = i
            break
    if header_idx is None:
        raise ValueError(f"Cannot find header row in SSGA XLSX for {ticker}")

    headers    = [str(c).strip() if c is not None else "" for c in rows[header_idx]]
    ticker_col = next((i for i, h in enumerate(headers) if h == "Ticker"), None)
    name_col   = next((i for i, h in enumerate(headers) if h == "Name"), None)
    weight_col = next((i for i, h in enumerate(headers) if "Weight" in h), None)

    if ticker_col is None or weight_col is None:
        raise ValueError(f"Missing Ticker/Weight columns in SSGA XLSX for {ticker}: {headers}")

    holdings = []
    for row in rows[header_idx + 1:]:
        if not any(row):
            break  # blank row signals end of data
        sym = str(row[ticker_col]).strip() if row[ticker_col] is not None else ""
        if not sym or sym in {"-", "N/A", "n/a", "None", "nan"}:
            continue
        try:
            weight = float(row[weight_col])
        except (TypeError, ValueError):
            continue
        if abs(weight) < 1e-9:
            continue
        # SSGA stores weight as a decimal fraction (0.0721 = 7.21%)
        weight_pct = weight * 100
        name = str(row[name_col]).strip() if name_col is not None and row[name_col] is not None else ""
        holdings.append({"asset": sym.upper(), "name": name, "weightPercentage": round(weight_pct, 6)})

    return holdings


def fetch_ark(ticker: str) -> list:
    """Fetch holdings from ARK Invest CSV direct download."""
    filename = ARK_FILENAMES.get(ticker)
    if not filename:
        raise ValueError(f"No ARK filename mapping for {ticker}")
    url = f"https://assets.ark-funds.com/fund-documents/funds-etf-csv/{filename}.csv"
    r   = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()

    reader   = csv.DictReader(io.StringIO(r.text))
    holdings = []
    for row in reader:
        sym = (row.get("ticker") or "").strip()
        if not sym or sym in {"-", "N/A", "n/a"}:
            continue
        weight_str = (row.get("weight (%)") or "0").strip().rstrip("%")
        try:
            weight_pct = float(weight_str)
        except ValueError:
            continue
        if abs(weight_pct) < 1e-9:
            continue
        name = (row.get("company") or "").strip()
        holdings.append({"asset": sym.upper(), "name": name, "weightPercentage": round(weight_pct, 6)})

    return holdings


def fetch_alphavantage(ticker: str) -> list:
    """Fetch holdings from Alpha Vantage ETF_PROFILE endpoint."""
    if not AV_KEY:
        raise ValueError("ALPHA_VANTAGE_KEY not set")
    url = (
        f"https://www.alphavantage.co/query"
        f"?function=ETF_PROFILE&symbol={ticker}&apikey={AV_KEY}"
    )
    r    = requests.get(url, timeout=30)
    r.raise_for_status()
    data = r.json()

    if "Error Message" in data:
        raise ValueError(data["Error Message"])
    if "Information" in data:
        raise ValueError(data["Information"])  # rate limit message
    if not isinstance(data.get("holdings"), list):
        raise ValueError(f"No holdings array returned for {ticker}")

    holdings = []
    for h in data["holdings"]:
        sym = (h.get("symbol") or "").strip().upper()
        if not sym or sym == "N/A":
            continue
        weight_pct = float(h.get("weight", 0)) * 100
        name       = h.get("description", "")
        holdings.append({"asset": sym, "name": name, "weightPercentage": round(weight_pct, 6)})

    return holdings


# ── Main ─────────────────────────────────────────────────────────────────────

FETCHERS = {
    "ssga":         fetch_ssga,
    "ark":          fetch_ark,
    "alphavantage": fetch_alphavantage,
}


def main():
    # Load existing cache so failed fetches keep the previous data
    if CACHE_FILE.exists():
        with open(CACHE_FILE, encoding="utf-8") as f:
            cache = json.load(f)
    else:
        cache = {"version": 1, "holdings": {}}

    now      = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    av_calls = 0
    success  = []
    failed   = []

    for ticker, provider in ETF_CONFIG.items():
        print(f"  [{provider:>13}] {ticker:<6} ... ", end="", flush=True)
        try:
            # Alpha Vantage free tier: 5 calls/min → wait 13s between calls
            if provider == "alphavantage" and av_calls > 0:
                time.sleep(13)
            if provider == "alphavantage":
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
            # keep the previous cache entry if one exists

    # Write updated cache
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)

    print(f"\n{'─'*50}")
    print(f"Updated: {len(success)}   Failed: {len(failed)}")
    if failed:
        print("Failed ETFs:")
        for t, err in failed:
            print(f"  {t}: {err}")

    # Non-zero exit only if everything failed (likely a config/network issue)
    if len(success) == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
