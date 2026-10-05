#!/usr/bin/env python3
"""
Nya börsnoteringar i USA det senaste året (Nasdaq, NYSE, NYSE American).

Hämtar listan över noteringar från Nasdaqs IPO-kalender (med stockanalysis.com som reserv),
lägger till dagens kurs från Yahoo Finance och skriver docs/data/ipos.json till appen.
Körs automatiskt varje vardagskväll av GitHub Actions.

  python ipo.py            # skriv docs/data/ipos.json
  python ipo.py --demo     # testdata, inget internet
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "docs", "data", "ipos.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
SPAC = re.compile(r"acquisition|blank check|spac|merger corp|capital corp\.? ?(i|ii|iii|iv|v|vi)\b|\bunits?\b", re.I)


def get(url: str, accept="application/json") -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9",
                                               "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def money(x):
    try:
        return float(str(x).replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def parse_date(x):
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%b %d, %Y"):
        try:
            return datetime.strptime(str(x).strip(), fmt).date()
        except ValueError:
            pass
    return None


def from_nasdaq(months: list[str]) -> tuple[list[dict], list[dict]]:
    """Nasdaqs IPO-kalender, en månad i taget."""
    priced, upcoming = [], []
    for m in months:
        d = json.loads(get(f"https://api.nasdaq.com/api/ipo/calendar?date={m}")).get("data") or {}
        for r in ((d.get("priced") or {}).get("rows") or []):
            priced.append({"t": r.get("proposedTickerSymbol"), "namn": r.get("companyName"), "börs": r.get("proposedExchange"),
                           "datum": parse_date(r.get("pricedDate")), "ipo_pris": money(r.get("proposedSharePrice")),
                           "belopp": money(r.get("dollarValueOfSharesOffered"))})
        up = (d.get("upcoming") or {}).get("upcomingTable") or {}
        for r in (up.get("rows") or []):
            upcoming.append({"t": r.get("proposedTickerSymbol"), "namn": r.get("companyName"), "börs": r.get("proposedExchange"),
                             "datum": str(parse_date(r.get("expectedPriceDate")) or r.get("expectedPriceDate") or ""),
                             "pris": r.get("proposedSharePrice"), "belopp": money(r.get("dollarValueOfSharesOffered"))})
    return priced, upcoming


def from_stockanalysis(years: list[int]) -> list[dict]:
    """Reserv: tabellerna på stockanalysis.com/ipos/ÅR/."""
    out = []
    for y in years:
        for t in pd.read_html(io.StringIO(get(f"https://stockanalysis.com/ipos/{y}/", "text/html"))):
            cols = {c.lower(): c for c in map(str, t.columns)}
            if "symbol" not in cols or "ipo date" not in cols:
                continue
            for r in t.to_dict("records"):
                out.append({"t": r[cols["symbol"]], "namn": r.get(cols.get("company name", ""), r[cols["symbol"]]),
                            "börs": None, "datum": parse_date(r[cols["ipo date"]]),
                            "ipo_pris": money(r.get(cols.get("ipo price", ""), None)), "belopp": None})
    return out


def prices(listed: dict[str, date]) -> dict:
    """Första dagens stängning, dagens kurs, högsta och lägsta sedan noteringen. listed: ticker -> noteringsdag."""
    tickers = list(listed)
    import yfinance as yf
    out = {}
    for i in range(0, len(tickers), 100):
        chunk = tickers[i:i + 100]
        df = yf.download(chunk, period="13mo", group_by="ticker", auto_adjust=False, threads=True, progress=False)
        for t in chunk:
            try:
                c = (df[t] if isinstance(df.columns, pd.MultiIndex) else df)["Close"].dropna()
            except KeyError:
                continue
            c = c[c.index.date >= listed[t]]  # tickern kan ha använts av ett annat bolag tidigare
            if len(c):
                out[t] = {"första": float(c.iloc[0]), "kurs": float(c.iloc[-1]), "högsta": float(c.max()), "lägsta": float(c.min()),
                          "första_datum": c.index[0].date().isoformat(), "spark": [round(float(x), 4) for x in c.iloc[::max(1, len(c) // 40)]]}

    def mcap(t):
        try:
            return t, float(yf.Ticker(t).fast_info["market_cap"])
        except Exception:
            return t, None
    with ThreadPoolExecutor(8) as ex:
        for t, v in ex.map(mcap, list(out)):
            out[t]["börsvärde"] = v
    return out


def demo():
    today = date.today()
    priced = [{"t": f"NY{i}", "namn": n, "börs": "NASDAQ Global Select", "datum": today - timedelta(days=20 + i * 25),
               "ipo_pris": 15.0 + i, "belopp": 2e8 + i * 5e7}
              for i, n in enumerate(["Demo Robotics Inc.", "Demo Health Corp.", "Demo Acquisition Corp II", "Demo Cloud Inc.", "Demo Energy Inc."])]
    px = {p["t"]: {"första": p["ipo_pris"] * 1.3, "kurs": p["ipo_pris"] * (0.7 + 0.3 * i), "högsta": p["ipo_pris"] * 2, "lägsta": p["ipo_pris"] * 0.6,
                   "första_datum": p["datum"].isoformat(), "spark": [p["ipo_pris"] * (1 + 0.02 * k) for k in range(20)], "börsvärde": 3e9}
          for i, p in enumerate(priced)}
    return priced, [{"t": "KOMM", "namn": "Demo Kommande Inc.", "börs": "NYSE", "datum": (today + timedelta(days=5)).isoformat(), "pris": "18.00-20.00", "belopp": 4e8}], px, "demo"


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument("--demo", action="store_true")
    a.add_argument("--out", default=OUT)
    args = a.parse_args()
    today = date.today()
    start = today - timedelta(days=365)

    if args.demo:
        priced, upcoming, px, källa = demo()
    else:
        months = [str(m) for m in pd.period_range(end=pd.Period(today, "M"), periods=13, freq="M")]
        källa, upcoming = "Nasdaq", []
        try:
            priced, upcoming = from_nasdaq(months)
            if not priced:
                raise RuntimeError("tom lista")
        except Exception as e:
            print(f"Nasdaq svarade inte ({e}). Provar stockanalysis.com …")
            källa = "stockanalysis.com"
            try:
                priced = from_stockanalysis(sorted({start.year, today.year}))
            except Exception as e2:
                print(f"FEL: Kunde inte hämta några börsnoteringar ({e2}). Den gamla listan behålls.")
                return 1
        priced = [p for p in priced if p["t"] and p["datum"] and start <= p["datum"] <= today]
        # Bara riktiga aktier på de stora börserna
        priced = [p for p in priced if re.fullmatch(r"[A-Z]{1,5}", str(p["t"]).strip()) and not re.search(r"OTC", str(p["börs"] or ""), re.I)]
        seen, uniq = set(), []
        for p in sorted(priced, key=lambda p: p["datum"], reverse=True):
            if p["t"] not in seen:
                seen.add(p["t"])
                uniq.append(p)
        priced = uniq
        print(f"{len(priced)} noteringar sedan {start} (källa: {källa})")
        px = prices({p["t"]: p["datum"] for p in priced})

    rows = []
    for p in priced:
        q = px.get(p["t"])
        if not q:
            continue  # handlas inte (ännu) eller har bytt namn
        ipo = p["ipo_pris"] if p["ipo_pris"] and p["ipo_pris"] > 0 else None
        rows.append({
            "t": p["t"], "namn": p["namn"], "börs": p["börs"], "datum": p["datum"].isoformat(),
            "dagar": (today - p["datum"]).days, "ipo_pris": ipo, "belopp": p["belopp"],
            "första_stängning": q["första"], "kurs": q["kurs"], "börsvärde": q.get("börsvärde"),
            "sedan_ipo": q["kurs"] / ipo - 1 if ipo else None,
            "första_dagen": q["första"] / ipo - 1 if ipo else None,
            "sedan_första_dagen": q["kurs"] / q["första"] - 1,
            "från_högsta": q["kurs"] / q["högsta"] - 1, "spark": q["spark"],
            "spac": bool(SPAC.search(str(p["namn"] or ""))),
        })
    out = {"uppdaterad": datetime.now().strftime("%Y-%m-%d %H:%M"), "från": start.isoformat(), "källa": källa,
           "noteringar": rows, "kommande": upcoming[:30]}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print(f"Skrev {len(rows)} noteringar och {len(out['kommande'])} kommande till {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
