"""Kontrollerar algoritmen (algoritm.py) med påhittad data. Kör: python test_algoritm.py

Det viktigaste som testas:
  - Ren slump ska INTE ge någon vinst (annars fuskar testet på något sätt).
  - Ett inplanterat mönster ska hittas.
  - Inget som räknas en viss dag får påverkas av kurser efter den dagen.
  - Algoritmens portfölj: beslut en gång i månaden, köp/sälj dagen efter, avgifter dras, samma körning två gånger ändrar inget.
"""
import sys

import numpy as np
import pandas as pd

import algoritm as A

FEL = []


def test(namn):
    def deco(fn):
        try:
            fn()
            print(f"OK   {namn}")
        except AssertionError as e:
            FEL.append(namn)
            print(f"FEL  {namn}: {e}")
        return fn
    return deco


def kor(effekt, seed=3, slut="2019-12-31", n=160, lika=False):
    C, P, V, spy, medl, hist = A.demo_data(seed=seed, effekt=effekt, n=n, slut=slut, lika=lika)
    D = A.Data(C, P, V, spy)
    rader, sek_ix, _, _ = A.bygg(D, medl, hist)
    pred = A.walk_forward(rader)
    return D, rader, sek_ix, pred, (C, P, V, spy, medl, hist)


D0, rader0, sek0, pred0, raw0 = kor(0.0)


@test("ren slump ger ingen vinst")
def _():
    # Alla aktier är statistiskt likadana, så det finns inget att hitta. Hittar testet ändå något fuskar det.
    for seed in (3, 4):
        _, rader, sek, pred, _ = kor(0.0, seed=seed, lika=True)
        for m in ("ridge", "gbm", "ens"):
            t = A.testa(rader, pred, sek, None, m)
            assert abs(t["ic_t"]) < 3, f"{m}: IC t-värde {t['ic_t']:.1f}"
            diff = t["algoritm"]["cagr"] - t["snitt"]["cagr"]
            assert -0.10 < diff < 0.03, f"{m}: {diff:+.1%} mot snittet per år"


@test("inplanterat mönster hittas")
def _():
    _, rader, sek, pred, _ = kor(0.02)
    t = A.testa(rader, pred, sek, None, "ens")
    assert t["ic_t"] > 4, f"IC t-värde {t['ic_t']:.1f}"
    assert t["algoritm"]["cagr"] > t["snitt"]["cagr"] + 0.02
    assert t["tiondelar"][9] > t["tiondelar"][0] + 0.05


@test("faktorer och förutsägelser använder inga framtida kurser")
def _():
    C, P, V, spy, medl, hist = raw0
    # Klipp av all data strax efter en beslutsdag mitt i testperioden
    k0 = next(k for k, r in enumerate(rader0) if r["datum"].year == 2014 and r["datum"].month == 3)
    stopp = D0.dates[rader0[k0]["i"] + 1]
    D1 = A.Data(C[C.index <= stopp], P[P.index <= stopp], V[V.index <= stopp], spy[spy.index <= stopp])
    rader1, _, _, _ = A.bygg(D1, medl, hist)
    assert rader1[-1]["datum"] == rader0[k0]["datum"]
    for k in (k0, k0 - 1, k0 - 14):
        assert np.array_equal(rader1[k]["ix"], rader0[k]["ix"]), "olika aktier"
        assert np.allclose(rader1[k]["X"], rader0[k]["X"]), "faktorerna ändras när framtiden tas bort"
    pred1 = A.walk_forward(rader1)
    for m in ("ridge", "gbm"):
        assert np.allclose(pred1[k0][m], pred0[k0][m]), f"{m}: förutsägelsen ändras när framtiden tas bort"
    assert not rader1[k0]["klar"] and rader0[k0]["klar"]


@test("träningen slutar före teståret")
def _():
    for y in (2012, 2016):
        tr = [r for r in rader0 if r["datum"].year < y][:-1]
        forsta = next(r for r in rader0 if r["datum"].year == y)
        sista_slut = D0.dates[rader0[rader0.index(tr[-1]) + 1]["i"] + 1]
        assert sista_slut <= forsta["datum"], "sista träningsmånaden slutar efter första testdagen"


@test("historiska medlemmar: rätt bolag vid rätt tid, namnbyten följs")
def _():
    hist = [(pd.Timestamp("2010-01-04"), frozenset({"AAA", "FB", "OLD"})), (pd.Timestamp("2015-06-01"), frozenset({"AAA", "FB", "NEW"})),
            (pd.Timestamp("2022-06-09"), frozenset({"AAA", "META", "NEW"}))]
    medl = {"AAA": {}, "META": {}, "NEW": {}, "NYAST": {}}
    # "FB" finns hos Yahoo men är idag ett annat bolag: namnbytet till META ska gå före
    mk = A.medlemskap(hist, medl, [pd.Timestamp(x) for x in ("2009-01-05", "2012-03-01", "2018-01-02", "2022-07-01", "2023-06-01")], ["AAA", "META", "NEW", "NYAST", "FB", "PARA"])
    s = {d.year: v[0] for d, v in mk.items()}
    assert s[2009] == frozenset()
    assert s[2012] == {"AAA", "META"}, s[2012]          # FB hittas som META, OLD saknar kurser
    assert s[2018] == {"AAA", "META", "NEW"}
    assert s[2022] == {"AAA", "META", "NEW"}
    assert s[2023] == {"AAA", "META", "NEW", "NYAST"}   # långt efter listans slut: dagens lista


@test("rangordning: jämnt fördelad, övriga aktier placeras rätt")
def _():
    x = np.array([5.0, 1.0, np.nan, 3.0] + list(range(10, 30)))
    m = np.ones(len(x), bool)
    r = A.rang(x, m)
    assert np.isnan(r[2]) and r[1] == np.nanmin(r) and abs(np.nanmean(r)) < 1e-9
    bas = np.arange(100.0)
    ro = A.rang_mot(np.array([-5.0, 49.5, 500.0, np.nan]), bas)
    assert ro[0] == -0.5 and abs(ro[1]) < 0.011 and ro[2] == 0.5 and np.isnan(ro[3])


@test("urval: högst 5 per bransch, behåller det som ska behållas")
def _():
    ordn = [f"T{i}" for i in range(100)]
    sek = {t: ("IT" if i < 12 else f"S{i % 7}") for i, t in enumerate(ordn)}
    val = A.valj(ordn, ["T50"], sek)
    assert len(val) == 20 and val[0] == "T50"
    assert sum(sek[t] == "IT" for t in val) == 5
    assert A.valj(ordn[:8], [], sek) == ["T0", "T1", "T2", "T3", "T4"]


@test("algoritmens portfölj: beslut, köp dagen efter, avgift, månadsskifte, upprepad körning")
def _():
    ordn = [f"T{i}" for i in range(100)]
    sek = {}
    noll = lambda *a: 0.0
    s1 = A.uppdatera_portfolj(None, "2026-11-12", noll, noll, ordn, sek)
    assert s1["beslut"]["köp"] == ordn[:20] and not s1["beslut"]["klart"] and s1["innehav"] == [] and s1["start"] is None
    assert A.uppdatera_portfolj(s1, "2026-11-12", noll, noll, ordn[::-1], sek) == s1, "samma dag två gånger ska inte ändra något"
    # Dagen efter: köpen genomförs, 0,3 % avgift
    s2 = A.uppdatera_portfolj(s1, "2026-11-13", noll, noll, ordn, sek)
    assert len(s2["innehav"]) == 20 and s2["beslut"]["klart"] and s2["start"] == "2026-11-13"
    assert abs(s2["värde"] - 100 * (1 - A.KOSTNAD)) < 1e-9 and s2["historik"]["datum"] == ["2026-11-13"]
    assert A.uppdatera_portfolj(s2, "2026-11-13", noll, noll, ordn, sek) == s2
    # Senare samma månad: värdet följer kurserna, inget nytt beslut
    upp = lambda t, fran: 0.10 if t == "T0" else 0.0
    s3 = A.uppdatera_portfolj(s2, "2026-11-20", upp, lambda fran: 0.02, ordn[::-1], sek)
    assert s3["beslut"] == s2["beslut"]
    assert abs(s3["värde"] - s2["värde"] * (1 + 0.10 / 20)) < 1e-9 and abs(s3["index"] - 102) < 1e-9
    assert abs(next(h for h in s3["innehav"] if h["t"] == "T0")["f"] - 1.10) < 1e-12
    # Ny månad: T0–T4 har fallit ur de 60 bästa och säljs, fem nya köps
    ny = ordn[5:65] + ordn[:5] + ordn[65:]
    s4 = A.uppdatera_portfolj(s3, "2026-12-01", noll, noll, ny, sek)
    b = s4["beslut"]
    assert set(b["sälj"]) == {"T0", "T1", "T2", "T3", "T4"} and b["köp"] == ["T20", "T21", "T22", "T23", "T24"] and not b["klart"]
    assert len(s4["innehav"]) == 20, "inget säljs förrän dagen efter"
    s5 = A.uppdatera_portfolj(s4, "2026-12-02", noll, noll, ny, sek)
    assert {h["t"] for h in s5["innehav"]} == set(ordn[5:25]) and len(s5["logg"]) == 2
    assert s5["värde"] < s4["värde"] and abs(sum(h["v"] for h in s5["innehav"]) - s5["värde"]) < 1e-9
    assert all(abs(h["v"] - s5["värde"] / 20) < 1e-9 for h in s5["innehav"])
    # Aktie som försvunnit ur listan säljs vid nästa beslut
    s6 = A.uppdatera_portfolj(s5, "2027-01-04", noll, noll, [t for t in ny if t != "T7"], sek)
    assert "T7" in s6["beslut"]["sälj"]


@test("nyckeltal räknas rätt")
def _():
    n = A.nyckeltal(np.array([0.1, -0.5, 0.2] + [0.0] * 9))
    assert abs(n["cagr"] - (1.1 * 0.5 * 1.2 - 1)) < 1e-9 and abs(n["maxdd"] + 0.5) < 1e-9


if __name__ == "__main__":
    print("Alla test gick igenom" if not FEL else f"{len(FEL)} test misslyckades")
    sys.exit(1 if FEL else 0)
