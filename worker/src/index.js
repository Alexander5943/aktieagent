/**
 * Aktieagent – backend (Cloudflare Worker)
 *
 * Appen i telefonen pratar med den här servern. Den:
 *   - söker efter aktier
 *   - hämtar kurser, nyckeltal, rapportsiffror och nyheter från Yahoo Finance
 *   - räknar ut poäng och förväntad avkastning (samma regler som Python-koden)
 *   - låter Claude läsa senaste rapporten och nyheter på webben och ge en bedömning
 *   - sparar din bevakningslista
 *
 * Hemligheter (sätts i GitHub/Cloudflare, aldrig i koden):
 *   ANTHROPIC_API_KEY  din nyckel från console.anthropic.com
 *   APP_KEY            din egen app-kod, så att bara du kan använda servern
 */

import { horizons, valuation, hype, seasonality, macro, FACTORS } from "./analys.js";

const MODEL = "claude-opus-5-5";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const AI_CACHE_DAYS = 7;          // en AI-analys återanvänds i 7 dagar om du inte ber om en ny
const DEFAULT_AI_DAILY_LIMIT = 25; // skydd mot att krediterna tar slut av misstag
const CRON_MAX_STOCKS = 3;         // per körning (måndag kl 05, 06 och 07 UTC = högst 9 i veckan). Gratisplanen tillåter 50 anrop per körning

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    try {
      if (!env.APP_KEY) return json({ error: "APP_KEY saknas på servern." }, 500);
      if (req.headers.get("X-App-Key") !== env.APP_KEY) return json({ error: "Fel app-kod." }, 401);

      const p = url.pathname;
      if (p === "/api/ping") return json({ ok: true, model: MODEL });
      if (p === "/api/search") return json(await search(url.searchParams.get("q") || "", ctx));
      if (p === "/api/quotes") return json(await quotes((url.searchParams.get("symbols") || "").split(","), ctx));
      if (p === "/api/stock") return json(await stock(ticker(url), env, ctx));
      if (p === "/api/ai" && req.method === "GET") return json(await getAI(ticker(url), env));
      if (p === "/api/ai" && req.method === "POST") return json(await runAI(ticker(url), env, ctx, url.searchParams.get("force") === "1"));
      if (p === "/api/watchlist" && req.method === "GET") return json(await getWatchlist(env));
      if (p === "/api/watchlist" && req.method === "POST") return json(await editWatchlist(await req.json(), env));
      if (p === "/api/portfolio" && req.method === "GET") return json(await getPortfolio(env));
      if (p === "/api/portfolio" && req.method === "POST") return json(await editPortfolio(await req.json(), env));
      if (p === "/api/signal") return json(await signal(ticker(url), env, ctx));
      if (p === "/api/portfolio/advice" && req.method === "GET") return json((await env.AKTIE_KV.get("portfolio:advice", "json")) || { saknas: true });
      if (p === "/api/portfolio/advice" && req.method === "POST") return json(await portfolioAdvice(await req.json(), env));
      return json({ error: "Okänd adress." }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },

  // Varje måndag (två körningar): uppdatera AI-analysen för bevakningslistan, äldsta först
  async scheduled(event, env, ctx) {
    const list = await getWatchlist(env);
    const withAge = await Promise.all(list.map(async (w) => {
      const c = await env.AKTIE_KV.get("ai:" + w.t, "json");
      return { t: w.t, at: c ? c.analyserad : 0 };
    }));
    withAge.sort((a, b) => a.at - b.at);
    const due = withAge.filter((w) => Date.now() - w.at > 6 * 86400e3);
    for (const w of due.slice(0, CRON_MAX_STOCKS)) {
      try { await runAI(w.t, env, ctx, true, true); } catch (e) { console.log("cron", w.t, e.message); }
    }
  },
};

function ticker(url) {
  const t = (url.searchParams.get("t") || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(t)) throw httpError("Ogiltig ticker.", 400);
  return t;
}

function httpError(msg, status) { const e = new Error(msg); e.status = status; return e; }

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Headers", "X-App-Key, Content-Type");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  }));
}

// Enkel cache (Cloudflares egen) för Yahoo-svar
async function cached(key, seconds, ctx, fn) {
  const cache = caches.default;
  const req = new Request("https://cache.aktieagent/" + encodeURIComponent(key));
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const data = await fn();
  const res = new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
  });
  ctx.waitUntil(cache.put(req, res));
  return data;
}

// ---------------------------------------------------------------------------
// Yahoo Finance
// ---------------------------------------------------------------------------

async function yget(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
  if (!r.ok) throw httpError(`Yahoo svarade ${r.status}`, r.status === 404 ? 404 : 502);
  return r.json();
}

let CRUMB = null; // { crumb, cookie, at }

async function getCrumb(env, refresh = false) {
  if (!refresh && CRUMB && Date.now() - CRUMB.at < 6 * 3600e3) return CRUMB;
  if (!refresh) {
    const k = await env.AKTIE_KV.get("yahoo:crumb", "json");
    if (k && Date.now() - k.at < 6 * 3600e3) return (CRUMB = k);
  }
  const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
  const cookie = raw.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
  const c = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 40 || crumb.includes("<")) throw new Error("Kunde inte logga in mot Yahoo.");
  CRUMB = { crumb, cookie, at: Date.now() };
  await env.AKTIE_KV.put("yahoo:crumb", JSON.stringify(CRUMB), { expirationTtl: 6 * 3600 });
  return CRUMB;
}

async function quoteSummary(t, env) {
  const modules = "price,assetProfile,summaryDetail,financialData,defaultKeyStatistics,earningsTrend,calendarEvents,majorHoldersBreakdown,institutionOwnership";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = await getCrumb(env, attempt > 0);
      const d = await yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=${modules}&crumb=${encodeURIComponent(c.crumb)}`, { Cookie: c.cookie });
      return d.quoteSummary.result[0];
    } catch (e) {
      if (attempt === 1) return null; // vi klarar oss utan nyckeltal (AI:n söker själv)
    }
  }
}

async function search(q, ctx) {
  q = q.trim();
  if (q.length < 1) return { results: [] };
  return cached("search:" + q.toLowerCase(), 3600, ctx, async () => {
    const d = await yget(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0&lang=en-US`);
    const results = (d.quotes || [])
      .filter((x) => ["EQUITY", "ETF"].includes(x.quoteType) && x.symbol)
      .map((x) => ({ t: x.symbol, namn: x.longname || x.shortname || x.symbol, börs: x.exchDisp || x.exchange || "", typ: x.quoteType }));
    return { results };
  });
}

async function chart(t, range, interval = "1d") {
  const d = await yget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=${range}&interval=${interval}&includePrePost=false`);
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw httpError(`Hittade ingen kursdata för ${t}.`, 404);
  const q = r.indicators.quote[0];
  const adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || q.close;
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (adj[i] == null || q.close[i] == null) continue;
    rows.push({ d: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), c: round(adj[i]), v: q.volume[i] || 0 });
  }
  return { meta: r.meta, rows };
}

async function quotes(symbols, ctx) {
  symbols = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
  const out = await Promise.all(symbols.map((t) => cached("q:" + t, 60, ctx, async () => {
    try {
      const { meta, rows } = await chart(t, "1mo");
      const price = meta.regularMarketPrice;
      const prev = rows.length > 1 ? rows[rows.length - 2].c : meta.chartPreviousClose;
      return { t, pris: price, idag: prev ? price / prev - 1 : null, valuta: meta.currency, spark: rows.map((r) => r.c) };
    } catch { return { t, fel: true }; }
  })));
  return { quotes: out };
}

async function financials(t) {
  // Omsättning och resultat per kvartal och år (fundamentals-timeseries kräver ingen inloggning)
  const now = Math.floor(Date.now() / 1000), from = now - 6 * 365 * 86400;
  const types = "quarterlyTotalRevenue,quarterlyNetIncome,annualTotalRevenue,annualNetIncome";
  try {
    const d = await yget(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(t)}?type=${types}&period1=${from}&period2=${now}`);
    const get = (name) => {
      const r = (d.timeseries.result || []).find((x) => x.meta && x.meta.type && x.meta.type[0] === name);
      return ((r && r[name]) || []).filter(Boolean).map((x) => ({ d: x.asOfDate, v: x.reportedValue ? x.reportedValue.raw : null }));
    };
    const merge = (rev, ni) => rev.map((r) => ({ d: r.d, oms: r.v, res: (ni.find((n) => n.d === r.d) || {}).v ?? null }));
    return {
      kvartal: merge(get("quarterlyTotalRevenue"), get("quarterlyNetIncome")).slice(-8),
      år: merge(get("annualTotalRevenue"), get("annualNetIncome")).slice(-5),
    };
  } catch { return { kvartal: [], år: [] }; }
}

async function news(t) {
  try {
    const d = await yget(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(t)}&quotesCount=0&newsCount=8`);
    return (d.news || []).map((n) => ({ titel: n.title, källa: n.publisher, länk: n.link, tid: n.providerPublishTime }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Analys: nyckeltal, teknik, poäng, förväntad avkastning
// ---------------------------------------------------------------------------

const raw = (o) => (o && typeof o === "object" ? (o.raw ?? null) : (typeof o === "number" ? o : null));
const round = (x, n = 4) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const avg = (xs) => { xs = xs.filter((x) => x != null && isFinite(x)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };

function fundamentals(qs) {
  if (!qs) return null;
  const fd = qs.financialData || {}, sd = qs.summaryDetail || {}, ks = qs.defaultKeyStatistics || {};
  const pr = qs.price || {}, sp = qs.assetProfile || qs.summaryProfile || {};
  const trend = (qs.earningsTrend && qs.earningsTrend.trend) || [];
  const y0 = trend.find((x) => x.period === "0y") || {}, y1 = trend.find((x) => x.period === "+1y") || {};
  const eps0 = raw(y0.earningsEstimate && y0.earningsEstimate.avg), eps1 = raw(y1.earningsEstimate && y1.earningsEstimate.avg);
  let g1 = raw(y1.earningsEstimate && y1.earningsEstimate.growth);
  if (g1 == null && eps0 > 0 && eps1 != null) g1 = eps1 / eps0 - 1;
  const ed = qs.calendarEvents && qs.calendarEvents.earnings && qs.calendarEvents.earnings.earningsDate;
  return {
    namn: pr.longName || pr.shortName, sektor: sp.sector || null, bransch: sp.industry || null,
    beskrivning: sp.longBusinessSummary ? sp.longBusinessSummary.slice(0, 2500) : null, webb: sp.website || null,
    anställda: raw(sp.fullTimeEmployees), land: sp.country || null, stad: sp.city || null,
    vd: ((sp.companyOfficers || []).find((o) => /CEO|Chief Executive/i.test(o.title || "")) || {}).name || null,
    ägare: owners(qs),
    börsvärde: raw(pr.marketCap) ?? raw(sd.marketCap), valuta: pr.currency || null,
    pe: raw(sd.trailingPE), forward_pe: raw(sd.forwardPE) ?? raw(ks.forwardPE), peg: raw(ks.pegRatio),
    ps: raw(sd.priceToSalesTrailing12Months), ev_ebitda: raw(ks.enterpriseToEbitda),
    omsättningstillväxt: raw(fd.revenueGrowth), vinsttillväxt: raw(fd.earningsGrowth),
    bruttomarginal: raw(fd.grossMargins), rörelsemarginal: raw(fd.operatingMargins), vinstmarginal: raw(fd.profitMargins),
    roe: raw(fd.returnOnEquity), skuld_eget_kapital: raw(fd.debtToEquity), current_ratio: raw(fd.currentRatio),
    kassa: raw(fd.totalCash), skuld: raw(fd.totalDebt), fritt_kassaflöde: raw(fd.freeCashflow),
    beta: raw(sd.beta), utdelning: raw(sd.trailingAnnualDividendYield) ?? raw(sd.dividendYield), blankning: raw(ks.shortPercentOfFloat),
    högsta_52v: raw(sd.fiftyTwoWeekHigh), lägsta_52v: raw(sd.fiftyTwoWeekLow),
    riktkurs: raw(fd.targetMeanPrice), riktkurs_hög: raw(fd.targetHighPrice), riktkurs_låg: raw(fd.targetLowPrice),
    analytiker_råd: fd.recommendationKey || null, antal_analytiker: raw(fd.numberOfAnalystOpinions),
    eps_i_år: eps0, eps_nästa_år: eps1, vinsttillväxt_nästa_år: g1,
    omsättningstillväxt_nästa_år: raw(y1.revenueEstimate && y1.revenueEstimate.growth),
    nästa_rapport: ed && ed[0] ? new Date(raw(ed[0]) * 1000).toISOString().slice(0, 10) : null,
  };
}

function owners(qs) {
  const mh = qs.majorHoldersBreakdown || {}, io = (qs.institutionOwnership && qs.institutionOwnership.ownershipList) || [];
  const största = io.slice(0, 8).map((o) => ({ namn: o.organization, andel: raw(o.pctHeld), värde: raw(o.value), datum: o.reportDate && o.reportDate.fmt ? o.reportDate.fmt : null }))
    .filter((o) => o.namn);
  const out = { insiders: raw(mh.insidersPercentHeld), institutioner: raw(mh.institutionsPercentHeld), antal_institutioner: raw(mh.institutionsCount), största };
  return out.insiders == null && out.institutioner == null && !största.length ? null : out;
}

function technicals(rows) {
  const c = rows.map((r) => r.c), n = c.length, last = c[n - 1];
  const sma = (k) => (n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null);
  const change = (days) => (n > days ? last / c[n - 1 - days] - 1 : null);
  const ret = []; for (let i = 1; i < n; i++) ret.push(c[i] / c[i - 1] - 1);
  const yr = ret.slice(-252), mean = avg(yr), sd = Math.sqrt(avg(yr.map((r) => (r - mean) ** 2)));
  let gain = 0, loss = 0; for (let i = n - 14; i < n; i++) { const d = c[i] - c[i - 1]; if (d > 0) gain += d; else loss -= d; }
  const two = c.slice(-504); let peak = two[0], mdd = 0; for (const x of two) { peak = Math.max(peak, x); mdd = Math.min(mdd, x / peak - 1); }
  return {
    kurs: last, förändring_1d: change(1), förändring_1m: change(21), förändring_3m: change(63), förändring_6m: change(126), förändring_1år: change(252),
    förändring_5år: change(1260), förändring_10år: n > 2400 ? last / c[0] - 1 : null,
    sma50: sma(50), sma200: sma(200), rsi14: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss),
    volatilitet: sd * Math.sqrt(252), max_drawdown_2år: mdd, sharpe_1år: sd ? (mean / sd) * Math.sqrt(252) : null,
    från_52v_högsta: last / Math.max(...c.slice(-252)) - 1,
  };
}

function lin(v, good, bad) { return v == null || !isFinite(v) ? null : clip(((v - bad) / (good - bad)) * 10, 0, 10); }

function score(f, t) {
  f = f || {};
  const upside = f.riktkurs && t.kurs ? f.riktkurs / t.kurs - 1 : null;
  const fcfY = f.fritt_kassaflöde != null && f.börsvärde ? f.fritt_kassaflöde / f.börsvärde : null;
  const areas = {
    "Värdering": avg([f.forward_pe != null ? (f.forward_pe > 0 ? lin(f.forward_pe, 12, 60) : 0) : null,
      lin(f.peg, 0.8, 3), lin(f.ps, 2, 20), lin(f.ev_ebitda, 8, 40), lin(upside, 0.3, -0.15)]),
    "Tillväxt": avg([lin(f.omsättningstillväxt, 0.3, -0.05), lin(f.vinsttillväxt, 0.3, -0.2), lin(f.vinsttillväxt_nästa_år, 0.3, -0.1)]),
    "Lönsamhet": avg([lin(f.bruttomarginal, 0.65, 0.15), lin(f.rörelsemarginal, 0.25, -0.1), lin(f.roe, 0.25, -0.05), lin(fcfY, 0.05, -0.03)]),
    "Finansiell styrka": avg([lin(f.skuld_eget_kapital, 10, 200), lin(f.current_ratio, 2.5, 0.8),
      f.skuld ? lin((f.kassa || 0) / f.skuld, 1.5, 0.2) : (f.kassa ? 10 : null)]),
    "Trend & risk": avg([t.sma200 ? lin(t.kurs / t.sma200 - 1, 0.15, -0.15) : null, lin(t.förändring_6m, 0.3, -0.25),
      lin(-Math.abs(t.rsi14 - 55), 0, -30), lin(t.volatilitet, 0.2, 0.8), lin(t.max_drawdown_2år, -0.15, -0.7)]),
  };
  const w = { "Värdering": 0.25, "Tillväxt": 0.25, "Lönsamhet": 0.2, "Finansiell styrka": 0.15, "Trend & risk": 0.15 };
  const have = Object.keys(areas).filter((k) => areas[k] != null);
  const total = have.length ? (have.reduce((s, k) => s + areas[k] * w[k], 0) / have.reduce((s, k) => s + w[k], 0)) * 10 : 0;
  const out = {}; for (const k in areas) out[k] = areas[k] == null ? null : Math.round(areas[k] * 10) / 10;
  return {
    områden: out, total: Math.round(total),
    bedömning: total >= 65 ? "Köpvärd" : total >= 45 ? "Avvakta / bevaka" : "Undvik just nu",
    uppsida_riktkurs: upside, datatäckning: have.length,
  };
}

function expectedReturn(f, t) {
  f = f || {};
  const parts = {}, w = { analytiker: 0.5, fundamenta: 0.35, trend: 0.15 };
  if (f.riktkurs && (f.antal_analytiker || 0) >= 3) parts.analytiker = clip(f.riktkurs / t.kurs - 1, -0.5, 1);
  let g = f.vinsttillväxt_nästa_år ?? f.omsättningstillväxt_nästa_år ?? f.vinsttillväxt ?? f.omsättningstillväxt;
  let ey = f.eps_nästa_år > 0 ? f.eps_nästa_år / t.kurs : (f.forward_pe > 0 ? 1 / f.forward_pe : null);
  if (g != null) parts.fundamenta = clip((ey ?? -0.05) + clip(g, -0.2, 0.4), -0.3, 0.6);
  if (t.förändring_1år != null) parts.trend = clip(t.förändring_1år, -0.5, 1) * 0.3;
  const keys = Object.keys(parts);
  if (!keys.length) return { förväntad: null, delar: parts };
  const tw = keys.reduce((s, k) => s + w[k], 0);
  return { förväntad: keys.reduce((s, k) => s + parts[k] * w[k], 0) / tw, delar: parts };
}

// Börsen, räntan, dollarn, oljan och inflationsskyddade obligationer – veckovis i 5 år, delas av alla aktier
async function macroSeries(ctx) {
  const tickers = [...new Set(FACTORS.flatMap((f) => [f.t, f.mot]).filter(Boolean))];
  const out = {};
  await Promise.all(tickers.map(async (x) => {
    try { out[x] = await cached("macro:" + x, 12 * 3600, ctx, async () => (await chart(x, "5y", "1wk")).rows); } catch { out[x] = []; }
  }));
  return out;
}

async function stock(t, env, ctx) {
  return cached("stock2:" + t, 1800, ctx, async () => {
    const [ch, qs, fin, nw, ms] = await Promise.all([chart(t, "10y"), quoteSummary(t, env), financials(t), news(t), macroSeries(ctx).catch(() => ({}))]);
    const f = fundamentals(qs);
    const tech = technicals(ch.rows);
    const meta = ch.meta;
    const er = expectedReturn(f, tech);
    const safe = (fn) => { try { return fn(); } catch (e) { console.log("analys", t, e.message); return null; } };
    return {
      t, namn: (f && f.namn) || meta.longName || meta.shortName || t,
      valuta: meta.currency, börs: meta.fullExchangeName || meta.exchangeName,
      pris: meta.regularMarketPrice, idag: tech.förändring_1d,
      historik: ch.rows, nyckeltal: f, teknik: tech, poäng: score(f, tech), förväntad: er,
      horisonter: safe(() => horizons(f, tech, er.förväntad)),
      värdering: safe(() => valuation(f, tech)),
      hype: safe(() => hype(f, tech)),
      säsong: safe(() => seasonality(ch.rows)),
      makro: safe(() => macro(ch.rows, ms)),
      rapporter: fin, nyheter: nw, hämtad: Date.now(),
    };
  });
}

// ---------------------------------------------------------------------------
// AI-analys med Claude (läser senaste rapporten och nyheter på webben)
// ---------------------------------------------------------------------------

const SYSTEM = `Du är en noggrann och ärlig aktieanalytiker. Du skriver på svenska, i korta och enkla meningar.
Du får aktuell data om en aktie (kurs, nyckeltal, prognoser, kvartalssiffror, poäng, nyheter).
Använd webbsökning för att läsa bolagets SENASTE kvartalsrapport eller årsrapport och viktiga nyheter från de senaste 3 månaderna.
Ta också reda på bolagets affärsidé, uttalade mål och strategi (t.ex. ledningens prognoser), samt viktiga avtal, kontrakt eller partnerskap som nämns i rapporten eller nyheterna.
Väg värdering mot tillväxt. Bedöm om aktien är under- eller övervärderad, hur mycket hype som finns kring den och vad som redan är inprisat i kursen.
Datan innehåller en räknad modell (värdering.rimligt, värdering.inprisat.tillväxt = tillväxten kursen förutsätter, hype.poäng 0–100). Använd den som en signal, inte som facit, och säg emot den om rapporterna pekar åt ett annat håll.
Var tydlig med risker och med vad du är osäker på. Hitta aldrig på siffror eller avtal.
Skriv för en privatperson. Detta är underlag för egen analys, inte finansiell rådgivning.
Avsluta ALLTID med att anropa verktyget submit_verdict.`;

const VERDICT_TOOL = {
  name: "submit_verdict",
  description: "Lämna din slutliga bedömning av aktien. Anropas sist.",
  input_schema: {
    type: "object",
    properties: {
      betyg: { type: "string", enum: ["Köpvärd", "Avvakta / bevaka", "Undvik just nu"] },
      sakerhet: { type: "string", enum: ["Låg", "Medel", "Hög"], description: "Hur säker bedömningen är." },
      kort: { type: "string", description: "Bedömningen i 1–2 korta meningar." },
      sammanfattning: { type: "string", description: "3–5 korta meningar." },
      senaste_rapport: { type: "string", description: "Vad senaste rapporten visade, med period och viktigaste siffror. 2–4 meningar." },
      vardering: { type: "string", description: "Är aktien dyr eller billig i förhållande till tillväxten? Varför?" },
      vardering_lage: { type: "string", enum: ["Undervärderad", "Rimligt värderad", "Övervärderad"], description: "Din samlade bedömning efter rapporter, analyser och hype." },
      inprisat: { type: "string", description: "Vad kursen redan räknar med (tillväxt, marginaler, framtida produkter) och om det är rimligt. 2–3 meningar." },
      hype: { type: "string", description: "Hur mycket hype, förväntningar och uppmärksamhet som finns kring aktien just nu, och om den är befogad. 1–3 meningar." },
      ide: { type: "string", description: "Bolagets affärsidé: vad de säljer, till vem och hur de tjänar pengar. 2–3 enkla meningar." },
      mal: { type: "string", description: "Bolagets uttalade mål, strategi och prognoser framåt. 2–3 meningar." },
      kontrakt: { type: "array", items: { type: "string" }, description: "Viktiga avtal, kontrakt eller partnerskap som nämns i källorna (med datum om möjligt). Tom lista om du inte hittat några." },
      styrkor: { type: "array", items: { type: "string" }, description: "3–5 korta punkter." },
      risker: { type: "array", items: { type: "string" }, description: "3–5 korta punkter." },
      att_bevaka: { type: "array", items: { type: "string" }, description: "Vad som skulle ändra bedömningen." },
    },
    required: ["betyg", "sakerhet", "kort", "sammanfattning", "senaste_rapport", "vardering", "vardering_lage", "inprisat", "hype", "ide", "mal", "styrkor", "risker", "att_bevaka"],
  },
};

// Dagsgräns så att krediterna inte tar slut av misstag
async function countAI(env, fromCron = false) {
  const day = new Date().toISOString().slice(0, 10);
  const limit = Number(env.AI_DAILY_LIMIT || DEFAULT_AI_DAILY_LIMIT);
  const used = Number((await env.AKTIE_KV.get("aicount:" + day)) || 0);
  if (used >= limit && !fromCron) throw httpError(`Dagens gräns på ${limit} AI-analyser är nådd. Försök i morgon.`, 429);
  await env.AKTIE_KV.put("aicount:" + day, String(used + 1), { expirationTtl: 3 * 86400 });
}

async function claude(env, body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await r.json();
  if (!r.ok) {
    const msg = (res.error && res.error.message) || `Claude svarade ${r.status}`;
    throw httpError(/credit|balance/i.test(msg) ? "Krediterna är slut. Fyll på i console.anthropic.com." : msg, 502);
  }
  return res;
}

async function getAI(t, env) {
  return (await env.AKTIE_KV.get("ai:" + t, "json")) || { saknas: true };
}

async function runAI(t, env, ctx, force = false, fromCron = false) {
  if (!force) {
    const c = await env.AKTIE_KV.get("ai:" + t, "json");
    if (c && Date.now() - c.analyserad < AI_CACHE_DAYS * 86400e3) return c;
  }
  if (!env.ANTHROPIC_API_KEY) throw httpError("ANTHROPIC_API_KEY saknas på servern.", 500);

  await countAI(env, fromCron);

  const s = await stock(t, env, ctx);
  // Skicka inte stora tabeller till AI:n (kostar bara pengar)
  const data = {
    ...s, historik: undefined, hämtad: undefined,
    värdering: s.värdering ? { ...s.värdering, inprisat: { ...s.värdering.inprisat, tabell: undefined } } : null,
    säsong: s.säsong ? { bästa: s.säsong.bästa, sämsta: s.säsong.sämsta, strategi: s.säsong.strategi && { ...s.säsong.strategi, affärer: undefined } } : null,
    nyckeltal: s.nyckeltal ? { ...s.nyckeltal, beskrivning: s.nyckeltal.beskrivning && s.nyckeltal.beskrivning.slice(0, 800) } : null,
  };
  const today = new Date().toISOString().slice(0, 10);
  const messages = [{ role: "user", content: `Dagens datum: ${today}. Analysera aktien ${t} (${s.namn}). Är den en bra investering just nu?\n\nData:\n${JSON.stringify(data)}` }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }, VERDICT_TOOL];
  const sources = new Map();

  for (let round = 0; round < 5; round++) {
    const body = { model: MODEL, max_tokens: 6000, system: SYSTEM, tools, messages };
    const res = await claude(env, body);
    for (const b of res.content) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const x of b.content) if (x.url && !sources.has(x.url)) sources.set(x.url, { titel: x.title, länk: x.url, datum: x.page_age || null });
      }
    }
    const v = res.content.find((b) => b.type === "tool_use" && b.name === "submit_verdict");
    if (v) {
      const i = v.input || {};
      const out = {
        t, betyg: i.betyg || s.poäng.bedömning, säkerhet: i.sakerhet || "Låg", kort: i.kort || "",
        sammanfattning: i.sammanfattning || "", senaste_rapport: i.senaste_rapport || "", värdering: i.vardering || "",
        värderingsläge: i.vardering_lage || null, inprisat: i.inprisat || "", hype: i.hype || "", idé: i.ide || "", mål: i.mal || "",
        kontrakt: Array.isArray(i.kontrakt) ? i.kontrakt.slice(0, 8) : [],
        styrkor: i.styrkor || [], risker: i.risker || [], att_bevaka: i.att_bevaka || [],
        källor: [...sources.values()].slice(0, 8), poäng: s.poäng.total, pris_vid_analys: s.pris,
        modell: MODEL, analyserad: Date.now(),
      };
      await env.AKTIE_KV.put("ai:" + t, JSON.stringify(out), { expirationTtl: AI_CACHE_DAYS * 86400 * 4 });
      return out;
    }
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason !== "pause_turn") {
      messages.push({ role: "user", content: "Avsluta nu genom att anropa submit_verdict." });
    }
  }
  throw httpError("AI:n gav inget svar. Försök igen.", 502);
}

// ---------------------------------------------------------------------------
// Bevakningslista
// ---------------------------------------------------------------------------

async function getWatchlist(env) {
  return (await env.AKTIE_KV.get("watchlist", "json")) || [];
}

async function editWatchlist(body, env) {
  let list = await getWatchlist(env);
  const t = String(body.t || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(t)) throw httpError("Ogiltig ticker.", 400);
  if (body.action === "add" && !list.some((w) => w.t === t)) list.push({ t, namn: String(body.namn || t).slice(0, 80), tillagd: Date.now() });
  if (body.action === "remove") list = list.filter((w) => w.t !== t);
  if (list.length > 60) throw httpError("Max 60 aktier i bevakningslistan.", 400);
  await env.AKTIE_KV.put("watchlist", JSON.stringify(list));
  return list;
}

// ---------------------------------------------------------------------------
// Portfölj: dina innehav, en kort signal per aktie och AI-råd för hela portföljen
// ---------------------------------------------------------------------------

const cleanT = (x) => { const t = String(x || "").trim().toUpperCase(); if (!/^[A-Z0-9.\-^=]{1,15}$/.test(t)) throw httpError("Ogiltig ticker.", 400); return t; };
const fnum = (x) => { const v = Number(x); return isFinite(v) ? v : null; };
const str = (x, n) => (x == null ? "" : String(x).slice(0, n));

async function getPortfolio(env) {
  return (await env.AKTIE_KV.get("portfolio", "json")) || [];
}

async function editPortfolio(body, env) {
  let list = await getPortfolio(env);
  const t = cleanT(body.t);
  if (body.action === "set") {
    const antal = fnum(body.antal), gav = fnum(body.gav);
    if (!(antal > 0 && antal < 1e9)) throw httpError("Ange hur många aktier du äger.", 400);
    if (!(gav > 0 && gav < 1e7)) throw httpError("Ange vad du betalade per aktie.", 400);
    const row = { t, namn: str(body.namn || t, 80), antal, gav, ändrad: Date.now() };
    const i = list.findIndex((x) => x.t === t);
    if (i >= 0) list[i] = { ...list[i], ...row }; else list.push({ ...row, tillagd: Date.now() });
  }
  if (body.action === "remove") list = list.filter((x) => x.t !== t);
  if (list.length > 40) throw httpError("Max 40 innehav.", 400);
  await env.AKTIE_KV.put("portfolio", JSON.stringify(list));
  return list;
}

/** Det viktigaste om en aktie, litet nog för att hämta för hela portföljen. */
async function signal(t, env, ctx) {
  const s = await stock(t, env, ctx);
  const ai = await env.AKTIE_KV.get("ai:" + t, "json");
  const f = s.nyckeltal || {}, h = s.horisonter;
  return {
    t, namn: s.namn, pris: s.pris, valuta: s.valuta, idag: s.idag, sektor: f.sektor || null,
    poäng: s.poäng.total, bedömning: s.poäng.bedömning,
    horisonter: h ? Object.fromEntries(h.rader.map((r) => [r.år, { årlig: r.årlig, kurs: r.kurs }])) : {},
    utdelning: h ? h.utdelning : null, förlustbolag: h ? h.förlustbolag : null,
    värdering: s.värdering ? { läge: s.värdering.läge, gap: s.värdering.gap, rimligt: s.värdering.rimligt } : null,
    hype: s.hype ? { poäng: s.hype.poäng, nivå: s.hype.nivå } : null,
    analytiker: { riktkurs: f.riktkurs ?? null, antal: f.antal_analytiker ?? null, råd: f.analytiker_råd ?? null },
    förändring_1år: s.teknik.förändring_1år, volatilitet: s.teknik.volatilitet,
    ai: ai ? { betyg: ai.betyg, kort: ai.kort, värderingsläge: ai.värderingsläge || null, analyserad: ai.analyserad } : null,
  };
}

const ADVICE_SYSTEM = `Du är en ärlig och noggrann rådgivare för en privatperson. Du skriver på svenska, i korta och enkla meningar.
Du får personens aktieinnehav: antal, köpkurs, dagens kurs, vinst eller förlust, andel av portföljen och analysdata per aktie
(förväntad avkastning per år om 1, 3, 5 och 10 år från en räknad modell, värderingsläge, hype 0–100, kvalitetspoäng 0–100, analytiker och en tidigare AI-bedömning om sådan finns).
Du får också kandidater: aktier från appens topplistor med förväntad avkastning.

Målet är högsta möjliga avkastning per år på 3–5 års sikt, till en rimlig risk.
- För varje innehav: välj Köp mer, Behåll, Sälj delvis eller Sälj. Motivera kort med siffrorna.
- Köpkursen avgör inte vad som är klokt framåt. Det som spelar roll är vad aktien väntas ge härifrån jämfört med alternativen.
- Vid Sälj eller Sälj delvis: föreslå 1–3 alternativ ENBART ur kandidatlistan, som väntas ge mer per år. Välj gärna en annan sektor om portföljen är koncentrerad.
- Ett innehav som är över 30 % av portföljen är en risk i sig.
- Var försiktig: en modell kan ha fel, särskilt för förlustbolag och aktier med hög hype. Säg när underlaget är tunt.
- Hitta aldrig på siffror eller aktier. Detta är underlag för egna beslut, inte finansiell rådgivning.
Avsluta genom att anropa verktyget submit_advice.`;

const RAD = ["Köp mer", "Behåll", "Sälj delvis", "Sälj"];
const ADVICE_TOOL = {
  name: "submit_advice",
  description: "Lämna råden för portföljen. Anropas sist.",
  input_schema: {
    type: "object",
    properties: {
      sammanfattning: { type: "string", description: "Portföljen i 2–4 korta meningar: styrkor, risker, viktigaste ändringen." },
      forvantad_fore: { type: "number", description: "Ungefärlig förväntad avkastning per år för portföljen som den är, som decimal (0.08 = 8 %)." },
      forvantad_efter: { type: "number", description: "Ungefärlig förväntad avkastning per år om råden följs, som decimal." },
      innehav: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            rad: { type: "string", enum: RAD },
            kort: { type: "string", description: "Rådet i en kort mening." },
            motivering: { type: "string", description: "2–3 korta meningar med siffrorna som avgör." },
            alternativ: {
              type: "array", description: "Endast vid Sälj eller Sälj delvis. 1–3 aktier ur kandidatlistan.",
              items: { type: "object", properties: { ticker: { type: "string" }, varfor: { type: "string" } }, required: ["ticker", "varfor"] },
            },
          },
          required: ["ticker", "rad", "kort", "motivering"],
        },
      },
      att_tanka_pa: { type: "array", items: { type: "string" }, description: "2–4 korta punkter, t.ex. spridning, risk, courtage." },
    },
    required: ["sammanfattning", "innehav"],
  },
};

const portfolioKey = (list) => list.map((x) => `${x.t}:${x.antal}`).sort().join(",");

async function portfolioAdvice(body, env) {
  if (!env.ANTHROPIC_API_KEY) throw httpError("ANTHROPIC_API_KEY saknas på servern.", 500);
  const list = await getPortfolio(env);
  if (!list.length) throw httpError("Lägg till dina innehav först.", 400);
  // Appen skickar med signalerna den redan hämtat (så slipper servern hämta allt igen). Rensa och begränsa.
  const sig = new Map((Array.isArray(body.signaler) ? body.signaler : []).slice(0, 40).map((x) => [String(x.t || "").toUpperCase(), x]));
  const owned = new Set(list.map((x) => x.t));
  const total = list.reduce((s, x) => s + x.antal * (fnum((sig.get(x.t) || {}).pris) || x.gav), 0);
  const innehav = list.map((x) => {
    const g = sig.get(x.t) || {}, pris = fnum(g.pris) || x.gav;
    const h = g.horisonter || {}, a = (k) => fnum(h[k] && h[k].årlig);
    return {
      ticker: x.t, namn: str(x.namn, 80), antal: x.antal, köpkurs: x.gav, kurs: pris, vinst: pris / x.gav - 1, andel: total ? (x.antal * pris) / total : null,
      sektor: str(g.sektor, 40), förväntad_per_år: { "1": a(1), "3": a(3), "5": a(5), "10": a(10) },
      värdering: g.värdering ? { läge: str(g.värdering.läge, 30), gap: fnum(g.värdering.gap) } : null,
      hype: g.hype ? fnum(g.hype.poäng) : null, kvalitet: fnum(g.poäng), förlustbolag: !!g.förlustbolag,
      analytiker: g.analytiker ? { riktkurs: fnum(g.analytiker.riktkurs), antal: fnum(g.analytiker.antal) } : null,
      tidigare_ai: g.ai ? { betyg: str(g.ai.betyg, 30), kort: str(g.ai.kort, 300) } : null,
    };
  });
  const kandidater = (Array.isArray(body.kandidater) ? body.kandidater : []).slice(0, 60)
    .map((k) => ({ ticker: str(k.t, 15).toUpperCase(), namn: str(k.namn, 60), sektor: str(k.sektor, 40), lista: str(k.lista, 20),
      per_år_3år: fnum(k.årlig_3år), per_år_10år: fnum(k.årlig_10år), förväntad_1år: fnum(k.förväntad), kvalitet: fnum(k.kvalitet), ai: str(k.ai, 30) }))
    .filter((k) => /^[A-Z0-9.\-]{1,15}$/.test(k.ticker) && !owned.has(k.ticker));
  const candSet = new Set(kandidater.map((k) => k.ticker));

  await countAI(env);
  const messages = [{ role: "user", content: `Dagens datum: ${new Date().toISOString().slice(0, 10)}.\n\nMina innehav:\n${JSON.stringify(innehav)}\n\nKandidater:\n${JSON.stringify(kandidater)}` }];
  for (let round = 0; round < 3; round++) {
    const res = await claude(env, { model: MODEL, max_tokens: 6000, system: ADVICE_SYSTEM, tools: [ADVICE_TOOL], messages });
    const v = res.content.find((b) => b.type === "tool_use" && b.name === "submit_advice");
    if (v) {
      const i = v.input || {};
      const rows = (Array.isArray(i.innehav) ? i.innehav : []).map((r) => ({
        t: str(r.ticker, 15).toUpperCase(), råd: RAD.includes(r.rad) ? r.rad : "Behåll", kort: str(r.kort, 300), motivering: str(r.motivering, 900),
        alternativ: (Array.isArray(r.alternativ) ? r.alternativ : []).map((a) => ({ t: str(a.ticker, 15).toUpperCase(), varför: str(a.varfor, 400) }))
          .filter((a) => candSet.has(a.t)).slice(0, 3), // bara aktier som faktiskt fanns i listan
      })).filter((r) => owned.has(r.t));
      const out = {
        sammanfattning: str(i.sammanfattning, 1200), före: fnum(i.forvantad_fore), efter: fnum(i.forvantad_efter),
        innehav: rows, att_tänka_på: (Array.isArray(i.att_tanka_pa) ? i.att_tanka_pa : []).map((x) => str(x, 300)).slice(0, 5),
        kandidater: kandidater.filter((k) => rows.some((r) => r.alternativ.some((a) => a.t === k.ticker))),
        portfölj: portfolioKey(list), modell: MODEL, skapad: Date.now(),
      };
      await env.AKTIE_KV.put("portfolio:advice", JSON.stringify(out));
      return out;
    }
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: "Avsluta nu genom att anropa submit_advice." });
  }
  throw httpError("AI:n gav inget svar. Försök igen.", 502);
}

// Exporteras för tester
export const _test = { fundamentals, technicals, score, expectedReturn, editWatchlist, runAI, stock, search, macroSeries, portfolioKey };
