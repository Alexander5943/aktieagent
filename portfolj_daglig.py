#!/usr/bin/env python3
"""
Daglig AI-genomgång av portföljen.

Körs av GitHub Actions varje vardagskväll efter att börsen i New York stängt. Gör bara något om
"Daglig AI-genomgång" är påslagen i appens Portfölj-flik (kostar ungefär 1 kr per gång).

Pratar med servern precis som appen gör: hämtar portföljen och en signal per aktie,
tar kandidater ur topplistorna och ber servern om ett AI-råd. Rådet sparas på servern
och syns i appen nästa gång du öppnar den.

  APP_KEY=... python portfolj_daglig.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))


def worker_url() -> str:
    with open(os.path.join(ROOT, "docs", "config.js"), encoding="utf-8") as fh:
        m = re.search(r'workerUrl:\s*"([^"]+)"', fh.read())
    if not m or not m.group(1).startswith("https://"):
        raise SystemExit("FEL: Hittade ingen serveradress i docs/config.js.")
    return m.group(1).rstrip("/")


def api(base: str, key: str, path: str, body: dict | None = None, timeout: int = 60):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-App-Key": key, "Content-Type": "application/json", "User-Agent": "aktieagent-daglig"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error")
        except Exception:
            msg = None
        raise RuntimeError(msg or f"Servern svarade {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"Ingen kontakt med servern ({e})") from None


def candidates() -> list[dict]:
    """Samma kandidater som appen använder: topplistorna 1–3 år och 5–10 år (annars förra 12-månaderslistan)."""
    try:
        with open(os.path.join(ROOT, "docs", "data", "ranking.json"), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return []
    out: dict[str, dict] = {}

    def add(rows, lista):
        for x in rows or []:
            out.setdefault(x["ticker"], {"t": x["ticker"], "namn": x.get("namn"), "sektor": x.get("sektor"),
                                         "årlig_3år": x.get("årlig_3år"), "årlig_10år": x.get("årlig_10år"),
                                         "förväntad": x.get("förväntad"), "kvalitet": x.get("kvalitet"),
                                         "ai": x.get("ai"), "lista": lista})
    listor = d.get("listor") or {}
    if listor.get("mellan"):
        add(listor["mellan"]["rader"], "1–3 år")
    if listor.get("lang"):
        add(listor["lang"]["rader"], "5–10 år")
    if not out:
        add(d.get("rader"), "12 månader")
    return list(out.values())


def main() -> int:
    key = os.environ.get("APP_KEY")
    if not key:
        print("::error::APP_KEY saknas i GitHub-hemligheterna.")
        return 1
    base = (os.environ.get("WORKER_URL") or "").rstrip("/") or worker_url()  # WORKER_URL bara för test
    try:
        settings = api(base, key, "/api/portfolio/settings")
        portfolio = api(base, key, "/api/portfolio") if settings.get("dagligAI") else []
    except RuntimeError as e:
        print(f"::error::{e}")
        return 1
    if not settings.get("dagligAI"):
        print("Daglig AI-genomgång är avstängd i appen. Inget att göra.")
        return 0
    if not portfolio:
        print("Portföljen är tom. Inget att göra.")
        return 0
    signals = []
    for h in portfolio:
        try:
            signals.append(api(base, key, f"/api/signal?t={h['t']}"))
        except RuntimeError as e:
            print(f"  {h['t']}: kunde inte hämta data ({e})")
    print(f"{len(signals)} av {len(portfolio)} aktier hämtade. Ber AI:n om råd …")
    try:
        a = api(base, key, "/api/portfolio/advice", {"signaler": signals, "kandidater": candidates(), "automatisk": True}, timeout=180)
    except RuntimeError as e:
        print(f"::error::AI-genomgången misslyckades: {e}")
        return 1
    print(a.get("sammanfattning", ""))
    for r in a.get("innehav", []):
        alt = ", ".join(x["t"] for x in r.get("alternativ", []))
        print(f"  {r['t']:<6} {r['råd']:<12} {r.get('kort', '')}{'  → ' + alt if alt else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
