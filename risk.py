#!/usr/bin/env python3
"""
Risklistan: alla amerikanska aktier indelade i risknivå 1–10, plus nivå 0 (statspapper).

  Nivå 0      Amerikanska statspapper (räntefonder med 1–3 månaders statsskuldväxlar). Inte aktier.
  Nivå 1–10   Aktier. Grunden är hur mycket aktien svänger på ett år, sedan justeras den för
              förluster, stora ras, hög skuld, litet bolag och lugna lönsamma bolag
              (samma regel som aktiesidan i appen: modell.risk_level).

Inom varje nivå sorteras aktierna efter förväntad avkastning per år (3 år) och kvalitet.
Ingen AI används – körningen är gratis. Skriver docs/data/risk.json. Körs en gång i månaden.

  python risk.py           # alla aktier i USA
  python risk.py --demo    # testdata, inget internet
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import numpy as np
import pandas as pd

import aktieagent as A
import modell
import screener as S

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "docs", "data", "risk.json")
STATSPAPPER = ["SGOV", "BIL", "SHV", "USFR", "TFLO"]
MIN_MCAP = 3e8


def num(x):
    try:
        x = float(x)
        return None if np.isnan(x) or np.isinf(x) else x
    except (TypeError, ValueError):
        return None


def history(tickers: list[str], demo: bool) -> dict[str, pd.DataFrame]:
    """Stängningskurser 2 år bakåt, för många aktier åt gången."""
    if demo:
        return {t: A.fetch_demo(t).history for t in tickers}
    import yfinance as yf
    out = {}
    for i in range(0, len(tickers), 250):
        chunk = tickers[i:i + 250]
        print(f"  kurser {i + len(chunk)}/{len(tickers)}", end="\r", flush=True)
        df = yf.download(chunk, period="2y", group_by="ticker", auto_adjust=True, threads=True, progress=False)
        for t in chunk:
            try:
                h = (df[t] if isinstance(df.columns, pd.MultiIndex) else df).dropna(subset=["Close"])
            except KeyError:
                continue
            if len(h) >= 200 and float(h["Close"].iloc[-1]) >= 2 and float((h["Close"] * h["Volume"]).iloc[-60:].median()) >= 3e6:
                out[t] = h
    print()
    return out


def stats(close: pd.Series) -> dict:
    """Samma mått som servern: volatilitet senaste året, största raset senaste 2 åren."""
    c = close.dropna()
    r = c.pct_change().dropna().iloc[-252:]
    two = c.iloc[-504:]
    return {"vol": float(r.std(ddof=0) * np.sqrt(252)), "dd": float((two / two.cummax() - 1).min())}


def one(t: str, h: pd.DataFrame, demo: bool) -> dict | None:
    info = S.get_info(t, demo)
    if not info or info.get("quoteType") not in (None, "EQUITY"):
        return None
    mcap = num(info.get("marketCap"))
    if not mcap or mcap < MIN_MCAP:
        return None
    name = info.get("longName") or info.get("shortName") or t
    if "acquisition corp" in name.lower():
        return None
    st = stats(h["Close"])
    pm = num(info.get("profitMargins"))
    loss = pm is not None and pm < 0
    lvl = modell.risk_level(st["vol"], st["dd"], num(info.get("beta")), loss, num(info.get("debtToEquity")), mcap, info.get("sector"))
    if lvl is None:
        return None
    # Förväntad avkastning (samma modell som appen) och kvalitetspoäng
    d = A.StockData(t, info, h.iloc[-504:], None, None)
    f, tech = A.fundamentals(d), A.technicals(d.history)
    er1 = S.expected_return(f, tech, {})["förväntad"]
    price = float(h["Close"].iloc[-1])
    hz = modell.horizons({
        "eps_nästa_år": num(info.get("forwardEps")), "forward_pe": f.get("forward_pe"),
        "omsättningstillväxt": f.get("omsättningstillväxt"), "vinsttillväxt": f.get("vinsttillväxt"),
        "ps": f.get("ps"), "bruttomarginal": f.get("bruttomarginal"), "roe": f.get("roe"),
        "rörelsemarginal": f.get("rörelsemarginal"), "utdelning": num(info.get("trailingAnnualDividendYield")),
    }, price, er1)
    r = lambda x, n=4: None if x is None else round(x, n)
    return {"t": t, "n": name[:60], "s": info.get("sector") or "–", "r": lvl, "v": r(st["vol"]), "dd": r(st["dd"]),
            "b": r(num(info.get("beta")), 2), "mc": mcap, "f": loss, "p": r(price, 2),
            "a3": r(hz.get(3)), "q": A.score(f, tech)["total"], "u": r(num(info.get("trailingAnnualDividendYield")))}


def treasuries(demo: bool) -> list[dict]:
    """Statspapper: räntan räknas som utdelningarna senaste 12 månaderna delat med kursen."""
    rows = []
    for t in STATSPAPPER:
        name, y = f"{t} Treasury Bill ETF", 0.041
        if not demo:
            try:
                import yfinance as yf
                tk = yf.Ticker(t)
                info = S.get_info(t, demo) or {}
                name = info.get("longName") or info.get("shortName") or t
                div = tk.dividends
                price = float(tk.history(period="5d")["Close"].iloc[-1])
                if len(div):
                    idx = div.index.tz_localize(None) if getattr(div.index, "tz", None) is not None else div.index
                    last = div[idx >= pd.Timestamp.now() - pd.Timedelta(days=365)]
                    y = float(last.sum()) / price if price else None
                else:
                    y = None
            except Exception as e:
                print(f"  {t}: {e}")
                y = None
        rows.append({"t": t, "n": str(name)[:60], "s": "Statspapper", "r": 0, "ränta": None if y is None else round(y, 4)})
    return rows


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument("--demo", action="store_true")
    a.add_argument("--out", default=OUT)
    a.add_argument("--workers", type=int, default=8)
    args = a.parse_args()

    tickers = S.universe("all", args.demo, None)
    print(f"Steg 1: {len(tickers)} aktier i USA")
    hists = history(tickers, args.demo)
    print(f"  {len(hists)} med tillräcklig handel")
    rows = []
    with ThreadPoolExecutor(args.workers) as ex:
        for i, row in enumerate(ex.map(lambda t: _safe(one, t, hists[t], args.demo), list(hists)), 1):
            if i % 100 == 0:
                print(f"  nyckeltal {i}/{len(hists)}", end="\r", flush=True)
            if row:
                rows.append(row)
    print(f"\nSteg 2: {len(rows)} aktier med risknivå")
    if not rows:
        print("::error::Inga aktier kunde räknas. Svarar Yahoo Finance? Den gamla listan behålls.")
        return 1
    # Poäng för sorteringen "bäst först": 60 % förväntad avkastning, 40 % kvalitet (som percentiler)
    df = pd.DataFrame(rows)
    df["x"] = (df["a3"].rank(pct=True).fillna(0) * 0.6 + df["q"].rank(pct=True).fillna(0) * 0.4).round(4)
    rows = df.sort_values("x", ascending=False).replace({np.nan: None}).to_dict("records")
    per = {str(k): int(v) for k, v in df["r"].value_counts().sort_index().items()}
    print("  per nivå:", per)
    out = {"uppdaterad": datetime.now().strftime("%Y-%m-%d"), "antal": len(rows), "per_nivå": per,
           "statspapper": treasuries(args.demo), "aktier": rows}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Skrev {len(rows)} aktier till {args.out} ({os.path.getsize(args.out) // 1024} kB)")
    return 0


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
