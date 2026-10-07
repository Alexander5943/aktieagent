/* Aktieagent – appen i telefonen. Pratar med servern (Cloudflare Worker) som hämtar data och kör AI. */
(() => {
  "use strict";

  // ---------- Inställningar och hjälpfunktioner ----------
  const CFG = window.AKTIE_CONFIG || {};
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem("aktie." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem("aktie." + k, JSON.stringify(v)); } catch {} },
    del: (k) => { try { localStorage.removeItem("aktie." + k); } catch {} },
  };
  const serverUrl = () => (LS.get("server", "") || CFG.workerUrl || "").replace(/\/+$/, "");
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
  const nf = (d) => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (x, d = 2) => (x == null || !isFinite(x) ? "–" : nf(d).format(x));
  const pct = (x, d = 1, sign = true) => {
    if (x == null || !isFinite(x)) return "–";
    const v = Math.round(x * 100 * 10 ** d) / 10 ** d || 0; // undvik "−0 %"
    return (sign && v > 0 ? "+" : "") + nf(d).format(v) + " %";
  };
  const big = (x) => {
    if (x == null || !isFinite(x)) return "–";
    const a = Math.abs(x);
    if (a >= 1e12) return num(x / 1e12, 2) + " bn";
    if (a >= 1e9) return num(x / 1e9, 1) + " md";
    if (a >= 1e6) return num(x / 1e6, 0) + " mn";
    return num(x, 0);
  };
  const cls = (x) => (x == null ? "" : x >= 0 ? "up" : "down");
  const pillCls = (b) => (b === "Köpvärd" ? "buy" : b === "Undvik just nu" ? "avoid" : "hold");
  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 2) return "nyss"; if (m < 60) return `${m} min sedan`;
    const h = Math.round(m / 60); if (h < 24) return `${h} tim sedan`;
    const d = Math.round(h / 24); return d === 1 ? "i går" : `${d} dagar sedan`;
  };
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 3200);
  }
  const ICON = {
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
    chev: '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>',
  };

  // ---------- Prat med servern ----------
  async function api(path, opts = {}) {
    const base = serverUrl();
    if (!base) throw new Error("Appen är inte kopplad till servern än.");
    let r;
    try {
      r = await fetch(base + path, {
        method: opts.method || "GET",
        headers: { "X-App-Key": LS.get("key", ""), "Content-Type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch { throw new Error("Ingen kontakt med servern. Kolla internet."); }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { LS.del("key"); route(); throw new Error("Fel app-kod."); }
    if (!r.ok) throw new Error(data.error || `Fel ${r.status}`);
    return data;
  }

  // Bevakningslistan hålls i minnet så att stjärnan svarar direkt
  let watch = LS.get("watchCache", []);
  async function loadWatch() { watch = await api("/api/watchlist"); LS.set("watchCache", watch); return watch; }
  const inWatch = (t) => watch.some((w) => w.t === t);
  async function toggleWatch(t, namn) {
    const add = !inWatch(t);
    watch = await api("/api/watchlist", { method: "POST", body: { action: add ? "add" : "remove", t, namn } });
    LS.set("watchCache", watch);
    toast(add ? `${t} tillagd i bevakningen` : `${t} borttagen`);
    return add;
  }

  // ---------- Router ----------
  let current = null;
  const GEAR = '<a class="iconbtn" href="#/installningar" aria-label="Inställningar"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></a>';
  function setTop(title, action = "", back = false, gear = !back) {
    $("#title").innerHTML = back ? `<button class="back" onclick="history.length>1?history.back():location.hash='#/bevakning'">‹ Tillbaka</button>` : esc(title);
    $("#topaction").innerHTML = action + (gear ? GEAR : "");
  }
  function route() {
    const h = location.hash.replace(/^#\/?/, "") || "bevakning";
    const [page, arg, arg2] = h.split("/");
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === page || (page === "aktie" && a.dataset.tab === LS.get("lastTab", "bevakning"))));
    if (current && current.destroy) current.destroy();
    current = null;
    window.scrollTo(0, 0);
    if (!serverUrl() || !LS.get("key", "")) return viewLogin();
    if (page !== "aktie" && page !== "installningar") LS.set("lastTab", page);
    if (page === "sok") return viewSearch();
    if (page === "topp") return viewTop();
    if (page === "framtid") return viewFuture();
    if (page === "installningar") return viewSettings();
    if (page === "portfolj") return viewPortfolio(arg === "ny" && arg2 ? decodeURIComponent(arg2).toUpperCase() : null);
    if (page === "aktie" && arg) return viewStock(decodeURIComponent(arg).toUpperCase());
    return viewWatch();
  }
  window.addEventListener("hashchange", route);

  // ---------- Inloggning ----------
  function viewLogin() {
    setTop("Aktier", "", false, false);
    const needServer = !CFG.workerUrl;
    view.innerHTML = `
      <div class="card">
        <h2>Välkommen</h2>
        <p class="muted small">Ange din app-kod för att komma igång. Det är koden du själv valde när servern sattes upp.</p>
        ${needServer ? `<div class="field"><label>Serveradress</label><input id="srv" type="url" placeholder="https://aktieagent.….workers.dev" value="${esc(LS.get("server", ""))}" autocomplete="off"></div>` : ""}
        <div class="field"><label>App-kod</label><input id="key" type="password" autocomplete="current-password"></div>
        <button class="btn" id="go">Logga in</button>
      </div>`;
    $("#go").onclick = async () => {
      if (needServer) LS.set("server", $("#srv").value.trim());
      LS.set("key", $("#key").value.trim());
      const b = $("#go"); b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
      try { await api("/api/ping"); location.hash = "#/bevakning"; route(); }
      catch (e) { toast(e.message); b.disabled = false; b.textContent = "Logga in"; }
    };
  }

  // ---------- Bevakning ----------
  function spark(vals, up) {
    if (!vals || vals.length < 2) return "";
    const w = 64, h = 26, lo = Math.min(...vals), hi = Math.max(...vals), r = hi - lo || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - lo) / r) * h}`).join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 -2 ${w} ${h + 4}"><polyline points="${pts}" fill="none" stroke="var(--${up ? "up" : "down"})" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  async function viewWatch() {
    setTop("Bevakning", `<a class="star" href="#/sok">${ICON.search.replace("<svg", '<svg style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2"')} Lägg till</a>`);
    const render = (list, quotes = {}, ai = {}) => {
      if (!list.length) {
        view.innerHTML = `<div class="card empty">${ICON.star}<p><b>Din bevakningslista är tom</b></p>
          <p class="small">Sök efter en aktie och tryck på stjärnan för att följa den.</p>
          <a class="btn" href="#/sok" style="margin-top:8px">Sök aktier</a></div>`;
        return;
      }
      view.innerHTML = `<div class="card">${list.map((w) => {
        const q = quotes[w.t] || {}, a = ai[w.t];
        const up = (q.idag ?? 0) >= 0;
        return `<a class="row" href="#/aktie/${encodeURIComponent(w.t)}">
          <div class="main"><b>${esc(w.t)}</b><span>${esc(w.namn || "")}</span></div>
          ${spark(q.spark, (q.spark && q.spark.at(-1) >= q.spark[0]))}
          <div class="side"><b>${q.pris != null ? num(q.pris) : '<span class="skeleton" style="display:inline-block;width:52px;height:14px"></span>'}</b>
            <span class="small ${cls(q.idag)}">${q.idag != null ? pct(q.idag, 2) : ""}</span>
            ${a && !a.saknas ? `<div style="margin-top:3px"><span class="pill ${pillCls(a.betyg)}">${esc(a.betyg)}</span></div>` : ""}</div>
        </a>`;
      }).join("")}</div>
      <p class="disclaimer">Kurser uppdateras varje minut. AI-analysen uppdateras automatiskt varje måndag.</p>`;
    };
    render(watch);
    try {
      const list = await loadWatch();
      render(list);
      if (!list.length) return;
      const [q, ais] = await Promise.all([
        api("/api/quotes?symbols=" + list.map((w) => encodeURIComponent(w.t)).join(",")),
        Promise.all(list.map((w) => api("/api/ai?t=" + encodeURIComponent(w.t)).catch(() => null))),
      ]);
      const qm = {}; q.quotes.forEach((x) => (qm[x.t] = x));
      const am = {}; list.forEach((w, i) => (am[w.t] = ais[i]));
      if (location.hash.replace(/^#\/?/, "").startsWith("bevakning") || location.hash === "") render(list, qm, am);
    } catch (e) { toast(e.message); }
  }

  // ---------- Sök ----------
  function viewSearch() {
    setTop("Sök");
    const recent = LS.get("recent", []);
    view.innerHTML = `
      <div class="search">${ICON.search}<input id="q" type="search" placeholder="Sök bolag eller ticker, t.ex. Nvidia" autocomplete="off" autocapitalize="characters" enterkeyhint="search"></div>
      <div id="res"></div>`;
    const res = $("#res"), q = $("#q");
    const showRecent = () => {
      res.innerHTML = recent.length ? `<div class="card"><h2>Senast sökta</h2>${recent.map(row).join("")}</div>`
        : `<div class="card empty">${ICON.search}<p>Sök på bolagsnamn eller ticker.<br><span class="small">Du får graf, nyckeltal och AI:ns bedömning.</span></p></div>`;
    };
    const row = (x) => `<a class="row" href="#/aktie/${encodeURIComponent(x.t)}" data-t="${esc(x.t)}" data-n="${esc(x.namn)}">
      <div class="main"><b>${esc(x.t)}</b><span>${esc(x.namn)}${x.börs ? " · " + esc(x.börs) : ""}</span></div>${ICON.chev}</a>`;
    res.addEventListener("click", (e) => {
      const a = e.target.closest("a.row"); if (!a) return;
      const item = { t: a.dataset.t, namn: a.dataset.n };
      LS.set("recent", [item, ...recent.filter((r) => r.t !== item.t)].slice(0, 8));
    });
    let timer, seq = 0;
    q.addEventListener("input", () => {
      clearTimeout(timer);
      const v = q.value.trim();
      if (!v) return showRecent();
      timer = setTimeout(async () => {
        const my = ++seq;
        res.innerHTML = `<div class="card"><div class="skeleton" style="height:44px;margin:6px 0"></div><div class="skeleton" style="height:44px;margin:6px 0"></div></div>`;
        try {
          const d = await api("/api/search?q=" + encodeURIComponent(v));
          if (my !== seq) return;
          res.innerHTML = d.results.length ? `<div class="card">${d.results.map(row).join("")}</div>`
            : `<div class="card empty"><p>Inga träffar för ”${esc(v)}”.</p></div>`;
        } catch (e) { if (my === seq) res.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p></div>`; }
      }, 300);
    });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") { const first = res.querySelector("a.row"); if (first) first.click(); } });
    showRecent();
    setTimeout(() => q.focus(), 50);
  }

  // ---------- Aktiesida ----------
  const RANGES = [["1M", 21], ["3M", 63], ["6M", 126], ["1Å", 252], ["5Å", 1260], ["10Å", 99999]];
  const MON = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const MONL = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
  const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const pctAbs = (x, d = 0) => pct(Math.abs(x), d, false);
  const signed = (v, d) => { const r = Math.round(v * 100 * 10 ** d) / 10 ** d; return r === 0 ? nf(d).format(0) : (r > 0 ? "+" : "−") + nf(d).format(Math.abs(r)); };

  // Tooltip för diagram: element med data-tip="rubrik\nrad\nrad". Text sätts med textContent.
  (function setupTip() {
    const tip = $("#tip"); let hideT;
    const show = (el, x, y) => {
      const lines = String(el.dataset.tip || "").split("\n");
      tip.replaceChildren(...lines.map((l, i) => { const e = document.createElement(i ? "div" : "b"); e.textContent = l; return e; }));
      tip.classList.add("show");
      const r = tip.getBoundingClientRect();
      tip.style.left = clip(x - r.width / 2, 8, innerWidth - r.width - 8) + "px";
      tip.style.top = (y - r.height - 14 < 8 ? y + 18 : y - r.height - 14) + "px";
    };
    const hide = () => tip.classList.remove("show");
    document.addEventListener("pointermove", (e) => {
      const el = e.target.closest && e.target.closest("[data-tip]");
      if (el) { clearTimeout(hideT); show(el, e.clientX, e.clientY); } else if (e.pointerType === "mouse") hide();
    });
    document.addEventListener("pointerdown", (e) => {
      const el = e.target.closest && e.target.closest("[data-tip]");
      if (el) { show(el, e.clientX, e.clientY); clearTimeout(hideT); hideT = setTimeout(hide, 2600); } else hide();
    });
    document.addEventListener("focusin", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el) { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); } });
    document.addEventListener("focusout", hide);
    addEventListener("scroll", hide, { passive: true });
  })();

  function quarterBars(kv) {
    if (!kv || !kv.length) return "";
    const W = 340, H = 150, pad = 22, n = kv.length, bw = (W - 10) / n;
    const vals = kv.flatMap((k) => [k.oms || 0, k.res || 0]);
    const hi = Math.max(...vals, 0), lo = Math.min(...vals, 0), span = hi - lo || 1;
    const y = (v) => pad / 2 + ((hi - v) / span) * (H - pad - pad / 2);
    const zero = y(0);
    const bars = kv.map((k, i) => {
      const x = 5 + i * bw, w = bw * 0.36;
      const d = new Date(k.d), lab = `K${Math.floor(d.getMonth() / 3) + 1} ${String(d.getFullYear()).slice(2)}`;
      const rect = (v, dx, color) => v == null ? "" : `<rect x="${x + dx}" y="${Math.min(y(v), zero)}" width="${w}" height="${Math.max(1, Math.abs(y(v) - zero))}" rx="2" fill="${color}"/>`;
      return `<g data-tip="${esc(`${lab}\nOmsättning ${big(k.oms)}\nResultat ${big(k.res)}`)}" tabindex="0"><rect x="${x}" y="0" width="${bw}" height="${H}" fill="transparent"/>`
        + rect(k.oms, bw * 0.1, "var(--accent)") + rect(k.res, bw * 0.5, k.res >= 0 ? "var(--up)" : "var(--down)")
        + `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${lab}</text></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Omsättning och resultat per kvartal"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--line)"/>${bars}</svg>`;
  }

  // ----- Förväntad avkastning 1, 3, 5, 10 år -----
  // Kursmålen ligger fast (de bygger på bolagets vinst). Avkastningen räknas om från dagens kurs.
  function hzVals(h, p) {
    return h.rader.map((r) => {
      const total = (r.kurs * (1 + h.utdelning) ** r.år) / p - 1;
      return { ...r, total, årlig: total <= -1 ? -1 : (1 + total) ** (1 / r.år) - 1 };
    });
  }
  function hzTiles(h, p, cur) {
    return hzVals(h, p).map((r) => `<div><span>Om ${r.år} år</span><b class="${cls(r.total)}">${pct(r.total, 0)}</b>
      <small>${r.år > 1 ? `${pct(r.årlig, 1)} per år` : "på 12 månader"}</small>
      <small>Motsvarar kurs <strong>${num(r.kurs, r.kurs < 10 ? 2 : 0)}</strong></small>
      <small>Spann ${num(r.låg, 0)}–${num(r.hög, 0)}</small></div>`).join("");
  }
  function hzCard(s) {
    const h = s.horisonter, er = s.förväntad;
    if (!h || !h.rader.length) return "";
    const metric = (label, val) => `<div><span>${label}</span><b>${val}</b></div>`;
    return `<div class="card" id="sec-avk"><h2>Förväntad avkastning</h2>
      <p class="small muted" style="margin:-4px 0 10px">Från dagens kurs. Räknas om automatiskt när kursen rör sig.</p>
      <div class="hz" id="hz">${hzTiles(h, s.pris, s.valuta)}</div>
      <div class="readout" id="projro">Tryck eller dra i grafen för att se kursen ett visst år.</div>
      <div class="chart" id="proj" style="height:220px"></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Kurs hittills</span><span><i style="background:var(--warn)"></i>Förväntad kurs</span><span><i style="background:var(--muted)"></i>Typiskt spann</span></div>
      <details><summary>Så räknas det</summary>
        <p class="small"><b>1 år:</b> 50 % analytikernas riktkurs, 35 % vinst och tillväxt, 15 % kurstrend.</p>
        ${er && er.delar ? `<div class="grid" style="margin:6px 0 10px">${metric("Analytiker", pct(er.delar.analytiker, 0))}${metric("Vinst och tillväxt", pct(er.delar.fundamenta, 0))}${metric("Kurstrend", pct(er.delar.trend, 0))}${metric("Antal analytiker", (s.nyckeltal || {}).antal_analytiker ?? "–")}</div>` : ""}
        <p class="small"><b>3–10 år:</b> ${h.förlustbolag ? "Försäljningen" : "Vinsten"} växer med ${pct(h.tillväxt, 0, false)} det första året (${esc(h.tillväxtkälla)}) och tillväxten avtar sedan mot 4 % per år.
          Värderingen (P/E) går gradvis mot en rimlig nivå för bolagets tillväxt och lönsamhet. ${h.utdelning > 0 ? `Utdelningen, ${pct(h.utdelning, 1, false)} per år, ingår.` : ""}</p>
        <p class="small"><b>Spannet</b> visar hur mycket det brukar skilja, givet hur mycket aktien svänger.</p>
      </details>
      <p class="tiny muted">Säkerhet: ${esc(h.säkerhet)}. ${h.förlustbolag ? "Bolaget går med förlust, så siffrorna långt fram är extra osäkra. " : ""}En uppskattning, ingen prognos.</p></div>`;
  }
  function addMonths(iso, m) { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); }
  function projPath(s, key) {
    const h = s.horisonter, start = s.historik.at(-1);
    const anchors = [[0, s.pris], ...h.rader.map((r) => [r.år * 12, r[key]])];
    const out = [];
    for (let m = 1; m <= anchors.at(-1)[0]; m++) {
      const i = anchors.findIndex((a) => a[0] >= m), [m0, v0] = anchors[i - 1], [m1, v1] = anchors[i];
      out.push({ time: addMonths(start.d, m), value: v0 * (v1 / v0) ** ((m - m0) / (m1 - m0)) });
    }
    return [{ time: start.d, value: s.pris }, ...out];
  }

  // ----- Värdering, inprisat och hype -----
  const lägeFor = (gap) => gap <= -0.4 ? "Kraftigt undervärderad" : gap <= -0.15 ? "Undervärderad" : gap < 0.15 ? "Rimligt värderad" : gap < 0.4 ? "Övervärderad" : "Kraftigt övervärderad";
  const lägeCls = (l) => (/under/i.test(l || "") ? "buy" : /över/i.test(l || "") ? "avoid" : "hold");
  function impliedAt(tab, p) {
    if (!tab || tab.length < 2) return null;
    if (p <= tab[0][0]) return tab[0][1];
    if (p >= tab.at(-1)[0]) return tab.at(-1)[1];
    const i = tab.findIndex((x) => x[0] >= p), [p0, g0] = tab[i - 1], [p1, g1] = tab[i];
    return g0 + (g1 - g0) * (Math.log(p / p0) / Math.log(p1 / p0));
  }
  function valBody(s, p) {
    const v = s.värdering, cur = s.valuta ? " " + esc(s.valuta) : "";
    if (!v) return `<p class="small muted">Det finns för lite data om vinst och försäljning för att räkna ut ett rimligt värde.</p>`;
    const gap = p / v.rimligt - 1, l = lägeFor(gap), pos = clip(((gap + 0.6) / 1.2) * 100, 0, 100);
    const ig = impliedAt(v.inprisat.tabell, p), g = v.inprisat.väntad;
    let slutsats = "";
    if (ig != null && g != null) slutsats = ig > g + 0.05 ? "Marknaden räknar med mer än så. Mycket av den goda utvecklingen är redan inprisad."
      : ig < g - 0.05 ? "Marknaden räknar med mindre än så. Förväntningarna i kursen är låga."
      : "Det är ungefär vad som väntas. Kursen speglar förväntningarna.";
    return `<div class="verdict"><span class="pill ${lägeCls(l)}">${esc(l)}</span>
        <span class="small muted">Kursen är ${pctAbs(gap)} ${gap >= 0 ? "över" : "under"} rimligt värde</span></div>
      <div class="scale" role="img" aria-label="Kursen jämfört med rimligt värde: ${pct(gap, 0)}">
        <div class="mark" style="left:${pos}%"><span>${pct(gap, 0)}</span></div>
        <div class="ends"><span>Billig</span><span>Rimlig</span><span>Dyr</span></div></div>
      <div class="kv"><span>Rimligt värde idag</span><b>${num(v.rimligt)}${cur}</b></div>
      ${v.modell != null ? `<div class="kv"><span>Enligt vinstmodellen</span><b>${num(v.modell)}${cur}</b></div>` : ""}
      ${v.analytiker != null ? `<div class="kv"><span>Enligt analytikernas riktkurs</span><b>${num(v.analytiker)}${cur}</b></div>` : ""}
      ${ig != null ? `<div class="callout"><b>Inprisat:</b> Dagens kurs förutsätter att vinsten växer ungefär <b>${pct(ig, 0, false)} per år</b> de närmaste åren.
        Väntad tillväxt är <b>${pct(g, 0, false)}</b> (${esc(v.inprisat.källa)}). ${slutsats}</div>`
        : `<p class="small muted">Bolaget går med förlust, så det går inte att räkna ut vilken vinsttillväxt kursen förutsätter.</p>`}`;
  }
  function valCard(s) {
    const hy = s.hype;
    return `<div class="card" id="sec-varde"><h2>Värdering</h2><div id="valbody">${valBody(s, s.pris)}</div>
      ${hy ? `<h3>Hype-mätare</h3>
        <div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:20px">${hy.poäng} <span class="small muted">/ 100</span></b><span class="small" style="font-weight:650">${esc(hy.nivå)}</span></div>
        <div class="meter" role="img" aria-label="Hype ${hy.poäng} av 100"><i style="width:${hy.poäng}%"></i></div>
        <details><summary>Vad mätaren bygger på</summary>
          ${Object.entries(hy.delar).map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${(v || 0) * 10}%;background:var(--warn)"></div></div><b>${v == null ? "–" : num(v, 1)}</b></div>`).join("")}
          <p class="tiny muted">Hög poäng = kursen har stigit snabbt, köptrycket är starkt och värderingen är hög jämfört med tillväxten. Det betyder inte att aktien måste falla, men risken för besvikelse är större.</p>
        </details>` : ""}
      <p class="tiny muted">Rimligt värde = vad framtida vinster är värda idag med 9 % avkastningskrav (60 %), vägt mot analytikernas riktkurs (40 %). AI-bedömningen ovan väger också in rapporter och nyheter.</p></div>`;
  }

  // ----- Bolaget -----
  function aiBolag(a) {
    if (!a || a.saknas) return `<p class="small muted">AI-analysen fyller i bolagets affärsidé, mål och viktiga kontrakt.</p>`;
    const li = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join("");
    return `${a.idé ? `<h3>Affärsidé</h3><p>${esc(a.idé)}</p>` : ""}
      ${a.mål ? `<h3>Mål och strategi</h3><p>${esc(a.mål)}</p>` : ""}
      ${a.kontrakt && a.kontrakt.length ? `<h3>Viktiga avtal och kontrakt</h3><ul class="pts">${li(a.kontrakt)}</ul>` : a.idé ? `<p class="small muted">AI:n hittade inga större avtal eller kontrakt i nyheterna.</p>` : ""}
      ${a.idé ? `<p class="tiny muted">Enligt AI-analysen ${esc(ago(a.analyserad))}.</p>` : ""}`;
  }
  function bolagCard(s) {
    const f = s.nyckeltal || {};
    const kv = (k, v) => (v == null || v === "" ? "" : `<div class="kv"><span>${k}</span><b>${v}</b></div>`);
    const host = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    return `<div class="card" id="sec-bolag"><h2>Bolaget</h2>
      <div id="framtidbox"></div>
      <div id="aibolag">${aiBolag(null)}</div>
      ${f.beskrivning ? `<details><summary>Bolagets egen beskrivning</summary><p class="desc" lang="en">${esc(f.beskrivning)}</p></details>` : ""}
      <h3>Fakta</h3>
      ${kv("Sektor", esc([f.sektor, f.bransch].filter(Boolean).join(" · ")))}${kv("VD", f.vd && esc(f.vd))}
      ${kv("Anställda", f.anställda != null ? num(f.anställda, 0) : null)}${kv("Säte", esc([f.stad, f.land].filter(Boolean).join(", ")))}
      ${kv("Börsvärde", f.börsvärde != null ? big(f.börsvärde) + " " + esc(s.valuta || "") : null)}
      ${f.webb ? kv("Webbplats", `<a href="${safeUrl(f.webb)}" target="_blank" rel="noopener">${esc(host(f.webb))}</a>`) : ""}
    </div>`;
  }

  // ----- Vem äger aktien? -----
  // Yahoo ger andelen hos institutioner och insiders. Resten ägs av småsparare och övriga.
  function ownerSplit(ä) {
    if (!ä || ä.institutioner == null) return null; // utan institutionernas andel går resten inte att räkna ut
    const instRå = ä.institutioner, inst = clip(instRå, 0, 1), ins = clip(ä.insiders ?? 0, 0, 1 - inst);
    return { inst, ins, små: Math.max(0, 1 - inst - ins), överRapporterat: instRå > 1.0001, antal: ä.antal_institutioner };
  }
  function ownerCard(s) {
    const ä = (s.nyckeltal || {}).ägare, o = ownerSplit(ä);
    if (!o) {
      const top = ä && ä.största && ä.största.length ? ä.största : null;
      return `<div class="card" id="sec-agare"><h2>Vem äger aktien?</h2><p class="small muted">Yahoo Finance har ingen uppgift om hur stor del institutioner och småsparare äger.${ä && ä.insiders != null ? ` Insiders (ledning, grundare) äger ${pct(ä.insiders, 1, false)}.` : ""}</p>
        ${top ? `<h3>Största ägarna</h3>${top.map((x) => `<div class="holder"><span>${esc(x.namn)}</span><span></span><b>${pct(x.andel, 1, false)}</b></div>`).join("")}` : ""}</div>`;
    }
    const seg = [["Institutioner", o.inst, "var(--o1)", "Fonder, pensionsbolag, banker"], ["Insiders", o.ins, "var(--o2)", "Ledning, styrelse, grundare"], ["Småsparare och övriga", o.små, "var(--o3)", "Privatpersoner som du och jag, m.fl."]];
    const tolkning = [];
    if (o.inst >= 0.7) tolkning.push(["Proffsen äger det mesta.", "Många fonder har granskat bolaget och vågar äga det. Aktien brukar vara stabilare och välbevakad – men det är svårare att hitta ett fynd som ingen annan sett."]);
    else if (o.inst >= 0.4) tolkning.push(["Blandat ägande.", "Både proffs och privatpersoner äger en stor del."]);
    else tolkning.push(["Mycket ägs av småsparare.", "Kursen kan svänga mer och drivas av nyheter och hype. Det kan också betyda att proffsen inte har upptäckt bolaget än – eller att de valt bort det."]);
    if (o.ins >= 0.1) tolkning.push(["Ledningen äger mycket själv.", `Insiders äger ${pct(o.ins, 0, false)}. De har egna pengar på spel, vilket brukar ses som ett gott tecken.`]);
    else if (o.ins >= 0.01) tolkning.push(["Ledningen äger en del själv.", `Insiders äger ${pct(o.ins, 0, false)} – de har en del egna pengar i bolaget.`]);
    else tolkning.push(["Ledningen äger nästan inget.", "Det är vanligt i stora bolag, men betyder att ledningen har lite egna pengar på spel."]);
    const maxA = ä.största && ä.största.length ? Math.max(...ä.största.map((x) => x.andel || 0)) : 1;
    return `<div class="card" id="sec-agare"><h2>Vem äger aktien?</h2>
      <div class="stack" role="img" aria-label="Institutioner ${pct(o.inst, 0, false)}, insiders ${pct(o.ins, 0, false)}, småsparare och övriga ${pct(o.små, 0, false)}">
        ${seg.filter(([, v]) => v > 0.002).map(([n, v, c]) => `<i style="flex:${v};background:${c}" data-tip="${esc(`${n}\n${pct(v, 1, false)} av aktierna`)}" tabindex="0"></i>`).join("")}</div>
      <div class="owners">${seg.map(([n, v, c, d]) => `<div><i style="background:${c}"></i><span>${n}<small>${d}</small></span><b>${pct(v, 0, false)}</b></div>`).join("")}</div>
      ${o.överRapporterat ? `<p class="tiny muted">Institutionernas andel rapporteras till över 100 % (samma aktier räknas ibland två gånger, t.ex. vid blankning). Den visas som 100 %.</p>` : ""}
      ${o.antal ? `<p class="small muted" style="margin:8px 0 0">${num(o.antal, 0)} institutioner äger aktien.</p>` : ""}
      <h3>Vad betyder det?</h3>
      ${tolkning.map(([r, t]) => `<p class="small" style="margin:4px 0 8px"><b>${r}</b> ${t}</p>`).join("")}
      ${ä.största && ä.största.length ? `<details><summary>Största ägarna</summary>${ä.största.map((x) => `<div class="holder" data-tip="${esc(`${x.namn}\n${pct(x.andel, 2, false)} av aktierna${x.värde ? "\nVärde " + big(x.värde) : ""}${x.datum ? "\nRapporterat " + x.datum : ""}`)}" tabindex="0">
          <span>${esc(x.namn)}</span><div class="track"><div class="fill" style="width:${((x.andel || 0) / maxA) * 100}%"></div></div><b>${pct(x.andel, 1, false)}</b></div>`).join("")}</details>` : ""}
      <p class="tiny muted">Ägandet är en ledtråd, inte ett betyg. Uppgifterna kommer från bolagens och fondernas rapporter till USA:s finansinspektion och kan vara upp till 3 månader gamla.</p></div>`;
  }

  // ----- Säsongsmönster -----
  function seasonBars(se) {
    const W = 340, H = 170, top = 18, bottom = 22, bw = W / 12;
    const vals = se.månader.map((m) => m.snitt ?? 0), lim = Math.max(0.01, ...vals.map(Math.abs));
    const y0 = top + (H - top - bottom) / 2, sc = (H - top - bottom) / 2 / lim;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Snittavkastning per månad">
      <line x1="0" x2="${W}" y1="${y0}" y2="${y0}" stroke="var(--line)"/>
      ${se.månader.map((m, i) => {
        const v = m.snitt ?? 0, x = i * bw, h = Math.max(1, Math.abs(v) * sc), yy = v >= 0 ? y0 - h : y0;
        const tipTxt = `${MONL[i]}\nSnitt ${pct(v, 1)} · median ${pct(m.median, 1)}\nUpp ${Math.round((m.andel_upp || 0) * m.antal)} av ${m.antal} år`;
        return `<g data-tip="${esc(tipTxt)}" tabindex="0"><rect x="${x}" y="0" width="${bw}" height="${H}" fill="transparent"/>
          <rect x="${x + bw * 0.18}" y="${yy}" width="${bw * 0.64}" height="${h}" rx="3" fill="var(--${v >= 0 ? "up" : "down"})"/>
          <text x="${x + bw / 2}" y="${v >= 0 ? yy - 4 : yy + h + 10}" text-anchor="middle" style="font-size:9px">${signed(v, 1)}</text>
          <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${MON[i]}</text></g>`;
      }).join("")}</svg>`;
  }
  function heat(se) {
    const cell = (v, i, y, row) => {
      if (v == null) return `<td></td>`;
      const a = Math.round(clip(Math.abs(v) / 0.12, 0, 1) * 70);
      const c = row.hela && row.bästa === i + 1 ? "best" : row.hela && row.sämsta === i + 1 ? "worst" : "";
      return `<td class="${c}" style="background:color-mix(in srgb,var(--${v >= 0 ? "up" : "down"}) ${a}%,var(--card))" data-tip="${esc(`${MONL[i]} ${y}\n${pct(v, 1)}`)}" tabindex="0">${signed(v, 0)}</td>`;
    };
    return `<div class="heat"><table><thead><tr><th></th>${MON.map((m) => `<th>${m.slice(0, 1).toUpperCase()}</th>`).join("")}</tr></thead>
      <tbody>${se.år.map((row) => `<tr><td class="y">${row.år}</td>${row.r.map((v, i) => cell(v, i, row.år, row)).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function seasonCard(s) {
    const se = s.säsong;
    if (!se) return `<div class="card" id="sec-sasong"><h2>Säsongsmönster</h2><p class="small muted">Aktien har för kort historik (minst 3 år behövs).</p></div>`;
    const st = se.strategi;
    return `<div class="card" id="sec-sasong"><h2>Säsongsmönster</h2>
      <p class="small muted" style="margin:-4px 0 6px">Snittavkastning per månad de senaste ${se.antal_år} åren.</p>
      <div class="bars">${seasonBars(se)}</div>
      <div class="chips"><span class="small muted" style="align-self:center">Bästa:</span>${se.bästa.map((m) => `<span class="chip up">${MON[m - 1]}</span>`).join("")}
        <span class="small muted" style="align-self:center;margin-left:6px">Sämsta:</span>${se.sämsta.map((m) => `<span class="chip down">${MON[m - 1]}</span>`).join("")}</div>
      ${st ? `<h3>Köp i svagaste perioden, sälj i starkaste</h3>
        <div class="callout">Köp i slutet av <b>${MONL[st.köp_efter - 1]}</b>, sälj i slutet av <b>${MONL[st.sälj_efter - 1]}</b> (${st.månader} mån).
          <div style="margin-top:6px">Snitt <b class="${cls(st.snitt)}">${pct(st.snitt, 1)}</b> per gång · lönsamt <b>${Math.round(st.andel_rätt * st.antal)} av ${st.antal}</b> år · median ${pct(st.median, 1)}</div>
          <div style="margin-top:6px">Gjort varje år: totalt <b class="${cls(st.totalt)}">${pct(st.totalt, 0)}</b>, jämfört med <b class="${cls(st.köp_och_behåll)}">${pct(st.köp_och_behåll, 0)}</b> om du ägt aktien hela tiden.</div>
          ${st.resten_snitt != null ? `<div style="margin-top:6px" class="small muted">Resten av året har aktien i snitt gått ${pct(st.resten_snitt, 1)}.</div>` : ""}
        </div>
        <p class="small">Mönstrets styrka: <span class="pill ${st.styrka === "Starkt" ? "buy" : st.styrka === "Måttligt" ? "hold" : "ghost"}">${esc(st.styrka)}</span></p>` : ""}
      <h3>Varje år, månad för månad</h3>
      ${heat(se)}
      <p class="tiny muted">Ram = årets bästa och sämsta månad. Mönster i historiken upprepas inte alltid, och strategin är vald i efterhand. Courtage och skatt ingår inte.</p></div>`;
  }

  // ----- Makrokänslighet -----
  const MACRO_TXT = {
    marknad: (r) => `börsen stiger ${pctAbs(r)}`, ranta: (r) => `räntan stiger ${num(r, 1)} procentenheter`,
    dollar: (r) => `dollarn stärks ${pctAbs(r)}`, olja: (r) => `oljepriset stiger ${pctAbs(r)}`, inflation: () => "inflationsoron ökar som den brukar under ett år",
  };
  function macroCard(s) {
    const m = s.makro;
    if (!m) return `<div class="card" id="sec-makro"><h2>Makrokänslighet</h2><p class="small muted">För lite gemensam historik för att räkna ut makrokänsligheten.</p></div>`;
    const name = (id) => ({ marknad: "börsen", ranta: "räntan", dollar: "dollarn", olja: "oljepriset", inflation: "inflationsoron" }[id]);
    return `<div class="card" id="sec-makro"><h2>Makrokänslighet</h2>
      <p class="small muted" style="margin:-4px 0 6px">Hur aktien brukar röra sig när omvärlden ändras. Varje faktor räknas med de andra hållna lika.</p>
      ${m.faktorer.map((f) => {
        const w = clip(Math.abs(f.effekt) / 0.3, 0, 1) * 50, clear = f.nivå !== "Ingen tydlig koppling";
        const txt = clear ? `När ${MACRO_TXT[f.id](f.rörelse)} på ett år har aktien i snitt ${f.effekt >= 0 ? "stigit" : "fallit"} ${pctAbs(f.effekt)}${f.id === "marknad" ? "" : ", utöver börsens påverkan"}.`
          : "Ingen tydlig koppling i historiken.";
        return `<div class="mac"><div class="h"><span>${esc(f.namn)}</span><span class="pill ${clear ? (f.nivå === "Hög" ? "hold" : "ghost") : "ghost"}">${esc(f.nivå)}</span></div>
          <div class="div" data-tip="${esc(`${f.namn}\nEffekt ${pct(f.effekt, 1)} vid en typisk årsrörelse\nSäkerhet (t-värde) ${num(Math.abs(f.t), 1)}`)}" tabindex="0">
            <i style="${f.effekt >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`};background:var(--${f.effekt >= 0 ? "up" : "down"});opacity:${clear ? 1 : 0.35}"></i></div>
          <p class="small" style="margin:2px 0 0">${txt}</p></div>`;
      }).join("")}
      <div class="callout">${m.beta != null ? `<b>Beta ${num(m.beta, 2)}:</b> aktien rör sig i snitt ${num(m.beta, 1)} gånger så mycket som börsen. ` : ""}
        ${m.känsligast ? `Mest känslig för <b>${name(m.känsligast)}</b>. ` : ""}Makro förklarar ungefär <b>${pct(m.förklaringsgrad, 0, false)}</b> av aktiens rörelser, resten beror på bolaget självt.</div>
      <p class="tiny muted">Bygger på ${m.veckor} veckor (5 år). Räntan = amerikanska 10-åriga statsräntan. Inflationsoro = inflationsskyddade mot vanliga statsobligationer.</p></div>`;
  }

  // ----- AI -----
  const aiLoading = (msg) => `<div class="card" id="ai"><h2>AI-bedömning</h2>
    <p class="small muted" style="display:flex;gap:10px;align-items:center"><span class="spinner" style="flex-shrink:0"></span>${msg}</p></div>`;

  function aiCard(a, s) {
    if (!a || a.saknas) {
      return `<div class="card" id="ai"><h2>AI-bedömning</h2>
        <p class="small muted">AI:n läser bolagets senaste rapport och nyheter på webben. Den bedömer värdering, hype och vad som är inprisat, och tar fram affärsidé, mål och viktiga kontrakt. Tar 30–90 sekunder och kostar ungefär 1–2 kr.</p>
        <button class="btn" id="runai">Analysera ${esc(s.t)} med AI</button></div>`;
    }
    const li = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join("");
    const moved = a.pris_vid_analys && s.pris ? s.pris / a.pris_vid_analys - 1 : null;
    return `<div class="card" id="ai"><h2>AI-bedömning</h2>
      <div class="verdict"><span class="pill ${pillCls(a.betyg)}">${esc(a.betyg)}</span>
        ${a.värderingsläge ? `<span class="pill ${lägeCls(a.värderingsläge)}">${esc(a.värderingsläge)}</span>` : ""}
        <span class="small muted">Säkerhet: ${esc(a.säkerhet)}</span></div>
      <p class="kort">${esc(a.kort)}</p>
      <p>${esc(a.sammanfattning)}</p>
      <details><summary>Läs hela analysen</summary>
        ${a.senaste_rapport ? `<h3>Senaste rapporten</h3><p>${esc(a.senaste_rapport)}</p>` : ""}
        ${a.värdering ? `<h3>Värdering</h3><p>${esc(a.värdering)}</p>` : ""}
        ${a.inprisat ? `<h3>Vad är inprisat?</h3><p>${esc(a.inprisat)}</p>` : ""}
        ${a.hype ? `<h3>Hype</h3><p>${esc(a.hype)}</p>` : ""}
        <h3>Styrkor</h3><ul class="pts">${li(a.styrkor)}</ul>
        <h3>Risker</h3><ul class="pts">${li(a.risker)}</ul>
        ${a.att_bevaka && a.att_bevaka.length ? `<h3>Att bevaka</h3><ul class="pts">${li(a.att_bevaka)}</ul>` : ""}
        ${a.källor && a.källor.length ? `<h3>Det här läste AI:n</h3><div class="sources">${a.källor.map((k) =>
          `<a href="${safeUrl(k.länk)}" target="_blank" rel="noopener">${esc(k.titel || k.länk)}<span>${esc((k.länk || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}${k.datum ? " · " + esc(k.datum) : ""}</span></a>`).join("")}</div>` : ""}
      </details>
      <p class="tiny muted" style="margin:10px 0">Analyserad ${esc(ago(a.analyserad))}${moved != null && Math.abs(moved) > 0.03 ? ` · kursen har rört sig ${pct(moved)} sedan dess` : ""}</p>
      <button class="btn sec" id="runai">Gör en ny analys</button></div>`;
  }

  function lwOptions(el, col, height) {
    return {
      width: el.clientWidth, height,
      layout: { background: { type: "solid", color: "transparent" }, textColor: col("--muted"), fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: col("--line") } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0 }, handleScroll: false, handleScale: false,
      localization: { locale: "sv-SE", priceFormatter: (v) => num(v) },
    };
  }

  async function viewStock(t) {
    setTop(t, "", true);
    const charts = [], observers = []; let timer = null;
    const me = { destroy: () => { charts.forEach((c) => c.remove()); observers.forEach((o) => o.disconnect()); clearInterval(timer); } };
    current = me;
    const gone = () => current !== me; // användaren har gått till en annan sida
    view.innerHTML = `<div class="hero"><div class="skeleton" style="height:16px;width:50%"></div><div class="skeleton" style="height:38px;width:40%;margin-top:8px"></div></div>
      <div class="card"><div class="skeleton" style="height:240px"></div></div>`;
    let s;
    try { s = await api("/api/stock?t=" + encodeURIComponent(t)); }
    catch (e) { view.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p><a href="#/sok">Tillbaka till sök</a></div>`; return; }
    if (gone()) return;

    const f = s.nyckeltal || {}, te = s.teknik, p = s.poäng;
    const starBtn = () => `<button class="star ${inWatch(t) ? "on" : ""}" id="star">${ICON.star}${inWatch(t) ? "Bevakas" : "Bevaka"}</button>`;
    $("#topaction").innerHTML = starBtn();

    const metric = (label, val) => `<div><span>${label}</span><b>${val}</b></div>`;
    const sections = [["sec-chart", "Graf"], ["sec-ai", "AI"], ["sec-avk", "Avkastning"], ["sec-varde", "Värdering"], ["sec-agare", "Ägare"], ["sec-bolag", "Bolaget"], ["sec-sasong", "Säsong"], ["sec-makro", "Makro"], ["sec-tal", "Nyckeltal"]];
    view.innerHTML = `
      <div class="hero">
        <div class="name">${esc(s.namn)} · ${esc(t)}${s.börs ? " · " + esc(s.börs) : ""}</div>
        <div class="price"><span id="price">${num(s.pris)}</span> <span class="small muted">${esc(s.valuta || "")}</span></div>
        <div class="chg ${cls(s.idag)}" id="chg">${pct(s.idag, 2)} idag</div>
        <div class="tiny muted" id="liveinfo"></div>
        <div class="small" style="margin-top:6px">${(() => { const h = portfolio.find((x) => x.t === t); return h ? `I din portfölj${h.andel ? ` (${num(h.andel, 0)} %)` : h.antal ? ` (${num(h.antal, h.antal % 1 ? 2 : 0)} st)` : ""} · <a href="#/portfolj">Se dagens tips</a>` : `<a href="#/portfolj/ny/${encodeURIComponent(t)}">+ Lägg till i portföljen</a>`; })()}</div>
      </div>
      <nav class="jump" id="jump" aria-label="Hoppa till">${sections.map(([id, l]) => `<button data-sec="${id}">${l}</button>`).join("")}</nav>
      <div class="card" style="padding-top:8px" id="sec-chart">
        <div class="ranges" id="ranges">${RANGES.map(([l], i) => `<button data-i="${i}" class="${i === 3 ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="chart" id="chart"></div>
        <div class="legend"><span><i style="background:var(--warn)"></i>Snitt 50 dagar</span><span><i style="background:var(--muted)"></i>Snitt 200 dagar</span></div>
      </div>
      <div id="sec-ai"><div id="aiwrap">${aiLoading("Hämtar AI-analys…")}</div></div>
      ${hzCard(s)}
      ${valCard(s)}
      ${ownerCard(s)}
      ${bolagCard(s)}
      ${seasonCard(s)}
      ${macroCard(s)}
      <div class="card"><h2>Analysens poäng</h2>
        <div class="big"><b>${p.total}</b><span class="muted">/ 100</span><span class="pill ${pillCls(p.bedömning)}" style="margin-left:auto">${esc(p.bedömning)}</span></div>
        ${Object.entries(p.områden).map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${(v || 0) * 10}%"></div></div><b>${v == null ? "–" : num(v, 1)}</b></div>`).join("")}
        <p class="tiny muted">Regelbaserad poäng från nyckeltal och kurstrend. ${p.datatäckning < 5 ? "Viss data saknas för den här aktien." : ""}</p>
      </div>
      ${s.rapporter && s.rapporter.kvartal && s.rapporter.kvartal.length ? `<div class="card bars"><h2>Omsättning och resultat per kvartal</h2>${quarterBars(s.rapporter.kvartal)}
        <div class="legend"><span><i style="background:var(--accent);height:8px"></i>Omsättning</span><span><i style="background:var(--up);height:8px"></i>Resultat</span>
        <span>Senaste: ${big(s.rapporter.kvartal.at(-1).oms)} / ${big(s.rapporter.kvartal.at(-1).res)}</span></div></div>` : ""}
      <div class="card" id="sec-tal"><h2>Nyckeltal</h2><div class="grid">
        ${metric("Börsvärde", big(f.börsvärde))}${metric("P/E (forward)", `${num(f.pe, 1)} (${num(f.forward_pe, 1)})`)}
        ${metric("PEG", num(f.peg, 2))}${metric("P/S", num(f.ps, 1))}
        ${metric("Omsättningstillväxt", pct(f.omsättningstillväxt, 0))}${metric("Vinsttillväxt nästa år", pct(f.vinsttillväxt_nästa_år, 0))}
        ${metric("Bruttomarginal", pct(f.bruttomarginal, 0, false))}${metric("Rörelsemarginal", pct(f.rörelsemarginal, 0, false))}
        ${metric("ROE", pct(f.roe, 0, false))}${metric("Skuld / eget kapital", num(f.skuld_eget_kapital, 0))}
        ${metric("Fritt kassaflöde", big(f.fritt_kassaflöde))}${metric("Riktkurs", `${num(f.riktkurs)} (${pct(p.uppsida_riktkurs, 0)})`)}
        ${metric("Kurs 1 år", `<span class="${cls(te.förändring_1år)}">${pct(te.förändring_1år, 0)}</span>`)}${metric("Kurs 5 år", `<span class="${cls(te.förändring_5år)}">${pct(te.förändring_5år, 0)}</span>`)}
        ${metric("Volatilitet", pct(te.volatilitet, 0, false))}${metric("Från 52v-högsta", pct(te.från_52v_högsta, 0))}
        ${metric("Utdelning", pct(f.utdelning, 1, false))}${metric("Nästa rapport", esc(f.nästa_rapport || "–"))}
      </div></div>
      ${s.nyheter && s.nyheter.length ? `<div class="card news"><h2>Nyheter</h2>${s.nyheter.slice(0, 6).map((n) =>
        `<a href="${safeUrl(n.länk)}" target="_blank" rel="noopener">${esc(n.titel)}<span>${esc(n.källa || "")}${n.tid ? " · " + esc(ago(n.tid * 1000)) : ""}</span></a>`).join("")}</div>` : ""}
      <p class="disclaimer">Underlag för egen analys – inte finansiell rådgivning. Data: Yahoo Finance.</p>`;

    framtidBox(t);
    $("#jump").onclick = (e) => { const b = e.target.closest("button"); const el = b && document.getElementById(b.dataset.sec); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };

    // Stjärna
    const bindStar = () => {
      const b = $("#star"); if (!b) return;
      b.onclick = async () => {
        b.disabled = true;
        try { await toggleWatch(t, s.namn); $("#topaction").innerHTML = starBtn(); bindStar(); }
        catch (e) { toast(e.message); b.disabled = false; }
      };
    };
    bindStar();

    // Kursgraf
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const hist = s.historik.map((r) => ({ time: r.d, value: r.c }));
    const sma = (k) => { const out = []; let sum = 0; for (let i = 0; i < hist.length; i++) { sum += hist[i].value; if (i >= k) sum -= hist[i - k].value; if (i >= k - 1) out.push({ time: hist[i].time, value: sum / k }); } return out; };
    const s50 = sma(50), s200 = sma(200);
    const watchSize = (chart, el) => { const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })); ro.observe(el); observers.push(ro); };
    if (window.LightweightCharts) {
      const el = $("#chart");
      const chartObj = LightweightCharts.createChart(el, lwOptions(el, col, 240)); charts.push(chartObj);
      const area = chartObj.addAreaSeries({ lineWidth: 2, priceLineVisible: false });
      const l50 = chartObj.addLineSeries({ color: col("--warn"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const l200 = chartObj.addLineSeries({ color: col("--muted"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const setRange = (i) => {
        const n = RANGES[i][1], from = hist[Math.max(0, hist.length - n)].time;
        const data = hist.filter((x) => x.time >= from);
        const chg = data.at(-1).value / data[0].value - 1, c = col(chg >= 0 ? "--up" : "--down");
        area.applyOptions({ lineColor: c, topColor: c + "40", bottomColor: c + "00" });
        area.setData(data);
        l50.setData(s50.filter((x) => x.time >= from));
        l200.setData(s200.filter((x) => x.time >= from));
        chartObj.timeScale().fitContent();
        const lab = RANGES[i][0].replace("Å", " år").replace("M", " mån");
        $("#chg").innerHTML = `${pct(s.idag, 2)} idag · <span class="${cls(chg)}">${pct(chg, 1)} ${n >= 99999 ? `sedan ${data[0].time.slice(0, 4)}` : lab}</span>`;
        $("#chg").className = "chg " + cls(s.idag);
        document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("on", +b.dataset.i === i));
      };
      $("#ranges").onclick = (e) => { const b = e.target.closest("button"); if (b) setRange(+b.dataset.i); };
      setRange(3);
      watchSize(chartObj, el);

      // Graf över förväntad kurs: 5 år bakåt och 10 år framåt
      const pel = $("#proj");
      if (pel && s.horisonter && s.horisonter.rader.length) {
        const pc = LightweightCharts.createChart(pel, lwOptions(pel, col, 220)); charts.push(pc);
        // Månadsvis, så att framtiden får lika mycket plats som historiken
        const byM = new Map(); for (const x of hist.slice(-1270)) byM.set(x.time.slice(0, 7), x);
        const past = [...byM.values()]; past[past.length - 1] = hist.at(-1);
        const ha = pc.addAreaSeries({ lineWidth: 2, lineColor: col("--accent"), topColor: col("--accent") + "30", bottomColor: col("--accent") + "00", priceLineVisible: false, lastValueVisible: false });
        ha.setData(past);
        const band = { color: col("--muted"), lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        const lo = pc.addLineSeries(band), hi = pc.addLineSeries(band);
        const mid = pc.addLineSeries({ color: col("--warn"), lineWidth: 2, lineStyle: 1, priceLineVisible: false, lastValueVisible: false });
        const pm = projPath(s, "kurs"), pl = projPath(s, "låg"), ph = projPath(s, "hög");
        mid.setData(pm); lo.setData(pl); hi.setData(ph);
        mid.setMarkers(s.horisonter.rader.map((r) => ({ time: addMonths(s.historik.at(-1).d, r.år * 12), position: "inBar", color: col("--warn"), shape: "circle", text: `${r.år} år` })));
        pc.applyOptions({ timeScale: { fixRightEdge: false, rightOffset: 8 } });
        pc.timeScale().fitContent();
        const ro = $("#projro"), base = ro.innerHTML;
        pc.subscribeCrosshairMove((param) => {
          if (!param.time || !param.seriesData) { ro.innerHTML = base; return; }
          const d = String(param.time), when = `${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
          const m = param.seriesData.get(mid), h0 = param.seriesData.get(ha);
          if (m) {
            const l = param.seriesData.get(lo), u = param.seriesData.get(hi);
            ro.innerHTML = `<b>${when}:</b> förväntad kurs <b>${num(m.value)}</b> (${pct(m.value / s.pris - 1, 0)})${l && u ? ` · spann ${num(l.value, 0)}–${num(u.value, 0)}` : ""}`;
          } else if (h0) ro.innerHTML = `<b>${when}:</b> kurs <b>${num(h0.value)}</b>`;
        });
        watchSize(pc, pel);
      }
    } else {
      $("#chart").innerHTML = '<p class="muted small">Grafen kunde inte laddas.</p>';
    }

    // Kursen uppdateras varje minut, och med den förväntad avkastning och värdering
    const refresh = async () => {
      if (document.hidden || gone()) return;
      try {
        const q = (await api("/api/quotes?symbols=" + encodeURIComponent(t))).quotes[0];
        if (!q || q.fel || !(q.pris > 0) || gone()) return;
        $("#price").textContent = num(q.pris);
        if (s.horisonter && $("#hz")) $("#hz").innerHTML = hzTiles(s.horisonter, q.pris, s.valuta);
        if ($("#valbody")) $("#valbody").innerHTML = valBody(s, q.pris);
        const tm = new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        $("#liveinfo").innerHTML = `<span class="live"></span>Kursen uppdaterad ${tm}`;
      } catch { /* försök igen nästa minut */ }
    };
    timer = setInterval(refresh, 60000);
    refresh();

    // AI-del
    const showAI = (a) => {
      $("#aiwrap").innerHTML = aiCard(a, s);
      if ($("#aibolag")) $("#aibolag").innerHTML = aiBolag(a);
      const b = $("#runai"); if (b) b.onclick = () => runAI(true);
    };
    const runAI = async (force) => {
      $("#aiwrap").innerHTML = aiLoading("AI:n läser senaste rapporten och nyheter om bolaget. Det tar 30–90 sekunder.");
      try {
        const a = await api(`/api/ai?t=${encodeURIComponent(t)}${force ? "&force=1" : ""}`, { method: "POST" });
        if (!gone()) showAI(a);
      } catch (e) {
        toast(e.message);
        if (!gone()) showAI(null);
      }
    };
    try {
      const a = await api("/api/ai?t=" + encodeURIComponent(t));
      if (gone()) return;
      const stale = !a.saknas && Date.now() - a.analyserad > 7 * 86400e3;
      if ((a.saknas || stale) && LS.get("autoAI", true)) return runAI(false);
      showAI(a);
    } catch (e) { if (!gone()) showAI(null); }
  }

  // ---------- Listor: topplistor per tidshorisont och nya börsnoteringar ----------
  const TABS = [["kort", "1–6 mån"], ["mellan", "1–3 år"], ["lang", "5–10 år"], ["nya", "Nya"]];
  async function viewTop() {
    setTop("Topplista");
    let tab = LS.get("toppTab", "mellan");
    view.innerHTML = `<div class="seg" id="seg">${TABS.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join("")}</div><div id="lst"><div class="card"><div class="skeleton" style="height:200px"></div></div></div>`;
    const lst = $("#lst");
    let ranking = null, ipos = null;
    const load = async (url) => { const r = await fetch(url + "?" + Date.now()); if (!r.ok) throw new Error(); return r.json(); };

    const listRow = (r, side) => `<a class="row" href="#/aktie/${encodeURIComponent(r.ticker)}">
      <div style="width:22px;color:var(--muted);font-variant-numeric:tabular-nums">${r.rank}</div>
      <div class="main"><b>${esc(r.ticker)}</b><span>${esc(r.namn)}</span></div>
      <div class="side">${side}${r.ai ? `<div style="margin-top:3px"><span class="pill ${pillCls(r.ai)}">${esc(r.ai)}</span></div>` : ""}</div></a>`;

    const renderList = (k) => {
      const d = ranking;
      if (!d) { lst.innerHTML = `<div class="card empty"><p><b>Ingen topplista än</b></p><p class="small">Den skapas automatiskt den 1:a varje månad.</p></div>`; return; }
      const L = d.listor && d.listor[k];
      if (!L) { // äldre data utan tidshorisonter
        lst.innerHTML = `<div class="card"><h2>Topp ${d.rader.length} för ${esc(d.period)}</h2>
          <p class="small muted">Listorna per tidshorisont skapas vid nästa körning (den 1:a i månaden). Så länge visas förra listan: högst förväntad avkastning de kommande 12 månaderna.</p>
          ${d.rader.map((r) => listRow(r, `<b class="${cls(r.förväntad)}">${pct(r.förväntad, 0)}</b><span class="small muted">kvalitet ${r.kvalitet}</span>`)).join("")}</div>`;
        return;
      }
      const side = {
        kort: (r) => `<b class="${cls(r.kort_6m)}">${pct(r.kort_6m, 0)}</b><span class="small muted">på 6 mån</span>`,
        mellan: (r) => `<b class="${cls(r.årlig_3år)}">${pct(r.årlig_3år, 0)}</b><span class="small muted">per år · kval. ${r.kvalitet}</span>`,
        lang: (r) => `<b class="${cls(r.årlig_10år)}">${pct(r.årlig_10år, 0)}</b><span class="small muted">per år i 10 år</span>`,
      }[k];
      lst.innerHTML = `<div class="card"><h2>Bäst på ${esc(L.namn)}</h2>
        <p class="small muted" style="margin:-4px 0 6px">${esc(L.metod)}. ${esc(d.universum || "S&P 500")} · ${esc(d.antal)} aktier · skapad ${esc(d.datum)}</p>
        ${L.rader.map((r) => listRow(r, side(r))).join("")}</div>
        ${k === "mellan" && d.rapport ? `<p class="small" style="text-align:center"><a href="${esc(d.rapport)}">Hela listan med AI-motiveringar →</a></p>` : ""}
        <p class="disclaimer">${k === "kort" ? "Kort sikt är mest slump. Säsongsmönster och momentum håller inte alltid." : "Uppskattningar byggda på analytikers prognoser, vinst, tillväxt och kvalitet – inga löften."} Uppdateras den 1:a varje månad. Inte finansiell rådgivning.</p>`;
    };

    const renderIpo = () => {
      if (!ipos) { lst.innerHTML = `<div class="card empty"><p><b>Ingen lista än</b></p><p class="small">Listan över nya börsnoteringar uppdateras varje vardagskväll.</p></div>`; return; }
      const sort = LS.get("ipoSort", "nyast"), hideSpac = LS.get("ipoHideSpac", true);
      let rows = ipos.noteringar.filter((r) => !(hideSpac && r.spac));
      const by = { nyast: (a, b) => b.datum.localeCompare(a.datum), bast: (a, b) => (b.sedan_ipo ?? b.sedan_första_dagen) - (a.sedan_ipo ?? a.sedan_första_dagen), samst: (a, b) => (a.sedan_ipo ?? a.sedan_första_dagen) - (b.sedan_ipo ?? b.sedan_första_dagen), storst: (a, b) => (b.börsvärde || 0) - (a.börsvärde || 0) }[sort];
      rows = rows.slice().sort(by);
      const fmtD = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
      const ret = (r) => r.sedan_ipo ?? r.sedan_första_dagen;
      lst.innerHTML = `<div class="card"><h2>Nya börsnoteringar</h2>
        <p class="small muted" style="margin:-4px 0 6px">Börsnoterade i USA sedan ${esc(fmtD(ipos.från))} · uppdaterad ${esc(ipos.uppdaterad)}</p>
        <div class="toolbar"><select id="ipoSort" aria-label="Sortera">
          ${[["nyast", "Senast noterade"], ["bast", "Bäst sedan noteringen"], ["samst", "Sämst sedan noteringen"], ["storst", "Störst börsvärde"]].map(([k, l]) => `<option value="${k}" ${k === sort ? "selected" : ""}>${l}</option>`).join("")}
        </select><label><input type="checkbox" id="spac" ${hideSpac ? "checked" : ""}> Dölj SPAC-bolag</label></div>
        ${rows.length ? rows.map((r) => `<a class="row" href="#/aktie/${encodeURIComponent(r.t)}">
          <div class="main"><b>${esc(r.t)}</b><span>${esc(r.namn)}</span><span>${esc(fmtD(r.datum))} · ${r.dagar} dagar${r.börsvärde ? " · värde " + big(r.börsvärde) : ""}</span></div>
          <div class="side"><b class="${cls(ret(r))}">${pct(ret(r), 0)}</b><span class="small muted">${r.ipo_pris ? `från ${num(r.ipo_pris)}` : "sedan dag 1"}</span></div></a>`).join("")
          : `<p class="small muted">Inga noteringar att visa.</p>`}
      </div>
      ${ipos.kommande && ipos.kommande.length ? `<div class="card"><h2>Kommande noteringar</h2>${ipos.kommande.map((r) => `<div class="row">
          <div class="main"><b>${esc(r.t || "–")}</b><span>${esc(r.namn)}</span></div>
          <div class="side"><b class="small">${/^\d{4}-\d\d-\d\d$/.test(r.datum || "") ? esc(fmtD(r.datum)) : esc(r.datum || "")}</b><span class="small muted">${r.pris ? esc(r.pris) + " $" : ""}</span></div></div>`).join("")}</div>` : ""}
      <p class="disclaimer">Avkastning räknas från teckningskursen vid noteringen. Nya bolag svänger mycket. Källa: ${esc(ipos.källa)}, Yahoo Finance.</p>`;
      $("#ipoSort").onchange = (e) => { LS.set("ipoSort", e.target.value); renderIpo(); };
      $("#spac").onchange = (e) => { LS.set("ipoHideSpac", e.target.checked); renderIpo(); };
    };

    const show = async (k) => {
      tab = k; LS.set("toppTab", k);
      document.querySelectorAll("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
      if (k === "nya") {
        if (!ipos) { lst.innerHTML = `<div class="card"><div class="skeleton" style="height:200px"></div></div>`; try { ipos = await load("data/ipos.json"); } catch { ipos = null; } }
        if (tab === "nya") renderIpo();
      } else {
        if (!ranking) { try { ranking = await load("data/ranking.json"); } catch { ranking = null; } }
        if (tab === k) renderList(k);
      }
    };
    $("#seg").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.k); };
    show(tab);
  }

  // ---------- Framtidsaktier ----------
  let framtidP = null;
  const loadFramtid = () => (framtidP = framtidP || fetch("data/framtid.json?" + Date.now()).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).catch((e) => { framtidP = null; throw e; }));
  const fmtDay = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const change = (r) => r.förra == null ? `<span class="pill ghost">Ny</span>` : r.förra > r.rank ? `<span class="tiny up">▲ ${r.förra - r.rank}</span>`
    : r.förra < r.rank ? `<span class="tiny down">▼ ${r.rank - r.förra}</span>` : "";
  const delBars = (delar) => Object.entries(delar).map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${(v || 0) * 10}%"></div></div><b>${num(v, k === "Genomförande" ? 1 : 0)}</b></div>`).join("");

  async function viewFuture() {
    setTop("Framtidsaktier");
    view.innerHTML = `<div class="card"><div class="skeleton" style="height:240px"></div></div>`;
    let d;
    try { d = await loadFramtid(); }
    catch { view.innerHTML = `<div class="card empty"><p><b>Ingen lista än</b></p><p class="small">Listan skapas var 3:e månad (2 januari, april, juli och oktober).</p></div>`; return; }
    if (location.hash.replace(/^#\/?/, "") !== "framtid") return;
    const counts = {}; d.rader.forEach((r) => (counts[r.tema] = (counts[r.tema] || 0) + 1));
    const teman = ["Alla", ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])];
    let tema = LS.get("framtidTema", "Alla"); if (!teman.includes(tema)) tema = "Alla";
    const render = () => {
      const rows = d.rader.filter((r) => tema === "Alla" || r.tema === tema);
      view.innerHTML = `
        <div class="card"><h2>Morgondagens idéer</h2>
          <p class="small" style="margin:0 0 6px">Bolag som ännu inte går med vinst, men som har idéer som löser framtidens problem och en tydlig plan för att nå dit.</p>
          <p class="tiny muted" style="margin:0">Uppdaterad ${esc(fmtDay(d.uppdaterad))} · nästa ${esc(fmtDay(d.nästa))} · ${esc(d.olönsamma)} olönsamma bolag gicks igenom</p>
          <details><summary>Så rangordnas listan</summary>
            <p class="small">Poängen 0–100 väger ihop fyra delar:</p>
            <ul class="pts small"><li><b>Idé 35 %:</b> hur bra, unik och svår att kopiera lösningen är.</li>
              <li><b>Framtidsproblem 25 %:</b> hur stort och växande problemet är.</li>
              <li><b>Målmedvetenhet 20 %:</b> tydlig plan, fokus och milstolpar som nåtts.</li>
              <li><b>Genomförande 20 %:</b> räknas ur siffrorna – tillväxt, hur länge kassan räcker, bruttomarginal, hur mycket ledningen äger och analytikernas prognos.</li></ul>
            <p class="small muted">De tre första bedöms av AI utifrån bolagens beskrivning och siffror. Bolag mindre än 300 mn USD, banker, fastighetsbolag och SPAC-bolag är inte med.</p>
          </details></div>
        <nav class="jump" style="position:static" aria-label="Tema">${teman.map((t) => `<button data-t="${esc(t)}" style="${t === tema ? "background:var(--text);color:var(--bg);border-color:var(--text)" : ""}">${esc(t)}${t === "Alla" ? "" : ` · ${counts[t]}`}</button>`).join("")}</nav>
        <div class="card">${rows.map((r) => `<a class="frow" href="#/aktie/${encodeURIComponent(r.ticker)}">
            <div class="rk"><b>${r.rank}</b>${change(r)}</div>
            <div class="main"><div class="t"><b>${esc(r.ticker)}</b><span class="chip">${esc(r.tema)}</span></div>
              <span class="nm">${esc(r.namn)}</span>
              <p><b>Löser:</b> ${esc(r.problem)}</p><p class="muted">${esc(r.idé)}</p></div>
            <div class="sc"><b>${r.poäng}</b><span>/100</span></div></a>`).join("")}</div>
        <p class="disclaimer">Bolag utan vinst är riskabla. De kan behöva ta in nya pengar (nyemission) eller misslyckas helt. Sprid riskerna. Inte finansiell rådgivning.</p>`;
      $(".jump", view).onclick = (e) => { const b = e.target.closest("button"); if (!b) return; tema = b.dataset.t; LS.set("framtidTema", tema); render(); };
    };
    render();
  }

  // På aktiesidan: visa om aktien finns bland framtidsaktierna
  async function framtidBox(t) {
    try {
      const d = await loadFramtid(), r = d.rader.find((x) => x.ticker === t), el = $("#framtidbox");
      if (!r || !el) return;
      el.innerHTML = `<div class="callout"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <b>Framtidsaktie #${r.rank} av ${d.rader.length}</b><span class="pill ghost">${esc(r.tema)} · ${r.poäng}/100</span></div>
        <p style="margin:8px 0 4px"><b>Löser:</b> ${esc(r.problem)}</p><p style="margin:4px 0">${esc(r.idé)}</p>
        ${r.mål ? `<p style="margin:4px 0"><b>Mål:</b> ${esc(r.mål)}</p>` : ""}${r.risk ? `<p style="margin:4px 0"><b>Största risk:</b> ${esc(r.risk)}</p>` : ""}
        <details><summary>Poängen</summary>${delBars(r.delar)}</details></div>`;
    } catch { /* ingen lista än */ }
  }

  // ---------- Portfölj ----------
  const RAD_CLS = { "Köp mer": "buy", "Behåll": "neutral", "Sälj delvis": "hold", "Sälj": "avoid" };
  let portfolio = LS.get("portCache", []);
  async function loadPortfolio() { portfolio = await api("/api/portfolio"); LS.set("portCache", portfolio); return portfolio; }
  const annual = (sig) => { const h = (sig && sig.horisonter) || {}; return h[3] ? h[3].årlig : h[1] ? h[1].årlig : null; };

  // Snabbregel (gratis): bygger på förväntad avkastning per år, värdering, hype, kvalitet och hur stor del av portföljen aktien är
  function ruleTip(sig, weight) {
    const a3 = annual(sig), gap = sig && sig.värdering ? sig.värdering.gap : null, hy = sig && sig.hype ? sig.hype.poäng : null, q = sig ? sig.poäng : null;
    if (a3 == null) return { råd: "Behåll", skäl: ["För lite data för att räkna ut en förväntad avkastning."] };
    const R = {
      låg: `Låg förväntad avkastning: ${pct(a3, 0)} per år de kommande 3 åren.`,
      bra: `Förväntad avkastning ${pct(a3, 0)} per år de kommande 3 åren.`,
      dyr: gap != null ? `${sig.värdering.läge}: kursen är ${pct(gap, 0)} mot rimligt värde.` : null,
      billig: gap != null ? `${sig.värdering.läge} (${pct(gap, 0)} mot rimligt värde).` : null,
      hype: hy != null ? `Hög hype (${hy}/100) – risk för besvikelse om förväntningarna inte nås.` : null,
      svag: q != null ? `Svag analyspoäng (${q}/100).` : null,
      stor: `Aktien är ${pct(weight, 0, false)} av portföljen – mycket på ett kort. Sprid gärna en del till andra aktier.`,
    };
    const tip = (råd, first) => ({ råd, skäl: [...new Set([...first, R.bra, R.billig].filter(Boolean))] });
    // Det som avgör tipset står först
    if (a3 < 0.04) return tip("Sälj", [R.låg]);
    if ((gap ?? 0) > 0.6) return tip("Sälj", [R.dyr]);
    if ((q ?? 100) < 40 && (gap ?? 0) > 0.3) return tip("Sälj", [R.svag, R.dyr]);
    if ((hy ?? 0) >= 80) return tip("Sälj delvis", [R.hype]);
    if ((gap ?? 0) > 0.3) return tip("Sälj delvis", [R.dyr]);
    if (weight > 0.35) return tip("Sälj delvis", [R.stor]);
    if (a3 >= 0.15 && (q ?? 0) >= 55 && (gap ?? 0) <= 0.15 && (hy ?? 0) < 75 && weight < 0.25) return tip("Köp mer", [R.bra, R.billig]);
    return tip("Behåll", [R.bra, weight > 0.3 ? R.stor : null]);
  }

  // Kandidater att byta till: aktierna i topplistorna 1–3 år och 5–10 år (eller förra 12-månaderslistan)
  async function loadCandidates() {
    try {
      const r = await fetch("data/ranking.json?" + Date.now()); if (!r.ok) return [];
      const d = await r.json(), out = new Map();
      const add = (rows, lista) => (rows || []).forEach((x) => out.has(x.ticker) || out.set(x.ticker, {
        t: x.ticker, namn: x.namn, sektor: x.sektor, årlig_3år: x.årlig_3år ?? null, årlig_10år: x.årlig_10år ?? null,
        förväntad: x.förväntad ?? null, kvalitet: x.kvalitet, ai: x.ai || null, lista }));
      if (d.listor && d.listor.mellan) add(d.listor.mellan.rader, "1–3 år");
      if (d.listor && d.listor.lang) add(d.listor.lang.rader, "5–10 år");
      if (!out.size) add(d.rader, "12 månader");
      return [...out.values()];
    } catch { return []; }
  }
  const candAnnual = (c) => c.årlig_3år ?? c.förväntad;
  function betterAlternatives(sig, cands, owned) {
    const mine = annual(sig) ?? 0, sek = sig && sig.sektor;
    return cands.filter((c) => !owned.has(c.t) && candAnnual(c) != null && candAnnual(c) > mine + 0.04)
      .sort((a, b) => (candAnnual(b) + (b.sektor !== sek ? 0.02 : 0)) - (candAnnual(a) + (a.sektor !== sek ? 0.02 : 0))).slice(0, 3);
  }

  // Samma regel som servern (weightsFor i worker/src/index.js): hur stor del av portföljen varje aktie är
  function weightsFor(list, priceOf = () => null) {
    const n = list.length;
    if (!n) return { w: [], sätt: null, summa: 0 };
    const hasA = list.map((x) => x.andel > 0), sumA = list.reduce((s, x) => s + (x.andel > 0 ? x.andel : 0), 0);
    const norm = (raw) => { const s = raw.reduce((a, b) => a + b, 0); return s > 0 ? raw.map((v) => v / s) : raw.map(() => 1 / n); };
    if (hasA.every(Boolean)) return { w: norm(list.map((x) => x.andel)), sätt: "andel", summa: sumA };
    if (!hasA.some(Boolean)) {
      if (list.every((x) => x.antal > 0)) return { w: norm(list.map((x) => x.antal * (priceOf(x.t) || x.gav))), sätt: "värde", summa: 100 };
      return { w: list.map(() => 1 / n), sätt: "lika", summa: 100 };
    }
    const miss = hasA.filter((h) => !h).length, rest = Math.max(0, 100 - sumA);
    return { w: norm(list.map((x) => (x.andel > 0 ? x.andel : rest / miss))), sätt: "blandat", summa: sumA };
  }
  const SÄTT = {
    andel: "efter andelarna du angett", värde: "efter hur mycket varje innehav är värt idag",
    lika: "lika mycket i varje aktie (du har inte angett andelar)", blandat: "efter dina andelar – aktier utan andel delar lika på resten",
  };
  const HZ = [[1, "1 år"], [3, "3 år"], [5, "5 år"], [10, "10 år"]];
  const today = () => new Date().toLocaleDateString("sv-SE");
  const shortDate = (iso) => { const d = new Date(iso + "T12:00:00"); return `${d.getDate()} ${MON[d.getMonth()]}`; };

  async function viewPortfolio(prefill) {
    setTop("Portfölj", `<button class="star" id="addbtn">+ Lägg till</button>`);
    let timer = null;
    const me = { destroy: () => clearInterval(timer) };
    current = me;
    const gone = () => current !== me;
    const sigs = {}, prices = {}, open = new Set();
    let cands = [], advice = null, aiBusy = false, settings = { dagligAI: false }, tipsLog = null, updatedAt = null;
    let hz = LS.get("portHz", 3), belopp = LS.get("portBelopp", "");
    view.innerHTML = `<div id="pform"></div><div id="psum"></div><div id="plist"><div class="card"><div class="skeleton" style="height:120px"></div></div></div><div id="pai"></div>
      <p class="disclaimer">Underlag för egna beslut – inte finansiell rådgivning.</p>`;

    // Allt som räknas fram ur portföljen och de senaste kurserna
    const priceOf = (t) => prices[t] ?? (sigs[t] && sigs[t].pris) ?? null;
    function calc() {
      const { w, sätt, summa } = weightsFor(portfolio, priceOf);
      const list = portfolio.map((x, i) => {
        const sig = sigs[x.t], h = (sig && sig.horisonter) || {}, pris = priceOf(x.t);
        return { ...x, vikt: w[i], sig, pris, r: Object.fromEntries(HZ.map(([y]) => [y, h[y] ? h[y].årlig : null])),
          värde: x.antal > 0 && pris ? x.antal * pris : null, vinst: x.antal > 0 && pris ? (pris - x.gav) * x.antal : null };
      });
      // Viktat snitt per år: Σ andel × förväntad avkastning. Aktier utan prognos räknas bort och resten vägs upp.
      const sum = (y) => { let v = 0, ws = 0; list.forEach((x) => { if (x.r[y] != null) { v += x.vikt * x.r[y]; ws += x.vikt; } }); return ws ? { v: v / ws, täckning: ws } : null; };
      return { list, sätt, summa, total: Object.fromEntries(HZ.map(([y]) => [y, sum(y)])) };
    }
    const tipsFor = (c) => Object.fromEntries(c.list.filter((x) => x.sig).map((x) => [x.t, ruleTip(x.sig, x.vikt).råd]));
    const ref = () => tipsLog && (tipsLog.senast && tipsLog.senast.datum !== today() ? tipsLog.senast : tipsLog.förra);

    // Värdet om N år med portföljens förväntade avkastning per år (som om du behåller samma andelar)
    function growHTML(c) {
      const n = Number(String(belopp).replace(/\s/g, "").replace(",", ".")), tot = c.total[hz];
      if (!(n > 0) || !tot) return "";
      const g = (1 + tot.v) ** hz;
      return `blir det ungefär <b>${num(n * g, 0)} kr</b> om ${hz} år (<span class="${cls(g - 1)}">${g >= 1 ? "+" : "−"}${num(Math.abs(n * (g - 1)), 0)} kr</span>), om prognoserna slår in.`;
    }

    function renderSummary(c) {
      const el = $("#psum");
      if (!portfolio.length) { el.innerHTML = ""; return; }
      const tot = c.total[hz], loading = c.list.some((x) => !x.sig);
      const rows = c.list.slice().sort((a, b) => b.vikt - a.vikt);
      const withValue = c.list.filter((x) => x.värde != null);
      const cost = withValue.reduce((s, x) => s + x.antal * x.gav, 0), val = withValue.reduce((s, x) => s + x.värde, 0);
      el.innerHTML = `<div class="card"><h2>Förväntad avkastning per år</h2>
        <div class="seg" id="hzseg" role="tablist" aria-label="Tidshorisont">${HZ.map(([y, l]) => `<button data-y="${y}" class="${y === hz ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="big" style="margin:6px 0 0"><b class="${cls(tot && tot.v)}" style="white-space:nowrap">${tot ? pct(tot.v, 1) : "–"}</b><span class="muted">per år</span></div>
        <p class="small muted" style="margin:0">${hz === 1 ? "Nästa 12 månader." : `I snitt de kommande ${hz} åren.`}</p>
        <p class="small muted" style="margin:0 0 10px">Hela portföljen tillsammans, viktat ${SÄTT[c.sätt]}.${loading ? " Hämtar data …" : ""}</p>
        ${c.sätt === "blandat" ? `<p class="small" style="color:var(--warn)">${c.summa >= 100 ? `Dina andelar blir redan ${num(c.summa, 0)} %, så aktier utan andel räknas som 0 %. Ange en andel för dem.` : `Aktier utan angiven andel delar lika på resterande ${num(100 - c.summa, 0)} %.`}</p>` : ""}
        ${c.sätt === "andel" && Math.abs(c.summa - 100) > 0.5 ? `<p class="small" style="color:var(--warn)">Dina andelar blir ${num(c.summa, 0)} % tillsammans. Vi räknar som om de är 100 % (varje andel delas med ${num(c.summa, 0)}).</p>` : ""}
        <h3>Så räknas det</h3>
        <div class="calc" role="table" aria-label="Uträkning">
          <div class="calc-h" role="row"><span>Aktie</span><span>Andel</span><span>Förväntat</span><span>Bidrag</span></div>
          ${rows.map((x) => `<div role="row"><span><b>${esc(x.t)}</b></span><span>${pct(x.vikt, x.vikt * 100 % 1 ? 1 : 0, false)}</span>
            <span class="${cls(x.r[hz])}">${x.sig ? pct(x.r[hz], 1) : "…"}</span><span>${x.r[hz] != null ? pct(x.vikt * x.r[hz], 2) : "–"}</span></div>`).join("")}
          <div class="calc-s" role="row"><span>Summa</span><span>${pct(rows.reduce((s, x) => s + x.vikt, 0), 0, false)}</span><span></span><span class="${cls(tot && tot.v)}"><b>${tot ? pct(tot.v, 1) : "–"}</b></span></div>
        </div>
        <p class="tiny muted">Bidrag = andel × aktiens förväntade avkastning per år. Summan av bidragen är portföljens förväntade avkastning per år.
          ${tot && tot.täckning < 0.999 ? `Aktier utan prognos (${pct(1 - tot.täckning, 0, false)} av portföljen) räknas inte med – resten vägs upp.` : ""}</p>
        <div class="field" style="margin-top:12px"><label for="belopp">Om jag investerar (kr)</label><input id="belopp" type="text" inputmode="numeric" placeholder="t.ex. 10 000" value="${esc(belopp)}"></div>
        <p class="small" id="growtxt">${growHTML(c)}</p>
        ${withValue.length ? `<div class="grid" style="margin-top:10px"><div><span>Värde idag${withValue.length < c.list.length ? " (de med antal)" : ""}</span><b>${num(val, 0)} USD</b></div>
          <div><span>Sedan köp</span><b class="${cls(val - cost)}">${pct(cost ? val / cost - 1 : null, 1)}</b></div></div>` : ""}
      </div>`;
      $("#hzseg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; hz = +b.dataset.y; LS.set("portHz", hz); renderSummary(calc()); };
      $("#belopp").oninput = (e) => { belopp = e.target.value; LS.set("portBelopp", belopp); $("#growtxt").innerHTML = growHTML(calc()); };
    }

    function renderList(c) {
      const el = $("#plist");
      if (!portfolio.length) {
        el.innerHTML = `<div class="card empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4"/></svg>
          <p><b>Lägg in aktierna du investerar i</b></p><p class="small">Ange hur stor del av dina pengar som ligger i varje aktie, t.ex. 50 % Nvidia, 25 % Micron. Du får dagliga tips om att köpa mer, behålla eller sälja – och portföljens förväntade avkastning per år.</p>
          <button class="btn" id="addfirst" style="margin-top:8px">Lägg till aktie</button></div>`;
        $("#addfirst").onclick = () => showForm();
        return;
      }
      const owned = new Set(portfolio.map((x) => x.t)), r0 = ref(), fresh = freshAdvice();
      const tips = c.list.map((x) => ({ x, tip: x.sig ? ruleTip(x.sig, x.vikt) : null }));
      const changed = r0 ? tips.filter(({ x, tip }) => tip && r0.tips[x.t] && r0.tips[x.t] !== tip.råd) : [];
      const tm = updatedAt ? updatedAt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : null;
      el.innerHTML = `<div class="card"><h2>Dagens tips</h2>
        <p class="small muted" style="margin:-4px 0 6px">${tm ? `<span class="live"></span>Uppdaterat idag ${tm} med dagens kurser och nyckeltal. ` : ""}Räknas om varje gång du öppnar appen och varje minut.</p>
        ${r0 ? `<p class="small" style="margin:0 0 6px">${changed.length ? `<b>${changed.length} ${changed.length === 1 ? "tips har" : "tips har"} ändrats</b> sedan ${shortDate(r0.datum)}.` : `Inga tips har ändrats sedan ${shortDate(r0.datum)}.`}</p>` : ""}
        ${tips.sort((a, b) => b.x.vikt - a.x.vikt).map(({ x, tip }) => {
          const was = r0 && tip && r0.tips[x.t] && r0.tips[x.t] !== tip.råd ? r0.tips[x.t] : null;
          const ai = fresh ? advice.innehav.find((r) => r.t === x.t) : null;
          const alts = tip && /Sälj/.test(tip.råd) ? betterAlternatives(x.sig, cands, owned) : [];
          const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
          return `<details class="hold" data-t="${esc(x.t)}" ${open.has(x.t) ? "open" : ""}><summary class="row">
              <div class="main"><b>${esc(x.t)}</b><span>${esc(x.namn || "")}</span><span>${pct(x.vikt, 0, false)} av portföljen${x.r[3] != null ? ` · väntas ${pct(x.r[3], 0)}/år` : ""}</span></div>
              <div class="side">${tip ? `<span class="pill ${RAD_CLS[tip.råd]}">${esc(tip.råd)}</span>` : '<span class="spinner" style="width:14px;height:14px"></span>'}
                ${was ? `<span class="tiny" style="display:block;margin-top:4px;color:var(--warn)">Ändrat · var ${esc(was)}</span>` : ""}</div></summary>
            <div class="holdbody">
              ${x.sig ? kv("Kurs nu", `${num(x.pris)} ${esc(x.sig.valuta || "")}`) : ""}
              ${x.antal > 0 ? kv("Antal / köpkurs", `${num(x.antal, x.antal % 1 ? 2 : 0)} st / ${num(x.gav)}`) + kv("Sedan köp", x.pris ? `<span class="${cls(x.vinst)}">${pct(x.pris / x.gav - 1, 1)}</span>` : "–") : ""}
              ${x.sig ? kv("Väntat per år (1 / 3 / 10 år)", `${pct(x.r[1], 0)} / ${pct(x.r[3], 0)} / ${pct(x.r[10], 0)}`) : ""}
              ${x.sig && x.sig.värdering ? kv("Värdering", esc(x.sig.värdering.läge)) : ""}
              ${x.sig && x.sig.hype ? kv("Hype", `${x.sig.hype.poäng}/100 · ${esc(x.sig.hype.nivå)}`) : ""}
              ${tip ? `<p class="small" style="margin:10px 0 4px"><b>Varför ${esc(tip.råd.toLowerCase())}?</b></p><ul class="pts small">${tip.skäl.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
              ${ai ? `<div class="callout"><b>AI-genomgången ${esc(ago(advice.skapad))}: ${esc(ai.råd)}.</b> ${esc(ai.kort)} <span class="small">${esc(ai.motivering)}</span></div>` : ""}
              ${(ai && ai.alternativ.length) || alts.length ? `<h3>Bättre att investera i istället</h3>${(ai && ai.alternativ.length ? ai.alternativ.map((a) => ({ ...(cands.find((k) => k.t === a.t) || { t: a.t }), varför: a.varför })) : alts)
                .map((k) => `<a class="row" href="#/aktie/${encodeURIComponent(k.t)}"><div class="main"><b>${esc(k.t)}</b><span>${esc(k.varför || k.namn || "")}</span></div>
                  <div class="side"><b class="${cls(candAnnual(k))}">${pct(candAnnual(k), 0)}</b><span class="small muted">${k.årlig_3år != null ? "per år" : "12 mån"}</span></div></a>`).join("")}` : ""}
              <div class="btnrow"><a class="btn sec" href="#/aktie/${encodeURIComponent(x.t)}">Öppna</a><button class="btn sec" data-edit="${esc(x.t)}">Ändra</button><button class="btn sec" data-del="${esc(x.t)}">Ta bort</button></div>
            </div></details>`;
        }).join("")}
        <p class="tiny muted" style="margin-top:8px">Tipsen bygger på förväntad avkastning per år, värdering, hype och hur stor del av portföljen aktien är. Tryck på en aktie för att se varför.</p></div>`;
      el.querySelectorAll("details.hold").forEach((d) => d.addEventListener("toggle", () => (d.open ? open.add(d.dataset.t) : open.delete(d.dataset.t))));
      el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => showForm(portfolio.find((x) => x.t === b.dataset.edit))));
      el.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
        if (!confirm(`Ta bort ${b.dataset.del} från portföljen?`)) return;
        try { portfolio = await api("/api/portfolio", { method: "POST", body: { action: "remove", t: b.dataset.del } }); LS.set("portCache", portfolio); toast(`${b.dataset.del} borttagen`); renderAll(); }
        catch (e) { toast(e.message); }
      }));
    }

    const freshAdvice = () => advice && !advice.saknas && advice.portfölj === portfolio.map((x) => `${x.t}:${x.andel ?? ""}:${x.antal ?? ""}`).sort().join(",");
    function renderAI() {
      const el = $("#pai");
      if (!portfolio.length) { el.innerHTML = ""; return; }
      const toggle = `<label class="switch"><span>Daglig AI-genomgång<br><span class="small muted">Varje vardagskväll efter börsens stängning. Ungefär 1 kr per gång (cirka 20 kr i månaden).</span></span>
        <input type="checkbox" id="dagligai" ${settings.dagligAI ? "checked" : ""}></label>`;
      let body;
      if (aiBusy) body = `<p class="small muted" style="display:flex;gap:10px;align-items:center"><span class="spinner" style="flex-shrink:0"></span>AI:n går igenom dina innehav och jämför med topplistorna. Tar 20–60 sekunder.</p>`;
      else if (!advice || advice.saknas) body = `<p class="small muted">AI:n går igenom hela portföljen: vad du bör köpa mer av, behålla eller sälja, och vilka aktier ur topplistorna du kan byta till för högre avkastning per år.</p>
        <button class="btn" id="runadv">Gör en AI-genomgång nu (ca 1 kr)</button>`;
      else {
        const stale = !freshAdvice(), old = Date.now() - advice.skapad > 36 * 3600e3;
        body = `${stale ? `<p class="small" style="color:var(--warn)">Portföljen har ändrats sedan genomgången. Gör en ny för att få med ändringarna.</p>` : old ? `<p class="small" style="color:var(--warn)">Genomgången är ${esc(ago(advice.skapad))} gammal.</p>` : ""}
          <p>${esc(advice.sammanfattning)}</p>
          ${advice.före != null && advice.efter != null ? `<div class="grid" style="margin:8px 0"><div><span>Förväntat per år nu</span><b>${pct(advice.före, 1)}</b></div><div><span>Om du följer råden</span><b class="${cls(advice.efter - advice.före)}">${pct(advice.efter, 1)}</b></div></div>` : ""}
          ${advice.innehav.map((r) => `<div class="row" style="align-items:flex-start"><div class="main"><b>${esc(r.t)}</b><span style="white-space:normal">${esc(r.kort)}</span>
            ${r.alternativ.length ? `<span style="white-space:normal">Byt till: ${r.alternativ.map((a) => `<a href="#/aktie/${encodeURIComponent(a.t)}">${esc(a.t)}</a>`).join(", ")}</span>` : ""}</div>
            <div class="side"><span class="pill ${RAD_CLS[r.råd]}">${esc(r.råd)}</span></div></div>`).join("")}
          ${advice.att_tänka_på && advice.att_tänka_på.length ? `<h3>Att tänka på</h3><ul class="pts small">${advice.att_tänka_på.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
          <p class="tiny muted" style="margin:10px 0">${advice.automatisk ? "Automatisk genomgång" : "Gjord"} ${esc(ago(advice.skapad))}.</p>
          <button class="btn sec" id="runadv">Gör en ny genomgång (ca 1 kr)</button>`;
      }
      el.innerHTML = `<div class="card"><h2>AI-genomgång av portföljen</h2>${body}<div style="margin-top:12px;border-top:1px solid var(--line)">${toggle}</div></div>`;
      $("#dagligai").onchange = async (e) => {
        try { settings = await api("/api/portfolio/settings", { method: "POST", body: { dagligAI: e.target.checked } }); toast(settings.dagligAI ? "Daglig AI-genomgång på" : "Daglig AI-genomgång av"); }
        catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
      };
      const b = $("#runadv");
      if (b) b.onclick = async () => {
        aiBusy = true; renderAI();
        try { advice = await api("/api/portfolio/advice", { method: "POST", body: { signaler: Object.values(sigs), kandidater: cands } }); }
        catch (e) { toast(e.message); }
        aiBusy = false;
        if (!gone()) renderAll();
      };
    }

    function renderAll() { const c = calc(); renderSummary(c); renderList(c); renderAI(); }

    // Formulär: andel i procent (huvudsaken), antal och köpkurs om man vill följa vinsten
    function showForm(edit, t0) {
      const f = $("#pform");
      let pick = edit ? { t: edit.t, namn: edit.namn } : t0 ? { t: t0, namn: t0 } : null;
      const used = portfolio.filter((x) => !edit || x.t !== edit.t).reduce((s, x) => s + (x.andel || 0), 0);
      f.innerHTML = `<div class="card"><h2>${edit ? `Ändra ${esc(edit.t)}` : "Lägg till aktie"}</h2>
        ${edit ? "" : `<div class="field"><label for="pq">Aktie</label><input id="pq" type="search" placeholder="Sök bolag eller ticker" autocomplete="off" autocapitalize="characters" value="${esc(t0 || "")}"></div><div id="psug"></div>`}
        <div class="field"><label for="pandel">Andel av portföljen (%)</label><input id="pandel" type="number" inputmode="decimal" min="0" max="100" step="any" value="${edit && edit.andel != null ? esc(edit.andel) : ""}" placeholder="${used > 0 && used < 100 ? `t.ex. ${num(100 - used, 0)} (${num(100 - used, 0)} % kvar)` : "t.ex. 25"}">
          <p class="tiny muted" style="margin:4px 0 0">Hur stor del av pengarna du har (eller vill ha) i aktien. ${used > 0 ? `Dina andra aktier har ${num(used, 0)} %.` : ""}</p></div>
        <details ${edit && edit.antal ? "open" : ""}><summary>Antal aktier och köpkurs (valfritt)</summary>
          <p class="tiny muted">Fyll i om du vill följa din vinst eller förlust.</p>
          <div class="field"><label for="pantal">Antal aktier</label><input id="pantal" type="number" inputmode="decimal" min="0" step="any" value="${edit && edit.antal != null ? esc(edit.antal) : ""}"></div>
          <div class="field"><label for="pgav">Köpkurs per aktie (USD)</label><input id="pgav" type="number" inputmode="decimal" min="0" step="any" value="${edit && edit.gav != null ? esc(edit.gav) : ""}" placeholder="Snittpriset du betalade"></div>
        </details>
        <div class="btnrow"><button class="btn" id="psave">Spara</button><button class="btn sec" id="pcancel">Avbryt</button></div></div>`;
      f.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#pcancel").onclick = () => { f.innerHTML = ""; };
      const showPrice = (s) => { sigs[s.t] = s; $("#pgav").placeholder = `Kurs nu: ${num(s.pris)}`; };
      if (!edit) {
        const q = $("#pq"), sug = $("#psug"); let tm, seq = 0;
        q.addEventListener("input", () => {
          clearTimeout(tm); pick = null;
          const v = q.value.trim(); if (!v) { sug.innerHTML = ""; return; }
          tm = setTimeout(async () => {
            const my = ++seq;
            try {
              const d = await api("/api/search?q=" + encodeURIComponent(v)); if (my !== seq) return;
              sug.innerHTML = d.results.slice(0, 5).map((x) => `<button class="row sugg" data-t="${esc(x.t)}" data-n="${esc(x.namn)}"><div class="main"><b>${esc(x.t)}</b><span>${esc(x.namn)}${x.börs ? " · " + esc(x.börs) : ""}</span></div></button>`).join("");
            } catch (e) { sug.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; }
          }, 300);
        });
        sug.onclick = (e) => {
          const b = e.target.closest("button[data-t]"); if (!b) return;
          pick = { t: b.dataset.t, namn: b.dataset.n }; q.value = `${pick.t} – ${pick.namn}`; sug.innerHTML = "";
          api("/api/signal?t=" + encodeURIComponent(pick.t)).then(showPrice).catch(() => {});
          $("#pandel").focus();
        };
        if (t0) api("/api/signal?t=" + encodeURIComponent(t0)).then((s) => { if (pick) pick.namn = s.namn; q.value = `${s.t} – ${s.namn}`; showPrice(s); }).catch(() => {});
        else setTimeout(() => q.focus(), 300);
      }
      $("#psave").onclick = async () => {
        if (!pick) { toast("Välj en aktie i listan."); return; }
        const val = (id) => { const v = String($(id).value).trim().replace(",", "."); return v === "" ? null : parseFloat(v); };
        const andel = val("#pandel"), antal = val("#pantal"), gav = val("#pgav");
        if (andel == null && antal == null) { toast("Ange andelen i procent (eller antal och köpkurs)."); return; }
        if (andel != null && !(andel > 0 && andel <= 100)) { toast("Andelen ska vara mellan 0 och 100 %."); return; }
        if ((antal == null) !== (gav == null)) { toast("Fyll i både antal och köpkurs, eller inget av dem."); return; }
        const b = $("#psave"); b.disabled = true;
        try {
          portfolio = await api("/api/portfolio", { method: "POST", body: { action: "set", t: pick.t, namn: pick.namn, andel, antal, gav } });
          LS.set("portCache", portfolio);
          f.innerHTML = ""; toast(`${pick.t} sparad`);
          await loadSignals([pick.t]);
          if (gone()) return;
          renderAll(); saveTips();
        } catch (e) { toast(e.message); b.disabled = false; }
      };
    }
    $("#addbtn").onclick = () => showForm();

    // Signal för varje innehav, fyra åt gången
    async function loadSignals(ts) {
      const queue = ts.filter((t) => !sigs[t]);
      const work = async () => { while (queue.length) { const t = queue.shift(); try { sigs[t] = await api("/api/signal?t=" + encodeURIComponent(t)); } catch {} if (!gone()) renderAll(); } };
      await Promise.all([work(), work(), work(), work()]);
      updatedAt = new Date();
    }
    // Spara dagens tips en gång per dag, så att appen i morgon kan visa vad som ändrats
    async function saveTips() {
      const c = calc(), tips = tipsFor(c);
      if (!Object.keys(tips).length) return; // sparar de aktier som gick att hämta
      // Servern flyttar gårdagens tips till "förra" när ett nytt datum sparas
      try { tipsLog = await api("/api/portfolio/tips", { method: "POST", body: { datum: today(), tips } }); } catch {}
    }
    const refresh = async () => {
      if (document.hidden || gone() || !portfolio.length) return;
      try {
        const q = await api("/api/quotes?symbols=" + portfolio.map((x) => encodeURIComponent(x.t)).join(","));
        q.quotes.forEach((x) => { if (x.pris > 0) prices[x.t] = x.pris; });
        updatedAt = new Date();
        if (!gone()) { const c = calc(); renderSummary(c); renderList(c); }
      } catch {}
    };

    renderAll();
    try {
      const [, c, a, st, tl] = await Promise.all([loadPortfolio(), loadCandidates(), api("/api/portfolio/advice").catch(() => null),
        api("/api/portfolio/settings").catch(() => settings), api("/api/portfolio/tips").catch(() => null)]);
      if (gone()) return;
      cands = c; advice = a; settings = st; tipsLog = tl && tl.senast ? tl : null;
      renderAll();
      if (prefill) showForm(portfolio.find((x) => x.t === prefill), portfolio.some((x) => x.t === prefill) ? null : prefill);
      await loadSignals(portfolio.map((x) => x.t));
      if (gone()) return;
      renderAll();
      saveTips();
      timer = setInterval(refresh, 60000);
    } catch (e) { toast(e.message); }
  }

  // ---------- Inställningar ----------
  function viewSettings() {
    setTop("Inställningar", "", true);
    view.innerHTML = `
      <div class="card"><h2>AI</h2>
        <label class="switch"><span>Analysera automatiskt när jag öppnar en aktie<br><span class="small muted">Varje ny analys kostar ungefär 1–2 kr. En analys sparas i 7 dagar.</span></span>
          <input type="checkbox" id="auto" ${LS.get("autoAI", true) ? "checked" : ""}></label>
      </div>
      <div class="card"><h2>Konto</h2>
        <p class="small muted">Servern: ${esc(serverUrl() || "ej kopplad")}</p>
        <button class="btn sec" id="logout">Logga ut</button>
      </div>
      <div class="card"><h2>Om appen</h2>
        <p class="small">Kurser och nyckeltal kommer från Yahoo Finance. AI-bedömningen görs av Claude, som läser bolagets senaste rapport och nyheter. Poäng och förväntad avkastning räknas fram med fasta regler.</p>
        <p class="small muted">Underlag för egen analys – inte finansiell rådgivning.</p>
      </div>`;
    $("#auto").onchange = (e) => { LS.set("autoAI", e.target.checked); toast(e.target.checked ? "Automatisk AI-analys på" : "Automatisk AI-analys av"); };
    $("#logout").onclick = () => { LS.del("key"); route(); };
  }

  route();
})();
