"""Kontrollerar att Python-modellen (modell.py) ger samma svar som serverns (worker/src/analys.js).
Kör: python test_modell.py"""
import json
import os
import subprocess
import sys

import modell

ROOT = os.path.dirname(os.path.abspath(__file__))
CASES = [
    ({"eps_nästa_år": 6.1, "forward_pe": 28, "vinsttillväxt_nästa_år": 0.36, "roe": 0.9, "rörelsemarginal": 0.58,
      "ps": 18, "bruttomarginal": 0.72, "utdelning": 0.0003}, 170.0, 0.21),
    ({"eps_nästa_år": 7.0, "forward_pe": 25, "vinsttillväxt_nästa_år": 0.05, "roe": 1.5, "rörelsemarginal": 0.3,
      "utdelning": 0.005}, 175.0, 0.06),
    ({"forward_pe": None, "omsättningstillväxt_nästa_år": 0.45, "ps": 12, "bruttomarginal": 0.6}, 40.0, None),  # förlustbolag
    ({"eps_nästa_år": 2.0, "forward_pe": 9, "omsättningstillväxt": -0.08, "roe": 0.05, "utdelning": 0.04}, 20.0, -0.1),
    ({"eps_nästa_år": 30.0, "forward_pe": 12, "vinsttillväxt_nästa_år": 0.1}, 120.0, 0.12),  # valuta-skydd slår till
    ({}, 50.0, None),
]


def js_results():
    script = (
        "import { horizons } from './worker/src/analys.js';"
        f"const cases = {json.dumps([[f, p, er] for f, p, er in CASES], ensure_ascii=False)};"
        "console.log(JSON.stringify(cases.map(([f,p,er]) => Object.fromEntries(horizons(f, {kurs:p, volatilitet:0.3}, er).rader.map(r => [r.år, r.årlig])))));"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main():
    fails = 0
    for (f, p, er), js in zip(CASES, js_results()):
        py = modell.horizons(f, p, er)
        for k, v in js.items():
            pv = py.get(int(k))
            if pv is None or abs(pv - v) > 1e-9:
                fails += 1
                print(f"SKILLNAD {f} år {k}: js {v} py {pv}")
        if set(map(int, js)) != set(py):
            fails += 1
            print(f"SKILLNAD i vilka år som finns: js {sorted(js)} py {sorted(py)}")
    print("Python och server ger samma svar" if not fails else f"{fails} skillnader")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
