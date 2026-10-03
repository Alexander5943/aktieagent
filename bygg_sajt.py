#!/usr/bin/env python3
"""
Förbereder data till appen efter att screenern har körts.

Själva appen (docs/index.html, app.js, app.css) är fasta filer. Det här skriptet
skriver bara docs/data/ranking.json (topplistan) och ser till att ikoner och
manifest finns.
"""
from __future__ import annotations

import json
import os

import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")
REP = os.path.join(DOCS, "rapporter")
DATA = os.path.join(DOCS, "data")


def latest(prefix, ext):
    if not os.path.isdir(REP):
        return None
    files = sorted((f for f in os.listdir(REP) if f.startswith(prefix) and f.endswith(ext)), reverse=True)
    return files[0] if files else None


def num(x):
    return None if x is None or pd.isna(x) else float(x)


def ranking():
    csv = latest("aktieranking_", ".csv")
    if not csv:
        return
    df = pd.read_csv(os.path.join(REP, csv))
    ai = {}
    ai_file = os.path.join(REP, csv.replace(".csv", "_ai.json"))
    if os.path.exists(ai_file):
        with open(ai_file, encoding="utf-8") as fh:
            ai = json.load(fh)
    period = csv.split("_")[1]
    rows = [{
        "rank": int(r.rank), "ticker": r.ticker, "namn": str(r.namn), "sektor": str(r.sektor),
        "förväntad": num(r.förväntad_avkastning), "kvalitet": int(r.kvalitetspoäng),
        "volatilitet": num(r.volatilitet), "ai": (ai.get(r.ticker) or {}).get("betyg"),
    } for r in df.head(30).itertuples()]
    out = {
        "period": period.replace("-", "–"), "datum": csv.split("_")[2][:10], "antal": len(df),
        "universum": "S&P 500", "rader": rows, "rapport": "rapporter/" + csv.replace(".csv", ".html"),
    }
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "ranking.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print(f"Topplista: {len(rows)} rader från {csv}")


def make_icons():
    if os.path.exists(os.path.join(DOCS, "icon-512.png")):
        return
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    for size in (180, 192, 512):
        fig = plt.figure(figsize=(1, 1), dpi=size)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(0, 1), ax.set_ylim(0, 1), ax.axis("off")
        fig.patch.set_facecolor("#14365a")
        ax.plot([0.18, 0.38, 0.55, 0.82], [0.30, 0.52, 0.42, 0.74], color="#7ee2a8",
                lw=size / 18, solid_capstyle="round", solid_joinstyle="round")
        name = "apple-touch-icon.png" if size == 180 else f"icon-{size}.png"
        fig.savefig(os.path.join(DOCS, name), facecolor=fig.get_facecolor())
        plt.close(fig)


def main():
    os.makedirs(DOCS, exist_ok=True)
    make_icons()
    open(os.path.join(DOCS, ".nojekyll"), "w").close()
    manifest = {"name": "Aktier", "short_name": "Aktier", "start_url": "./", "display": "standalone",
                "background_color": "#14365a", "theme_color": "#14365a", "lang": "sv",
                "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
                          {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}]}
    with open(os.path.join(DOCS, "manifest.webmanifest"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False)
    ranking()


if __name__ == "__main__":
    main()
