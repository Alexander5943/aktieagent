"""Testar Framtidsaktier utan internet: filter, AI-svarets format och rangordningen.  python test_framtid.py"""
import re
import sys
import types

import framtid as F

fails = 0


def check(name, ok):
    global fails
    print(("OK   " if ok else "FEL  ") + name)
    fails += 0 if ok else 1


base = {"quoteType": "EQUITY", "longName": "Fusion Power Inc", "industry": "Utilities - Renewable", "sector": "Utilities",
        "marketCap": 2e9, "trailingEps": -1.2, "profitMargins": -0.8, "totalRevenue": 5e7, "revenueGrowth": 0.9,
        "grossMargins": 0.3, "totalCash": 6e8, "freeCashflow": -1.5e8, "heldPercentInsiders": 0.25,
        "longBusinessSummary": "Builds small modular nuclear reactors and fusion power plants for data centers."}

f = F.facts("FUSN", base, {"omsättningstillväxt_nästa_år": 0.8})
check("olönsamt framtidsbolag kommer med", f is not None and f["tema_ord"] == "Energi")
check("kassan räcker 4 år", f is not None and abs(f["kassa_år"] - 4.0) < 1e-9)
check("lönsamt bolag sorteras bort", F.facts("PROF", {**base, "trailingEps": 2, "profitMargins": 0.2, "netIncomeToCommon": 5e8}, {}) is None)
check("för litet bolag sorteras bort", F.facts("TINY", {**base, "marketCap": 1e8}, {}) is None)
check("krympande förlustbolag sorteras bort", F.facts("SHRK", {**base, "totalRevenue": 5e9, "revenueGrowth": -0.1}, {}) is None)
check("SPAC sorteras bort", F.facts("SPAC", {**base, "longName": "Future Acquisition Corp II"}, {}) is None)
check("bank sorteras bort", F.facts("BANK", {**base, "industry": "Banks - Regional"}, {}) is None)


def names(schema):
    out = []
    for k, v in (schema.get("properties") or {}).items():
        out.append(k)
        out += names(v.get("items", {}) if v.get("type") == "array" else v)
    return out


check("AI-verktygets fältnamn är ASCII", all(re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", k) for k in names(F.SCORES_TOOL["input_schema"])))

# Låtsas-Claude
calls = []


class FakeMessages:
    def create(self, **kw):
        calls.append(kw)
        import json
        rows = json.loads(kw["messages"][0]["content"].split("\n", 1)[1].split("\n\n")[0])
        bolag = [{"ticker": r["ticker"].lower(), "tema": "Energi", "problem": "Ren energi", "ide": "Små reaktorer.", "malsattning": "Första reaktorn 2028.",
                  "risk": "Tillstånd.", "problem_poang": 9, "ide_poang": 8 if r["ticker"] == "FUSN" else 4, "malmedveten_poang": 7} for r in rows]
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="tool_use", input={"bolag": bolag})])


sys.modules["anthropic"] = types.SimpleNamespace(Anthropic=lambda: types.SimpleNamespace(messages=FakeMessages()))
others = [F.facts(f"X{i}", {**base, "longName": f"Other {i}", "longBusinessSummary": "Sells software."}, {}) for i in range(25)]
cands = F.preselect([f] + others)
sc = F.ai_scores(cands)
check("AI anropas i grupper om 20", len(calls) == 2 and "tool_choice" not in calls[0] and calls[0]["tools"][0]["name"] == "submit_scores")
check("svar mappas till ticker (versaler)", "FUSN" in sc and len(sc) == 26)
top = F.rank(cands, sc)
check("bäst idé hamnar först", top[0]["ticker"] == "FUSN" and top[0]["poäng"] > top[1]["poäng"])
check("poäng 0–100 och delar finns", 0 <= top[0]["poäng"] <= 100 and set(top[0]["delar"]) == {"Idé", "Framtidsproblem", "Målmedvetenhet", "Genomförande"})
check("nästa uppdatering", F.next_update(F.date(2026, 10, 5)) == "2027-01-02" and F.next_update(F.date(2026, 12, 31)) == "2027-01-02")

print("\nAlla test gick igenom" if not fails else f"\n{fails} test misslyckades")
sys.exit(1 if fails else 0)
