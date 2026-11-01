#!/usr/bin/env python3
"""
Måndagens AI-uppdatering: gör nya AI-analyser för aktierna i bevakningslistan som är äldre än 6 dagar.
Högst MAX aktier per vecka (ca 1–2 kr styck). Äldsta först. Aktier utanför USA hoppas över.
Om en aktie misslyckas fortsätter körningen med nästa.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX = int(os.environ.get("MAX_AKTIER", "9"))
ALDER = 6 * 86400e3


def url() -> str:
    with open(os.path.join(ROOT, "docs", "config.js"), encoding="utf-8") as fh:
        return re.search(r'workerUrl:\s*"([^"]+)"', fh.read()).group(1).rstrip("/")


def api(base, key, path, method="GET", timeout=60):
    req = urllib.request.Request(base + path, method=method, headers={"X-App-Key": key, "User-Agent": "aktieagent-ai-vecka"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error")
        except Exception:  # noqa: BLE001
            msg = None
        raise RuntimeError(msg or f"Servern svarade {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"Ingen kontakt med servern ({e})") from None


def main():
    key = os.environ.get("APP_KEY")
    if not key:
        print("::error::APP_KEY saknas i GitHub-hemligheterna.")
        return 1
    base = url()
    try:
        wl = api(base, key, "/api/watchlist")
    except RuntimeError as e:
        print(f"::error::{e}")
        return 1
    now = time.time() * 1000
    lista = []
    for w in wl:
        t = w["t"]
        if re.search(r"\.[A-Z]{1,3}$", t):
            print(f"  {t}: inte amerikansk, hoppas över")
            continue
        try:
            a = api(base, key, f"/api/ai?t={t}")
        except RuntimeError as e:
            print(f"  {t}: {e}")
            continue
        at = 0 if a.get("saknas") else a.get("analyserad", 0)
        if now - at > ALDER:
            lista.append((at, t))
    lista.sort()
    klara, fel = [], []
    for at, t in lista[:MAX]:
        t0 = time.time()
        try:
            a = api(base, key, f"/api/ai?t={t}&force=1", method="POST", timeout=300)
            klara.append(f"{t} ({a.get('betyg')})")
            print(f"  {t}: klar på {time.time() - t0:.0f} s – {a.get('betyg')}")
        except RuntimeError as e:
            fel.append(f"{t}: {e}")
            print(f"  {t}: misslyckades efter {time.time() - t0:.0f} s – {e}")
            if "gräns" in str(e) or "Krediterna" in str(e):
                break
    print(f"::notice title=AI-uppdatering::{len(klara)} nya analyser: {', '.join(klara) or 'inga'}" + (f" · {len(lista) - MAX} väntar till nästa vecka" if len(lista) > MAX else ""))
    if fel:
        print("::warning title=Misslyckades::" + " | ".join(fel))
    return 0


if __name__ == "__main__":
    sys.exit(main())
