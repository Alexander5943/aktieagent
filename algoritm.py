#!/usr/bin/env python3
"""
Algoritmen: en datormodell som lär sig av historiska kurser vilka aktier som brukar gå bäst
den närmaste månaden, och som fattar beslut (köp / behåll / sälj) utifrån det.

Så fungerar den
  1. Data      Dagliga kurser och omsättning för alla aktier som varit med i S&P 500 sedan 2005
               (Yahoo Finance). Vilka bolag som var med vid varje tidpunkt kommer från en öppen
               lista (github.com/fja05680/sp500), så att modellen inte får "veta" i förväg vilka
               bolag som senare blev stora.
  2. Faktorer  19 mått per aktie och månad: trend, senaste veckorna, svängningar, handel,
               reaktion på senaste rapporten, säsong och bransch. Varje mått görs om till en
               rangordning mellan aktierna den dagen.
  3. Modell    En vägd poäng (ridge-regression) och beslutsträd (gradient boosting) tränas att
               förutse vilka aktier som går bättre än de andra den kommande månaden.
  4. Test      Modellen tränas bara på data FÖRE varje testår och prövas sedan på året efter
               (walk-forward), med 0,3 % avgift per affär. Resultatet visas i appen.
  5. Beslut    Varje månad väljs de 20 högst rankade aktierna (högst 5 per bransch). En aktie
               säljs först när den fallit ur de 60 bästa. Beslutet tas på månadens första
               handelsdag och genomförs till stängningskursen dagen efter.

Ingen AI används – körningen är gratis. Skriver docs/data/algoritm.json.

  python algoritm.py            # riktig data
  python algoritm.py --demo     # påhittad data, inget internet

Inte finansiell rådgivning. Historiska resultat är ingen garanti för framtiden.
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import os
import re
import sys
import time
import urllib.request
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "docs", "data", "algoritm.json")
KRASCH = os.path.join(ROOT, "docs", "data", "krasch.json")
NU_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
HIST_URL = "https://raw.githubusercontent.com/fja05680/sp500/master/S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv"
MIN_KVOT = 0.03        # skydd mot fel bolag under samma kortnamn: ett indexbolag handlas aldrig för mindre än 3 % av medianbolaget
FEL_DATA = {"PARA"}    # kortnamn där Yahoo har trasig data
# Bolag som bytt kortnamn: gammalt namn -> det namn Yahoo har kurserna under idag
ALIAS = {
    "FB": "META", "PCLN": "BKNG", "ANTM": "ELV", "WLP": "ELV", "HCN": "WELL", "KORS": "CPRI", "COG": "CTRA", "RE": "EG", "PKI": "RVTY",
    "ABC": "COR", "FLT": "CPAY", "WLTW": "WTW", "BLL": "BALL", "DISCA": "WBD", "TMK": "GL", "LUK": "JEF", "HRS": "LHX", "SYMC": "GEN",
    "NLOK": "GEN", "UTX": "RTX", "CTL": "LUMN", "MYL": "VTRS", "JEC": "J", "BBT": "TFC", "ADS": "BFH", "FBHS": "FBIN", "GPS": "GAP",
    "HFC": "DINO", "LB": "BBWI", "COH": "TPR", "WYN": "TNL", "KFT": "MDLZ", "DPS": "KDP", "PX": "LIN", "HCP": "DOC", "PEAK": "DOC",
    "CBG": "CBRE", "BHGE": "BKR", "BHI": "BKR", "ZMH": "ZBH", "DLPH": "APTV", "FI": "FISV", "FISV": "FI", "CDAY": "DAY", "ARNC": "HWM",
}

START = "2004-01-01"   # kursdata hämtas härifrån
TEST_FRAN = 2010       # första testår (åren före används bara för träning)
N_INNEHAV = 20         # antal aktier i algoritmens portfölj
BUFFERT = 60           # en aktie behålls så länge den är bland de 60 bästa
MAX_SEKTOR = 5         # högst så många aktier per bransch
KOSTNAD = 0.003        # avgift per köp eller sälj (courtage + valutaväxling)
KOP_P, SALJ_P = 90, 20  # poäng (0–100) för Köp respektive Sälj
VAL = "ens"            # modell som används: "ridge", "gbm" eller "ens" (snittet av båda)
HORISONTER = (1, 3, 6)  # månader framåt som sparas i träningsdatan
HORISONT = 1           # så många månader framåt modellen tränas att förutse
JUSTERA = False        # räkna bort börsens rörelse ur målet (se satt_mal)
RIDGE_L = 0.02
MIN_OMS, MIN_KURS = 5e6, 2.0   # övriga aktier: minst så stor daglig handel ($) och kurs

# Faktorerna och vilket tema de hör till
FAKTORER = [
    ("m12", "trend"), ("m6", "trend"), ("rjm", "trend"), ("topp", "trend"), ("ma200", "trend"), ("jamn", "trend"),
    ("m1", "rekyl"), ("v1", "rekyl"), ("max1", "rekyl"),
    ("vol3", "risk"), ("vol12", "risk"), ("beta", "risk"), ("ivol", "risk"), ("ras", "risk"),
    ("oms", "handel"),
    ("hopp", "rapport"), ("sasong", "sasong"), ("sektor", "bransch"),
]
FID = [f for f, _ in FAKTORER]
FNAMN = {
    "m12": "Kurs senaste året", "m6": "Kurs senaste halvåret", "rjm": "Uppgång i förhållande till svängningar",
    "topp": "Närhet till årshögsta", "ma200": "Avstånd till 200-dagars snitt", "jamn": "Andel dagar med uppgång",
    "m1": "Kurs senaste månaden", "v1": "Kurs senaste veckan", "max1": "Största dagsuppgång senaste månaden",
    "vol3": "Svängningar 3 månader", "vol12": "Svängningar 12 månader", "beta": "Följsamhet mot börsen (beta)",
    "ivol": "Egna svängningar", "ras": "Största ras senaste året", "oms": "Ökad handel",
    "hopp": "Reaktion på senaste rapporten", "sasong": "Säsong", "sektor": "Branschens trend",
}
TEMAN = [
    ("trend", "Trend", "Hur aktien har gått det senaste året och halvåret, och hur nära sin högsta kurs den är."),
    ("rekyl", "Senaste veckorna", "Hur aktien har rört sig den senaste månaden och veckan. Väldigt snabba rörelser brukar delvis gå tillbaka."),
    ("risk", "Svängningar", "Hur mycket aktien svänger, hur känslig den är för börsen och hur djupt den har fallit senaste året."),
    ("handel", "Handel", "Om handeln i aktien har ökat eller minskat den senaste månaden jämfört med året."),
    ("rapport", "Senaste rapporten", "Hur kursen reagerade den dag aktien handlades mest under senaste kvartalet – oftast rapportdagen."),
    ("sasong", "Säsong", "Hur aktien brukar gå just den här månaden på året."),
    ("bransch", "Branschen", "Hur aktiens bransch har gått det senaste halvåret."),
]
TID = [t for t, _, _ in TEMAN]
SEKTOR_SV = {
    "Information Technology": "IT", "Health Care": "Hälsovård", "Financials": "Finans", "Consumer Discretionary": "Sällanköp",
    "Communication Services": "Kommunikation", "Industrials": "Industri", "Consumer Staples": "Dagligvaror", "Energy": "Energi",
    "Utilities": "Kraft", "Real Estate": "Fastigheter", "Materials": "Material",
}

warnings.filterwarnings("ignore", category=RuntimeWarning)


# ---------------------------------------------------------------------------
# 1. Data
# ---------------------------------------------------------------------------
def _get(url: str) -> str:
    err = None
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) aktieagent"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"{url}: {err}")


def _tick(x) -> str | None:
    t = str(x).strip().upper().replace(".", "-")
    return t if re.fullmatch(r"[A-Z][A-Z0-9\-]{0,5}", t) else None


def sp500_nu(csv: str | None = None) -> dict:
    """Dagens S&P 500: ticker -> namn och bransch."""
    df = pd.read_csv(io.StringIO(csv or _get(NU_URL)))
    medl = {}
    for _, r in df.iterrows():
        t = _tick(r["Symbol"])
        if t:
            medl[t] = {"n": str(r.get("Security", t))[:40], "s": SEKTOR_SV.get(str(r.get("GICS Sector")), str(r.get("GICS Sector", "–")))}
    if len(medl) < 400:
        raise RuntimeError("Listan över S&P 500 ser fel ut.")
    return medl


def sp500_historik(csv: str | None = None) -> list:
    """Vilka aktier som var med i S&P 500 vid olika datum sedan 1996: [(datum, {tickers})], äldst först."""
    df = pd.read_csv(io.StringIO(csv or _get(HIST_URL)))
    ut = []
    for d, ts in zip(pd.to_datetime(df["date"]), df["tickers"]):
        ut.append((d, frozenset(x for x in map(_tick, str(ts).split(",")) if x)))
    ut.sort(key=lambda x: x[0])
    if len(ut) < 500 or len(ut[-1][1]) < 400:
        raise RuntimeError("Listan över historiska medlemmar ser fel ut.")
    return ut


def medlemskap(hist: list, medl: dict, datum, finns) -> dict:
    """
    Vilka aktier som var med i indexet vid varje datum (bara de som har kursdata).
    Efter den historiska listans sista datum används dagens lista. Bolag som bytt kortnamn letas upp via ALIAS.
    """
    finns = set(finns) - FEL_DATA

    def los(t):
        # Ett gammalt kortnamn kan idag tillhöra ett helt annat bolag. Finns ett känt namnbyte används det i första hand.
        if t in medl and t in finns:
            return t
        if ALIAS.get(t) in finns:
            return ALIAS[t]
        return t if t in finns else None

    hd = [d for d, _ in hist]
    hd64 = np.array(hd, dtype="datetime64[ns]")
    cache, ut = {}, {}
    for d in datum:
        k = int(np.searchsorted(hd64, np.datetime64(d), side="right")) - 1
        if not hist or d > hd[-1] + pd.Timedelta(days=45):
            k = -9   # dagens lista
        if k not in cache:
            raw = set(medl) if k == -9 else hist[k][1] if k >= 0 else set()
            cache[k] = (frozenset(x for x in map(los, raw) if x), len(raw))
        ut[d] = cache[k]
    return ut


def kurser(tickers: list[str], start: str | None = None, period: str | None = None, paket: int = 150):
    """
    Från Yahoo Finance: justerad stängningskurs (med utdelningar, för avkastning), ojusterad stängningskurs
    (för att räkna handel i dollar utan att framtida utdelningar smyger in) och antal handlade aktier.
    """
    import yfinance as yf
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    C, P, V = {}, {}, {}
    for a in range(0, len(tickers), paket):
        chunk = tickers[a:a + paket]
        df = None
        for forsok in range(3):
            try:
                df = yf.download(chunk, start=start, period=period, auto_adjust=False, progress=False, threads=True, group_by="ticker", timeout=30)
                if df is not None and not df.empty:
                    break
            except Exception as e:  # noqa: BLE001
                print(f"  paket {a // paket + 1}: {e}", flush=True)
            time.sleep(5 * (forsok + 1))
        if df is None or df.empty:
            continue
        for t in chunk:
            try:
                h = df[t] if isinstance(df.columns, pd.MultiIndex) else df
                c = h["Adj Close"].dropna()
            except (KeyError, TypeError):
                continue
            if len(c) >= 60:
                C[t], P[t], V[t] = c, h["Close"].reindex(c.index), h["Volume"].reindex(c.index)
        print(f"  kurser {min(a + paket, len(tickers))}/{len(tickers)} ({len(C)} med data)", flush=True)
    C, P, V = pd.DataFrame(C), pd.DataFrame(P), pd.DataFrame(V)
    for d in (C, P, V):
        idx = pd.to_datetime(d.index)
        d.index = idx.tz_localize(None) if getattr(idx, "tz", None) is not None else idx
    return C.sort_index(), P.sort_index(), V.sort_index()


def alla_usa() -> list[str]:
    """Alla vanliga aktier på Nasdaq och NYSE (samma lista som topplistan kan använda)."""
    out = []
    nas = pd.read_csv(io.StringIO(_get("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt")), sep="|")
    out += nas[(nas["Test Issue"] == "N") & (nas["ETF"] == "N")]["Symbol"].tolist()
    oth = pd.read_csv(io.StringIO(_get("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt")), sep="|")
    out += oth[(oth["Test Issue"] == "N") & (oth["ETF"] == "N")]["ACT Symbol"].tolist()
    return sorted({t for t in map(str, out) if t.isalpha() and len(t) <= 5 and not (len(t) == 5 and t[-1] in "WURQ")})


def demo_data(seed: int = 1, effekt: float = 0.0, n: int = 220, start: str = "2004-01-01", slut: str | None = None, lika: bool = False):
    """
    Påhittad data för test. effekt > 0 planterar ett mönster: aktier som gått bra senaste halvåret fortsätter gå bra.
    lika=True gör alla aktier statistiskt likadana (ren slump – då finns inget att hitta).
    """
    rng = np.random.default_rng(seed)
    d = pd.bdate_range(start, slut or pd.Timestamp.today().normalize())
    T = len(d)
    mkt = rng.normal(0.0003, 0.01, T)
    beta = np.ones(n) if lika else rng.uniform(0.6, 1.5, n)
    vol = np.full(n, 0.018) if lika else rng.uniform(0.008, 0.03, n)
    R = mkt[:, None] * beta + rng.normal(0, 1, (T, n)) * vol
    if effekt:
        lp = np.zeros(n)
        hist = np.zeros((T, n))
        for i in range(T):
            if i >= 147 and i % 21 == 0:
                mom = hist[i - 21] - hist[i - 147]
                rk = mom.argsort().argsort() / (n - 1) - 0.5
                drift = effekt * rk / 21
            elif i < 147:
                drift = 0
            R[i] += drift
            lp = lp + np.log1p(np.clip(R[i], -0.5, 0.5))
            hist[i] = lp
    P = 50 * np.exp(np.cumsum(np.log1p(np.clip(R, -0.5, 0.5)), axis=0))
    tick = [f"D{i:03d}" for i in range(n)]
    C = pd.DataFrame(P, index=d, columns=tick)
    V = pd.DataFrame(rng.lognormal(14, 0.6, (T, n)), index=d, columns=tick)
    for j in range(0, n, 9):   # några stora "rapportdagar"
        V.iloc[rng.integers(0, T, 40), j] *= 6
    sek = list(SEKTOR_SV.values())
    # De 20 sista är "gamla medlemmar" som lämnat indexet, 30 kom med senare
    medl = {t: {"n": f"Demobolag {i}", "s": sek[i % len(sek)]} for i, t in enumerate(tick[: n - 20])}
    andr = []
    for k in range(20):
        dat = d[int(T * (0.25 + 0.035 * k))]
        andr.append((dat, tick[k], tick[n - 20 + k]))    # tick[k] in, gammal ut
        C.iloc[d.get_loc(dat) + 40:, n - 20 + k] = np.nan  # den gamla slutar handlas strax efter
    for k in range(20, 30):
        andr.append((d[int(T * (0.1 + 0.08 * (k - 20)))], tick[k], None))
    # Historisk medlemslista: gå bakåt från dagens lista och backa ändringarna
    andr.sort(key=lambda x: x[0], reverse=True)
    cur, hist = set(medl), []
    for dat, inn, ut in andr:
        hist.append((dat, frozenset(cur)))   # gäller från och med ändringsdagen
        cur.discard(inn)
        if ut:
            cur.add(ut)
    hist.append((d[0], frozenset(cur)))
    hist.sort(key=lambda x: x[0])
    spy = pd.Series(100 * np.exp(np.cumsum(mkt)), index=d)
    return C, C.copy(), V.where(C.notna()), spy, medl, hist


# ---------------------------------------------------------------------------
# 2. Faktorer
# ---------------------------------------------------------------------------
class Data:
    """Kursmatris (dagar × aktier) med det som behövs för att räkna faktorer."""

    def __init__(self, C: pd.DataFrame, P: pd.DataFrame, V: pd.DataFrame, spy: pd.Series):
        """C = justerade kurser (avkastning), P = ojusterade kurser (handel i dollar), V = antal handlade aktier."""
        self.dates = spy.dropna().index
        C = C.reindex(self.dates)
        self.tick = list(C.columns)
        self.ix = {t: j for j, t in enumerate(self.tick)}
        self.Pb = C.ffill(limit=5).to_numpy(float)          # för faktorer: små hål fylls
        self.Pf = C.ffill().to_numpy(float)                 # för avkastning: sista kurs gäller efter avnotering
        self.R = np.full_like(self.Pb, np.nan)
        self.R[1:] = self.Pb[1:] / self.Pb[:-1] - 1
        self.Vol = V.reindex(self.dates).reindex(columns=self.tick).to_numpy(float)
        self.DV = self.Vol * P.reindex(self.dates).reindex(columns=self.tick).ffill(limit=5).to_numpy(float)
        self.m = spy.reindex(self.dates).to_numpy(float)
        self.Rm = np.full(len(self.m), np.nan)
        self.Rm[1:] = self.m[1:] / self.m[:-1] - 1
        # Avkastning per kalendermånad, för säsongsfaktorn
        me = pd.DataFrame(self.Pb, index=self.dates).resample("ME").last()
        self.MR = me.pct_change(fill_method=None)
        self._my = (self.MR.index.year.to_numpy(), self.MR.index.month.to_numpy())

    def giltig(self, i: int) -> np.ndarray:
        """Aktier med minst ett års historik vid dag i."""
        if i < 252:
            return np.zeros(len(self.tick), bool)
        w = self.Pb[i - 252:i + 1]
        return np.isfinite(w[-1]) & np.isfinite(w[0]) & (np.isfinite(w).sum(0) >= 240)

    def sasong(self, i: int) -> np.ndarray:
        """Snittavkastning samma kalendermånad de senaste 10 åren (minst 5 år krävs)."""
        mal = self.dates[i] + pd.Timedelta(days=15)
        y, m = self._my
        rader = (m == mal.month) & (y < mal.year) & (y >= mal.year - 10) & np.asarray(self.MR.index < self.dates[i])
        if rader.sum() < 5:
            return np.full(len(self.tick), np.nan)
        x = self.MR.to_numpy()[rader]
        return np.where(np.isfinite(x).sum(0) >= 5, np.nanmean(x, 0), np.nan)

    def faktorer(self, i: int) -> dict:
        """Alla faktorer för alla aktier vid dag i. Använder bara data till och med dag i."""
        Pb, R = self.Pb, self.R
        p = Pb[i]
        r252, r63, r21 = R[i - 251:i + 1], R[i - 62:i + 1], R[i - 20:i + 1]
        w = Pb[i - 251:i + 1]
        f = {}
        f["m12"] = Pb[i - 21] / Pb[i - 252] - 1
        f["m6"] = Pb[i - 21] / Pb[i - 126] - 1
        f["m1"] = p / Pb[i - 21] - 1
        f["v1"] = p / Pb[i - 5] - 1
        vol12, vol3 = np.nanstd(r252, 0), np.nanstd(r63, 0)
        f["vol12"], f["vol3"] = vol12, vol3
        rm = self.Rm[i - 251:i + 1]
        rmc = rm - np.nanmean(rm)
        beta = np.nanmean((r252 - np.nanmean(r252, 0)) * rmc[:, None], 0) / np.nanmean(rmc ** 2)
        f["beta"] = beta
        f["ivol"] = np.sqrt(np.maximum(vol12 ** 2 - beta ** 2 * np.nanmean(rmc ** 2), 0))
        f["rjm"] = f["m12"] / (vol12 * np.sqrt(252))
        f["topp"] = p / np.nanmax(w, 0)
        f["ma200"] = p / np.nanmean(Pb[i - 199:i + 1], 0) - 1
        f["ras"] = np.nanmin(w / np.fmax.accumulate(w, 0) - 1, 0)
        f["jamn"] = np.nansum(r252 > 0, 0) / np.maximum(np.isfinite(r252).sum(0), 1)
        f["max1"] = np.nanmax(r21, 0)
        dv = self.DV
        f["oms"] = np.nanmean(dv[i - 20:i + 1], 0) / np.nanmean(dv[i - 251:i + 1], 0)
        f["_oms"] = np.nanmean(dv[i - 62:i + 1], 0)   # handel i dollar per dag (används bara som skydd, inte i modellen)
        v63 = np.where(np.isfinite(self.Vol[i - 62:i + 1]), self.Vol[i - 62:i + 1], -1.0)
        j = v63.argmax(0)
        hopp = r63[j, np.arange(len(p))]
        f["hopp"] = np.where(v63.max(0) > 0, hopp, np.nan)
        f["sasong"] = self.sasong(i)
        return f


def rang(x: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Rangordning inom gruppen, från -0,5 (lägst) till +0,5 (högst). Övriga blir NaN."""
    out = np.full(x.shape, np.nan)
    ok = mask & np.isfinite(x)
    n = int(ok.sum())
    if n < 20:
        return out
    r = np.empty(n)
    r[x[ok].argsort(kind="stable")] = (np.arange(n) + 0.5) / n - 0.5
    out[ok] = r
    return out


def rang_mot(x: np.ndarray, bas: np.ndarray) -> np.ndarray:
    """Var x hamnar i rangordningen bland värdena i bas (för aktier utanför S&P 500)."""
    b = np.sort(bas[np.isfinite(bas)])
    if len(b) < 20:
        return np.full(x.shape, np.nan)
    r = (np.searchsorted(b, x, side="left") + np.searchsorted(b, x, side="right")) / 2 / len(b) - 0.5
    return np.where(np.isfinite(x), np.clip(r, -0.5, 0.5), np.nan)


def tvarsnitt(D: Data, i: int, medl_mask: np.ndarray, sek_ix: np.ndarray, extra_mask: np.ndarray | None = None):
    """Rangordnade faktorer vid dag i för indexets aktier (och ev. övriga, rangordnade mot indexets)."""
    f = D.faktorer(i)
    mask = D.giltig(i) & medl_mask
    if mask.sum() >= 20:
        mask &= f["_oms"] >= MIN_KVOT * np.nanmedian(f["_oms"][mask])
    # Branschens trend: snittet av halvårstrenden bland indexets aktier i samma bransch
    sm = np.full(len(D.tick), np.nan)
    for s in np.unique(sek_ix[mask & (sek_ix >= 0)]):
        g = mask & (sek_ix == s)
        if g.sum() >= 3:
            sm[sek_ix == s] = np.nanmean(f["m6"][g])
    f["sektor"] = sm
    X = np.column_stack([rang(f[k], mask) for k in FID])
    if extra_mask is not None:
        em = D.giltig(i) & extra_mask & ~mask
        Xe = np.column_stack([rang_mot(f[k], np.where(mask, f[k], np.nan)) for k in FID])
        X = np.where(em[:, None], Xe, X)
        mask_alla = mask | em
    else:
        mask_alla = mask
    return np.nan_to_num(X, nan=0.0), mask, mask_alla, f


def signaldagar(D: Data) -> list[int]:
    """Första handelsdagen varje månad (då beslutet tas)."""
    m = D.dates.month.to_numpy()
    return [i for i in range(258, len(D.dates) - 1) if m[i] != m[i - 1]]


def bygg(D: Data, medl: dict, hist: list):
    """Träningsdata: en rad per aktie och månad med faktorer och hur aktien gick 1, 3 och 6 månader efteråt."""
    sig = signaldagar(D)
    mk = medlemskap(hist, medl, [D.dates[i] for i in sig] + [D.dates[-1]], D.tick)
    sek_namn = sorted({m["s"] for m in medl.values()})
    sek_ix = np.array([sek_namn.index(medl[t]["s"]) if t in medl else -1 for t in D.tick])
    rader = []
    for k, i in enumerate(sig):
        mm = np.array([t in mk[D.dates[i]][0] for t in D.tick])
        X, mask, _, f = tvarsnitt(D, i, mm, sek_ix)
        e0 = i + 1                                   # köp sker till stängningskursen dagen efter beslutet
        ok = mask & np.isfinite(D.Pf[e0])
        fh = {}
        for h in HORISONTER:
            if k + h < len(sig):
                e1 = sig[k + h] + 1
                fh[h] = (np.clip(D.Pf[e1][ok] / D.Pf[e0][ok] - 1, -0.95, 1.5 if h == 1 else 3.0), float(D.m[e1] / D.m[e0] - 1))
        fwd, bm = fh.get(1, (np.full(int(ok.sum()), np.nan), np.nan))
        rader.append({"i": i, "datum": D.dates[i], "ix": np.flatnonzero(ok), "X": X[ok], "fwd": fwd, "spy": bm, "fh": fh,
                      "beta": np.clip(np.nan_to_num(f["beta"][ok], nan=1.0), 0.0, 3.0), "klar": 1 in fh, "medl": mk[D.dates[i]][1]})
    satt_mal(rader)
    return rader, sek_ix, sek_namn, mk


def satt_mal(rader, h: int | None = None, justera: bool | None = None):
    """
    Det modellen ska lära sig förutse: aktiens rangordning efter avkastningen de kommande h månaderna.
    justera=True räknar först bort det som bara beror på att hela börsen gick upp eller ner (beta × börsen),
    så att modellen letar efter aktier som går bättre än sin risk motiverar – inte bara efter aktier som svänger mer.
    """
    h = HORISONT if h is None else h
    justera = JUSTERA if justera is None else justera
    for r in rader:
        if h in r["fh"]:
            f, bm = r["fh"][h]
            z = f - r["beta"] * bm if justera else f
            r["y"], r["tr"] = rang(z, np.isfinite(z)), True
        else:
            r["y"], r["tr"] = np.full(len(r["ix"]), np.nan), False
    return rader


# ---------------------------------------------------------------------------
# 3. Modeller
# ---------------------------------------------------------------------------
def ridge_fit(X, y):
    n, p = X.shape
    return np.linalg.solve(X.T @ X + RIDGE_L * n * np.eye(p), X.T @ y)


def gbm_fit(X, y):
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(max_depth=3, max_iter=150, learning_rate=0.05, min_samples_leaf=200,
                                         l2_regularization=1.0, early_stopping=False, random_state=0).fit(X, y)


def _r(x):
    """Rang 0..1 inom en vektor."""
    r = np.empty(len(x))
    r[np.argsort(x, kind="stable")] = (np.arange(len(x)) + 0.5) / max(len(x), 1)
    return r


class Modell:
    def __init__(self, rader, gbm=True):
        tr = [r for r in rader if r["tr"]]
        X = np.vstack([r["X"] for r in tr])
        y = np.concatenate([r["y"] for r in tr])
        ok = np.isfinite(y)
        self.n = int(ok.sum())
        self.w = ridge_fit(X[ok], y[ok])
        self.g = gbm_fit(X[ok], y[ok]) if gbm else None

    def poang(self, X, bas: np.ndarray | None = None) -> dict:
        """Poäng per modell. bas = vilka rader som utgör jämförelsegruppen (indexets aktier)."""
        a = X @ self.w
        out = {"ridge": a}
        if self.g is not None:
            b = self.g.predict(X)
            out["gbm"] = b
            if bas is None:
                out["ens"] = (_r(a) + _r(b)) / 2
            else:   # övriga aktier placeras in i indexaktiernas rangordning
                sa, sb = np.sort(a[bas]), np.sort(b[bas])
                out["ens"] = (np.searchsorted(sa, a) / len(sa) + np.searchsorted(sb, b) / len(sb)) / 2
        return out


def walk_forward(rader, gbm=True):
    """Tränar på allt före varje testår och förutser året. Returnerar förutsägelser per månad."""
    ar = sorted({r["datum"].year for r in rader if r["klar"]})
    pred = {}
    for y in [a for a in ar if a >= TEST_FRAN]:
        tr = [r for r in rader if r["datum"].year < y]
        tr = tr[:-HORISONT]   # de sista månaderna före teståret slutar inne i testperioden – tas bort
        if len(tr) < 36:
            continue
        m = Modell(tr, gbm)
        for k, r in enumerate(rader):
            if r["datum"].year == y:
                pred[k] = m.poang(r["X"])
    return pred


# ---------------------------------------------------------------------------
# 4. Test
# ---------------------------------------------------------------------------
def valj(ordning, behall, sek, n=N_INNEHAV, max_sek=MAX_SEKTOR):
    """Fyll på till n aktier uppifrån i rangordningen, högst max_sek per bransch (okänd bransch räknas inte)."""
    val = list(behall)
    antal = {}
    for t in val:
        if sek.get(t, -1) != -1:
            antal[sek[t]] = antal.get(sek[t], 0) + 1
    for t in ordning:
        if len(val) >= n:
            break
        if t in val:
            continue
        s = sek.get(t, -1)
        if s != -1 and antal.get(s, 0) >= max_sek:
            continue
        val.append(t)
        if s != -1:
            antal[s] = antal.get(s, 0) + 1
    return val


def spearman(a, b):
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 20:
        return np.nan
    return float(np.corrcoef(_r(a[ok]), _r(b[ok]))[0, 1])


def nyckeltal(ret: np.ndarray) -> dict:
    ret = np.asarray(ret, float)
    v = np.cumprod(1 + ret)
    ar = len(ret) / 12
    return {"cagr": float(v[-1] ** (1 / ar) - 1), "vol": float(ret.std() * np.sqrt(12)),
            "maxdd": float((v / np.maximum.accumulate(v) - 1).min()),
            "sharpe": float(ret.mean() / ret.std() * np.sqrt(12)) if ret.std() > 0 else None}


def testa(rader, pred, sek_ix, krasch: pd.Series | None, modell=VAL):
    """Hur hade algoritmen gått? Tiondelar, träffsäkerhet och portföljen mot jämförelser, efter avgifter."""
    ks = [k for k in sorted(pred) if rader[k]["klar"] and modell in pred[k]]
    ic, dec, dec_abs = [], [], []
    port, jamf, spy, oms, datum, broms = [], [], [], [], [], []
    innehav, w_prev = [], {}
    andel_prev = 1.0
    for k in ks:
        r, s = rader[k], pred[k][modell]
        fwd = r["fwd"]
        ok = np.isfinite(fwd)
        ic.append(spearman(s, fwd))
        q = np.minimum((_r(s) * 10).astype(int), 9)
        snitt = np.nanmean(fwd[ok])
        dec.append([np.nanmean(fwd[ok & (q == d)]) - snitt for d in range(10)])
        dec_abs.append([np.nanmean(fwd[ok & (q == d)]) for d in range(10)])
        # Portföljen
        ordn = r["ix"][np.argsort(-s, kind="stable")]
        rank = {int(t): n for n, t in enumerate(ordn)}
        beh = [t for t in innehav if t in rank and rank[t] < BUFFERT]
        innehav = valj([int(t) for t in ordn], beh, {int(t): int(sek_ix[t]) for t in r["ix"]})
        w = {t: 1 / len(innehav) for t in innehav}
        handel = sum(abs(w.get(t, 0) - w_prev.get(t, 0)) for t in set(w) | set(w_prev))
        avk = {int(t): f for t, f in zip(r["ix"], fwd)}
        pr = sum(w[t] * (avk[t] if np.isfinite(avk[t]) else 0.0) for t in innehav) - KOSTNAD * handel
        port.append(pr)
        jamf.append(snitt)
        spy.append(r["spy"])
        oms.append(handel / 2)
        datum.append(r["datum"])
        # vikterna driver med kursen till nästa månad
        tot = sum(w[t] * (1 + (avk[t] if np.isfinite(avk[t]) else 0.0)) for t in innehav)
        w_prev = {t: w[t] * (1 + (avk[t] if np.isfinite(avk[t]) else 0.0)) / tot for t in innehav}
        # Variant: halva portföljen i kontanter när krasch-mätaren visar rött
        if krasch is not None:
            fore = krasch[krasch.index < r["datum"]]
            andel = 0.5 if len(fore) and fore.iloc[-1] >= 65 else 1.0
            broms.append(andel * pr - KOSTNAD * abs(andel - andel_prev))
            andel_prev = andel
    if len(ks) < 24:
        return None
    ic = np.array(ic)
    port, jamf, spy = np.array(port), np.array(jamf), np.array(spy)
    ar = sorted({d.year for d in datum})
    per_ar = []
    for y in ar:
        m = np.array([d.year == y for d in datum])
        per_ar.append({"år": y, "algoritm": float(np.prod(1 + port[m]) - 1), "snitt": float(np.prod(1 + jamf[m]) - 1), "index": float(np.prod(1 + spy[m]) - 1), "månader": int(m.sum())})
    ut = {
        "från": datum[0].strftime("%Y-%m-%d"), "till": (datum[-1] + pd.offsets.MonthBegin(1)).strftime("%Y-%m-%d"), "månader": len(ks),
        "ic": float(np.nanmean(ic)), "ic_t": float(np.nanmean(ic) / np.nanstd(ic) * np.sqrt(np.isfinite(ic).sum())), "ic_plus": float(np.nanmean(ic > 0)),
        "tiondelar": [float(x) * 12 for x in np.nanmean(np.array(dec), 0)],
        "tiondelar_abs": [float(x) * 12 for x in np.nanmean(np.array(dec_abs), 0)],
        "algoritm": nyckeltal(port), "snitt": nyckeltal(jamf), "index": nyckeltal(spy),
        "omsättning": float(np.mean(oms) * 12), "bättre_än_snitt": float(np.mean(port > jamf)), "bättre_än_index": float(np.mean(port > spy)),
        "år": per_ar, "år_bättre": int(sum(a["algoritm"] > a["index"] for a in per_ar)),
        "kurva": {"datum": [d.strftime("%Y-%m-%d") for d in datum] , "algoritm": [round(float(x), 4) for x in np.cumprod(1 + port)],
                  "snitt": [round(float(x), 4) for x in np.cumprod(1 + jamf)], "index": [round(float(x), 4) for x in np.cumprod(1 + spy)]},
        "kostnad": KOSTNAD,
    }
    if broms:
        ut["broms"] = nyckeltal(np.array(broms))
    return ut


# ---------------------------------------------------------------------------
# 5. Algoritmens portfölj (följs dag för dag, med avgifter)
# ---------------------------------------------------------------------------
def uppdatera_portfolj(st: dict | None, datum: str, avk, index_avk, ordning: list[str], sek: dict) -> dict:
    """
    st       förra lägets portfölj (eller None)
    datum    dagens datum (senaste stängningskurs)
    avk      funktion (ticker, från_datum) -> avkastning från det datumet till idag
    index_avk  funktion (från_datum) -> S&P 500 (SPY) under samma tid
    ordning  indexets aktier, bäst först
    """
    st = json.loads(json.dumps(st)) if st else {"start": None, "senast": None, "värde": 100.0, "index": 100.0, "innehav": [], "beslut": None, "logg": [],
                                                 "historik": {"datum": [], "algoritm": [], "index": []}}
    rank = {t: i for i, t in enumerate(ordning)}
    # 1. Värdera om till dagens kurser
    if st["senast"] and st["senast"] < datum:
        for h in st["innehav"]:
            r = avk(h["t"], st["senast"])
            h["v"] *= 1 + r
            h["f"] *= 1 + r
        if st["start"]:
            st["index"] *= 1 + index_avk(st["senast"])
            if st["innehav"]:
                st["värde"] = sum(h["v"] for h in st["innehav"])
    # 2. Genomför gårdagens beslut till dagens stängningskurs
    b = st["beslut"]
    if b and not b["klart"] and b["datum"] < datum:
        kvar = [h for h in st["innehav"] if h["t"] not in b["sälj"]]
        salda = [h for h in st["innehav"] if h["t"] in b["sälj"]]
        nav = st["värde"] if st["start"] else 100.0
        nya = [t for t in b["köp"] if t not in {h["t"] for h in kvar}]
        n = len(kvar) + len(nya)
        if n:
            mal = nav / n
            handel = sum(h["v"] for h in salda) + sum(abs(mal - h["v"]) for h in kvar) + mal * len(nya)
            nav -= KOSTNAD * handel
            mal = nav / n
            for h in kvar:
                h["v"] = mal
            kvar += [{"t": t, "v": mal, "f": 1.0, "köpt": datum} for t in nya]
        st["innehav"], st["värde"] = kvar, nav
        b["klart"], b["genomfört"] = True, datum
        if not st["start"]:
            st["start"], st["index"] = datum, 100.0
        st["logg"] = ([{"datum": datum, "köp": nya, "sälj": [h["t"] for h in salda]}] + st["logg"])[:24]
    # 3. Nytt beslut första körningen i en ny månad
    if b is None or (b["klart"] and b["datum"][:7] != datum[:7]):
        har = [h["t"] for h in st["innehav"]]
        behall = [t for t in har if t in rank and rank[t] < BUFFERT]
        val = valj(ordning, behall, sek)
        st["beslut"] = {"datum": datum, "köp": [t for t in val if t not in har], "sälj": [t for t in har if t not in behall],
                        "behåll": behall, "klart": False, "genomfört": None}
    # 4. Spara dagens läge
    st["senast"] = datum
    hi = st["historik"]
    if st["start"] and (not hi["datum"] or hi["datum"][-1] < datum):
        hi["datum"].append(datum)
        hi["algoritm"].append(round(st["värde"], 3))
        hi["index"].append(round(st["index"], 3))
    return st


# ---------------------------------------------------------------------------
# 6. Kör allt
# ---------------------------------------------------------------------------
def spara_data(fil, C, P, V, spy, medl, hist):
    f32 = lambda d: d.reindex(index=C.index, columns=C.columns).to_numpy(np.float32)
    np.savez_compressed(fil, C=f32(C), P=f32(P), V=f32(V), spy=spy.reindex(C.index).to_numpy(float),
                        datum=C.index.strftime("%Y-%m-%d").to_numpy().astype("U10"), tick=np.array(C.columns, dtype="U8"),
                        medl=json.dumps(medl, ensure_ascii=False), hist=json.dumps([[d.strftime("%Y-%m-%d"), sorted(ts)] for d, ts in hist]))


def las_data(fil):
    z = np.load(fil, allow_pickle=False)
    idx = pd.to_datetime(z["datum"])
    df = lambda k: pd.DataFrame(z[k].astype(float), index=idx, columns=list(z["tick"]))
    spy = pd.Series(z["spy"], index=idx).dropna()
    return df("C"), df("P"), df("V"), spy, json.loads(str(z["medl"])), [(pd.Timestamp(d), frozenset(ts)) for d, ts in json.loads(str(z["hist"]))]


def las_krasch() -> pd.Series | None:
    try:
        with open(KRASCH, encoding="utf-8") as fh:
            h = json.load(fh)["historik"]
        s = pd.Series(h["poäng"], index=pd.to_datetime(h["datum"]), dtype=float).dropna()
        return s if len(s) > 100 else None
    except Exception:  # noqa: BLE001
        return None


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument("--demo", action="store_true")
    a.add_argument("--utan-ovriga", action="store_true", help="Räkna bara på S&P 500 (hoppa över övriga amerikanska aktier)")
    a.add_argument("--out", default=OUT)
    a.add_argument("--spara-data", help="Spara kursdatan i en fil (för felsökning och utveckling)")
    a.add_argument("--data", help="Läs kursdata från en fil skapad med --spara-data i stället för från nätet")
    args = a.parse_args()
    t0 = time.time()

    forra = None
    try:
        with open(args.out, encoding="utf-8") as fh:
            forra = json.load(fh)
    except Exception:  # noqa: BLE001
        pass
    if forra and forra.get("demo") and not args.demo:
        forra = None

    # --- Data ---
    if args.demo:
        C, P, V, spy, medl, hist = demo_data(effekt=0.02)
        Ce = None
    elif args.data:
        C, P, V, spy, medl, hist = las_data(args.data)
        Ce = None
    else:
        medl, hist = sp500_nu(), sp500_historik()
        alla = set(medl) | set(ALIAS.values())
        for dat, ts in hist:
            if dat >= pd.Timestamp(START):
                alla |= ts
        alla = sorted(alla)
        print(f"S&P 500: {len(medl)} bolag idag, historik {hist[0][0].date()}–{hist[-1][0].date()}, {len(alla)} aktier har varit med sedan {START[:4]}", flush=True)
        C, P, V = kurser(alla + ["SPY"], start=START)
        if "SPY" not in C or len(C) < 1500:
            print("::error::Kunde inte hämta kurser från Yahoo Finance. Den gamla filen behålls.")
            return 1
        spy = C.pop("SPY")
        P.pop("SPY")
        V.pop("SPY")
        saknas = [t for t in medl if t not in C]
        print(f"Kurser för {C.shape[1]} av {len(alla)} aktier ({len(saknas)} av dagens bolag saknas: {saknas[:12]}) · {time.time() - t0:.0f} s", flush=True)
        Ce = None
        if not args.utan_ovriga:
            try:
                ovr = None
                if forra and datetime.now(timezone.utc).weekday() != 0:
                    ovr = [t for t, x in forra.get("aktier", {}).items() if not x.get("k")]
                if not ovr:
                    ovr = alla_usa()
                ovr = [t for t in ovr if t not in C.columns]
                print(f"Övriga amerikanska aktier: {len(ovr)} att hämta", flush=True)
                Ce, Pe, Ve = kurser(ovr, period="2y", paket=250)
                senast = Ce.index[-1]
                liq = (Pe * Ve).iloc[-60:].median()
                ok = (liq >= MIN_OMS) & (Pe.iloc[-1] >= MIN_KURS) & Ce.iloc[-1].notna() & (Ce.notna().sum() >= 260)
                Ce, Pe, Ve = Ce.loc[:, ok], Pe.loc[:, ok], Ve.loc[:, ok]
                print(f"  {Ce.shape[1]} med tillräcklig handel (till {senast.date()}) · {time.time() - t0:.0f} s", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"::warning::Övriga aktier kunde inte hämtas ({e}). Fortsätter med S&P 500.")
                Ce = None

    if args.spara_data:
        spara_data(args.spara_data, C, P, V, spy, medl, hist)

    # --- Träningsdata, test framåt i tiden och slutlig modell ---
    D = Data(C, P, V, spy)
    rader, sek_ix, sek_namn, mk = bygg(D, medl, hist)
    print(f"Träningsdata: {sum(len(r['ix']) for r in rader if r['klar'])} rader, {len(rader)} månader från {rader[0]['datum'].date()} · {time.time() - t0:.0f} s", flush=True)
    pred = walk_forward(rader)
    krasch = las_krasch()
    tester = {m: testa(rader, pred, sek_ix, krasch, m) for m in ("ridge", "gbm", "ens")}
    test = tester[VAL]
    if test is None:
        print("::error::För lite data för att testa algoritmen. Den gamla filen behålls.")
        return 1
    slut = Modell(rader)

    # --- Dagens poäng ---
    i = len(D.dates) - 1
    idag = D.dates[i]
    if Ce is not None and Ce.shape[1]:
        # Lägg till övriga aktier (2 års historik) bredvid indexets
        sista = D.dates[-520:]
        Call = pd.concat([C.reindex(sista), Ce.reindex(sista)], axis=1)
        Pall = pd.concat([P.reindex(sista), Pe.reindex(sista)], axis=1)
        Vall = pd.concat([V.reindex(sista), Ve.reindex(sista)], axis=1)
        D2 = Data(Call, Pall, Vall, spy.reindex(D.dates).iloc[-520:])
        # Säsong kräver lång historik: ta den från hela datamängden för indexets aktier
        sas = np.concatenate([D.sasong(i), np.full(Ce.shape[1], np.nan)])
        D2.sasong = lambda _i, _s=sas: _s
        i2 = len(D2.dates) - 1
        sek2 = np.concatenate([sek_ix, np.full(Ce.shape[1], -1)])
        mm = np.array([t in medl for t in D2.tick])
        X, mask, mask_alla, _ = tvarsnitt(D2, i2, mm, sek2, extra_mask=~mm)
        tick = D2.tick
    else:
        mm = np.array([t in medl for t in D.tick])
        X, mask, mask_alla, _ = tvarsnitt(D, i, mm, sek_ix)
        tick = D.tick
    ix = np.flatnonzero(mask_alla)
    karna = mask[ix]
    po = slut.poang(X[ix], bas=karna)[VAL]
    # Poäng 0–100: andel av indexets aktier som har lägre poäng
    bas = np.sort(po[karna])
    p100 = np.clip((np.searchsorted(bas, po, side="left") + np.searchsorted(bas, po, side="right")) / 2 / len(bas) * 100, 0, 100)
    # Skäl: hur mycket varje tema drar upp eller ner (från den vägda poängen)
    bidrag = X[ix] * slut.w
    tema_ix = [[j for j, (_, t) in enumerate(FAKTORER) if t == tid] for tid in TID]
    tb = np.column_stack([bidrag[:, js].sum(1) for js in tema_ix])
    skala = np.abs(tb[karna]).max() or 1.0
    aktier = {}
    for n, j in enumerate(ix):
        aktier[tick[j]] = {"p": int(round(p100[n])), "k": int(karna[n]), "s": [int(round(x / skala * 100)) for x in tb[n]]}
    ordn = [tick[ix[n]] for n in np.argsort(-po, kind="stable") if karna[n]]
    vikt_tema = np.abs(tb[karna]).mean(0)
    vikt_fakt = np.abs(bidrag[karna]).mean(0)

    # --- Algoritmens portfölj ---
    dstr = idag.strftime("%Y-%m-%d")
    pris = pd.DataFrame(D.Pf, index=D.dates, columns=D.tick)

    def avk(t, fran):
        if t not in pris:
            return 0.0
        s = pris[t]
        a = s[s.index <= fran]
        return float(s.iloc[-1] / a.iloc[-1] - 1) if len(a) and np.isfinite(a.iloc[-1]) and np.isfinite(s.iloc[-1]) else 0.0

    def index_avk(fran):
        s = spy.reindex(D.dates)
        a = s[s.index <= fran]
        return float(s.iloc[-1] / a.iloc[-1] - 1) if len(a) else 0.0

    pf = uppdatera_portfolj((forra or {}).get("läge"), dstr, avk, index_avk, ordn, {t: medl[t]["s"] for t in ordn})
    info = lambda t: {"t": t, "n": medl.get(t, {}).get("n", t), "s": medl.get(t, {}).get("s", "–"), "p": aktier.get(t, {}).get("p"),
                      "rank": ordn.index(t) + 1 if t in ordn else None}
    # Det appen visar (med namn, bransch och poäng). Det råa läget sparas separat under "läge".
    pf_ut = {**pf, "innehav": sorted(({**info(h["t"]), "utv": round(h["f"] - 1, 4), "köpt": h["köpt"], "vikt": round(h["v"] / pf["värde"], 4) if pf["värde"] else None}
                                      for h in pf["innehav"]), key=lambda x: x["rank"] or 9999)}
    if pf["beslut"]:
        pf_ut["beslut"] = {**pf["beslut"], **{k: [info(t) for t in pf["beslut"][k]] for k in ("köp", "sälj", "behåll")}}

    # --- Skriv ---
    nasta = (idag + pd.offsets.MonthBegin(1))
    while nasta.weekday() >= 5:
        nasta += pd.Timedelta(days=1)
    w_tot = vikt_tema.sum() or 1.0
    ut = {
        "uppdaterad": dstr, "skapad": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "demo": bool(args.demo),
        "regler": {"antal": N_INNEHAV, "buffert": BUFFERT, "max_bransch": MAX_SEKTOR, "kostnad": KOSTNAD, "köp": KOP_P, "sälj": SALJ_P, "modell": VAL},
        "universum": {"index": int(karna.sum()), "övriga": int((~karna).sum()), "tränad_på": slut.n, "månader": sum(r["klar"] for r in rader),
                      "från": rader[0]["datum"].strftime("%Y-%m-%d"), "aktier_i_data": len(D.tick)},
        "teman": [{"id": tid, "namn": namn, "text": text, "vikt": round(float(vikt_tema[n] / w_tot), 3),
                   "faktorer": [{"namn": FNAMN[FID[j]], "riktning": 1 if slut.w[j] > 0 else -1, "vikt": round(float(vikt_fakt[j] / (vikt_fakt.sum() or 1)), 3)} for j in tema_ix[n]]}
                  for n, (tid, namn, text) in enumerate(TEMAN)],
        "test": test,
        "portfölj": pf_ut,
        "läge": pf,
        "nästa_beslut": nasta.strftime("%Y-%m-%d"),
        "topp": [info(t) for t in ordn[:50]],
        "botten": [info(t) for t in ordn[-25:][::-1]],
        "aktier": aktier,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(ut, fh, ensure_ascii=False, separators=(",", ":"))

    # --- Sammanfattning (syns i GitHub Actions) ---
    p = lambda x: "–" if x is None else f"{x * 100:+.1f}%"
    print(f"::notice title=Algoritmen::{dstr} · {karna.sum()} indexaktier + {(~karna).sum()} övriga · tränad på {slut.n} rader · {os.path.getsize(args.out) // 1024} kB · {time.time() - t0:.0f} s")
    for m, t in tester.items():
        if t:
            print(f"::notice title=Test {m}{' (vald)' if m == VAL else ''}::{t['från']}–{t['till']} · IC {t['ic']:.3f} (t {t['ic_t']:.1f}, {t['ic_plus']:.0%} av månaderna) · algoritm {p(t['algoritm']['cagr'])}/år, snittaktie {p(t['snitt']['cagr'])}, index {p(t['index']['cagr'])} · maxras {p(t['algoritm']['maxdd'])} mot {p(t['index']['maxdd'])} · omsättning {t['omsättning']:.1f}x/år · bättre än index {t['år_bättre']} av {len(t['år'])} år"
                  + (f" · med krasch-broms {p(t['broms']['cagr'])}/år, maxras {p(t['broms']['maxdd'])}" if t.get("broms") else ""))
    print("::notice title=Tiondelar (per år mot snittet)::" + " | ".join(p(x) for x in test["tiondelar"]))
    print("::notice title=År::" + " | ".join(f"{a['år']}: {p(a['algoritm'])} / {p(a['snitt'])} / {p(a['index'])}" for a in test["år"]))
    print("::notice title=Faktorer::" + " | ".join(f"{FID[j]} {slut.w[j]:+.3f}" for j in np.argsort(-np.abs(slut.w))))
    print("::notice title=Teman::" + " | ".join(f"{t['namn']} {t['vikt']:.0%}" for t in ut["teman"]))
    print("::notice title=Medlemmar per år::" + " | ".join(f"{r['datum'].year}: {r['medl']} ({len(r['ix'])} med data)" for r in rader if r["datum"].month == 1))
    print("::notice title=Topp 20::" + ", ".join(ordn[:20]))
    b = pf["beslut"]
    if b:
        print(f"::notice title=Beslut {b['datum']}{'' if b['klart'] else ' (väntar)'}::KÖP {', '.join(b['köp']) or '–'} · SÄLJ {', '.join(b['sälj']) or '–'} · portfölj {pf['värde']:.2f} mot index {pf['index']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
