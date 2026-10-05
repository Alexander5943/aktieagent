#!/usr/bin/env python3
"""
Screener - rangordnar amerikanska aktier efter förväntad avkastning.

Två steg:
  Steg 1 (gratis):  Går igenom alla aktier. Räknar ut förväntad avkastning
                    och kvalitetspoäng. Rangordnar.
  Steg 2 (AI):      Claude djupanalyserar de bästa på listan.

Användning:
  python screener.py                        # S&P 500, AI på topp 10
  python screener.py --universe all         # alla aktier på NYSE + Nasdaq (~5 000)
  python screener.py --universe nasdaq100
  python screener.py --max-price 10         # bara aktier under $10
  python screener.py --min-mcap 100e6       # minsta börsvärde $100 mn
  python screener.py --ai-top 0             # hoppa över AI, helt gratis
  python screener.py --demo                 # testdata, inget internet

Inte finansiell rådgivning. "Förväntad avkastning" är en uppskattning
byggd på analytikers riktkurser, värdering, tillväxt och trend - ingen prognos.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime

import numpy as np
import pandas as pd

import aktieagent as A
import modell

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", date.today().isoformat())


# ---------------------------------------------------------------------------
# 1. VILKA AKTIER? (universum)
# ---------------------------------------------------------------------------

def _get_text(url: str) -> str:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def universe(kind: str, demo: bool, file: str | None) -> list[str]:
    if file:
        with open(file) as fh:
            return [x.strip().upper() for x in fh.read().replace(",", "\n").split() if x.strip()]
    if demo:
        return [f"D{i:03d}" for i in range(300)]

    if kind == "sp500":
        csv = _get_text("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv")
        return pd.read_csv(io.StringIO(csv))["Symbol"].str.replace(".", "-", regex=False).tolist()

    if kind == "nasdaq100":
        html = _get_text("https://en.wikipedia.org/wiki/Nasdaq-100")
        for t in pd.read_html(io.StringIO(html)):
            col = next((c for c in t.columns if str(c).lower() in ("ticker", "symbol")), None)
            if col is not None and len(t) > 90:
                return t[col].astype(str).tolist()
        raise RuntimeError("Hittade inte Nasdaq-100-listan.")

    # "all": alla vanliga aktier på Nasdaq, NYSE och NYSE American
    tickers = []
    nas = pd.read_csv(io.StringIO(_get_text("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt")), sep="|")
    nas = nas[(nas["Test Issue"] == "N") & (nas["ETF"] == "N")]
    tickers += nas["Symbol"].tolist()
    oth = pd.read_csv(io.StringIO(_get_text("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt")), sep="|")
    oth = oth[(oth["Test Issue"] == "N") & (oth["ETF"] == "N")]
    tickers += oth["ACT Symbol"].tolist()
    # Ta bort warranter, units, preferensaktier m.m.
    clean = [t for t in map(str, tickers)
             if t.isalpha() and len(t) <= 5 and not (len(t) == 5 and t[-1] in "WURQ")]
    return sorted(set(clean))


# ---------------------------------------------------------------------------
# 2. HÄMTA DATA (snabbt, med cache)
# ---------------------------------------------------------------------------

def batch_history(tickers: list[str], demo: bool) -> dict[str, pd.DataFrame]:
    """Kurshistorik för många aktier åt gången (snabbt)."""
    if demo:
        return {t: A.fetch_demo(t).history for t in tickers}
    import yfinance as yf

    out = {}
    chunks = [tickers[i:i + 200] for i in range(0, len(tickers), 200)]
    for n, chunk in enumerate(chunks, 1):
        print(f"  kurser: paket {n}/{len(chunks)}", end="\r")
        df = yf.download(chunk, period="10y", group_by="ticker", auto_adjust=True,
                         threads=True, progress=False)
        for t in chunk:
            try:
                h = df[t] if isinstance(df.columns, pd.MultiIndex) else df
                h = h.dropna(subset=["Close"])
                if len(h) >= 130:
                    out[t] = h
            except KeyError:
                pass
    print()
    return out


INFO_FEL = []  # tickers där Yahoo inte svarade


def get_info(ticker: str, demo: bool) -> dict:
    """Nyckeltal för en aktie. Sparas i cache så att en ny körning samma dag går snabbt."""
    if demo:
        return A.fetch_demo(ticker).info
    path = os.path.join(CACHE, f"{ticker}.json")
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    import yfinance as yf
    for attempt in range(3):
        try:
            info = yf.Ticker(ticker).info or {}
            os.makedirs(CACHE, exist_ok=True)
            with open(path, "w") as fh:
                json.dump(info, fh, default=str)
            return info
        except Exception:
            time.sleep(2 * (attempt + 1))  # Yahoo begränsar ibland; vänta och försök igen
    INFO_FEL.append(ticker)
    return {}


def get_estimates(ticker: str, demo: bool) -> dict:
    """
    Analytikers prognoser för innevarande räkenskapsår (0y) och nästa (+1y).
    Tillväxten från år 0 till år +1 är precis perioden vi rangordnar på.
    """
    if demo:
        rng = np.random.default_rng(zlib.crc32(ticker.encode()) + 1)
        eps0 = rng.uniform(-0.5, 5)
        g = rng.uniform(-0.15, 0.6)
        return {"eps_i_år": eps0, "eps_nästa_år": eps0 * (1 + g) if eps0 > 0 else eps0 + 0.5,
                "vinsttillväxt_nästa_år": g if eps0 > 0 else None,
                "omsättningstillväxt_nästa_år": rng.uniform(-0.05, 0.5), "analytiker_prognos": 12}
    path = os.path.join(CACHE, f"{ticker}_est.json")
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    import yfinance as yf
    out = {}
    try:
        t = yf.Ticker(ticker)
        ee = t.earnings_estimate
        if ee is not None and "+1y" in ee.index:
            out["eps_i_år"] = A._num(ee.loc["0y", "avg"])
            out["eps_nästa_år"] = A._num(ee.loc["+1y", "avg"])
            out["vinsttillväxt_nästa_år"] = A._num(ee.loc["+1y", "growth"])
            out["analytiker_prognos"] = A._num(ee.loc["+1y", "numberOfAnalysts"])
            # Yahoo räknar ibland inte tillväxt när vinsten är negativ - räkna själv om möjligt
            e0, e1 = out["eps_i_år"], out["eps_nästa_år"]
            if out["vinsttillväxt_nästa_år"] is None and e0 and e1 and e0 > 0:
                out["vinsttillväxt_nästa_år"] = e1 / e0 - 1
        re = t.revenue_estimate
        if re is not None and "+1y" in re.index:
            out["omsättningstillväxt_nästa_år"] = A._num(re.loc["+1y", "growth"])
    except Exception:
        pass
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(out, fh)
    return out


# ---------------------------------------------------------------------------
# 3. FÖRVÄNTAD AVKASTNING
# ---------------------------------------------------------------------------

def expected_return(f: dict, t: dict, est: dict | None = None) -> dict:
    """
    Uppskattad avkastning för perioden år -> år+1 (12 månader framåt), från tre källor:

      Analytiker (50 %)   Uppsida mot snittriktkursen (12 mån). Kräver minst 3 analytiker.
      Fundamental (35 %)  Nästa års vinst / kurs  +  vinsttillväxt från i år till nästa år.
                          Ungefär: "vad aktien tjänar åt dig" + "hur fort det växer".
                          Saknas vinstprognos används omsättningstillväxten nästa år.
      Trend (15 %)        Kursutveckling senaste 12 mån (momentum), nedskalad.

    Saknas en källa vägs de andra upp. Värden kapas så att enstaka extremer
    inte tar över listan.
    """
    parts, weights = {}, {"analytiker": 0.50, "fundamental": 0.35, "trend": 0.15}

    n = f.get("antal_analytiker") or 0
    if f.get("analytiker_riktkurs") and n >= 3:
        parts["analytiker"] = float(np.clip(f["analytiker_riktkurs"] / t["kurs"] - 1, -0.5, 1.0))

    est = est or {}
    eps1 = est.get("eps_nästa_år")
    g = est.get("vinsttillväxt_nästa_år")
    if g is None:
        g = est.get("omsättningstillväxt_nästa_år")
    ey = eps1 / t["kurs"] if eps1 and eps1 > 0 else None
    if ey is None and f.get("forward_pe") and f["forward_pe"] > 0:
        ey = 1 / f["forward_pe"]
    if g is None:  # sista utväg: senaste årets tillväxt
        g = f.get("vinsttillväxt") if f.get("vinsttillväxt") is not None else f.get("omsättningstillväxt")
    if g is not None:
        # Bolag utan vinst får bara tillväxtdelen, med avdrag för att vinsten saknas
        parts["fundamental"] = float(np.clip((ey if ey is not None else -0.05) + np.clip(g, -0.2, 0.4), -0.3, 0.6))

    if t.get("förändring_1år") is not None:
        parts["trend"] = float(np.clip(t["förändring_1år"], -0.5, 1.0) * 0.3)

    if not parts:
        return {"förväntad": None, "delar": parts}
    w = sum(weights[k] for k in parts)
    er = sum(parts[k] * weights[k] for k in parts) / w
    return {"förväntad": er, "delar": parts, "källor": len(parts)}


# ---------------------------------------------------------------------------
# 4. STEG 1 - SCREENA ALLA
# ---------------------------------------------------------------------------

def screen(tickers, demo, min_mcap, min_dollar_vol, max_price, min_price, workers):
    print(f"Steg 1: {len(tickers)} aktier i universumet")
    hists = batch_history(tickers, demo)

    # Snabbfilter på kurs och likviditet innan vi hämtar nyckeltal
    keep = []
    for tk, h in hists.items():
        price = float(h["Close"].iloc[-1])
        dvol = float((h["Close"] * h["Volume"]).iloc[-60:].median())
        if price >= min_price and (max_price is None or price <= max_price) and dvol >= min_dollar_vol:
            keep.append(tk)
    print(f"  {len(keep)} kvar efter filter (pris, handelsvolym)")

    rows = []

    def one(tk):
        info = get_info(tk, demo)
        if not info or (info.get("quoteType") not in (None, "EQUITY")):
            return None
        h10 = hists[tk]
        d = A.StockData(tk, info, h10.iloc[-504:], None, None)  # 2 år räcker för trend och risk
        f, t = A.fundamentals(d), A.technicals(d.history)
        if not f["börsvärde"] or f["börsvärde"] < min_mcap:
            return None
        s = A.score(f, t)
        est = get_estimates(tk, demo)
        er = expected_return(f, t, est)
        if er["förväntad"] is None:
            return None
        hz = horizon_fields(f, t, est, info, er["förväntad"], h10["Close"], s)
        return hz | {
            "ticker": tk, "namn": f["namn"], "sektor": f["sektor"] or "–",
            "kurs": t["kurs"], "börsvärde": f["börsvärde"],
            "förväntad_avkastning": er["förväntad"],
            "från_analytiker": er["delar"].get("analytiker"),
            "från_fundamenta": er["delar"].get("fundamental"),
            "från_trend": er["delar"].get("trend"),
            "datakällor": er["källor"],
            "kvalitetspoäng": s["total"],
            "volatilitet": t["volatilitet_årlig"],
            "riskjusterad": er["förväntad"] / max(t["volatilitet_årlig"], 0.10),
            "forward_pe": f["forward_pe"],
            "vinsttillväxt_nästa_år": est.get("vinsttillväxt_nästa_år"),
            "omsättningstillväxt_nästa_år": est.get("omsättningstillväxt_nästa_år"),
            "antal_analytiker": f["antal_analytiker"],
        }

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(one, tk): tk for tk in keep}
        for i, fu in enumerate(as_completed(futs), 1):
            if i % 25 == 0 or i == len(keep):
                print(f"  nyckeltal: {i}/{len(keep)}", end="\r", flush=True)
            try:
                r = fu.result()
                if r:
                    rows.append(r)
            except Exception:
                pass
    print()
    df = pd.DataFrame(rows)
    print(f"  {len(df)} aktier med tillräcklig data")
    return df


# ---------------------------------------------------------------------------
# 4b. TRE TIDSHORISONTER: 1–6 månader, 1–3 år, 5–10 år
# ---------------------------------------------------------------------------

def horizon_fields(f, t, est, info, er1, close, s) -> dict:
    """Extra kolumner för topplistorna per tidshorisont."""
    price = t["kurs"]
    mf = {
        "eps_nästa_år": est.get("eps_nästa_år"), "forward_pe": f.get("forward_pe"),
        "vinsttillväxt_nästa_år": est.get("vinsttillväxt_nästa_år"),
        "omsättningstillväxt_nästa_år": est.get("omsättningstillväxt_nästa_år"),
        "omsättningstillväxt": f.get("omsättningstillväxt"), "vinsttillväxt": f.get("vinsttillväxt"),
        "ps": f.get("ps"), "bruttomarginal": f.get("bruttomarginal"), "roe": f.get("roe"),
        "rörelsemarginal": f.get("rörelsemarginal"), "utdelning": A._num(info.get("trailingAnnualDividendYield")),
    }
    hz = modell.horizons(mf, price, er1)

    # 1–6 månader: analytikernas uppsida (halva), säsongsmönster och momentum
    means = modell.monthly_means(close)
    seas6 = modell.seasonal_ahead(means, date.today().month, 6)
    c = close.dropna()
    mom = float(c.iloc[-22] / c.iloc[-253] - 1) if len(c) > 253 else None  # 12 mån utom senaste månaden
    parts, w = {}, {"analytiker": 0.4, "säsong": 0.3, "momentum": 0.3}
    if f.get("analytiker_riktkurs") and (f.get("antal_analytiker") or 0) >= 3:
        parts["analytiker"] = 0.5 * float(np.clip(f["analytiker_riktkurs"] / price - 1, -0.5, 1.0))
    if seas6 is not None:
        parts["säsong"] = 0.5 * seas6 + 0.5 * 0.04  # mönster upprepas inte alltid: väg mot ett normalt halvår
    if mom is not None:
        parts["momentum"] = 0.04 + float(np.clip(mom, -0.5, 1.0)) * 0.15
    kort = sum(parts[k] * w[k] for k in parts) / sum(w[k] for k in parts) if parts else None
    if kort is not None and t.get("sma200") and price < t["sma200"]:
        kort -= 0.03  # under 200-dagars snitt: nedåttrend
    ar = s["områden"]
    long_q = [x for x in (ar.get("Lönsamhet"), ar.get("Finansiell styrka")) if x is not None]
    return {
        "kort_6m": kort, "säsong_6m": seas6, "momentum_12m": mom,
        "årlig_3år": hz.get(3), "årlig_5år": hz.get(5), "årlig_10år": hz.get(10),
        "lång_kvalitet": sum(long_q) / len(long_q) * 10 if long_q else None,
        "vinstbolag": bool(mf["eps_nästa_år"] and mf["eps_nästa_år"] > 0) or bool(f.get("forward_pe") and f["forward_pe"] > 0),
    }


LISTOR = {
    "kort": ("1–6 månader", "Analytikernas uppsida, säsongsmönster och kursmomentum"),
    "mellan": ("1–3 år", "Förväntad avkastning per år de kommande 3 åren, och bolagets kvalitet"),
    "lang": ("5–10 år", "Förväntad avkastning per år i 10 år, lönsamhet och finansiell styrka"),
}


def horizon_lists(df: pd.DataFrame, min_quality: int = 40) -> dict[str, pd.DataFrame]:
    """Tre rangordningar av samma aktier, en per tidshorisont."""
    d = df[df["kvalitetspoäng"] >= min_quality].copy()
    out = {}
    k = d.dropna(subset=["kort_6m"]).copy()
    out["kort"] = k.sort_values("kort_6m", ascending=False)
    m = d.dropna(subset=["årlig_3år"]).copy()
    m["_s"] = m["årlig_3år"].rank(pct=True) * 0.6 + m["kvalitetspoäng"].rank(pct=True) * 0.4
    out["mellan"] = m.sort_values("_s", ascending=False)
    lg = d[d["vinstbolag"]].dropna(subset=["årlig_10år"]).copy()
    lg["_s"] = lg["årlig_10år"].rank(pct=True) * 0.5 + lg["lång_kvalitet"].fillna(0).rank(pct=True) * 0.5
    out["lang"] = lg.sort_values("_s", ascending=False)
    for key in out:
        out[key] = out[key].drop(columns=["_s"], errors="ignore").reset_index(drop=True)
    return out


def rank(df: pd.DataFrame, sort: str, min_quality: int) -> pd.DataFrame:
    df = df[df["kvalitetspoäng"] >= min_quality].copy()
    key = {"avkastning": "förväntad_avkastning", "riskjusterad": "riskjusterad",
           "kombinerad": "kombinerad"}[sort]
    # Kombinerad: hälften förväntad avkastning, hälften kvalitet (som percentiler)
    df["kombinerad"] = (df["förväntad_avkastning"].rank(pct=True) * 0.5
                        + df["kvalitetspoäng"].rank(pct=True) * 0.5)
    df = df.sort_values(key, ascending=False).reset_index(drop=True)
    df.insert(0, "rank", df.index + 1)
    return df


# ---------------------------------------------------------------------------
# 5. RAPPORT
# ---------------------------------------------------------------------------

def html(df: pd.DataFrame, ai: dict, args, n_universe: int, period: str) -> str:
    p = lambda x: "–" if x is None or pd.isna(x) else f"{x * 100:+.0f} %"
    colors = {"Köpvärd": "#1a7f37", "Avvakta / bevaka": "#b7791f", "Undvik just nu": "#c0392b"}
    body = []
    for r in df.head(args.show).itertuples():
        v = ai.get(r.ticker)
        badge = (f'<span class="b" style="background:{colors[v["betyg"]]}" title="{v["sammanfattning"]}">'
                 f'{v["betyg"]}</span>') if v else ""
        body.append(
            f"<tr><td>{r.rank}</td><td><b>{r.ticker}</b><br><small>{str(r.namn)[:32]}</small></td>"
            f"<td>{r.sektor}</td><td data-v='{r.kurs}'>{r.kurs:.2f}</td>"
            f"<td data-v='{r.börsvärde}'>{A.fmt(r.börsvärde)}</td>"
            f"<td data-v='{r.förväntad_avkastning}' class='er'>{p(r.förväntad_avkastning)}</td>"
            f"<td data-v='{r.från_analytiker or -9}'>{p(r.från_analytiker)}</td>"
            f"<td data-v='{r.från_fundamenta or -9}'>{p(r.från_fundamenta)}</td>"
            f"<td data-v='{r.från_trend or -9}'>{p(r.från_trend)}</td>"
            f"<td data-v='{r.vinsttillväxt_nästa_år if pd.notna(r.vinsttillväxt_nästa_år) else -9}'>{p(r.vinsttillväxt_nästa_år)}</td>"
            f"<td data-v='{r.kvalitetspoäng}'>{r.kvalitetspoäng}</td>"
            f"<td data-v='{r.volatilitet}'>{r.volatilitet * 100:.0f} %</td>"
            f"<td>{badge}</td></tr>")
    ai_cards = "".join(
        f'<div class="card"><h3>{tk} <span class="b" style="background:{colors[v["betyg"]]}">{v["betyg"]}</span>'
        f' <small>säkerhet: {v["säkerhet"]}</small></h3><p>{v["sammanfattning"]}</p>'
        f'<p><b>Värdering:</b> {v["värdering_kommentar"]}</p>'
        f'<p><b>Risker:</b> {"; ".join(v["risker"])}</p></div>'
        for tk, v in ai.items())
    return f"""<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Aktieranking {period}</title>
<style>
body{{font-family:system-ui,sans-serif;background:#f4f5f7;color:#1c1e21;margin:0;padding:16px}}
main{{max-width:1200px;margin:auto}} .wrap{{overflow-x:auto;background:#fff;border-radius:12px;box-shadow:0 1px 3px #0001}}
table{{border-collapse:collapse;width:100%;font-size:13px}} th,td{{padding:7px 9px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap}}
th{{background:#fafafa;cursor:pointer;position:sticky;top:0}} td:nth-child(2),td:nth-child(3),th:nth-child(2),th:nth-child(3){{text-align:left}}
td small{{color:#777}} .er{{font-weight:600}} .b{{color:#fff;padding:2px 7px;border-radius:6px;font-size:12px}}
.card{{background:#fff;border-radius:12px;padding:14px 18px;margin:12px 0;box-shadow:0 1px 3px #0001}}
.note{{font-size:13px;color:#555;line-height:1.5}}
</style></head><body><main>
<h1>Aktieranking {period}</h1><p class="note"><b>Förväntad avkastning för perioden {period}</b> (12 månader från idag), baserat på analytikers prognoser för nästa år.</p>
<p class="note">Skapad {datetime.now():%Y-%m-%d %H:%M}. Universum: {args.universe} ({n_universe} aktier), {len(df)} klarade filtren.
Sorterad på: <b>{args.sort}</b>. Klicka på en kolumnrubrik för att sortera om.<br>
<b>Förväntad avkastning</b> = 50 % analytikers riktkurs + 35 % vinstavkastning och tillväxt + 15 % trend.
Det är en uppskattning, inte en prognos. Inte finansiell rådgivning.</p>
<div class="wrap"><table id="t"><thead><tr><th>#</th><th>Aktie</th><th>Sektor</th><th>Kurs</th><th>Börsvärde</th>
<th>Förväntad</th><th>Analytiker</th><th>Fundamenta</th><th>Trend</th><th>Vinsttillv. nästa år</th><th>Kvalitet</th><th>Volatilitet</th><th>AI</th></tr></thead>
<tbody>{''.join(body)}</tbody></table></div>
{('<h2>AI-agentens djupanalys</h2>' + ai_cards) if ai else ''}
</main><script>
document.querySelectorAll('#t th').forEach((th,i)=>th.onclick=()=>{{
 const tb=document.querySelector('#t tbody'),rows=[...tb.rows],asc=th.dataset.asc!=='1';th.dataset.asc=asc?'1':'0';
 const val=r=>{{const c=r.cells[i];return c.dataset.v!==undefined?parseFloat(c.dataset.v):(parseFloat(c.innerText)||c.innerText)}};
 rows.sort((a,b)=>{{const x=val(a),y=val(b);return (x>y?1:x<y?-1:0)*(asc?1:-1)}});rows.forEach(r=>tb.appendChild(r));
}});
</script></body></html>"""


# ---------------------------------------------------------------------------
# 6. HISTORIK - spara varje års lista och se i efterhand hur den gick
# ---------------------------------------------------------------------------

HIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historik")


def save_history(df: pd.DataFrame, period: str, top: int = 50):
    os.makedirs(HIST, exist_ok=True)
    path = os.path.join(HIST, f"ranking_{period}_{date.today().isoformat()}.csv")
    cols = ["rank", "ticker", "namn", "kurs", "förväntad_avkastning", "kvalitetspoäng"]
    df[cols].head(top).rename(columns={"kurs": "startkurs"}).to_csv(path, index=False)
    return path


def evaluate(top: int, demo: bool):
    """Jämför gamla listors förväntade avkastning med vad som faktiskt hände."""
    files = sorted(f for f in os.listdir(HIST) if f.endswith(".csv")) if os.path.isdir(HIST) else []
    if not files:
        print("Ingen historik ännu. Kör screenern först - listan sparas automatiskt.")
        return
    import yfinance as yf
    for fn in files:
        period, start = fn[8:-4].rsplit("_", 1)
        old = pd.read_csv(os.path.join(HIST, fn)).head(top)
        days = (date.today() - date.fromisoformat(start)).days
        if days < 30:  # för tidigt att säga något
            continue
        print(f"\n=== Lista {period} (skapad {start}, {days} dagar sedan) - topp {len(old)} ===")
        if demo:
            print("  (demo: ingen riktig kursdata)")
            continue
        px = yf.download(old["ticker"].tolist() + ["SPY"], start=start, auto_adjust=True,
                         progress=False)["Close"]
        now = px.ffill().iloc[-1]
        old["nu"] = old["ticker"].map(now)
        old["faktisk"] = old["nu"] / old["startkurs"] - 1
        spy = float(px["SPY"].dropna().iloc[-1] / px["SPY"].dropna().iloc[0] - 1)
        for r in old.itertuples():
            fakt = "–" if pd.isna(r.faktisk) else f"{r.faktisk * 100:+6.1f} %"
            print(f"  {r.rank:>3}. {r.ticker:<6} förväntad {r.förväntad_avkastning * 100:+5.0f} %   faktisk {fakt}")
        ok = old.dropna(subset=["faktisk"])
        print(f"  Snitt listan: {ok['faktisk'].mean() * 100:+.1f} %   S&P 500 (SPY): {spy * 100:+.1f} %   "
              f"Slog index: {(ok['faktisk'] > spy).mean() * 100:.0f} % av aktierna")
        if days < 365:
            print("  Obs: perioden är inte slut än.")


# ---------------------------------------------------------------------------
# 7. KÖR
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Rangordna amerikanska aktier efter förväntad avkastning")
    p.add_argument("--universe", choices=["sp500", "nasdaq100", "all"], default="sp500")
    p.add_argument("--tickers-file", help="Egen lista med tickers (en per rad)")
    p.add_argument("--min-mcap", type=float, default=300e6, help="Minsta börsvärde i USD (standard 300e6)")
    p.add_argument("--min-volume", type=float, default=2e6, help="Minsta dagliga handel i USD (standard 2e6)")
    p.add_argument("--min-price", type=float, default=1.0)
    p.add_argument("--max-price", type=float, default=None)
    p.add_argument("--min-quality", type=int, default=40, help="Lägsta kvalitetspoäng 0-100 (standard 40)")
    p.add_argument("--sort", choices=["avkastning", "riskjusterad", "kombinerad"], default="kombinerad")
    p.add_argument("--ai-top", type=int, default=10, help="Antal i toppen som AI djupanalyserar (0 = ingen AI)")
    p.add_argument("--show", type=int, default=100, help="Antal rader i rapporten")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--demo", action="store_true")
    p.add_argument("--out", default=None, help="Filnamn (standard: aktieranking_ÅR-ÅR+1.html)")
    p.add_argument("--out-dir", help="Spara rapporten i denna mapp med dagens datum i namnet")
    p.add_argument("--manadsvis", action="store_true",
                   help="Hoppa över om en ranking redan gjorts denna månad (för schemalagd körning)")
    p.add_argument("--utvardera", action="store_true", help="Visa hur tidigare års listor faktiskt gick")
    a = p.parse_args()

    if a.utvardera:
        evaluate(20, a.demo)
        return
    year = date.today().year  # perioden följer kalendern automatiskt
    period = f"{year}-{year + 1}"
    a.out = a.out or f"aktieranking_{period}.html"
    if a.out_dir:
        os.makedirs(a.out_dir, exist_ok=True)
        month = date.today().strftime("%Y-%m")
        if a.manadsvis and any(fn.startswith("aktieranking_") and f"_{month}-" in fn and fn.endswith(".html")
                               for fn in os.listdir(a.out_dir)):
            print(f"{datetime.now():%Y-%m-%d %H:%M} Ranking för {month} finns redan - hoppar över.")
            return
        a.out = os.path.join(a.out_dir, f"aktieranking_{period}_{date.today().isoformat()}.html")
    print(f"Period: {year}–{year + 1} (12 månader framåt från {date.today().isoformat()})")
    if a.tickers_file:
        a.universe = "egen lista"

    tickers = universe(a.universe, a.demo, a.tickers_file)
    df = screen(tickers, a.demo, a.min_mcap, a.min_volume, a.max_price, a.min_price, a.workers)
    if df.empty:
        print("FEL: Inga aktier klarade filtren. Om 0 kurser hämtades svarar troligen inte Yahoo Finance just nu.")
        return 1
    df = rank(df, a.sort, a.min_quality)
    df.to_csv(a.out.replace(".html", ".csv"), index=False)
    if not a.demo:
        save_history(df, period)

    print("\nTopp 15:")
    for r in df.head(15).itertuples():
        print(f"  {r.rank:>3}. {r.ticker:<6} förväntad {r.förväntad_avkastning * 100:+5.0f} %   "
              f"kvalitet {r.kvalitetspoäng:>3}   {str(r.namn)[:30]}")

    ai = {}
    if a.ai_top > 0:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("\n(Ingen ANTHROPIC_API_KEY - hoppar över steg 2.)")
        else:
            # AI på toppen av listan 1–3 år (samma antal analyser som tidigare)
            top = horizon_lists(df, a.min_quality)["mellan"]["ticker"].head(a.ai_top).tolist()
            print(f"\nSteg 2: AI djupanalyserar topp {a.ai_top} på listan 1–3 år")
            for tk in top:
                try:
                    r = A.analyze(tk, a.demo, True)
                    if r["ai"]:
                        ai[tk] = r["ai"]
                except Exception as e:
                    print(f"  Fel för {tk}: {e}")

    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(html(df, ai, a, len(tickers), f"{year}–{year + 1}"))
    with open(a.out.replace(".html", "_ai.json"), "w", encoding="utf-8") as fh:
        json.dump(ai, fh, ensure_ascii=False)
    print(f"\nRapport: {os.path.abspath(a.out)}")
    print(f"Alla rader (CSV): {os.path.abspath(a.out.replace('.html', '.csv'))}")


if __name__ == "__main__":
    sys.exit(main())
