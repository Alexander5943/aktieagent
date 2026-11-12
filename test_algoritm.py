"""Kontrollerar algoritmen (algoritm.py) med påhittad data. Kör: python test_algoritm.py

Det viktigaste som testas:
  - Ren slump ska INTE ge någon vinst (annars fuskar testet på något sätt).
  - Ett inplanterat mönster ska hittas.
  - Inget som räknas en viss dag får påverkas av kurser efter den dagen.
  - Algoritmens portfölj: beslut en gång per kvartal, köp/sälj dagen efter, avgifter dras,
    samma körning två gånger ändrar inget.
"""
import copy
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
        t = A.testa(rader, pred, sek)
        assert abs(t["ic_t"]) < 3, f"IC t-värde {t['ic_t']:.1f}"
        diff = t["algoritm"]["cagr"] - t["snitt"]["cagr"]
        assert -0.08 < diff < 0.03, f"{diff:+.1%} mot snittet per år"


@test("inplanterat mönster hittas")
def _():
    _, rader, sek, pred, _ = kor(0.02)
    t = A.testa(rader, pred, sek)
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
    assert np.allclose(pred1[k0], pred0[k0]), "förutsägelsen ändras när framtiden tas bort"
    assert not rader1[k0]["klar"] and rader0[k0]["klar"]


@test("träningen använder bara månader vars utfall var känt före teståret")
def _():
    k0 = next(k for k, r in enumerate(rader0) if r["datum"].year == 2014)
    # Sista tillåtna träningsmånadens utfall mäts till dagen efter föregående beslut – det ska ligga före teststarten
    assert D0.dates[rader0[k0 - 1]["i"] + 1] <= rader0[k0]["datum"]
    # Förstör utfallen för alla månader som inte får användas. Förutsägelsen ska inte ändras.
    r2 = copy.deepcopy(rader0)
    rng = np.random.default_rng(0)
    for h in A.MAL:
        for r in r2[k0 - h:]:
            if h in r["y"]:
                r["y"][h] = rng.permutation(r["y"][h])
    a, b = A.Modell(rader0, k0), A.Modell(r2, k0)
    assert np.allclose(a.poang(rader0[k0]["X"]), b.poang(rader0[k0]["X"])), "modellen har tränat på utfall som inte var kända"
    # Och tvärtom: förstörs ett utfall som FÅR användas ska förutsägelsen ändras (annars testar vi ingenting)
    r3 = copy.deepcopy(rader0)
    for r in r3[: k0 - max(A.MAL)]:
        for h in r["y"]:
            r["y"][h] = rng.permutation(r["y"][h])
    assert not np.allclose(a.poang(rader0[k0]["X"]), A.Modell(r3, k0).poang(rader0[k0]["X"]))


@test("målet är rensat från börsens och branschens rörelse")
def _():
    rng = np.random.default_rng(1)
    n = 300
    beta = rng.uniform(0.5, 1.5, n)
    sek = rng.integers(-1, 5, n)
    egen = rng.normal(0, 0.05, n)
    f = 0.10 * beta + 0.03 * sek + egen        # stor börsrörelse och olika per bransch
    y = A.rensat_mal(f, beta, sek)
    assert abs(np.corrcoef(y, egen)[0, 1]) > 0.9, "aktiens egna rörelse ska vara kvar"
    assert abs(np.corrcoef(y, A._r(beta))[0, 1]) < 0.05, "beta ska vara bortrensat"
    assert all(abs(y[sek == g].mean()) < 0.03 for g in np.unique(sek)), "branschen ska vara bortrensad"
    f[:5] = np.nan
    assert np.isnan(A.rensat_mal(f, beta, sek)[:5]).all()


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


@test("skydd mot fel bolag: ett 'indexbolag' som knappt handlas räknas inte med")
def _():
    C, P, V, spy, medl, hist = A.demo_data(seed=5, n=80, slut="2008-12-31", lika=True)
    V2 = V.copy()
    V2.iloc[:, 3] = V2.iloc[:, 3] / 1000          # handlas för en tusendel av de andra
    D = A.Data(C, P, V2, spy)
    i = len(D.dates) - 2
    mm = np.ones(len(D.tick), bool)
    _, mask, _, _ = A.tvarsnitt(D, i, mm, np.zeros(len(D.tick), int))
    assert not mask[3] and mask.sum() >= 50


@test("handel i dollar räknas på ojusterad kurs (framtida utdelningar får inte smyga in)")
def _():
    C, P, V, spy, medl, hist = A.demo_data(seed=6, n=40, slut="2007-12-31", lika=True)
    C2 = C.copy()
    C2.iloc[:, 0] = C2.iloc[:, 0] * 0.2          # som om en stor framtida utdelning justerat ner hela historiken
    a, b = A.Data(C, P, V, spy), A.Data(C2, P, V, spy)
    i = len(a.dates) - 2
    fa, fb = a.faktorer(i), b.faktorer(i)
    assert np.allclose(fa["_oms"], fb["_oms"], equal_nan=True) and np.allclose(fa["oms"], fb["oms"], equal_nan=True)
    assert np.allclose(fa["m12"], fb["m12"], equal_nan=True), "avkastningen påverkas inte av nivån"
    # Kontroll att testet biter: räknas handeln på den justerade kursen blir den fel
    assert not np.isclose(np.nanmean(b.Vol[i - 62:i + 1, 0] * b.Pb[i - 62:i + 1, 0]), fa["_oms"][0])


@test("dagens poäng: aktier utanför indexet får poäng utan att indexaktiernas ändras")
def _():
    C, P, V, spy, medl, hist = raw0
    D, rader, sek_ix = D0, rader0, sek0
    m = A.Modell(rader)
    tick, ix, karna, Xi, po, p100 = A.dagens_poang(D, C, P, V, spy, medl, sek_ix, m)
    assert karna.all() and 100 < len(ix) <= len(medl) and abs(np.median(p100) - 50) < 1
    # Flytta 25 av indexets aktier till "övriga" (2 års kurser) och räkna om
    flytt = [t for t in D.tick if t in medl][-25:]
    medl2 = {t: v for t, v in medl.items() if t not in flytt}
    behall = [t for t in D.tick if t not in flytt]
    D2 = A.Data(C[behall], P[behall], V[behall], spy)
    r2, sek2, _, _ = A.bygg(D2, medl2, [(d, frozenset(x for x in ts if x not in flytt)) for d, ts in hist])
    ov = (C[flytt].iloc[-504:], P[flytt].iloc[-504:], V[flytt].iloc[-504:])
    utan = A.dagens_poang(D2, C[behall], P[behall], V[behall], spy, medl2, sek2, m)
    med = A.dagens_poang(D2, C[behall], P[behall], V[behall], spy, medl2, sek2, m, ov)
    p_utan = dict(zip([utan[0][j] for j in utan[1]], utan[5]))
    p_med = dict(zip([med[0][j] for j in med[1]], med[5]))
    k_med = dict(zip([med[0][j] for j in med[1]], med[2]))
    assert all(abs(p_med[t] - p) < 1e-9 for t, p in p_utan.items()), "indexaktiernas poäng ändras av att övriga läggs till"
    nya = [t for t in flytt if t in p_med]
    assert len(nya) >= 20 and not any(k_med[t] for t in nya) and all(0 <= p_med[t] <= 100 for t in nya)
    assert np.std([p_med[t] for t in nya]) > 10, "övriga aktier ska spridas över skalan, inte hamna på samma poäng"


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


@test("simuleringen: beslut bara vissa månader, avgift på det som handlas")
def _():
    datum = pd.date_range("2020-01-01", periods=8, freq="MS")
    n = 150
    rader = [{"datum": d, "ix": np.arange(n), "fwd": np.full(n, 0.01), "spy": 0.01, "klar": True} for d in datum]
    # Samma rangordning i 3 månader, sedan omvänd: byte får bara ske i april och juli
    pred = {k: (np.arange(n, 0, -1.0) if k < 3 else np.arange(n) * 1.0) for k in range(8)}
    port, oms, byten = A.simulera(rader, pred, list(range(8)), np.full(n, -1))
    assert abs(port[0] - (0.01 - A.KOSTNAD)) < 1e-9, f"första månaden: allt köps ({port[0]})"
    assert abs(port[1] - 0.01) < 1e-9 and abs(port[2] - 0.01) < 1e-9, "februari, mars: ingen handel"
    assert abs(port[3] - (0.01 - 2 * A.KOSTNAD)) < 1e-9, f"april: allt byts, sälj + köp ({port[3]})"
    assert abs(oms[4]) < 1e-9 and abs(oms[5]) < 1e-9 and byten == [0, 20, 0], (oms, byten)


@test("algoritmens portfölj: beslut per kvartal, köp dagen efter, avgift, upprepad körning")
def _():
    ordn = [f"T{i}" for i in range(150)]
    sek = {}
    K = A.KOSTNAD
    noll = lambda *a: 0.0
    s1 = A.uppdatera_portfolj(None, "2026-11-12", noll, noll, ordn, sek)
    assert s1["beslut"]["köp"] == ordn[:20] and not s1["beslut"]["klart"] and s1["innehav"] == [] and s1["start"] is None
    assert A.uppdatera_portfolj(s1, "2026-11-12", noll, noll, ordn[::-1], sek) == s1, "samma dag två gånger ska inte ändra något"
    # Dagen efter: köpen genomförs, 0,3 % avgift
    s2 = A.uppdatera_portfolj(s1, "2026-11-13", noll, noll, ordn, sek)
    assert len(s2["innehav"]) == 20 and s2["beslut"]["klart"] and s2["start"] == "2026-11-13"
    assert abs(s2["värde"] - 100 * (1 - K)) < 1e-9 and s2["historik"]["datum"] == ["2026-11-13"]
    assert A.uppdatera_portfolj(s2, "2026-11-13", noll, noll, ordn, sek) == s2
    # Senare: värdet följer kurserna, inget nytt beslut
    upp = lambda t, fran: 0.10 if t == "T0" else 0.0
    s3 = A.uppdatera_portfolj(s2, "2026-11-20", upp, lambda fran: 0.02, ordn[::-1], sek)
    assert s3["beslut"] == s2["beslut"]
    assert abs(s3["värde"] - s2["värde"] * (1 + 0.10 / 20)) < 1e-9 and abs(s3["index"] - 102) < 1e-9
    assert abs(next(h for h in s3["innehav"] if h["t"] == "T0")["f"] - 1.10) < 1e-12
    # December är ingen beslutsmånad: inget händer även om rangordningen har ändrats
    ny = ordn[5:105] + ordn[:5] + ordn[105:]          # T0–T4 har fallit ur de 100 bästa
    s4 = A.uppdatera_portfolj(s3, "2026-12-01", noll, noll, ny, sek)
    assert s4["beslut"] == s3["beslut"] and len(s4["innehav"]) == 20
    # Januari: beslut. T0–T4 säljs, fem nya köps – dagen efter
    s5 = A.uppdatera_portfolj(s4, "2027-01-04", noll, noll, ny, sek)
    b = s5["beslut"]
    assert set(b["sälj"]) == {"T0", "T1", "T2", "T3", "T4"} and b["köp"] == ["T20", "T21", "T22", "T23", "T24"] and not b["klart"]
    assert len(s5["innehav"]) == 20, "inget säljs förrän dagen efter"
    s6 = A.uppdatera_portfolj(s5, "2027-01-05", noll, noll, ny, sek)
    assert {h["t"] for h in s6["innehav"]} == set(ordn[5:25]) and len(s6["logg"]) == 2
    salt = sum(h["v"] for h in s5["innehav"] if h["t"] in b["sälj"])
    assert abs(s6["värde"] - (s5["värde"] - salt + salt * (1 - K) ** 2)) < 1e-9, "avgift på både sälj och köp"
    assert all(abs(h["v"] - salt * (1 - K) ** 2 / 5) < 1e-9 for h in s6["innehav"] if h["köpt"] == "2027-01-05")
    gamla = {h["t"]: h["v"] for h in s5["innehav"]}
    assert all(abs(h["v"] - gamla[h["t"]]) < 1e-12 for h in s6["innehav"] if h["köpt"] != "2027-01-05"), "det som behålls rörs inte"
    assert A.uppdatera_portfolj(s6, "2027-01-05", noll, noll, ny, sek) == s6
    # Aktie som försvunnit ur listan säljs vid nästa beslut (april)
    utan = [t for t in ny if t != "T7"]
    assert A.uppdatera_portfolj(s6, "2027-02-01", noll, noll, utan, sek)["beslut"] == s6["beslut"]
    assert "T7" in A.uppdatera_portfolj(s6, "2027-04-01", noll, noll, utan, sek)["beslut"]["sälj"]


@test("nyckeltal räknas rätt")
def _():
    n = A.nyckeltal(np.array([0.1, -0.5, 0.2] + [0.0] * 9))
    assert abs(n["cagr"] - (1.1 * 0.5 * 1.2 - 1)) < 1e-9 and abs(n["maxdd"] + 0.5) < 1e-9
    assert abs(A.nyckeltal(np.array([-0.2] + [0.0] * 11))["maxdd"] + 0.2) < 1e-9, "ras från start ska räknas"


if __name__ == "__main__":
    print("Alla test gick igenom" if not FEL else f"{len(FEL)} test misslyckades")
    sys.exit(1 if FEL else 0)
