#!/usr/bin/env python3
"""
Aktieagent - en AI-agent som analyserar aktier.

Vad den gör:
  1. Hämtar data (kurs, nyckeltal, rapporter, nyheter) från Yahoo Finance.
  2. Räknar ut nyckeltal och ger en poäng 0-100 i fem områden.
  3. Låter Claude (AI) undersöka datan med verktyg och skriva en bedömning.
  4. Sparar en HTML-rapport med graf.

Användning:
  python aktieagent.py NVDA                  # en aktie
  python aktieagent.py NVDA BE RXRX          # flera aktier
  python aktieagent.py NVDA --no-ai          # bara regelbaserad poäng
  python aktieagent.py NVDA --demo           # testdata, inget internet

Inte finansiell rådgivning. Agenten är ett verktyg för egen analys.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import sys
import zlib
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd

MODEL = os.environ.get("AKTIEAGENT_MODEL", "claude-opus-5-5")
AI_DISABLED = False


# ---------------------------------------------------------------------------
# 1. DATA
# ---------------------------------------------------------------------------

@dataclass
class StockData:
    ticker: str
    info: dict
    history: pd.DataFrame          # kolumner: Open, High, Low, Close, Volume
    income: pd.DataFrame | None    # årlig resultaträkning (rader = poster, kolumner = år)
    cashflow: pd.DataFrame | None
    news: list[dict] = field(default_factory=list)


def fetch_live(ticker: str) -> StockData:
    import yfinance as yf

    t = yf.Ticker(ticker)
    hist = t.history(period="2y", auto_adjust=True)
    if hist.empty:
        raise ValueError(f"Hittade ingen kursdata för {ticker}. Stämmer tickern?")
    info = t.info or {}

    def safe(fn):
        try:
            df = fn()
            return df if df is not None and not df.empty else None
        except Exception:
            return None

    news = []
    try:
        for n in (t.news or [])[:10]:
            c = n.get("content", n)
            news.append({
                "titel": c.get("title", ""),
                "källa": (c.get("provider") or {}).get("displayName", c.get("publisher", "")),
                "datum": c.get("pubDate", ""),
            })
    except Exception:
        pass

    return StockData(ticker.upper(), info, hist, safe(lambda: t.income_stmt),
                     safe(lambda: t.cashflow), news)


def fetch_demo(ticker: str) -> StockData:
    """Syntetisk data så att man kan testa utan internet."""
    rng = np.random.default_rng(zlib.crc32(ticker.encode()))
    days = pd.bdate_range(end=datetime.today(), periods=500)
    drift = rng.uniform(-0.0003, 0.0012)
    vol = rng.uniform(0.015, 0.04)
    close = 50 * np.exp(np.cumsum(rng.normal(drift, vol, len(days))))
    hist = pd.DataFrame({"Open": close, "High": close * 1.01, "Low": close * 0.99,
                         "Close": close, "Volume": rng.integers(1e6, 5e7, len(days))},
                        index=days)
    rev = np.array([800, 1000, 1300, 1600]) * rng.uniform(0.5, 2)
    years = pd.to_datetime(["2022-12-31", "2023-12-31", "2024-12-31", "2025-12-31"])[::-1]
    income = pd.DataFrame({y: {"Total Revenue": r * 1e6, "Net Income": r * 0.15e6,
                               "Gross Profit": r * 0.55e6}
                           for y, r in zip(years, rev[::-1])})
    cashflow = pd.DataFrame({y: {"Free Cash Flow": r * 0.12e6} for y, r in zip(years, rev[::-1])})
    info = {
        "longName": f"{ticker} Demo Inc", "sector": "Technology", "industry": "Software",
        "currentPrice": float(close[-1]), "marketCap": float(close[-1]) * 2e8,
        "trailingPE": rng.uniform(10, 60), "forwardPE": rng.uniform(8, 45),
        "priceToSalesTrailing12Months": rng.uniform(1, 15), "pegRatio": rng.uniform(0.6, 3),
        "enterpriseToEbitda": rng.uniform(6, 35),
        "revenueGrowth": rng.uniform(-0.05, 0.5), "earningsGrowth": rng.uniform(-0.2, 0.6),
        "grossMargins": rng.uniform(0.2, 0.8), "operatingMargins": rng.uniform(-0.1, 0.4),
        "profitMargins": rng.uniform(-0.1, 0.3), "returnOnEquity": rng.uniform(-0.05, 0.4),
        "debtToEquity": rng.uniform(0, 150), "currentRatio": rng.uniform(0.8, 3.5),
        "totalCash": 3e9, "totalDebt": 2e9, "freeCashflow": rng.uniform(-2e8, 2e9),
        "targetMeanPrice": float(close[-1]) * rng.uniform(0.8, 1.4),
        "recommendationKey": "buy", "numberOfAnalystOpinions": 20, "beta": rng.uniform(0.7, 2.2),
        "shortPercentOfFloat": rng.uniform(0.01, 0.15),
    }
    news = [{"titel": "Demo: bolaget höjer prognosen", "källa": "Demo", "datum": "2026-09-30"}]
    return StockData(ticker.upper(), info, hist, income, cashflow, news)


# ---------------------------------------------------------------------------
# 2. ANALYS - nyckeltal och poäng
# ---------------------------------------------------------------------------

def _num(x):
    try:
        x = float(x)
        return None if math.isnan(x) or math.isinf(x) else x
    except (TypeError, ValueError):
        return None


def technicals(hist: pd.DataFrame) -> dict:
    c = hist["Close"]
    ret = c.pct_change().dropna()
    delta = c.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rsi = 100 - 100 / (1 + gain / loss)
    peak = c.cummax()
    last = c.iloc[-1]

    def change(days):
        return float(last / c.iloc[-days - 1] - 1) if len(c) > days else None

    return {
        "kurs": float(last),
        "förändring_1m": change(21), "förändring_6m": change(126), "förändring_1år": change(252),
        "sma50": float(c.rolling(50).mean().iloc[-1]),
        "sma200": float(c.rolling(200).mean().iloc[-1]) if len(c) >= 200 else None,
        "rsi14": float(rsi.iloc[-1]),
        "volatilitet_årlig": float(ret.std() * np.sqrt(252)),
        "max_drawdown_2år": float((c / peak - 1).min()),
        "från_52v_högsta": float(last / c.iloc[-252:].max() - 1),
        "sharpe_1år": float(ret.iloc[-252:].mean() / ret.iloc[-252:].std() * np.sqrt(252)),
    }


def fundamentals(d: StockData) -> dict:
    i = d.info
    out = {
        "namn": i.get("longName") or i.get("shortName") or d.ticker,
        "sektor": i.get("sector"), "bransch": i.get("industry"),
        "börsvärde": _num(i.get("marketCap")),
        "pe": _num(i.get("trailingPE")), "forward_pe": _num(i.get("forwardPE")),
        "peg": _num(i.get("pegRatio") or i.get("trailingPegRatio")),
        "ps": _num(i.get("priceToSalesTrailing12Months")),
        "ev_ebitda": _num(i.get("enterpriseToEbitda")),
        "omsättningstillväxt": _num(i.get("revenueGrowth")),
        "vinsttillväxt": _num(i.get("earningsGrowth")),
        "bruttomarginal": _num(i.get("grossMargins")),
        "rörelsemarginal": _num(i.get("operatingMargins")),
        "vinstmarginal": _num(i.get("profitMargins")),
        "roe": _num(i.get("returnOnEquity")),
        "skuld_eget_kapital": _num(i.get("debtToEquity")),
        "current_ratio": _num(i.get("currentRatio")),
        "kassa": _num(i.get("totalCash")), "skuld": _num(i.get("totalDebt")),
        "fritt_kassaflöde": _num(i.get("freeCashflow")),
        "beta": _num(i.get("beta")),
        "blankning_andel": _num(i.get("shortPercentOfFloat")),
        "analytiker_riktkurs": _num(i.get("targetMeanPrice")),
        "analytiker_råd": i.get("recommendationKey"),
        "antal_analytiker": i.get("numberOfAnalystOpinions"),
    }
    # Omsättning per år och genomsnittlig tillväxt (CAGR)
    if d.income is not None and "Total Revenue" in d.income.index:
        rev = d.income.loc["Total Revenue"].dropna().sort_index()
        out["omsättning_per_år"] = {str(k.year): float(v) for k, v in rev.items()}
        if len(rev) >= 2 and rev.iloc[0] > 0:
            n = len(rev) - 1
            out["omsättning_cagr"] = float((rev.iloc[-1] / rev.iloc[0]) ** (1 / n) - 1)
    return out


def _score(value, good, bad):
    """Linjär poäng 0-10. good = värde som ger 10, bad = värde som ger 0."""
    if value is None:
        return None
    s = (value - bad) / (good - bad) * 10
    return max(0.0, min(10.0, s))


def score(f: dict, t: dict) -> dict:
    """Fem områden, 0-10 vardera. Totalt 0-100."""
    def avg(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    upside = None
    if f.get("analytiker_riktkurs") and t["kurs"]:
        upside = f["analytiker_riktkurs"] / t["kurs"] - 1

    areas = {
        "Värdering": avg([
            _score(f["forward_pe"], 12, 60) if f["forward_pe"] and f["forward_pe"] > 0 else 0 if f["forward_pe"] else None,
            _score(f["peg"], 0.8, 3.0),
            _score(f["ps"], 2, 20),
            _score(f["ev_ebitda"], 8, 40),
            _score(upside, 0.30, -0.15),
        ]),
        "Tillväxt": avg([
            _score(f["omsättningstillväxt"], 0.30, -0.05),
            _score(f["vinsttillväxt"], 0.30, -0.20),
            _score(f.get("omsättning_cagr"), 0.30, 0.0),
        ]),
        "Lönsamhet": avg([
            _score(f["bruttomarginal"], 0.65, 0.15),
            _score(f["rörelsemarginal"], 0.25, -0.10),
            _score(f["roe"], 0.25, -0.05),
            _score((f["fritt_kassaflöde"] or 0) / f["börsvärde"], 0.05, -0.03)
            if f["fritt_kassaflöde"] is not None and f["börsvärde"] else None,
        ]),
        "Finansiell styrka": avg([
            _score(f["skuld_eget_kapital"], 10, 200),
            _score(f["current_ratio"], 2.5, 0.8),
            _score((f["kassa"] or 0) / f["skuld"], 1.5, 0.2) if f["skuld"] else (10.0 if f["kassa"] else None),
        ]),
        "Trend & risk": avg([
            _score(t["kurs"] / t["sma200"] - 1, 0.15, -0.15) if t["sma200"] else None,
            _score(t["förändring_6m"], 0.30, -0.25),
            _score(-abs(t["rsi14"] - 55), 0, -30),          # bäst runt 55, sämst vid extremer
            _score(t["volatilitet_årlig"], 0.20, 0.80),
            _score(t["max_drawdown_2år"], -0.15, -0.70),
        ]),
    }
    weights = {"Värdering": 0.25, "Tillväxt": 0.25, "Lönsamhet": 0.2,
               "Finansiell styrka": 0.15, "Trend & risk": 0.15}
    have = {k: v for k, v in areas.items() if v is not None}
    total = sum(have[k] * weights[k] for k in have) / sum(weights[k] for k in have) * 10 if have else 0
    verdict = "Köpvärd" if total >= 65 else "Avvakta / bevaka" if total >= 45 else "Undvik just nu"
    return {"områden": {k: (round(v, 1) if v is not None else None) for k, v in areas.items()},
            "total": round(total), "bedömning": verdict,
            "uppsida_mot_riktkurs": upside,
            "datatäckning": f"{len(have)}/5 områden"}


# ---------------------------------------------------------------------------
# 3. AI-AGENTEN - Claude undersöker datan med verktyg
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """Du är en noggrann aktieanalytiker. Du skriver på svenska.
Använd verktygen för att undersöka aktien. Titta på värdering, tillväxt, lönsamhet,
balansräkning, kurstrend, risk och nyheter. Jämför värderingen med tillväxten.
Var ärlig om osäkerhet och om data saknas. Hitta inte på siffror.
Skriv i korta, enkla meningar. Avsluta ALLTID genom att anropa submit_verdict.
Detta är underlag för egen analys, inte finansiell rådgivning."""

TOOLS = [
    {"name": "get_overview", "description": "Bolagets namn, sektor, börsvärde och aktuell kurs.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_fundamentals", "description": "Värdering (P/E, PEG, P/S, EV/EBITDA), tillväxt, marginaler, ROE, skuld, kassaflöde, analytikers riktkurs.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_technicals", "description": "Kursutveckling, glidande medelvärden, RSI, volatilitet, max drawdown, Sharpe.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_news", "description": "De senaste nyhetsrubrikerna om bolaget.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_rule_score", "description": "Regelbaserad poäng 0-100 per område. Använd som en av flera signaler, inte som facit.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "submit_verdict", "description": "Lämna din slutliga bedömning. Anropas sist.",
     "input_schema": {
         "type": "object",
         "properties": {
             "betyg": {"type": "string", "enum": ["Köpvärd", "Avvakta / bevaka", "Undvik just nu"]},
             "sakerhet": {"type": "string", "enum": ["Låg", "Medel", "Hög"],
                          "description": "Hur säker bedömningen är, givet datan."},
             "sammanfattning": {"type": "string", "description": "2-4 korta meningar."},
             "styrkor": {"type": "array", "items": {"type": "string"}},
             "risker": {"type": "array", "items": {"type": "string"}},
             "vardering_kommentar": {"type": "string", "description": "Är aktien dyr eller billig i förhållande till tillväxten? Varför?"},
             "att_bevaka": {"type": "array", "items": {"type": "string"},
                            "description": "Vad som skulle ändra bedömningen."},
         },
         "required": ["betyg", "sakerhet", "sammanfattning", "styrkor", "risker",
                      "vardering_kommentar", "att_bevaka"],
     }},
]


def run_ai_agent(d: StockData, f: dict, t: dict, s: dict, verbose=True) -> dict | None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("  (Ingen ANTHROPIC_API_KEY satt - hoppar över AI-delen.)")
        return None
    import anthropic

    client = anthropic.Anthropic()
    handlers = {
        "get_overview": lambda: {k: f[k] for k in ("namn", "sektor", "bransch", "börsvärde")} | {"kurs": t["kurs"]},
        "get_fundamentals": lambda: f,
        "get_technicals": lambda: t,
        "get_news": lambda: d.news or [{"info": "Inga nyheter hittades."}],
        "get_rule_score": lambda: s,
    }
    messages = [{"role": "user", "content": f"Analysera aktien {d.ticker}. Är den en bra investering just nu?"}]

    for _ in range(10):  # max antal varv i agent-loopen
        resp = client.messages.create(model=MODEL, max_tokens=4000, system=SYSTEM_PROMPT,
                                      tools=TOOLS, messages=messages)
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            if verbose:
                print(f"  -> agenten anropar {block.name}")
            if block.name == "submit_verdict":
                # API:t tillåter bara a-z i fältnamn, så å/ä/ö läggs tillbaka här
                v = dict(block.input)
                return {"betyg": v.get("betyg", s["bedömning"]),
                        "säkerhet": v.get("sakerhet", "Låg"),
                        "sammanfattning": v.get("sammanfattning", ""),
                        "styrkor": v.get("styrkor", []), "risker": v.get("risker", []),
                        "värdering_kommentar": v.get("vardering_kommentar", ""),
                        "att_bevaka": v.get("att_bevaka", [])}
            data = handlers[block.name]()
            results.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": json.dumps(data, ensure_ascii=False, default=str)})
        if not results:
            messages.append({"role": "user", "content": "Avsluta nu med submit_verdict."})
        else:
            messages.append({"role": "user", "content": results})
    return None


# ---------------------------------------------------------------------------
# 4. RAPPORT
# ---------------------------------------------------------------------------

def pct(x):
    return "–" if x is None else f"{x * 100:+.1f} %"


def fmt(x, d=1):
    if x is None:
        return "–"
    if abs(x) >= 1e9:
        return f"{x / 1e9:.1f} mdr"
    if abs(x) >= 1e6:
        return f"{x / 1e6:.0f} mn"
    return f"{x:.{d}f}"


def chart_png(d: StockData) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    c = d.history["Close"]
    fig, ax = plt.subplots(figsize=(9, 3.6), dpi=110)
    ax.plot(c.index, c, color="#1f4e79", lw=1.6, label="Kurs")
    ax.plot(c.index, c.rolling(50).mean(), color="#e08a1e", lw=1.1, label="SMA 50")
    ax.plot(c.index, c.rolling(200).mean(), color="#8a8a8a", lw=1.1, ls="--", label="SMA 200")
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(alpha=0.25)
    ax.legend(frameon=False, loc="upper left", fontsize=9)
    ax.set_title(f"{d.ticker} – 2 år", loc="left", fontsize=11)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def html_report(results: list[dict]) -> str:
    colors = {"Köpvärd": "#1a7f37", "Avvakta / bevaka": "#b7791f", "Undvik just nu": "#c0392b"}
    cards = []
    for r in results:
        f, t, s, ai = r["f"], r["t"], r["s"], r["ai"]
        verdict = ai["betyg"] if ai else s["bedömning"]
        bars = "".join(
            f'<div class="bar"><span>{k}</span><div class="track"><div class="fill" '
            f'style="width:{(v or 0) * 10}%"></div></div><b>{"–" if v is None else v}</b></div>'
            for k, v in s["områden"].items())
        rows = [
            ("Kurs", fmt(t["kurs"], 2)), ("Börsvärde", fmt(f["börsvärde"])),
            ("P/E / Forward P/E", f'{fmt(f["pe"])} / {fmt(f["forward_pe"])}'),
            ("PEG", fmt(f["peg"], 2)), ("P/S", fmt(f["ps"])), ("EV/EBITDA", fmt(f["ev_ebitda"])),
            ("Omsättningstillväxt", pct(f["omsättningstillväxt"])),
            ("Bruttomarginal", pct(f["bruttomarginal"])), ("Rörelsemarginal", pct(f["rörelsemarginal"])),
            ("ROE", pct(f["roe"])), ("Skuld / eget kapital", fmt(f["skuld_eget_kapital"])),
            ("Fritt kassaflöde", fmt(f["fritt_kassaflöde"])),
            ("Kurs 6 mån / 1 år", f'{pct(t["förändring_6m"])} / {pct(t["förändring_1år"])}'),
            ("RSI (14)", fmt(t["rsi14"])), ("Volatilitet (år)", pct(t["volatilitet_årlig"])),
            ("Max drawdown (2 år)", pct(t["max_drawdown_2år"])),
            ("Uppsida mot riktkurs", pct(s["uppsida_mot_riktkurs"])),
        ]
        table = "".join(f"<tr><td>{a}</td><td>{b}</td></tr>" for a, b in rows)
        ai_html = ""
        if ai:
            li = lambda xs: "".join(f"<li>{x}</li>" for x in xs)
            ai_html = (f'<h3>AI-agentens bedömning <small>säkerhet: {ai["säkerhet"]}</small></h3>'
                       f'<p>{ai["sammanfattning"]}</p><p><b>Värdering:</b> {ai["värdering_kommentar"]}</p>'
                       f'<div class="cols"><div><h4>Styrkor</h4><ul>{li(ai["styrkor"])}</ul></div>'
                       f'<div><h4>Risker</h4><ul>{li(ai["risker"])}</ul></div></div>'
                       f'<h4>Att bevaka</h4><ul>{li(ai["att_bevaka"])}</ul>')
        cards.append(f"""
<section class="card" id="{r['d'].ticker}">
  <header><div><h2>{r['d'].ticker}</h2><p class="muted">{f['namn']} · {f['sektor'] or ''}</p></div>
  <div class="verdict" style="background:{colors[verdict]}">{verdict}<small>{s['total']}/100</small></div></header>
  <img src="data:image/png;base64,{chart_png(r['d'])}" alt="Kursgraf">
  <div class="cols"><div><h3>Poäng per område</h3>{bars}</div>
  <div><h3>Nyckeltal</h3><table>{table}</table></div></div>
  {ai_html}
</section>""")
    return f"""<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Aktieanalys</title>
<style>
body{{font-family:system-ui,sans-serif;background:#f4f5f7;color:#1c1e21;margin:0;padding:16px}}
main{{max-width:980px;margin:auto}} .card{{background:#fff;border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 1px 3px #0001}}
header{{display:flex;justify-content:space-between;align-items:center;gap:12px}} h2{{margin:0}}
.muted{{color:#666;margin:4px 0}} img{{width:100%;margin:12px 0}}
.verdict{{color:#fff;padding:10px 16px;border-radius:10px;font-weight:600;text-align:center}}
.verdict small{{display:block;font-weight:400;opacity:.9}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:24px}} @media(max-width:700px){{.cols{{grid-template-columns:1fr}}}}
.bar{{display:grid;grid-template-columns:130px 1fr 32px;align-items:center;gap:8px;margin:6px 0;font-size:14px}}
.track{{background:#e6e8eb;border-radius:6px;height:10px}} .fill{{background:#1f4e79;height:10px;border-radius:6px}}
table{{width:100%;border-collapse:collapse;font-size:14px}} td{{padding:4px 0;border-bottom:1px solid #eee}} td:last-child{{text-align:right}}
.note{{font-size:12px;color:#777}}
</style></head><body><main>
<h1>Aktieanalys</h1><p class="note">Skapad {datetime.now():%Y-%m-%d %H:%M}. Underlag för egen analys – inte finansiell rådgivning.</p>
{''.join(cards)}</main></body></html>"""


# ---------------------------------------------------------------------------
# 5. KÖR
# ---------------------------------------------------------------------------

def analyze(ticker: str, demo: bool, use_ai: bool) -> dict:
    print(f"\n=== {ticker.upper()} ===")
    d = fetch_demo(ticker) if demo else fetch_live(ticker)
    f, t = fundamentals(d), technicals(d.history)
    s = score(f, t)
    print(f"  Regelpoäng: {s['total']}/100 -> {s['bedömning']}")
    for k, v in s["områden"].items():
        print(f"    {k:<18} {'–' if v is None else v}")
    ai = None
    global AI_DISABLED
    if use_ai and not AI_DISABLED:
        try:
            ai = run_ai_agent(d, f, t, s)
        except Exception as e:
            # T.ex. slut på krediter eller fel nyckel: fortsätt med bara regelpoängen
            msg = str(e)
            if "credit" in msg.lower() or "balance" in msg.lower():
                print("  AI-delen stoppad: krediterna är slut. Fyll på i console.anthropic.com.")
            else:
                print(f"  AI-delen misslyckades ({type(e).__name__}): {msg[:200]}")
            AI_DISABLED = True  # försök inte igen för resten av aktierna i denna körning
    if ai:
        print(f"  AI-bedömning: {ai['betyg']} (säkerhet: {ai['säkerhet']})")
        print(f"  {ai['sammanfattning']}")
    return {"d": d, "f": f, "t": t, "s": s, "ai": ai}


def main():
    p = argparse.ArgumentParser(description="AI-agent för aktieanalys")
    p.add_argument("tickers", nargs="*", help="T.ex. NVDA BE RXRX")
    p.add_argument("--file", help="Läs tickers från en fil, t.ex. bevakningslista.txt")
    p.add_argument("--out-dir", help="Spara rapporten i denna mapp med dagens datum i namnet")
    p.add_argument("--no-ai", action="store_true", help="Hoppa över Claude, bara regelpoäng")
    p.add_argument("--demo", action="store_true", help="Använd testdata (inget internet)")
    p.add_argument("--out", default="aktieanalys.html", help="Filnamn för rapporten")
    a = p.parse_args()
    if a.file:
        with open(a.file, encoding="utf-8") as fh:
            a.tickers += [x.split("#")[0].strip().upper() for x in fh if x.split("#")[0].strip()]
    if not a.tickers:
        p.error("Ange minst en ticker eller --file")
    if a.out_dir:
        os.makedirs(a.out_dir, exist_ok=True)
        a.out = os.path.join(a.out_dir, f"bevakning_{datetime.now():%Y-%m-%d}.html")

    results = []
    for tk in a.tickers:
        try:
            results.append(analyze(tk, a.demo, not a.no_ai))
        except Exception as e:
            print(f"  Fel för {tk}: {e}")
    if not results:
        print("\nFEL: Ingen aktie kunde analyseras. Troligen svarar inte Yahoo Finance just nu.")
        return 1
    if results:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(html_report(results))
        if a.out_dir:  # kort sammanfattning som mobilappen visar
            summary = [{"ticker": r["d"].ticker, "namn": r["f"]["namn"], "kurs": r["t"]["kurs"],
                        "poäng": r["s"]["total"],
                        "betyg": r["ai"]["betyg"] if r["ai"] else r["s"]["bedömning"],
                        "säkerhet": r["ai"]["säkerhet"] if r["ai"] else None,
                        "sammanfattning": r["ai"]["sammanfattning"] if r["ai"] else None,
                        "förändring_1m": r["t"]["förändring_1m"]} for r in results]
            with open(a.out.replace(".html", ".json"), "w", encoding="utf-8") as fh:
                json.dump(summary, fh, ensure_ascii=False, indent=1)
        print(f"\nRapport sparad: {os.path.abspath(a.out)}")


if __name__ == "__main__":
    sys.exit(main())
