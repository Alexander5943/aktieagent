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
  function setTop(title, action = "", back = false) {
    $("#title").innerHTML = back ? `<button class="back" onclick="history.length>1?history.back():location.hash='#/bevakning'">‹ Tillbaka</button>` : esc(title);
    $("#topaction").innerHTML = action;
  }
  function route() {
    const h = location.hash.replace(/^#\/?/, "") || "bevakning";
    const [page, arg] = h.split("/");
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === page || (page === "aktie" && a.dataset.tab === LS.get("lastTab", "bevakning"))));
    if (current && current.destroy) current.destroy();
    current = null;
    window.scrollTo(0, 0);
    if (!serverUrl() || !LS.get("key", "")) return viewLogin();
    if (page !== "aktie") LS.set("lastTab", page);
    if (page === "sok") return viewSearch();
    if (page === "topp") return viewTop();
    if (page === "installningar") return viewSettings();
    if (page === "aktie" && arg) return viewStock(decodeURIComponent(arg).toUpperCase());
    return viewWatch();
  }
  window.addEventListener("hashchange", route);

  // ---------- Inloggning ----------
  function viewLogin() {
    setTop("Aktier");
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
      <p class="disclaimer">Kurser uppdateras var 5:e minut. AI-analysen uppdateras automatiskt varje måndag.</p>`;
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
  const RANGES = [["1M", 21], ["3M", 63], ["6M", 126], ["1Å", 252], ["5Å", 99999]];

  function quarterBars(kv) {
    if (!kv || !kv.length) return "";
    const W = 340, H = 150, pad = 22, n = kv.length, bw = (W - 10) / n;
    const vals = kv.flatMap((k) => [k.oms || 0, k.res || 0]);
    const hi = Math.max(...vals, 0), lo = Math.min(...vals, 0), span = hi - lo || 1;
    const y = (v) => pad / 2 + ((hi - v) / span) * (H - pad - pad / 2);
    const zero = y(0);
    const bars = kv.map((k, i) => {
      const x = 5 + i * bw, w = bw * 0.36;
      const rect = (v, dx, color) => v == null ? "" : `<rect x="${x + dx}" y="${Math.min(y(v), zero)}" width="${w}" height="${Math.max(1, Math.abs(y(v) - zero))}" rx="2" fill="${color}"/>`;
      const d = new Date(k.d), lab = `K${Math.floor(d.getMonth() / 3) + 1} ${String(d.getFullYear()).slice(2)}`;
      return rect(k.oms, bw * 0.1, "var(--accent)") + rect(k.res, bw * 0.5, k.res >= 0 ? "var(--up)" : "var(--down)")
        + `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${lab}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Omsättning och resultat per kvartal"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--line)"/>${bars}</svg>`;
  }

  const aiLoading = (msg) => `<div class="card" id="ai"><h2>AI-bedömning</h2>
    <p class="small muted" style="display:flex;gap:10px;align-items:center"><span class="spinner" style="flex-shrink:0"></span>${msg}</p></div>`;

  function aiCard(a, s) {
    if (!a || a.saknas) {
      return `<div class="card" id="ai"><h2>AI-bedömning</h2>
        <p class="small muted">AI:n läser bolagets senaste rapport och nyheter på webben och ger en bedömning. Tar 30–90 sekunder och kostar ungefär 1–2 kr.</p>
        <button class="btn" id="runai">Analysera ${esc(s.t)} med AI</button></div>`;
    }
    const li = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join("");
    const moved = a.pris_vid_analys && s.pris ? s.pris / a.pris_vid_analys - 1 : null;
    return `<div class="card" id="ai"><h2>AI-bedömning</h2>
      <div class="verdict"><span class="pill ${pillCls(a.betyg)}">${esc(a.betyg)}</span><span class="small muted">Säkerhet: ${esc(a.säkerhet)}</span></div>
      <p class="kort">${esc(a.kort)}</p>
      <p>${esc(a.sammanfattning)}</p>
      <details><summary>Läs hela analysen</summary>
        ${a.senaste_rapport ? `<h3>Senaste rapporten</h3><p>${esc(a.senaste_rapport)}</p>` : ""}
        ${a.värdering ? `<h3>Värdering</h3><p>${esc(a.värdering)}</p>` : ""}
        <h3>Styrkor</h3><ul class="pts">${li(a.styrkor)}</ul>
        <h3>Risker</h3><ul class="pts">${li(a.risker)}</ul>
        ${a.att_bevaka && a.att_bevaka.length ? `<h3>Att bevaka</h3><ul class="pts">${li(a.att_bevaka)}</ul>` : ""}
        ${a.källor && a.källor.length ? `<h3>Det här läste AI:n</h3><div class="sources">${a.källor.map((k) =>
          `<a href="${safeUrl(k.länk)}" target="_blank" rel="noopener">${esc(k.titel || k.länk)}<span>${esc((k.länk || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}${k.datum ? " · " + esc(k.datum) : ""}</span></a>`).join("")}</div>` : ""}
      </details>
      <p class="tiny muted" style="margin:10px 0">Analyserad ${esc(ago(a.analyserad))}${moved != null && Math.abs(moved) > 0.03 ? ` · kursen har rört sig ${pct(moved)} sedan dess` : ""}</p>
      <button class="btn sec" id="runai">Gör en ny analys</button></div>`;
  }

  async function viewStock(t) {
    setTop(t, "", true);
    let chartObj = null, ro = null;
    const me = { destroy: () => { if (chartObj) chartObj.remove(); if (ro) ro.disconnect(); } };
    current = me;
    const gone = () => current !== me; // användaren har gått till en annan sida
    view.innerHTML = `<div class="hero"><div class="skeleton" style="height:16px;width:50%"></div><div class="skeleton" style="height:38px;width:40%;margin-top:8px"></div></div>
      <div class="card"><div class="skeleton" style="height:240px"></div></div>`;
    let s;
    try { s = await api("/api/stock?t=" + encodeURIComponent(t)); }
    catch (e) { view.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p><a href="#/sok">Tillbaka till sök</a></div>`; return; }
    if (gone()) return;

    const f = s.nyckeltal || {}, te = s.teknik, p = s.poäng, er = s.förväntad;
    const starBtn = () => `<button class="star ${inWatch(t) ? "on" : ""}" id="star">${ICON.star}${inWatch(t) ? "Bevakas" : "Bevaka"}</button>`;
    $("#topaction").innerHTML = starBtn();

    const metric = (label, val) => `<div><span>${label}</span><b>${val}</b></div>`;
    view.innerHTML = `
      <div class="hero">
        <div class="name">${esc(s.namn)} · ${esc(t)}${s.börs ? " · " + esc(s.börs) : ""}</div>
        <div class="price">${num(s.pris)} <span class="small muted">${esc(s.valuta || "")}</span></div>
        <div class="chg ${cls(s.idag)}" id="chg">${pct(s.idag, 2)} idag</div>
      </div>
      <div class="card" style="padding-top:8px">
        <div class="ranges" id="ranges">${RANGES.map(([l], i) => `<button data-i="${i}" class="${i === 3 ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="chart" id="chart"></div>
        <div class="legend"><span><i style="background:var(--warn)"></i>Snitt 50 dagar</span><span><i style="background:var(--muted)"></i>Snitt 200 dagar</span></div>
      </div>
      <div id="aiwrap">${aiLoading("Hämtar AI-analys…")}</div>
      <div class="card"><h2>Analysens poäng</h2>
        <div class="big"><b>${p.total}</b><span class="muted">/ 100</span><span class="pill ${pillCls(p.bedömning)}" style="margin-left:auto">${esc(p.bedömning)}</span></div>
        ${Object.entries(p.områden).map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${(v || 0) * 10}%"></div></div><b>${v == null ? "–" : num(v, 1)}</b></div>`).join("")}
        <p class="tiny muted">Regelbaserad poäng från nyckeltal och kurstrend. ${p.datatäckning < 5 ? "Viss data saknas för den här aktien." : ""}</p>
      </div>
      ${er && er.förväntad != null ? `<div class="card"><h2>Förväntad avkastning 12 månader</h2>
        <div class="big"><b class="${cls(er.förväntad)}">${pct(er.förväntad, 0)}</b></div>
        <div class="grid" style="margin-top:10px">
          ${metric("Från analytikers riktkurs", pct(er.delar.analytiker, 0))}${metric("Från vinst och tillväxt", pct(er.delar.fundamenta, 0))}
          ${metric("Från kurstrend", pct(er.delar.trend, 0))}${metric("Analytiker", f.antal_analytiker ?? "–")}</div>
        <p class="tiny muted">En uppskattning, ingen prognos. Analytikers riktkurser är ofta för optimistiska.</p></div>` : ""}
      ${s.rapporter && s.rapporter.kvartal && s.rapporter.kvartal.length ? `<div class="card bars"><h2>Omsättning och resultat per kvartal</h2>${quarterBars(s.rapporter.kvartal)}
        <div class="legend"><span><i style="background:var(--accent);height:8px"></i>Omsättning</span><span><i style="background:var(--up);height:8px"></i>Resultat</span>
        <span>Senaste: ${big(s.rapporter.kvartal.at(-1).oms)} / ${big(s.rapporter.kvartal.at(-1).res)}</span></div></div>` : ""}
      <div class="card"><h2>Nyckeltal</h2><div class="grid">
        ${metric("Börsvärde", big(f.börsvärde))}${metric("P/E (forward)", `${num(f.pe, 1)} (${num(f.forward_pe, 1)})`)}
        ${metric("PEG", num(f.peg, 2))}${metric("P/S", num(f.ps, 1))}
        ${metric("Omsättningstillväxt", pct(f.omsättningstillväxt, 0))}${metric("Vinsttillväxt nästa år", pct(f.vinsttillväxt_nästa_år, 0))}
        ${metric("Bruttomarginal", pct(f.bruttomarginal, 0, false))}${metric("Rörelsemarginal", pct(f.rörelsemarginal, 0, false))}
        ${metric("ROE", pct(f.roe, 0, false))}${metric("Skuld / eget kapital", num(f.skuld_eget_kapital, 0))}
        ${metric("Fritt kassaflöde", big(f.fritt_kassaflöde))}${metric("Riktkurs", `${num(f.riktkurs)} (${pct(p.uppsida_riktkurs, 0)})`)}
        ${metric("Kurs 1 år", `<span class="${cls(te.förändring_1år)}">${pct(te.förändring_1år, 0)}</span>`)}${metric("Volatilitet", pct(te.volatilitet, 0, false))}
        ${metric("Från 52v-högsta", pct(te.från_52v_högsta, 0))}${metric("Nästa rapport", esc(f.nästa_rapport || "–"))}
      </div>${f.beskrivning ? `<p class="desc">${esc(f.beskrivning)}${f.beskrivning.length >= 600 ? "…" : ""}</p>` : ""}</div>
      ${s.nyheter && s.nyheter.length ? `<div class="card news"><h2>Nyheter</h2>${s.nyheter.slice(0, 6).map((n) =>
        `<a href="${safeUrl(n.länk)}" target="_blank" rel="noopener">${esc(n.titel)}<span>${esc(n.källa || "")}${n.tid ? " · " + esc(ago(n.tid * 1000)) : ""}</span></a>`).join("")}</div>` : ""}
      <p class="disclaimer">Underlag för egen analys – inte finansiell rådgivning. Data: Yahoo Finance.</p>`;

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

    // Graf
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const hist = s.historik.map((r) => ({ time: r.d, value: r.c }));
    const sma = (k) => { const out = []; let sum = 0; for (let i = 0; i < hist.length; i++) { sum += hist[i].value; if (i >= k) sum -= hist[i - k].value; if (i >= k - 1) out.push({ time: hist[i].time, value: sum / k }); } return out; };
    const s50 = sma(50), s200 = sma(200);
    if (window.LightweightCharts) {
      const el = $("#chart");
      chartObj = LightweightCharts.createChart(el, {
        width: el.clientWidth, height: 240,
        layout: { background: { type: "solid", color: "transparent" }, textColor: col("--muted"), fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: col("--line") } },
        rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
        crosshair: { mode: 0 }, handleScroll: false, handleScale: false,
        localization: { locale: "sv-SE", priceFormatter: (v) => num(v) },
      });
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
        $("#chg").innerHTML = `${pct(s.idag, 2)} idag · <span class="${cls(chg)}">${pct(chg, 1)} ${RANGES[i][0] === "5Å" ? "5 år" : RANGES[i][0]}</span>`;
        $("#chg").className = "chg " + cls(s.idag);
        document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("on", +b.dataset.i === i));
      };
      $("#ranges").onclick = (e) => { const b = e.target.closest("button"); if (b) setRange(+b.dataset.i); };
      setRange(3);
      ro = new ResizeObserver(() => chartObj && chartObj.applyOptions({ width: el.clientWidth }));
      ro.observe(el);
    } else {
      $("#chart").innerHTML = '<p class="muted small">Grafen kunde inte laddas.</p>';
    }

    // AI-del
    const bindAI = (s) => {
      const b = $("#runai"); if (!b) return;
      b.onclick = () => runAI(true);
    };
    const runAI = async (force) => {
      $("#aiwrap").innerHTML = aiLoading("AI:n läser senaste rapporten och nyheter om bolaget. Det tar 30–90 sekunder.");
      try {
        const a = await api(`/api/ai?t=${encodeURIComponent(t)}${force ? "&force=1" : ""}`, { method: "POST" });
        if (gone()) return;
        $("#aiwrap").innerHTML = aiCard(a, s); bindAI(s);
      } catch (e) {
        toast(e.message);
        if (gone()) return;
        $("#aiwrap").innerHTML = aiCard(null, s); bindAI(s);
      }
    };
    try {
      const a = await api("/api/ai?t=" + encodeURIComponent(t));
      if (gone()) return;
      const stale = !a.saknas && Date.now() - a.analyserad > 7 * 86400e3;
      if ((a.saknas || stale) && LS.get("autoAI", true)) return runAI(false);
      $("#aiwrap").innerHTML = aiCard(a, s); bindAI(s);
    } catch (e) { if (!gone()) { $("#aiwrap").innerHTML = aiCard(null, s); bindAI(s); } }
  }

  // ---------- Topplista ----------
  async function viewTop() {
    setTop("Topplista");
    view.innerHTML = `<div class="card"><div class="skeleton" style="height:200px"></div></div>`;
    let d;
    try { const r = await fetch("data/ranking.json?" + Date.now()); if (!r.ok) throw 0; d = await r.json(); }
    catch { view.innerHTML = `<div class="card empty"><p><b>Ingen topplista än</b></p><p class="small">Den skapas automatiskt den 1:a varje månad.</p></div>`; return; }
    view.innerHTML = `
      <div class="card"><h2>Topp ${d.rader.length} för ${esc(d.period)}</h2><p class="small muted" style="margin:-4px 0 6px">Högst förväntad avkastning de kommande 12 månaderna</p>
        <p class="small muted">${esc(d.universum || "S&P 500")} · skapad ${esc(d.datum)} · ${esc(d.antal)} aktier analyserade</p>
        ${d.rader.map((r) => `<a class="row" href="#/aktie/${encodeURIComponent(r.ticker)}">
          <div style="width:22px;color:var(--muted);font-variant-numeric:tabular-nums">${r.rank}</div>
          <div class="main"><b>${esc(r.ticker)}</b><span>${esc(r.namn)}</span></div>
          <div class="side"><b class="${cls(r.förväntad)}">${pct(r.förväntad, 0)}</b>
            <span class="small muted">kvalitet ${r.kvalitet}</span>
            ${r.ai ? `<div style="margin-top:3px"><span class="pill ${pillCls(r.ai)}">${esc(r.ai)}</span></div>` : ""}</div></a>`).join("")}
      </div>
      ${d.rapport ? `<p class="small" style="text-align:center"><a href="${esc(d.rapport)}">Hela listan med AI-motiveringar →</a></p>` : ""}
      <p class="disclaimer">Förväntad avkastning = 50 % analytikers riktkurs, 35 % vinst och tillväxt, 15 % trend. En uppskattning, ingen prognos.</p>`;
  }

  // ---------- Inställningar ----------
  function viewSettings() {
    setTop("Inställningar");
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
