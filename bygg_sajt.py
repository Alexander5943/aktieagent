#!/usr/bin/env python3
"""
Bygger mobilappens startsida (docs/index.html) av rapporterna i docs/rapporter.
Körs automatiskt av GitHub efter varje analys.
"""
from __future__ import annotations

import html
import json
import os
from datetime import datetime, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")
REP = os.path.join(DOCS, "rapporter")
REPO = os.environ.get("GITHUB_REPOSITORY", "")

COLORS = {"Köpvärd": "#1a7f37", "Avvakta / bevaka": "#b7791f", "Undvik just nu": "#c0392b"}
e = html.escape


def files(prefix, ext):
    if not os.path.isdir(REP):
        return []
    return sorted((f for f in os.listdir(REP) if f.startswith(prefix) and f.endswith(ext)), reverse=True)


def pct(x):
    return "" if x is None or pd.isna(x) else f"{x * 100:+.0f} %"


def make_icons():
    """Skapar app-ikonen (en uppåtgående linje) om den saknas."""
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


def watch_card():
    js = files("bevakning_", ".json")
    if not js:
        return '<section class="card"><h2>Bevakningslista</h2><p class="muted">Ingen körning ännu.</p></section>'
    with open(os.path.join(REP, js[0]), encoding="utf-8") as fh:
        data = json.load(fh)
    day = js[0][10:20]
    page = js[0].replace(".json", ".html")
    order = {"Köpvärd": 0, "Avvakta / bevaka": 1, "Undvik just nu": 2}
    data.sort(key=lambda r: (order.get(r["betyg"], 3), -r["poäng"]))
    rows = []
    for r in data:
        summary = f'<p class="sum">{e(r["sammanfattning"])}</p>' if r.get("sammanfattning") else ""
        rows.append(
            f'<a class="row" href="rapporter/{page}#{e(r["ticker"])}">'
            f'<div class="l"><b>{e(r["ticker"])}</b><small>{e(str(r["namn"])[:28])}</small>{summary}</div>'
            f'<div class="r"><span class="badge" style="background:{COLORS.get(r["betyg"], "#555")}">{e(r["betyg"])}</span>'
            f'<small>{r["poäng"]}/100 · 1 mån {pct(r.get("förändring_1m"))}</small></div></a>')
    return (f'<section class="card"><div class="head"><h2>Bevakningslista</h2><span class="muted">{day}</span></div>'
            f'{"".join(rows)}<a class="more" href="rapporter/{page}">Hela rapporten med grafer →</a></section>')


def ranking_card():
    cs = files("aktieranking_", ".csv")
    if not cs:
        return '<section class="card"><h2>Årets topplista</h2><p class="muted">Ingen körning ännu.</p></section>'
    df = pd.read_csv(os.path.join(REP, cs[0])).head(10)
    period = cs[0].split("_")[1].replace("-", "–")
    day = cs[0].split("_")[2][:10]
    rows = "".join(
        f'<a class="row" href="rapporter/{cs[0].replace(".csv", ".html")}">'
        f'<div class="l"><b>{int(r.rank)}. {e(r.ticker)}</b><small>{e(str(r.namn)[:28])}</small></div>'
        f'<div class="r"><b class="up">{pct(r.förväntad_avkastning)}</b><small>kvalitet {int(r.kvalitetspoäng)}</small></div></a>'
        for r in df.itertuples())
    return (f'<section class="card"><div class="head"><h2>Topp 10 för {period}</h2><span class="muted">{day}</span></div>'
            f'<p class="muted">Förväntad avkastning 12 mån – en uppskattning, ingen prognos.</p>{rows}'
            f'<a class="more" href="rapporter/{cs[0].replace(".csv", ".html")}">Hela listan →</a></section>')


def eval_card():
    path = os.path.join(DOCS, "utvardering.txt")
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as fh:
        text = fh.read().strip()
    if not text or text.startswith("Ingen historik"):
        return ""
    return f'<section class="card"><h2>Hur gick tidigare listor?</h2><pre>{e(text)}</pre></section>'


def archive_card():
    items = files("bevakning_", ".html") + files("aktieranking_", ".html")
    items.sort(key=lambda f: f.rsplit("_", 1)[-1], reverse=True)
    if not items:
        return ""
    li = "".join(
        f'<li><a href="rapporter/{f}">{"Bevakning" if f.startswith("bev") else "Topplista " + f.split("_")[1]}'
        f' <span class="muted">{f.rsplit("_", 1)[-1][:10]}</span></a></li>' for f in items[:30])
    return f'<section class="card"><h2>Arkiv</h2><ul class="arch">{li}</ul></section>'


def run_button():
    if not REPO:
        return ""
    url = f"https://github.com/{REPO}/actions/workflows/aktieagent.yml"
    return f'<a class="btn" href="{url}">Kör en analys nu (öppnar GitHub)</a>'


def main():
    os.makedirs(DOCS, exist_ok=True)
    make_icons()
    open(os.path.join(DOCS, ".nojekyll"), "w").close()
    manifest = {"name": "Aktieagent", "short_name": "Aktier", "start_url": "./", "display": "standalone",
                "background_color": "#14365a", "theme_color": "#14365a", "lang": "sv",
                "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
                          {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}]}
    with open(os.path.join(DOCS, "manifest.webmanifest"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False)

    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    page = f"""<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Aktieagent</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Aktier">
<meta name="theme-color" content="#14365a">
<style>
:root{{--bg:#f2f3f5;--card:#fff;--text:#16181b;--muted:#6b7280;--line:#eceef1;--up:#1a7f37;--accent:#14365a}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0f1115;--card:#1a1d23;--text:#eceef1;--muted:#9aa1ab;--line:#2a2e36;--up:#4ac77a;--accent:#7eb6ff}}}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 -apple-system,system-ui,sans-serif;
padding:calc(env(safe-area-inset-top) + 12px) 16px calc(env(safe-area-inset-bottom) + 24px)}}
main{{max-width:640px;margin:auto}} h1{{font-size:26px;margin:8px 0 2px}} h2{{font-size:17px;margin:0 0 8px}}
.muted{{color:var(--muted);font-size:13px}} .card{{background:var(--card);border-radius:16px;padding:16px;margin:14px 0}}
.head{{display:flex;justify-content:space-between;align-items:baseline}}
.row{{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line);color:inherit;text-decoration:none}}
.l,.r{{display:flex;flex-direction:column}} .r{{align-items:flex-end;text-align:right;flex-shrink:0}}
.l small,.r small{{color:var(--muted);font-size:12px}} .sum{{margin:4px 0 0;font-size:13px;color:var(--muted)}}
.badge{{color:#fff;font-size:12px;font-weight:600;padding:3px 8px;border-radius:8px;margin-bottom:3px}}
.up{{color:var(--up)}} .more{{display:block;padding-top:10px;border-top:1px solid var(--line);color:var(--accent);text-decoration:none;font-weight:600}}
.btn{{display:block;text-align:center;background:var(--accent);color:var(--card);padding:12px;border-radius:12px;text-decoration:none;font-weight:600}}
pre{{white-space:pre-wrap;font-size:12px;margin:0}} .arch{{list-style:none;padding:0;margin:0}}
.arch li{{border-top:1px solid var(--line)}} .arch a{{display:block;padding:9px 0;color:inherit;text-decoration:none}}
</style></head><body><main>
<h1>Aktieagent</h1><p class="muted">Uppdaterad {now}. Underlag för egen analys – inte finansiell rådgivning.</p>
{watch_card()}
{ranking_card()}
{eval_card()}
{run_button()}
{archive_card()}
</main></body></html>"""
    with open(os.path.join(DOCS, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page)
    print(f"Appen byggd: {os.path.join(DOCS, 'index.html')}")


if __name__ == "__main__":
    main()
