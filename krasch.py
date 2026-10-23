#!/usr/bin/env python3
"""
Krasch-mätaren: följer 17 varningssignaler för den amerikanska börsen och väger ihop dem
till en risk 0–100 med ett råd (köp som vanligt / försiktig / sälj delvis).

Data (gratis, ingen AI):
  FRED (USA:s centralbank i St. Louis): räntekurva, arbetslöshet, a-kassa, bygglov, inflation,
    styrränta, kreditspread, finansiella förhållanden, börsvärde och BNP.
  Yahoo Finance: S&P 500, VIX, branscher, koppar, guld, dollarn, P/E.

Samma regler räknas bakåt till 1990 så att man kan se hur mätaren betett sig före tidigare ras.
Data som släpps i efterhand (t.ex. arbetslöshet) flyttas fram till dagen den blev känd,
så att testet inte fuskar genom att "se in i framtiden".

  python krasch.py          # riktig data, skriver docs/data/krasch.json
  python krasch.py --demo   # påhittad data, inget internet
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "docs", "data", "krasch.json")
START = "1985-01-01"
VISA_FRAN = "1990-01-01"

FRED = ["T10Y3M", "BAA10Y", "UNRATE", "ICSA", "NFCI", "FEDFUNDS", "CPIAUCSL", "PERMIT", "NCBEILQ027S", "GDP"]
SEKTORER = ["XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"]
YAHOO = ["^GSPC", "^VIX", "^VIX3M", "RSP", "SPY", "HG=F", "GC=F", "DX-Y.NYB"] + SEKTORER

# Zoner: gräns för gul, orange, röd. Hysteres: läget byts först när poängen gått HYST förbi gränsen.
TRÖSKLAR = [35, 50, 65]
HYST = 2
ZONER = [
    ("gron", "Grönt", "Köp som vanligt",
     "Inga tydliga varningstecken. Fortsätt köpa enligt din plan."),
    ("gul", "Gult", "Köp i mindre portioner",
     "Några varningstecken. Fortsätt köpa, men i mindre portioner, och ha lite pengar i reserv."),
    ("orange", "Orange", "Var försiktig",
     "Flera varningstecken. Köp inte mer av dina mest riskfyllda aktier och fundera på att sälja en del av dem."),
    ("rod", "Rött", "Minska risken",
     "Många varningstecken samtidigt. Sälj delvis riskfyllda aktier (risknivå 7–10), behåll kvalitetsbolag och ha pengar redo att köpa billigt senare."),
]

GRUPPER = [
    ("vardering", "Hur dyr är börsen?", "Säger hur långt börsen kan falla – men inte när."),
    ("ekonomi", "Ekonomin", "Varnar för lågkonjunktur. Ras blir ofta störst när ekonomin krymper."),
    ("pengar", "Pengar och lån", "När det blir svårt och dyrt att låna brukar börsen falla."),
    ("borsen", "Börsens egna signaler", "Hur börsen själv beter sig. Reagerar snabbast."),
]


# ---------------------------------------------------------------------------
# Hämta data
# ---------------------------------------------------------------------------
def fred(sid: str):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={START}"
    err = None
    for i in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (aktieagent)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                df = pd.read_csv(io.StringIO(r.read().decode("utf-8")))
            s = pd.Series(pd.to_numeric(df.iloc[:, 1], errors="coerce").values, index=pd.to_datetime(df.iloc[:, 0])).dropna()
            if len(s):
                return s.sort_index()
            err = "tom serie"
        except Exception as e:  # noqa: BLE001
            err = e
        time.sleep(4 * (i + 1))
    print(f"::warning::FRED {sid} kunde inte hämtas: {err}")
    return None


def yahoo(t: str):
    import yfinance as yf
    err = None
    for i in range(3):
        try:
            df = yf.download(t, start=START, auto_adjust=True, progress=False, threads=False)
            c = df["Close"]
            if isinstance(c, pd.DataFrame):
                c = c.iloc[:, 0]
            c = c.dropna()
            if len(c):
                idx = pd.to_datetime(c.index)
                c.index = idx.tz_localize(None) if idx.tz is not None else idx
                return c.sort_index()
            err = "tom serie"
        except Exception as e:  # noqa: BLE001
            err = e
        time.sleep(3 * (i + 1))
    print(f"::warning::Yahoo {t} kunde inte hämtas: {err}")
    return None


def spy_pe():
    try:
        import yfinance as yf
        pe = yf.Ticker("SPY").info.get("trailingPE")
        return float(pe) if pe and 5 < float(pe) < 80 else None
    except Exception:  # noqa: BLE001
        return None


def hamta():
    f = {s: fred(s) for s in FRED}
    y = {t: yahoo(t) for t in YAHOO}
    return f, y, spy_pe()


def demo():
    """Påhittad men rimlig data för test utan internet. Två ras läggs in (2008 och 2020)."""
    rng = np.random.default_rng(7)
    today = pd.Timestamp.today().normalize()
    d = pd.bdate_range(START, today)
    r = rng.normal(0.00035, 0.011, len(d))
    for a, b, k in (("2007-10-10", "2009-03-06", -0.0028), ("2020-02-20", "2020-03-23", -0.016), ("2000-03-24", "2002-10-09", -0.0011)):
        m = (d >= a) & (d <= b)
        r[m] += k
    spx = pd.Series(180 * np.exp(np.cumsum(r)), d)

    def ar(level, vol, idx, k=0.02):
        x = np.empty(len(idx))
        x[0] = level
        e = rng.normal(0, vol, len(idx))
        for i in range(1, len(idx)):
            x[i] = x[i - 1] + k * (level - x[i - 1]) + e[i]
        return pd.Series(x, idx)

    y = {"^GSPC": spx, "SPY": spx / 10, "^VIX": ar(18, 1.2, d).clip(9), "^VIX3M": ar(19, 0.8, d).clip(10)["2007-01-01":],
         "RSP": (spx * ar(1, 0.002, d).clip(0.5))["2003-05-01":], "HG=F": ar(3, 0.03, d).clip(1)["2000-08-01":],
         "GC=F": ar(1500, 8, d).clip(300)["2000-08-01":], "DX-Y.NYB": ar(95, 0.3, d)}
    for s in SEKTORER:
        y[s] = (spx * ar(1, 0.004, d).clip(0.3))["1998-12-22":]
    m = pd.date_range(START, today, freq="MS")
    w = pd.date_range(START, today, freq="W-SAT")
    q = pd.date_range(START, today, freq="QS")
    gdp = pd.Series(4300 * np.exp(0.0125 * np.arange(len(q))), q)
    eq = gdp * 1000 * 0.9 * (spx.reindex(q, method="ffill") / spx.reindex(q, method="ffill").iloc[0]) / np.exp(0.0125 * np.arange(len(q)))
    f = {"T10Y3M": ar(1.5, 0.04, d), "BAA10Y": ar(2.3, 0.03, d).clip(0.8), "UNRATE": ar(5.5, 0.12, m).clip(3).round(1),
         "ICSA": ar(350000, 9000, w).clip(150000), "NFCI": ar(-0.3, 0.04, w), "FEDFUNDS": ar(3, 0.2, m).clip(0.05),
         "CPIAUCSL": pd.Series(100 * np.exp(np.cumsum(rng.normal(0.0025, 0.002, len(m)))), m), "PERMIT": ar(1400, 45, m).clip(400),
         "NCBEILQ027S": eq.bfill(), "GDP": gdp}
    return f, y, 24.5


# ---------------------------------------------------------------------------
# Hjälpfunktioner
# ---------------------------------------------------------------------------
def lin(x, xs, ys):
    """Linjär skala mellan punkter, platt utanför. Behåller NaN."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    if xs[0] > xs[-1]:
        xs, ys = xs[::-1], ys[::-1]
    a = np.asarray(x, float)
    out = np.interp(np.nan_to_num(a, nan=xs[0]), xs, ys)
    out = np.where(np.isnan(a), np.nan, out)
    return pd.Series(out, index=x.index) if isinstance(x, pd.Series) else out


def pctl(series: pd.Series, value) -> float | None:
    s = series.dropna()
    if not len(s) or value is None or not np.isfinite(value):
        return None
    return float((s < value).mean())


def fnum(x, d=1):
    return f"{x:.{d}f}".replace(".", ",").replace("-", "−")


def fsign(x, d=1):
    return ("+" if x >= 0 else "−") + f"{abs(x):.{d}f}".replace(".", ",")


# ---------------------------------------------------------------------------
# Signalerna
# ---------------------------------------------------------------------------
def berakna(f: dict, y: dict, pe_nu):
    spx_d = y.get("^GSPC")
    if spx_d is None or len(spx_d) < 600:
        raise SystemExit("::error::S&P 500 saknas – kan inte räkna.")
    W = pd.date_range(pd.Timestamp(START) + pd.Timedelta(days=7), spx_d.index[-1] + pd.offsets.Week(weekday=4, n=0), freq="W-FRI")

    def wk(s, lag=0):
        if s is None or not len(s):
            return pd.Series(np.nan, index=W)
        s = s.copy()
        s.index = s.index + pd.Timedelta(days=lag)
        s = s[~s.index.duplicated(keep="last")]
        return s.reindex(s.index.union(W)).ffill().reindex(W)

    spx = wk(spx_d)
    I = {}  # id -> dict(raw, risk, extra)

    # --- Värdering ---
    eq, gdp = f.get("NCBEILQ027S"), f.get("GDP")
    if eq is not None and gdp is not None:
        q = (eq / (gdp.reindex(eq.index) * 1000) * 100).dropna()
        rel = q.index + pd.Timedelta(days=168)  # kvartalet + ca 11 veckor tills siffran publiceras
        qend = q.index + pd.offsets.QuarterEnd(0)
        spx_qe = spx_d.reindex(spx_d.index.union(qend)).ffill().reindex(qend).values
        base = pd.Series(q.values / spx_qe, index=rel)
        b = wk(base) * spx  # skrivs fram med börsens rörelse sedan kvartalets slut
        I["buffett"] = dict(raw=b, risk=lin(b, [80, 120, 170, 210], [10, 45, 75, 90]))
    pe = pd.Series(np.nan, index=W)
    if pe_nu:
        pe.iloc[-1] = pe_nu
        I["pe"] = dict(raw=pe, risk=lin(pe, [16, 20, 25, 32], [10, 30, 60, 90]))

    # --- Ekonomin ---
    c = wk(f.get("T10Y3M"), 1)
    if c.notna().any():
        minpast = c.rolling(78, min_periods=1).min()
        nyss = (minpast < -0.2) & (c >= 0)
        risk = np.where(c < 0, lin(c, [0, -0.5, -1.2], [60, 70, 80]), np.where(nyss, 80, lin(c, [0, 0.5, 1.5], [45, 25, 10])))
        I["kurva"] = dict(raw=c, risk=pd.Series(np.where(c.isna(), np.nan, risk), index=W), nyss=nyss)
    u = f.get("UNRATE")
    if u is not None:
        m3 = u.rolling(3).mean()
        s = wk(m3 - m3.shift(1).rolling(12).min(), 36)
        I["sahm"] = dict(raw=s, risk=lin(s, [0.1, 0.3, 0.5], [10, 50, 95]))
    ic = f.get("ICSA")
    if ic is not None:
        a4 = ic.rolling(4).mean()
        r = wk(a4 / a4.rolling(52).min() - 1, 6)
        I["ansokningar"] = dict(raw=r, risk=lin(r, [0.05, 0.15, 0.30], [10, 50, 90]))
    p = f.get("PERMIT")
    if p is not None:
        a3 = p.rolling(3).mean()
        r = wk(a3 / a3.shift(12) - 1, 50)
        I["bygglov"] = dict(raw=r, risk=lin(r, [0, -0.10, -0.25], [10, 50, 90]))
    cpi = f.get("CPIAUCSL")
    if cpi is not None:
        r = wk(cpi / cpi.shift(12) - 1, 45)
        I["inflation"] = dict(raw=r, risk=lin(r, [0.025, 0.04, 0.06], [10, 45, 80]))
    ff = f.get("FEDFUNDS")
    if ff is not None:
        r = wk(ff - ff.shift(12), 31)
        I["fed"] = dict(raw=r, risk=lin(r, [0, 1, 2.5], [15, 50, 85]), niva=wk(ff, 31))

    # --- Pengar och lån ---
    k = wk(f.get("BAA10Y"), 1)
    if k.notna().any():
        chg = k - k.shift(13)
        I["kredit"] = dict(raw=k, risk=np.fmax(lin(k, [2.0, 2.8, 3.5], [10, 45, 85]), lin(chg, [0, 0.3, 0.8], [10, 50, 95])), chg=chg)
    n = wk(f.get("NFCI"), 7)
    if n.notna().any():
        chg = n - n.shift(13)
        I["nfci"] = dict(raw=n, risk=np.fmax(lin(n, [-0.5, -0.2, 0.3], [10, 40, 90]), lin(chg, [0, 0.2, 0.5], [10, 50, 90])))
    dx = wk(y.get("DX-Y.NYB"))
    if dx.notna().any():
        chg = dx / dx.shift(13) - 1
        I["dollar"] = dict(raw=chg, risk=lin(chg, [0.01, 0.04, 0.08], [10, 45, 80]))

    # --- Börsens egna signaler ---
    ma200 = spx_d.rolling(200).mean()
    dist_d = spx_d / ma200 - 1
    dist = wk(dist_d)
    slope = wk(ma200 / ma200.shift(20) - 1)
    tr = np.where(dist < 0, lin(dist, [0, -0.05, -0.12], [55, 75, 90]) + np.where(slope < 0, 10, 0), lin(dist, [0, 0.04], [35, 10]))
    I["trend"] = dict(raw=dist, risk=pd.Series(np.where(dist.isna(), np.nan, np.minimum(tr, 95)), index=W))
    ret12 = wk(spx_d / spx_d.shift(252) - 1)
    I["hype"] = dict(raw=ret12, risk=np.fmax(lin(ret12, [0.15, 0.30, 0.45], [10, 50, 85]), lin(dist, [0.08, 0.15, 0.22], [10, 50, 85])), dist=dist)
    v, v3 = wk(y.get("^VIX")), wk(y.get("^VIX3M"))
    if v.notna().any():
        base = lin(v, [11, 13, 16, 22, 30, 40], [30, 15, 15, 45, 80, 95])
        term = lin(v / v3, [0.9, 1.0, 1.1], [15, 60, 90])
        I["vix"] = dict(raw=v, risk=pd.Series(np.fmax(base, np.where(np.isnan(term), base, term)), index=W), v3=v3)
    sek = pd.DataFrame({s: y[s] for s in SEKTORER if y.get(s) is not None})
    if len(sek.columns):
        upp = (sek > sek.rolling(200).mean()).astype(float).where(sek.rolling(200).mean().notna())
        andel = upp.mean(axis=1).where(upp.notna().sum(axis=1) >= 5)
        a = wk(andel)
        rr = wk(y.get("RSP")) / wk(y.get("SPY"))
        rchg = rr / rr.shift(26) - 1
        risk = np.fmax(lin(a, [0.33, 0.55, 0.8], [90, 50, 10]), lin(rchg, [-0.08, -0.04, 0], [85, 50, 15]))
        I["bredd"] = dict(raw=a, risk=risk, rchg=rchg)
    if y.get("XLP") is not None and y.get("XLY") is not None:
        r = wk(y["XLP"]) / wk(y["XLY"])
        chg = r / r.shift(13) - 1
        I["defensiv"] = dict(raw=chg, risk=lin(chg, [-0.02, 0.04, 0.10], [10, 50, 90]))
    if y.get("HG=F") is not None and y.get("GC=F") is not None:
        r = wk(y["HG=F"]) / wk(y["GC=F"])
        chg = r / r.shift(26) - 1
        I["koppar"] = dict(raw=chg, risk=lin(chg, [0, -0.10, -0.20], [15, 50, 85]))

    return W, spx, spx_d, I


# Namn, grupp, vikt, förklaring och hur nuläget beskrivs
def _kurva_nu(x, e, i):
    if x < 0:
        return f"Kurvan är vänd ({fsign(x, 2)} procentenheter). Det är en klassisk varning för lågkonjunktur."
    if bool(e["nyss"].iloc[i]):
        return f"Kurvan var nyss vänd och har vänt tillbaka ({fsign(x, 2)}). Historiskt har ras ofta kommit just i den här fasen."
    return f"Kurvan är normal ({fsign(x, 2)} procentenheter)."


META = {
    "buffett": ("Börsvärde mot ekonomin", "vardering", 1.0,
                "Hela börsens värde delat med hur mycket USA:s ekonomi (BNP) producerar på ett år. Kallas Buffett-indikatorn. Exempel: ett café som kostar 2 gånger sin årsförsäljning är dyrare än ett som kostar 1 gång.",
                lambda x, e, i: f"Börsen är värd {fnum(x, 0)} % av ekonomin."),
    "pe": ("P/E-tal för S&P 500", "vardering", 0.7,
           "Hur många års vinst du betalar för börsen. Historiskt har det oftast legat runt 15–20. Exempel: P/E 30 betyder att det tar 30 år för företagen att tjäna ihop det du betalar.",
           lambda x, e, i: f"P/E är {fnum(x, 1)}."),
    "kurva": ("Räntekurvan", "ekonomi", 1.5,
              "Skillnaden mellan räntan på 10 år och på 3 månader. Normalt är den långa räntan högre. När den korta blir högre (kurvan 'vänds') har en lågkonjunktur nästan alltid följt inom 6–24 månader.",
              _kurva_nu),
    "sahm": ("Arbetslösheten stiger (Sahm-regeln)", "ekonomi", 1.5,
             "Mäter hur snabbt arbetslösheten stiger jämfört med årets lägsta nivå. Når den 0,5 har USA nästan alltid redan varit i lågkonjunktur.",
             lambda x, e, i: f"Värdet är {fnum(x, 2)}" + (" – över larmgränsen 0,5." if x >= 0.5 else " (larm vid 0,5).")),
    "ansokningar": ("Nya arbetslösa varje vecka", "ekonomi", 1.0,
                    "Hur många som söker a-kassa varje vecka. Stiger det snabbt har företagen börjat säga upp folk.",
                    lambda x, e, i: f"{fnum(x * 100, 0)} % över årets lägsta nivå."),
    "bygglov": ("Bygglov för bostäder", "ekonomi", 0.7,
                "När färre nya bostäder planeras tror byggföretagen på sämre tider. Bygglov brukar falla långt före en lågkonjunktur.",
                lambda x, e, i: f"{fsign(x * 100, 0)} % jämfört med för ett år sedan."),
    "inflation": ("Inflation", "ekonomi", 0.7,
                  "Hur snabbt priserna stiger. Hög inflation tvingar centralbanken att höja räntan, vilket brukar pressa börsen.",
                  lambda x, e, i: f"Priserna stiger {fnum(x * 100, 1)} % per år."),
    "fed": ("Styrräntan (Fed)", "ekonomi", 0.8,
            "Räntan som USA:s centralbank bestämmer. Snabba höjningar gör lån dyra och kom före flera ras, t.ex. 2000, 2007 och 2022.",
            lambda x, e, i: f"{fsign(x, 2)} procentenheter senaste året (nu {fnum(e['niva'].iloc[i], 2)} %)."),
    "kredit": ("Ränta på företagslån", "pengar", 1.5,
               "Hur mycket mer ränta vanliga företag får betala än staten. Stiger den är långivarna rädda – det märks ofta före börsen.",
               lambda x, e, i: f"{fnum(x, 2)} procentenheter, {fsign(e['chg'].iloc[i], 2)} på 3 månader."),
    "nfci": ("Hur lätt det är att låna", "pengar", 1.0,
             "Chicago Fed:s mått (NFCI) på hur lätt företag och hushåll kan låna. Under 0 = lättare än normalt, över 0 = svårare.",
             lambda x, e, i: f"Värdet är {fsign(x, 2)}."),
    "dollar": ("Dollarn", "pengar", 0.4,
               "När dollarn stiger snabbt blir det dyrt för resten av världen att betala lån i dollar. Det kan skapa stress.",
               lambda x, e, i: f"{fsign(x * 100, 1)} % på 3 månader."),
    "trend": ("Trend (200-dagars snitt)", "borsen", 1.5,
              "Jämför börsen med snittet de senaste 200 dagarna. Under snittet = nedåttrend. De flesta stora ras har pågått under snittet.",
              lambda x, e, i: f"S&P 500 är {fsign(x * 100, 1)} % från snittet."),
    "bredd": ("Hur brett börsen stiger", "borsen", 1.0,
              "Hur många av börsens 9 stora branscher som är i upptrend. Om bara några få jättebolag drar upp börsen är uppgången svag.",
              lambda x, e, i: f"{fnum(x * 100, 0)} % av branscherna är i upptrend."),
    "defensiv": ("Flykt till säkra aktier", "borsen", 0.7,
                 "Jämför 'tråkiga' aktier (mat, hygien) med 'roliga' (shopping, bilar). När de tråkiga vinner har stora placerare börjat bli rädda.",
                 lambda x, e, i: f"Säkra aktier {fsign(x * 100, 1)} % mot de roliga på 3 månader."),
    "koppar": ("Koppar mot guld", "borsen", 0.5,
               "Koppar används i fabriker och byggen, guld köps när folk är oroliga. Faller koppar mot guld tror marknaden på sämre tider.",
               lambda x, e, i: f"{fsign(x * 100, 0)} % på 6 månader."),
    "vix": ("Rädsla (VIX)", "borsen", 1.0,
            "Mäter hur mycket placerarna tror att börsen ska svänga. Över 30 = rädsla. Väldigt lågt (under 12) kan betyda att alla är för lugna.",
            lambda x, e, i: f"VIX är {fnum(x, 1)}." + (" Den kortsiktiga rädslan är högre än den långsiktiga – akut stress." if np.isfinite(e["v3"].iloc[i]) and x > e["v3"].iloc[i] else "")),
    "hype": ("Hype (för snabb uppgång)", "borsen", 0.8,
             "När börsen stigit mycket på kort tid köper många för att 'inte missa'. Då räcker lite dåliga nyheter för ett ras.",
             lambda x, e, i: f"S&P 500 har gått {fsign(x * 100, 0)} % på ett år."),
}


def status(r):
    return "gron" if r < 35 else "gul" if r < 60 else "rod"


def zon_index(p, forra=None):
    z = sum(p >= t for t in TRÖSKLAR)
    if forra is not None and z != forra:
        # Hysteres: byt bara läge om poängen gått tydligt förbi gränsen
        grans = TRÖSKLAR[min(z, forra)]
        if abs(p - grans) < HYST:
            return forra
    return z


def poang(W, I):
    R = pd.DataFrame({k: pd.Series(np.asarray(e["risk"], float), index=W) for k, e in I.items()})
    w = pd.Series({k: META[k][2] for k in R.columns})
    have = R.notna()
    wmean = (R.fillna(0) * w).sum(axis=1) / (have * w).sum(axis=1)
    top3 = R.apply(lambda r: np.nanmean(np.sort(r.dropna().values)[-3:]) if r.notna().sum() >= 3 else np.nan, axis=1)
    s = 0.65 * wmean + 0.35 * top3
    return s.where(have.sum(axis=1) >= 6), R


def framat(spx: pd.Series):
    fwd12 = spx.shift(-52) / spx - 1
    fut = spx.shift(-1)
    fmin = fut[::-1].rolling(52, min_periods=52).min()[::-1] / spx - 1
    return fwd12, fmin


def kopl(spx_w, vix_w):
    dd = spx_w / spx_w.rolling(52, min_periods=1).max() - 1
    panik = (dd <= -0.20) & (vix_w >= 30)
    rea = (dd <= -0.10) & (vix_w >= 25) & ~panik
    return dd, rea, panik


def krascher(spx, score, grans):
    out, peak, pdate, inside, trough, tdate = [], spx.iloc[0], spx.index[0], False, None, None
    for d, v in spx.items():
        if not np.isfinite(v):
            continue
        if v >= peak:
            if inside:
                out.append((pdate, tdate, trough / peak - 1))
                inside = False
            peak, pdate = v, d
        elif v / peak - 1 <= -0.15:
            if not inside:
                inside, trough, tdate = True, v, d
            if v < trough:
                trough, tdate = v, d
    if inside:
        out.append((pdate, tdate, trough / peak - 1))
    rows = []
    for p, t, fall in out:
        fore = score[(score.index > p - pd.Timedelta(weeks=26)) & (score.index <= p)]
        varn = float(fore.max()) if fore.notna().any() else None
        # Första veckan efter toppen då mätaren nådde orange
        efter = score[(score.index > p) & (score.index <= t)]
        larm = efter[efter >= grans]
        rows.append({"topp": p.strftime("%Y-%m-%d"), "botten": t.strftime("%Y-%m-%d"), "fall": round(float(fall), 3),
                     "fore": None if varn is None else round(varn), "vid_topp": None if pd.isna(score.get(p)) else round(float(score.get(p))),
                     "varnade": varn is not None and varn >= grans,
                     "larm_efter": None if not len(larm) else round(float(spx[larm.index[0]] / spx[p] - 1), 3)})
    return rows


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument("--demo", action="store_true")
    a.add_argument("--out", default=OUT)
    args = a.parse_args()

    forra = None
    try:
        with open(args.out, encoding="utf-8") as fh:
            forra = json.load(fh)
    except Exception:  # noqa: BLE001
        pass

    f, y, pe_nu = demo() if args.demo else hamta()
    W, spx, spx_d, I = berakna(f, y, pe_nu)
    score, R = poang(W, I)
    fwd12, fmin = framat(spx)
    vix_w = I["vix"]["raw"] if "vix" in I else pd.Series(np.nan, index=W)
    dd, rea, panik = kopl(spx, vix_w)

    # Historiskt test från 1990
    mask = (W >= VISA_FRAN) & score.notna()
    S = score[mask]
    zon_h = S.apply(lambda p: sum(p >= t for t in TRÖSKLAR))
    klar = fwd12[mask].notna()
    kr = (fmin[mask] <= -0.15)
    zstat = []
    for zi, (zid, znamn, *_rest) in enumerate(ZONER):
        m = (zon_h == zi) & klar
        zstat.append({"zon": zid, "namn": znamn, "andel": round(float((zon_h == zi).mean()), 3), "veckor": int(m.sum()),
                      "snitt12": None if not m.any() else round(float(fwd12[mask][m].mean()), 3),
                      "krasch": None if not m.any() else round(float(kr[m].mean()), 3)})
    bas = {"snitt12": round(float(fwd12[mask][klar].mean()), 3), "krasch": round(float(kr[klar].mean()), 3)}
    def kstat(flag):
        m = flag[mask] & klar
        return None if not m.any() else {"veckor": int(m.sum()), "snitt12": round(float(fwd12[mask][m].mean()), 3),
                                         "andel_upp": round(float((fwd12[mask][m] > 0).mean()), 3)}

    # Nuläget
    i = len(W) - 1
    while i > 0 and pd.isna(score.iloc[i]):
        i -= 1
    p_nu = float(score.iloc[i])
    zf = None
    if forra and forra.get("zon") in [z[0] for z in ZONER]:
        zf = [z[0] for z in ZONER].index(forra["zon"])
    zi = zon_index(p_nu, zf)
    zid, znamn, rubrik, rad = ZONER[zi]
    i4 = max(0, i - 4)

    grupper = []
    for gid, gnamn, gtext in GRUPPER:
        ind = []
        for k, (namn, grupp, vikt, forkl, nu) in META.items():
            if grupp != gid:
                continue
            if k not in I:
                ind.append({"id": k, "namn": namn, "förklaring": forkl, "saknas": True})
                continue
            e = I[k]
            raw = e["raw"]
            x = raw.iloc[i]
            r = float(np.asarray(e["risk"], float)[i]) if np.isfinite(np.asarray(e["risk"], float)[i]) else None
            if r is None or not np.isfinite(x):
                ind.append({"id": k, "namn": namn, "förklaring": forkl, "saknas": True})
                continue
            hist = raw[(W >= VISA_FRAN)].iloc[:-1] if k != "pe" else pd.Series(dtype=float)
            p = pctl(hist, x)
            serie = raw.iloc[max(0, i - 155): i + 1]
            ind.append({"id": k, "namn": namn, "vikt": vikt, "risk": round(r), "status": status(r), "förklaring": forkl,
                        "nu": nu(float(x), e, i), "percentil": None if p is None else round(p, 2),
                        "serie": [None if not np.isfinite(v) else round(float(v), 4) for v in serie.values]})
        rs = [x["risk"] for x in ind if not x.get("saknas")]
        ws = [x["vikt"] for x in ind if not x.get("saknas")]
        grupper.append({"id": gid, "namn": gnamn, "text": gtext, "indikatorer": ind,
                        "poäng": None if not rs else round(float(np.average(rs, weights=ws)))})

    alla = [x for g in grupper for x in g["indikatorer"] if not x.get("saknas")]
    kl = "panik" if bool(panik.iloc[i]) else "rea" if bool(rea.iloc[i]) else None
    hz = [z for z in zstat if z["zon"] == zid][0]
    H = score[(W >= VISA_FRAN)]
    out = {
        "uppdaterad": spx_d.index[-1].strftime("%Y-%m-%d"),
        "skapad": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "demo": bool(args.demo),
        "poäng": round(p_nu), "förändring": None if pd.isna(score.iloc[i4]) else round(p_nu - float(score.iloc[i4])),
        "zon": zid, "zonnamn": znamn, "rubrik": rubrik, "råd": rad, "trösklar": TRÖSKLAR,
        "antal": {"gron": sum(x["status"] == "gron" for x in alla), "gul": sum(x["status"] == "gul" for x in alla),
                  "rod": sum(x["status"] == "rod" for x in alla), "totalt": len(alla)},
        "historiskt": hz, "bas": bas, "zoner": zstat,
        "köpläge": {"nivå": kl, "fall": round(float(dd.iloc[i]), 3), "vix": None if not np.isfinite(vix_w.iloc[i]) else round(float(vix_w.iloc[i]), 1),
                    "rea": kstat(rea), "panik": kstat(panik)},
        "grupper": grupper,
        "krascher": krascher(spx[W >= VISA_FRAN], score, TRÖSKLAR[1]),
        "historik": {"datum": [d.strftime("%Y-%m-%d") for d in H.index],
                     "poäng": [None if pd.isna(v) else round(float(v), 1) for v in H.values],
                     "spx": [round(float(v), 1) for v in spx[W >= VISA_FRAN].values]},
        "seriedatum": [d.strftime("%Y-%m-%d") for d in W[max(0, i - 155): i + 1]],
        "saknas": [k for k in META if k not in I],
    }
    if out["historik"]["datum"]:
        out["historik"]["datum"][-1] = out["uppdaterad"]
        out["seriedatum"][-1] = out["uppdaterad"]

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    # Sammanfattning (syns i GitHub Actions)
    print(f"::notice title=Krasch-mätaren::{out['poäng']}/100 {znamn} ({out['uppdaterad']}) · grön {out['antal']['gron']} gul {out['antal']['gul']} röd {out['antal']['rod']} · köpläge {kl}")
    print("::notice title=Signaler::" + " | ".join(f"{x['id']} {x['risk']} ({x['nu']})" for x in alla))
    print("::notice title=Zoner::" + " | ".join(f"{z['namn']} {z['andel']:.0%} snitt12 {z['snitt12']} krasch {z['krasch']}" for z in zstat if z['snitt12'] is not None) + f" | bas {bas}")
    print("::notice title=Ras::" + " | ".join(f"{c['topp']} {c['fall']:.0%} före {c['fore']} topp {c['vid_topp']} larm_efter {c['larm_efter']}" for c in out["krascher"]))
    print(f"::notice title=Köpläge::rea {out['köpläge']['rea']} panik {out['köpläge']['panik']} saknas {out['saknas']}")

    # Larm när läget ändras (skickas som GitHub-ärende = mejl)
    gh = os.environ.get("GITHUB_OUTPUT")
    if forra and not args.demo and gh:
        andrat = forra.get("zon") != zid
        nytt_kop = kl and forra.get("köpläge", {}).get("nivå") != kl
        if andrat or nytt_kop:
            pil = "↑" if zf is not None and zi > zf else "↓"
            titel = f"Krasch-mätaren: {znamn} ({out['poäng']}/100)" + (f" {pil} från {forra.get('zonnamn')}" if andrat else "") + (" · Köpläge!" if nytt_kop else "")
            rader = [f"**{rubrik}.** {rad}", "", f"Risk: {out['poäng']}/100 (var {forra.get('poäng')}).",
                     f"Signaler: {out['antal']['rod']} röda, {out['antal']['gul']} gula, {out['antal']['gron']} gröna."]
            if nytt_kop:
                rader += ["", "Börsen har fallit mycket och många är rädda. Historiskt har det ofta varit ett bra läge att köpa – i omgångar."]
            rader += ["", "Röda signaler:"] + [f"- {x['namn']}: {x['nu']}" for x in alla if x["status"] == "rod"]
            rader += ["", "Öppna appen → Marknad för hela bilden. Inte finansiell rådgivning."]
            with open(os.path.join(ROOT, "larm.md"), "w", encoding="utf-8") as fh:
                fh.write("\n".join(rader))
            with open(gh, "a", encoding="utf-8") as fh:
                fh.write(f"larm=1\ntitel={titel}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
