"""
Samma värderingsmodell som servern använder (worker/src/analys.js), i Python för topplistorna.
Ändras reglerna på ett ställe ska de ändras på båda. test_modell.py kontrollerar att de ger samma svar.
"""
from __future__ import annotations

import math

SLUT_TILLVAXT = 0.04   # långsiktig tillväxt när bolaget mognat
AVTAGANDE = 0.65       # hur fort tillväxten avtar mot SLUT_TILLVAXT per år
PE_ATERG = 0.7         # andel av "för högt/lågt" P/E som finns kvar efter ett år


def clip(x, lo, hi):
    return max(lo, min(hi, x))


def _num(x):
    try:
        x = float(x)
        return None if math.isnan(x) or math.isinf(x) else x
    except (TypeError, ValueError):
        return None


def quality_premium(f: dict) -> float:
    roe, opm = _num(f.get("roe")), _num(f.get("rörelsemarginal"))
    return (clip((roe - 0.1) * 20, 0, 5) if roe is not None else 0) + (clip((opm - 0.1) * 15, 0, 3) if opm is not None else 0)


def fair_pe(g, q=0.0):
    return clip(15 + 80 * g + q, 12, 32)


def g_at(g0, k):
    return SLUT_TILLVAXT + (g0 - SLUT_TILLVAXT) * AVTAGANDE ** k


def eps_at(e1, g0, years):
    e = e1
    for k in range(1, years + 1):
        e *= 1 + g_at(g0, k)
    return e


def model_inputs(f: dict, price: float) -> dict:
    g0 = None
    for k in ("vinsttillväxt_nästa_år", "omsättningstillväxt_nästa_år", "omsättningstillväxt", "vinsttillväxt"):
        if _num(f.get(k)) is not None:
            g0 = _num(f.get(k))
            break
    g0 = clip(g0 if g0 is not None else 0.05, -0.15, 0.4)
    e1 = _num(f.get("eps_nästa_år"))
    e1 = e1 if e1 and e1 > 0 else None
    fpe = _num(f.get("forward_pe"))
    if e1 and fpe and fpe > 0:
        r = (price / e1) / fpe
        if r < 0.6 or r > 1.6:  # prognos i annan valuta
            e1 = None
    if not e1 and fpe and fpe > 0:
        e1 = price / fpe
    ps = _num(f.get("ps"))
    return {"g0": g0, "E1": e1, "sps": price / ps if ps and ps > 0 else None,
            "d": clip(_num(f.get("utdelning")) or 0, 0, 0.1), "q": quality_premium(f),
            "bm": _num(f.get("bruttomarginal"))}


def price_at(inp: dict, price: float, years: int, full=False):
    g0 = inp["g0"]
    fair = fair_pe(g_at(g0, years + 1), inp["q"])
    if inp["E1"]:
        pe0 = price / inp["E1"]
        pe = fair if full else fair + (pe0 - fair) * PE_ATERG ** years
        return pe * eps_at(inp["E1"], g0, years)
    if inp["sps"]:
        bm = inp["bm"] if inp["bm"] is not None else 0.4
        margin = clip(bm * 0.35, 0.04, 0.25)
        fair_ps, ps0 = margin * fair, price / inp["sps"]
        ps = fair_ps if full else fair_ps + (ps0 - fair_ps) * PE_ATERG ** years
        return ps * inp["sps"] * (1 + g0) * eps_at(1, g0, years)
    return None


def horizons(f: dict, price: float, er1: float | None) -> dict:
    """Förväntad årlig avkastning om 1, 3, 5 och 10 år (samma som horizons() i analys.js)."""
    inp = model_inputs(f, price)
    out = {}
    for years in (1, 3, 5, 10):
        ann = None
        if years == 1 and er1 is not None:
            ann = er1
        else:
            p = price_at(inp, price, years)
            if p is not None:
                tot = (p / price) * (1 + inp["d"]) ** years - 1
                ann = -0.25 if tot <= -1 else (1 + tot) ** (1 / years) - 1
                if years == 3 and er1 is not None:
                    ann = 0.7 * ann + 0.3 * er1
        if ann is not None:
            out[years] = clip(ann, -0.5, 1) if years == 1 else clip(ann, -0.25, 0.4)
    return out


def monthly_means(close) -> list[float | None] | None:
    """Snittavkastning per kalendermånad (jan..dec) från en pandas-serie med dagliga kurser."""
    m = close.resample("ME").last().dropna()
    if len(m) and m.index[-1].to_period("M") == close.index[-1].to_period("M"):
        m = m.iloc[:-1]  # innevarande månad är inte klar
    r = m.pct_change().dropna()
    if len(r) < 36:
        return None
    return [float(r[r.index.month == k].mean()) if (r.index.month == k).any() else None for k in range(1, 13)]


def seasonal_ahead(means, from_month: int, n: int = 6):
    if not means:
        return None
    return sum((means[(from_month - 1 + i) % 12] or 0) for i in range(n))


# ---------------------------------------------------------------------------
# Risknivå 1–10 (samma regel som riskLevel() i worker/src/analys.js)
# ---------------------------------------------------------------------------
# Grunden är hur mycket aktien svänger på ett år (volatilitet). Sedan justeras den för
# förluster, stora ras, hög skuld, litet bolag och – åt andra hållet – lugna lönsamma bolag.
# Nivå 0 används bara för statspapper (räntefonder), inte för aktier.

RISK_VOL = [0.15, 0.20, 0.25, 0.30, 0.37, 0.45, 0.55, 0.70, 0.90]
SKULD_OK = ("Financial Services", "Real Estate", "Utilities")


def risk_level(vol, dd=None, beta=None, loss=False, de=None, mcap=None, sector=None) -> int | None:
    if vol is None or not math.isfinite(vol):
        return None
    lvl = 1 + sum(vol > x for x in RISK_VOL)
    if loss:
        lvl += 1
    if dd is not None and dd < -0.6:
        lvl += 1
    if de is not None and de > 200 and sector not in SKULD_OK:
        lvl += 1
    if mcap is not None and mcap < 2e9:
        lvl += 1
    if not loss and beta is not None and beta < 0.6 and dd is not None and dd > -0.25:
        lvl -= 1
    return int(clip(lvl, 1, 10))
