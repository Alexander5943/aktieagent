#!/usr/bin/env python3
"""
Framtidsaktier - amerikanska bolag som ännu inte är lönsamma, men har idéer som löser
framtidens problem och en tydlig plan för att nå dit. Topp 50, uppdateras var 3:e månad.

Tre steg:
  1. Gratis:  Går igenom alla aktier på Nasdaq, NYSE och NYSE American. Behåller olönsamma
              bolag med börsvärde över 300 mn USD och tillräcklig handel.
  2. Gratis:  Räknar "genomförandekraft" ur siffrorna: tillväxt, hur länge kassan räcker,
              bruttomarginal, ägande hos ledningen och analytikernas tillväxtprognos.
              De ~150 mest lovande (med spridning mellan branscher) går vidare.
  3. AI:      Claude bedömer varje bolags idé, hur stort framtidsproblem den löser och hur
              målmedvetet bolaget är. Ungefär 8 anrop utan webbsökning, cirka 10 kr per körning.

  python framtid.py            # skriver docs/data/framtid.json
  python framtid.py --demo     # testdata, inget internet och ingen AI
Inte finansiell rådgivning.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import numpy as np
import pandas as pd

import aktieagent as A
import screener as S

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "docs", "data", "framtid.json")
MODEL = os.environ.get("AKTIEAGENT_MODEL", "claude-opus-5-5")
TOP = 50
AI_CANDIDATES = 150
BATCH = 20

# Teman och ord i bolagets beskrivning som pekar på dem (används bara för att välja kandidater)
THEMES = {
    "AI och data": ["artificial intelligence", " ai ", "ai-", "machine learning", "large language", "data center", "inference", "gpu"],
    "Energi": ["nuclear", "fusion", "fission", "small modular reactor", "solar", "hydrogen", "fuel cell", "battery", "energy storage", "geothermal", "grid", "wind"],
    "Klimat": ["carbon capture", "decarbon", "emission", "climate", "sustainable", "recycl", "water purification", "lithium"],
    "Hälsa": ["gene", "genom", "crispr", "cell therapy", "mrna", "oncology", "cancer", "rare disease", "precision medicine", "diagnostic", "obesity", "alzheimer", "longevity", "antibod", "vaccine"],
    "Rymd": ["space", "satellite", "launch vehicle", "orbit", "lunar"],
    "Robotik": ["robot", "autonomous", "automation", "drone", "humanoid", "lidar", "evtol", "air mobility"],
    "Kvantdatorer": ["quantum"],
    "Säkerhet": ["cybersecurity", "cyber security", "defense", "zero trust", "identity security"],
    "Transport": ["electric vehicle", "ev charging", "autonomous driving", "electric aircraft", "self-driving"],
    "Chip": ["semiconductor", "photonic", "silicon carbide", "chip design"],
}
TEMAN = list(THEMES) + ["Annat"]
EXCLUDE_INDUSTRY = re.compile(r"shell compan|reit|bank|insurance|asset management|mortgage|oil & gas|tobacco|gambling", re.I)
SPAC = re.compile(r"acquisition corp|blank check|merger corp", re.I)


def num(x):
    return A._num(x)


GH = bool(os.environ.get("GITHUB_ACTIONS"))


def fel(msg):
    """Felmeddelande som syns direkt på körningens sida i GitHub."""
    print(f"::error::{msg}" if GH else f"FEL: {msg}", flush=True)


def info_note(msg):
    print(f"::notice::{msg}" if GH else msg, flush=True)


def lin(v, good, bad):
    if v is None:
        return None
    return max(0.0, min(10.0, (v - bad) / (good - bad) * 10))


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def theme_hits(text: str) -> tuple[str, int]:
    t = " " + (text or "").lower() + " "
    best, hits = "Annat", 0
    for tema, words in THEMES.items():
        n = sum(1 for w in words if w in t)
        if n > hits:
            best, hits = tema, n
    return best, hits


# ---------------------------------------------------------------------------
# 1–2. Kandidater och siffror
# ---------------------------------------------------------------------------

def liquid(tickers, demo, min_dollar_vol=3e6, min_price=2.0):
    """Snabbfilter på kurs och handel, med 3 månaders kurser."""
    if demo:
        return {t: A.fetch_demo(t).history for t in tickers}
    import yfinance as yf
    out = {}
    for i in range(0, len(tickers), 250):
        chunk = tickers[i:i + 250]
        print(f"  kurser {i + len(chunk)}/{len(tickers)}", end="\r", flush=True)
        df = yf.download(chunk, period="3mo", group_by="ticker", auto_adjust=True, threads=True, progress=False)
        for t in chunk:
            try:
                h = (df[t] if isinstance(df.columns, pd.MultiIndex) else df).dropna(subset=["Close"])
            except KeyError:
                continue
            if len(h) < 40:
                continue
            if float(h["Close"].iloc[-1]) >= min_price and float((h["Close"] * h["Volume"]).iloc[-40:].median()) >= min_dollar_vol:
                out[t] = h
    print()
    return out


def demo_info(t):
    info = dict(A.fetch_demo(t).info)
    rng = np.random.default_rng(sum(map(ord, t)))
    ideas = ["builds small modular nuclear reactors for data centers", "develops gene therapies for rare disease",
             "launches small satellites for global broadband", "makes humanoid robots for warehouses",
             "builds quantum computers using trapped ions", "sells grid-scale battery energy storage",
             "operates a regional bank", "designs photonic chips for AI data center networking"]
    k = int(rng.integers(0, len(ideas)))
    info.update({"longBusinessSummary": f"{t} Demo Inc {ideas[k]}.", "profitMargins": -rng.uniform(0.05, 2),
                 "trailingEps": -1.0, "totalRevenue": rng.uniform(0, 8e8), "marketCap": rng.uniform(4e8, 2e10),
                 "heldPercentInsiders": rng.uniform(0, 0.4), "freeCashflow": -rng.uniform(2e7, 4e8),
                 "industry": "Banks - Regional" if k == 6 else "Specialty Industrial Machinery", "quoteType": "EQUITY"})
    return info


def facts(t, info, est) -> dict | None:
    """Siffrorna för ett bolag, eller None om det inte passar listan."""
    name = info.get("longName") or info.get("shortName") or t
    if info.get("quoteType") not in (None, "EQUITY") or SPAC.search(name) or EXCLUDE_INDUSTRY.search(str(info.get("industry") or "")):
        return None
    mcap = num(info.get("marketCap"))
    if not mcap or mcap < 3e8:
        return None
    pm, eps, ni = num(info.get("profitMargins")), num(info.get("trailingEps")), num(info.get("netIncomeToCommon"))
    unprofitable = (eps is not None and eps <= 0) or (ni is not None and ni < 0) or (pm is not None and pm < 0)
    if not unprofitable:
        return None
    rev, g = num(info.get("totalRevenue")) or 0, num(info.get("revenueGrowth"))
    # Krympande bolag med förluster är inte "framtid" - pre-kommersiella (liten omsättning) får vara med
    if rev > 1e8 and (g is None or g < 0.05):
        return None
    cash, fcf = num(info.get("totalCash")) or 0, num(info.get("freeCashflow"))
    burn = -fcf if fcf is not None and fcf < 0 else None
    runway = min(cash / burn, 10.0) if burn else (10.0 if fcf is not None else None)
    gnext = est.get("omsättningstillväxt_nästa_år")
    gm = num(info.get("grossMargins")) if rev > 2e7 else None
    ins = num(info.get("heldPercentInsiders"))
    delar = {
        "Tillväxt": lin(g, 0.6, -0.05) if rev > 2e7 else None,
        "Väntad tillväxt": lin(gnext, 0.6, 0.0),
        "Kassan räcker": lin(runway, 4, 0.5),
        "Bruttomarginal": lin(gm, 0.6, 0.0),
        "Ledningen äger": lin(ins, 0.2, 0.0),
    }
    exek = mean(list(delar.values()))
    summary = (info.get("longBusinessSummary") or "").strip()
    tema, hits = theme_hits(summary + " " + str(info.get("industry") or ""))
    return {
        "ticker": t, "namn": name, "sektor": info.get("sector") or "–", "bransch": info.get("industry") or "–",
        "beskrivning": summary[:900], "börsvärde": mcap, "omsättning": rev, "omsättningstillväxt": g,
        "väntad_tillväxt": gnext, "bruttomarginal": gm, "kassa": cash, "kassaflöde": fcf, "kassa_år": runway,
        "insiders": ins, "anställda": num(info.get("fullTimeEmployees")),
        "analytiker": num(info.get("numberOfAnalystOpinions")), "riktkurs": num(info.get("targetMeanPrice")),
        "kurs": num(info.get("currentPrice") or info.get("regularMarketPrice")),
        "tema_ord": tema, "tema_träffar": hits, "exekvering": exek, "exekvering_delar": delar,
    }


def candidates(demo: bool, workers: int = 8) -> tuple[list[dict], int]:
    tickers = S.universe("all", demo, None)
    print(f"Steg 1: {len(tickers)} aktier i USA")
    hists = liquid(tickers, demo)
    print(f"  {len(hists)} med tillräcklig handel")

    def one(t):
        try:
            info = demo_info(t) if demo else S.get_info(t, demo)
            if not info:
                return None
            # Analytikernas prognos hämtas bara för olönsamma bolag (sparar tid)
            pm, eps = num(info.get("profitMargins")), num(info.get("trailingEps"))
            if not ((eps is not None and eps <= 0) or (pm is not None and pm < 0) or (num(info.get("netIncomeToCommon")) or 0) < 0):
                return None
            est = {} if demo else S.get_estimates(t, demo)
            return facts(t, info, est)
        except Exception:
            return None

    rows = []
    with ThreadPoolExecutor(workers) as ex:
        for i, r in enumerate(ex.map(one, list(hists)), 1):
            if i % 100 == 0:
                print(f"  nyckeltal {i}/{len(hists)}", end="\r", flush=True)
            if r:
                rows.append(r)
    print(f"\nSteg 2: {len(rows)} olönsamma bolag med börsvärde över 300 mn USD")
    return rows, len(tickers)


def preselect(rows: list[dict], n: int = AI_CANDIDATES) -> list[dict]:
    """Välj kandidater till AI:n: genomförandekraft + framtidstema, högst 30 per bransch."""
    for r in rows:
        size = lin(math.log10(r["börsvärde"]), 10.5, 8.5)
        r["förval"] = 0.5 * (r["exekvering"] or 0) + 0.3 * min(r["tema_träffar"], 4) * 2.5 + 0.2 * size
    rows = sorted(rows, key=lambda r: r["förval"], reverse=True)
    out, per = [], {}
    for r in rows:
        b = r["bransch"]
        if per.get(b, 0) >= 30:
            continue
        per[b] = per.get(b, 0) + 1
        out.append(r)
        if len(out) >= n:
            return out
    # För få branscher: fyll på med de bästa av resten
    chosen = {r["ticker"] for r in out}
    return out + [r for r in rows if r["ticker"] not in chosen][: n - len(out)]


# ---------------------------------------------------------------------------
# 3. AI-bedömning
# ---------------------------------------------------------------------------

SYSTEM = """Du är en erfaren, nykter riskkapitalanalytiker. Du skriver på svenska, i korta och enkla meningar.
Du bedömer amerikanska börsbolag som ännu inte är lönsamma. Frågan är: har bolaget en riktigt bra idé som löser ett
viktigt problem som världen kommer att ha i framtiden, och är bolaget målmedvetet nog att lyckas?
Bedöm varje bolag för sig, utifrån beskrivningen, siffrorna och det du själv vet om bolaget.
Var ärlig och sträng: de flesta bolag ska få medelpoäng. Ge inte höga poäng för modeord.
Låga poäng för: bolag vars problem inte växer i framtiden, idéer som är lätta att kopiera, ofokuserade bolag,
bolag som lever på nyemissioner utan plan, och bolag som är förlustbringande för att verksamheten krymper.
Hitta aldrig på fakta. Lämna svaret med verktyget submit_scores, ett objekt per bolag."""

SCORES_TOOL = {
    "name": "submit_scores",
    "description": "Lämna bedömningen av alla bolag i listan.",
    "input_schema": {
        "type": "object",
        "properties": {
            "bolag": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ticker": {"type": "string"},
                        "tema": {"type": "string", "enum": TEMAN},
                        "problem": {"type": "string", "description": "Vilket framtidsproblem bolaget löser. En kort mening."},
                        "ide": {"type": "string", "description": "Bolagets lösning och vad som gör den unik. 1–2 enkla meningar."},
                        "malsattning": {"type": "string", "description": "Bolagets mål och nästa viktiga milstolpar, om de är kända. En mening."},
                        "risk": {"type": "string", "description": "Den största risken. En mening."},
                        "problem_poang": {"type": "integer", "description": "Hur stort och växande framtidsproblemet är."},
                        "ide_poang": {"type": "integer", "description": "Hur bra, unik och svår att kopiera lösningen är."},
                        "malmedveten_poang": {"type": "integer", "description": "Tydlig plan, fokus, uppnådda milstolpar, ledning som levererar."},
                    },
                    "required": ["ticker", "tema", "problem", "ide", "malsattning", "risk", "problem_poang", "ide_poang", "malmedveten_poang"],
                },
            }
        },
        "required": ["bolag"],
    },
}


def ai_input(r: dict) -> dict:
    p = lambda x: None if x is None else round(x * 100)
    return {
        "ticker": r["ticker"], "namn": r["namn"], "bransch": r["bransch"], "beskrivning": r["beskrivning"],
        "börsvärde_mn_usd": round(r["börsvärde"] / 1e6), "omsättning_mn_usd": round(r["omsättning"] / 1e6),
        "omsättningstillväxt_pct": p(r["omsättningstillväxt"]), "väntad_tillväxt_nästa_år_pct": p(r["väntad_tillväxt"]),
        "bruttomarginal_pct": p(r["bruttomarginal"]), "kassa_mn_usd": round(r["kassa"] / 1e6),
        "fritt_kassaflöde_mn_usd": None if r["kassaflöde"] is None else round(r["kassaflöde"] / 1e6),
        "år_kassan_räcker": None if r["kassa_år"] is None else round(r["kassa_år"], 1),
        "ledningen_äger_pct": p(r["insiders"]), "anställda": r["anställda"],
    }


def ai_scores(rows: list[dict]) -> dict:
    import anthropic
    client = anthropic.Anthropic()
    out = {}
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        print(f"  AI bedömer bolag {i + 1}–{i + len(chunk)} av {len(rows)}")
        msg = f"Dagens datum: {date.today().isoformat()}. Bedöm dessa {len(chunk)} bolag:\n" + json.dumps([ai_input(r) for r in chunk], ensure_ascii=False)
        for attempt in range(2):
            try:
                resp = client.messages.create(model=MODEL, max_tokens=8000, system=SYSTEM, tools=[SCORES_TOOL],
                                              tool_choice={"type": "tool", "name": "submit_scores"},
                                              messages=[{"role": "user", "content": msg}])
                block = next(b for b in resp.content if b.type == "tool_use")
                for s in block.input.get("bolag", []):
                    out[str(s.get("ticker", "")).upper()] = s
                break
            except Exception as e:
                if "credit" in str(e).lower() or "balance" in str(e).lower():
                    fel("AI-krediterna är slut. Fyll på i console.anthropic.com.")
                    return out
                if attempt == 0:
                    print(f"  fel ({e}), försöker igen", flush=True)
                else:
                    fel(f"AI-anropet misslyckades för bolag {i + 1}–{i + len(chunk)}: {str(e)[:300]}")
    return out


def demo_scores(rows: list[dict]) -> dict:
    """Utan AI: poäng från temaord, bara för att kunna testa resten."""
    out = {}
    for r in rows:
        h = min(r["tema_träffar"], 3)
        out[r["ticker"]] = {"ticker": r["ticker"], "tema": r["tema_ord"], "problem": "Testdata: " + r["tema_ord"].lower(),
                            "ide": r["beskrivning"][:120], "malsattning": "Testdata.", "risk": "Testdata.",
                            "problem_poang": 4 + 2 * h, "ide_poang": 3 + 2 * h, "malmedveten_poang": 5}
    return out


# ---------------------------------------------------------------------------
# Rangordna och spara
# ---------------------------------------------------------------------------

def rank(rows: list[dict], scores: dict) -> list[dict]:
    """Total 0–100: idé 35 %, framtidsproblem 25 %, målmedvetenhet (AI) 20 %, genomförandekraft ur siffrorna 20 %."""
    out = []
    for r in rows:
        s = scores.get(r["ticker"])
        if not s:
            continue
        clip10 = lambda x: max(0, min(10, int(x or 0)))
        idé, prob, mål = clip10(s.get("ide_poang")), clip10(s.get("problem_poang")), clip10(s.get("malmedveten_poang"))
        exek = r["exekvering"] if r["exekvering"] is not None else 5.0
        total = (0.35 * idé + 0.25 * prob + 0.2 * mål + 0.2 * exek) * 10
        out.append({**r, "tema": s.get("tema") if s.get("tema") in TEMAN else r["tema_ord"],
                    "problem": s.get("problem", ""), "idé": s.get("ide", ""), "mål": s.get("malsattning", ""), "risk": s.get("risk", ""),
                    "poäng": round(total), "delar": {"Idé": idé, "Framtidsproblem": prob, "Målmedvetenhet": mål, "Genomförande": round(exek, 1)}})
    out.sort(key=lambda r: (r["poäng"], r["delar"]["Idé"]), reverse=True)
    return out[:TOP]


def next_update(today: date) -> str:
    for m in (1, 4, 7, 10):
        d = date(today.year, m, 2)
        if d > today:
            return d.isoformat()
    return date(today.year + 1, 1, 2).isoformat()


def main():
    a = argparse.ArgumentParser(description="Framtidsaktier: topp 50 olönsamma bolag med bäst idéer för framtiden")
    a.add_argument("--demo", action="store_true")
    a.add_argument("--out", default=OUT)
    args = a.parse_args()

    rows, n_universe = candidates(args.demo)
    if not rows:
        fel("Inga bolag hittades. Svarar Yahoo Finance? Den gamla listan behålls.")
        return 1
    cand = preselect(rows)
    info_note(f"{n_universe} aktier, {len(rows)} olönsamma bolag över 300 mn USD, {len(cand)} kandidater till AI")
    use_ai = not args.demo and os.environ.get("ANTHROPIC_API_KEY")
    if not args.demo and not use_ai:
        fel("ANTHROPIC_API_KEY saknas - listan kräver AI. Den gamla listan behålls.")
        return 1
    scores = ai_scores(cand) if use_ai else demo_scores(cand)
    if len(scores) < len(cand) * 0.6:
        fel(f"AI:n bedömde bara {len(scores)} av {len(cand)} bolag. Den gamla listan behålls.")
        return 1
    top = rank(cand, scores)

    prev = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, encoding="utf-8") as fh:
                prev = {r["ticker"]: r["rank"] for r in json.load(fh).get("rader", [])}
        except Exception:
            pass
    keep = ["ticker", "namn", "sektor", "bransch", "tema", "problem", "idé", "mål", "risk", "poäng", "delar",
            "börsvärde", "omsättning", "omsättningstillväxt", "väntad_tillväxt", "bruttomarginal", "kassa_år", "insiders", "kurs"]
    rader = []
    for i, r in enumerate(top, 1):
        rad = {k: r.get(k) for k in keep}
        rad["rank"] = i
        rad["förra"] = prev.get(r["ticker"])
        rader.append(rad)
    today = date.today()
    out = {"uppdaterad": today.isoformat(), "nästa": next_update(today), "universum": n_universe,
           "olönsamma": len(rows), "bedömda": len(scores), "modell": MODEL if use_ai else "demo", "rader": rader}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, allow_nan=False, default=lambda x: None)
    print(f"\nTopp 10 framtidsaktier:")
    for r in rader[:10]:
        print(f"  {r['rank']:>2}. {r['ticker']:<6} {r['poäng']:>3} p  {r['tema']:<13} {r['namn'][:34]}")
    info_note(f"Klart: {len(rader)} framtidsaktier, AI bedömde {len(scores)} bolag. Etta: {rader[0]['ticker']} ({rader[0]['namn']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
