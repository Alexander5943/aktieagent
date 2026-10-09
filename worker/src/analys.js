/**
 * Ren matematik för aktieanalysen – inga nätverksanrop.
 * Samma regler finns i Python i modell.py (används av topplistorna). Ändras det ena ska det andra ändras.
 *
 *   horizons()    förväntad avkastning och kursmål om 1, 3, 5 och 10 år
 *   valuation()   rimligt värde idag, under-/övervärderad och vilken tillväxt kursen prisar in
 *   hype()        hur "het" aktien är just nu (0–100)
 *   seasonality() bästa och sämsta månader + strategin "köp i svagaste perioden, sälj i starkaste"
 *   macro()       hur aktien brukar reagera på börsen, räntan, dollarn, oljan och inflationsoro
 */

export const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const avg = (xs) => { xs = xs.filter((x) => x != null && isFinite(x)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
const median = (xs) => { const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const lin = (v, good, bad) => (v == null || !isFinite(v) ? null : clip(((v - bad) / (good - bad)) * 10, 0, 10));
const num = (x) => (x != null && isFinite(x) ? x : null);

// ---------------------------------------------------------------------------
// Värderingsmodell
// ---------------------------------------------------------------------------
// Vinsten växer med bolagets förväntade tillväxt, som sedan avtar mot 4 % per år (som ekonomin).
// P/E går gradvis mot ett "rimligt" P/E som beror på tillväxten och bolagets kvalitet.

export const M = {
  slutTillvaxt: 0.04,  // långsiktig tillväxt när bolaget mognat
  avtagande: 0.65,     // hur fort tillväxten avtar mot slutTillvaxt per år
  peAterg: 0.7,        // andel av "för högt/lågt" P/E som finns kvar efter ett år
  avkastningskrav: 0.09,
};

export function qualityPremium(f) {
  const roe = num(f.roe), opm = num(f.rörelsemarginal);
  return (roe != null ? clip((roe - 0.1) * 20, 0, 5) : 0) + (opm != null ? clip((opm - 0.1) * 15, 0, 3) : 0);
}
export const fairPE = (g, q = 0) => clip(15 + 80 * g + q, 12, 32);
const gAt = (g0, k) => M.slutTillvaxt + (g0 - M.slutTillvaxt) * M.avtagande ** k;
/** Vinst per aktie 12 månader framåt, räknat från år T (T=0 → E1). */
export function epsAt(E1, g0, T) { let e = E1; for (let k = 1; k <= T; k++) e *= 1 + gAt(g0, k); return e; }

export function modelInputs(f, P) {
  f = f || {};
  const cands = [["analytikernas vinstprognos", f.vinsttillväxt_nästa_år], ["analytikernas omsättningsprognos", f.omsättningstillväxt_nästa_år],
    ["senaste årets omsättning", f.omsättningstillväxt], ["senaste årets vinst", f.vinsttillväxt]];
  const hit = cands.find(([, v]) => num(v) != null);
  const g0 = clip(hit ? hit[1] : 0.05, -0.15, 0.4);
  let E1 = f.eps_nästa_år > 0 ? f.eps_nästa_år : null;
  // Skydd mot prognoser i annan valuta (t.ex. utländska bolag): måste stämma med Yahoos forward P/E
  if (E1 && f.forward_pe > 0) { const r = (P / E1) / f.forward_pe; if (r < 0.6 || r > 1.6) E1 = null; }
  if (!E1 && f.forward_pe > 0) E1 = P / f.forward_pe;
  const sps = f.ps > 0 ? P / f.ps : null;
  return {
    g0, tillväxtkälla: hit ? hit[0] : "antagande (5 %)", E1, sps,
    d: clip(num(f.utdelning) ?? 0, 0, 0.1), q: qualityPremium(f), bm: num(f.bruttomarginal),
  };
}

/** Kurs om T år. full=true: P/E har helt nått "rimlig" nivå (används för rimligt värde). */
export function priceAt(inp, P, T, full = false, g0 = inp.g0) {
  const fair = fairPE(gAt(g0, T + 1), inp.q);
  if (inp.E1 > 0) {
    const pe0 = P / inp.E1;
    const pe = full ? fair : fair + (pe0 - fair) * M.peAterg ** T;
    return pe * epsAt(inp.E1, g0, T);
  }
  if (inp.sps > 0) {
    // Förlustbolag: försäljningen växer och marginalen antas bli normal på sikt
    const margin = clip((inp.bm ?? 0.4) * 0.35, 0.04, 0.25);
    const fairPS = margin * fair, ps0 = P / inp.sps;
    const ps = full ? fairPS : fairPS + (ps0 - fairPS) * M.peAterg ** T;
    return ps * inp.sps * (1 + g0) * epsAt(1, g0, T);
  }
  return null;
}

export function horizons(f, t, er1) {
  const P = t.kurs, inp = modelInputs(f, P), vol = clip(num(t.volatilitet) ?? 0.35, 0.15, 0.8);
  const rader = [];
  for (const T of [1, 3, 5, 10]) {
    let ann = null;
    if (T === 1 && er1 != null) ann = er1;
    else {
      const pT = priceAt(inp, P, T);
      if (pT != null) {
        const tot = (pT / P) * (1 + inp.d) ** T - 1;
        ann = tot <= -1 ? -0.25 : (1 + tot) ** (1 / T) - 1;
        if (T === 3 && er1 != null) ann = 0.7 * ann + 0.3 * er1;
      }
    }
    if (ann == null) continue;
    ann = T === 1 ? clip(ann, -0.5, 1) : clip(ann, -0.25, 0.4);
    const band = (vol * 0.6) / Math.sqrt(T);
    const kurs = (a) => P * ((1 + a) ** T) / (1 + inp.d) ** T;
    rader.push({ år: T, årlig: ann, total: (1 + ann) ** T - 1, kurs: kurs(ann), låg: kurs(Math.max(ann - band, -0.6)), hög: kurs(ann + band) });
  }
  const säkerhet = !inp.E1 ? "Låg" : (f && (f.antal_analytiker || 0) >= 5 && f.vinsttillväxt_nästa_år != null) ? "Medel" : "Låg";
  return { rader, utdelning: inp.d, tillväxt: inp.g0, tillväxtkälla: inp.tillväxtkälla, säkerhet, förlustbolag: !inp.E1 };
}

// ---------------------------------------------------------------------------
// Värdering: rimligt värde, läge och inprisad tillväxt
// ---------------------------------------------------------------------------

function fairValueModel(inp, P, g0 = inp.g0) {
  const p5 = priceAt(inp, P, 5, true, g0);
  return p5 == null ? null : (p5 * (1 + inp.d) ** 5) / (1 + M.avkastningskrav) ** 5;
}

/** Vilken årlig tillväxt (det närmaste året, sedan avtagande) som krävs för att kursen P ska vara rimlig. */
export function impliedGrowth(inp, P) {
  if (!(inp.E1 > 0)) return null;
  let lo = -0.3, hi = 0.9;
  if (fairValueModel(inp, P, hi) < P) return hi;
  if (fairValueModel(inp, P, lo) > P) return lo;
  for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (fairValueModel(inp, P, mid) < P) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export function valuation(f, t) {
  f = f || {};
  const P = t.kurs, inp = modelInputs(f, P);
  const modell = fairValueModel(inp, P);
  const analytiker = f.riktkurs && (f.antal_analytiker || 0) >= 3 ? f.riktkurs / (1 + M.avkastningskrav) : null;
  const rimligt = modell != null && analytiker != null ? 0.6 * modell + 0.4 * analytiker : (modell ?? analytiker);
  if (rimligt == null || !(rimligt > 0)) return null;
  const ig = impliedGrowth(inp, P);
  // Tabell så att appen kan räkna om inprisad tillväxt när kursen rör sig
  const tabell = [];
  if (inp.E1 > 0) for (let m = 0.4; m <= 2.6; m *= 1.1) tabell.push([+(P * m).toFixed(4), +impliedGrowth(inp, P * m).toFixed(4)]);
  return {
    rimligt, modell, analytiker, gap: P / rimligt - 1, läge: läge(P / rimligt - 1),
    inprisat: { tillväxt: ig, väntad: inp.g0, källa: inp.tillväxtkälla, tabell },
  };
}

export function läge(gap) {
  if (gap == null) return null;
  if (gap <= -0.4) return "Kraftigt undervärderad";
  if (gap <= -0.15) return "Undervärderad";
  if (gap < 0.15) return "Rimligt värderad";
  if (gap < 0.4) return "Övervärderad";
  return "Kraftigt övervärderad";
}

// ---------------------------------------------------------------------------
// Hype-mätare
// ---------------------------------------------------------------------------

export function hype(f, t) {
  f = f || {};
  const inp = modelInputs(f, t.kurs), vol = clip(num(t.volatilitet) ?? 0.35, 0.1, 1.5);
  const premium = inp.E1 > 0 ? (t.kurs / inp.E1) / fairPE(inp.g0, inp.q) : (f.ps > 0 ? f.ps / 6 : null);
  const delar = {
    "Köptryck (RSI)": lin(t.rsi14, 78, 40),
    "Över 200-dagars snitt": t.sma200 ? lin(t.kurs / t.sma200 - 1, 0.45, -0.05) : null,
    "Uppgång senaste 3 mån": t.förändring_3m != null ? lin(t.förändring_3m / (vol / 2), 1.6, -0.4) : null,
    "Värdering mot tillväxt": premium != null ? lin(premium, 2.2, 0.9) : null,
  };
  const v = avg(Object.values(delar));
  if (v == null) return null;
  const poäng = Math.round(v * 10);
  return { poäng, nivå: poäng >= 80 ? "Mycket hypad" : poäng >= 62 ? "Het" : poäng >= 38 ? "Normal" : "Lugn / ointresse", delar };
}

// ---------------------------------------------------------------------------
// Säsongsmönster
// ---------------------------------------------------------------------------

export function monthlyReturns(rows) {
  const me = new Map();
  for (const r of rows) me.set(r.d.slice(0, 7), r.c);
  const keys = [...me.keys()], cur = rows.length ? rows[rows.length - 1].d.slice(0, 7) : "";
  const out = [];
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === cur) break; // innevarande månad är inte klar
    out.push({ k: keys[i], y: +keys[i].slice(0, 4), m: +keys[i].slice(5, 7), c: me.get(keys[i]), r: me.get(keys[i]) / me.get(keys[i - 1]) - 1 });
  }
  return out;
}

export function seasonality(rows) {
  const mr = monthlyReturns(rows);
  if (mr.length < 36) return null;
  const månader = [];
  for (let m = 1; m <= 12; m++) {
    const xs = mr.filter((x) => x.m === m).map((x) => x.r);
    månader.push({ m, snitt: avg(xs), median: median(xs), andel_upp: xs.length ? xs.filter((x) => x > 0).length / xs.length : null, antal: xs.length });
  }
  const byYear = new Map();
  for (const x of mr) { if (!byYear.has(x.y)) byYear.set(x.y, Array(12).fill(null)); byYear.get(x.y)[x.m - 1] = x.r; }
  const år = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, r]) => {
    const have = r.map((v, i) => [v, i + 1]).filter(([v]) => v != null);
    const best = have.reduce((a, b) => (b[0] > a[0] ? b : a), have[0]), worst = have.reduce((a, b) => (b[0] < a[0] ? b : a), have[0]);
    return { år: y, r, bästa: best ? best[1] : null, sämsta: worst ? worst[1] : null, helår: have.reduce((p, [v]) => p * (1 + v), 1) - 1, hela: have.length === 12 };
  });
  const rankade = månader.filter((x) => x.snitt != null).slice().sort((a, b) => b.snitt - a.snitt);

  // Strategin: hitta köp-månad (lägsta punkten i ett "snittår") och sälj-månad (högsta punkten efter)
  // Räkna bort aktiens vanliga uppgång per månad, annars blir svaret bara "äg aktien nästan hela året"
  const lg0 = månader.map((x) => Math.log(1 + (x.snitt ?? 0))), drift = avg(lg0);
  const lg = lg0.map((x) => x - drift);
  // Högst 6 månaders innehav. Väljer det kortaste innehavet som fångar minst 85 % av den bästa möjliga vinsten.
  const cands = [];
  for (let B = 1; B <= 12; B++) {
    let g = 0;
    for (let L = 1; L <= 6; L++) { g += lg[(B + L - 1) % 12]; cands.push({ B, L, g }); }
  }
  const top = Math.max(...cands.map((c) => c.g));
  const best = cands.filter((c) => c.g >= top * 0.85).sort((a, b) => a.L - b.L || b.g - a.g)[0];
  const closes = mr.map((x) => x.c);
  const affärer = [], resten = [], helår = [];
  mr.forEach((x, i) => {
    if (x.m !== best.B) return;
    if (i + best.L < mr.length) affärer.push({ år: x.y, r: closes[i + best.L] / closes[i] - 1 });
    if (i + 12 < mr.length) {
      helår.push(closes[i + 12] / closes[i] - 1);
      resten.push(closes[i + 12] / closes[i + best.L] - 1);
    }
  });
  let strategi = null;
  if (affärer.length >= 3) {
    const rs = affärer.map((a) => a.r);
    const andel = rs.filter((r) => r > 0).length / rs.length;
    const snitt = avg(rs);
    // Jämför med att äga aktien hela tiden under samma år
    const firstI = mr.findIndex((x) => x.m === best.B);
    const lastSell = firstI + (affärer.length - 1) * 12 + best.L;
    const kob = closes[Math.min(lastSell, closes.length - 1)] / closes[firstI] - 1;
    strategi = {
      köp_efter: best.B, sälj_efter: ((best.B + best.L - 1) % 12) + 1, månader: best.L,
      snitt, median: median(rs), andel_rätt: andel, antal: rs.length, affärer,
      totalt: rs.reduce((p, r) => p * (1 + r), 1) - 1, köp_och_behåll: kob,
      resten_snitt: avg(resten), helår_snitt: avg(helår),
      styrka: andel >= 0.75 && rs.length >= 6 && snitt > 0.03 ? "Starkt" : andel >= 0.6 && snitt > 0 ? "Måttligt" : "Svagt",
    };
  }
  return { månader, år, bästa: rankade.slice(0, 3).map((x) => x.m), sämsta: rankade.slice(-3).reverse().map((x) => x.m), strategi, antal_år: byYear.size };
}

/** Snittavkastning de kommande n månaderna enligt säsongsmönstret (används av topplistan 1–6 mån). */
export function seasonalAhead(seas, fromMonth, n = 6) {
  if (!seas) return null;
  let s = 0; for (let i = 0; i < n; i++) s += seas.månader[(fromMonth - 1 + i) % 12].snitt ?? 0;
  return s;
}

// ---------------------------------------------------------------------------
// Makrokänslighet
// ---------------------------------------------------------------------------

export const FACTORS = [
  { id: "marknad", namn: "Börsen (S&P 500)", t: "^GSPC", typ: "pct" },
  { id: "ranta", namn: "Räntan (USA 10 år)", t: "^TNX", typ: "diff" },
  { id: "dollar", namn: "Dollarn", t: "DX-Y.NYB", typ: "pct" },
  { id: "olja", namn: "Oljepriset", t: "CL=F", typ: "pct" },
  { id: "inflation", namn: "Inflationsoro", t: "TIP", mot: "IEF", typ: "spread" },
];

// Vecka = dagnumret (sedan 1970) för veckans måndag. Snabbt, utan datumobjekt.
function weekKey(d) {
  const day = Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5);
  return day - ((day + 3) % 7); // 1970-01-01 var en torsdag
}
function weekly(rows) { const m = new Map(); for (const r of rows) if (r.c != null && isFinite(r.c)) m.set(weekKey(r.d), r.c); return m; }

function solve(A, b) { // Gauss-Jordan; ger lösning och invers
  const n = A.length, M2 = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M2[r][c]) > Math.abs(M2[p][c])) p = r;
    if (Math.abs(M2[p][c]) < 1e-14) return null;
    [M2[c], M2[p]] = [M2[p], M2[c]];
    const piv = M2[c][c]; for (let j = 0; j < M2[c].length; j++) M2[c][j] /= piv;
    for (let r = 0; r < n; r++) if (r !== c) { const k = M2[r][c]; if (k) for (let j = 0; j < M2[r].length; j++) M2[r][j] -= k * M2[c][j]; }
  }
  return { x: M2.map((r) => r[2 * n]), inv: M2.map((r) => r.slice(n, 2 * n)) };
}

/** stockRows: dagliga {d,c}. series: { [ticker]: veckovisa {d,c} }. */
export function macro(stockRows, series) {
  const s = weekly(stockRows.slice(-1400));
  const fx = FACTORS.filter((f) => series[f.t] && series[f.t].length && (!f.mot || (series[f.mot] && series[f.mot].length)));
  if (!fx.length) return null;
  const maps = {}; for (const k of Object.keys(series)) maps[k] = weekly(series[k] || []);
  const keys = [...s.keys()].filter((k) => fx.every((f) => maps[f.t].has(k) && (!f.mot || maps[f.mot].has(k)))).sort((a, b) => a - b).slice(-261);
  const y = [], X = [];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (b - a !== 7) continue;
    const pct = (m) => (m.get(a) > 0 ? m.get(b) / m.get(a) - 1 : null);
    const row = fx.map((f) => (f.typ === "diff" ? maps[f.t].get(b) - maps[f.t].get(a) : f.typ === "spread" ? (pct(maps[f.t]) ?? NaN) - (pct(maps[f.mot]) ?? NaN) : pct(maps[f.t])));
    const ys = pct(s);
    if (ys == null || row.some((v) => v == null || !isFinite(v)) || Math.abs(ys) > 0.6) continue;
    y.push(ys); X.push(row);
  }
  const n = y.length, k = fx.length;
  if (n < 52) return null;
  // Minsta kvadrat: y = a + Σ b_i x_i
  const Z = X.map((r) => [1, ...r]);
  const ZtZ = Array.from({ length: k + 1 }, (_, i) => Array.from({ length: k + 1 }, (_, j) => Z.reduce((s2, r) => s2 + r[i] * r[j], 0)));
  const Zty = Array.from({ length: k + 1 }, (_, i) => Z.reduce((s2, r, n2) => s2 + r[i] * y[n2], 0));
  const sol = solve(ZtZ, Zty);
  if (!sol) return null;
  const pred = Z.map((r) => r.reduce((s2, v, i) => s2 + v * sol.x[i], 0));
  const ym = avg(y), ssr = y.reduce((s2, v, i) => s2 + (v - pred[i]) ** 2, 0), sst = y.reduce((s2, v) => s2 + (v - ym) ** 2, 0);
  const s2 = ssr / Math.max(1, n - k - 1);
  const faktorer = fx.map((f, i) => {
    const b = sol.x[i + 1], se = Math.sqrt(Math.max(0, s2 * sol.inv[i + 1][i + 1])), tstat = se ? b / se : 0;
    const xs = X.map((r) => r[i]), xm = avg(xs);
    const rörelse = Math.sqrt(avg(xs.map((v) => (v - xm) ** 2))) * Math.sqrt(52); // en typisk årsrörelse
    const effekt = b * rörelse;
    const nivå = Math.abs(tstat) < 2 ? "Ingen tydlig koppling" : Math.abs(effekt) < 0.04 ? "Låg" : Math.abs(effekt) < 0.1 ? "Medel" : "Hög";
    return { id: f.id, namn: f.namn, koefficient: b, rörelse, enhet: f.typ === "diff" ? "procentenheter" : "%", effekt, t: tstat, nivå };
  });
  const tydliga = faktorer.filter((f) => f.nivå !== "Ingen tydlig koppling" && f.id !== "marknad").sort((a, b) => Math.abs(b.effekt) - Math.abs(a.effekt));
  return { faktorer, förklaringsgrad: sst ? 1 - ssr / sst : null, veckor: n, beta: (faktorer.find((f) => f.id === "marknad") || {}).koefficient ?? null, känsligast: tydliga[0] ? tydliga[0].id : null };
}

// ---------------------------------------------------------------------------
// Ägarbetyg: är ägandet ett gott eller dåligt tecken?
// ---------------------------------------------------------------------------
// Varje signal ger -2..+2 poäng. Summan ≥ 2 = Bra, ≤ -2 = Dålig, annars Neutral.

export function ownership(f) {
  const ä = f && f.ägare;
  if (!ä || ä.institutioner == null) return null;
  const inst = clip(ä.institutioner, 0, 1), ins = clip(ä.insiders ?? 0, 0, 1 - inst), små = 1 - inst - ins;
  const pct = (x, d = 0) => `${(x * 100).toFixed(d).replace(".", ",")} %`;
  const plus = [], minus = [];
  const add = (p, text) => (p > 0 ? plus : minus).push({ p, text });

  if (inst >= 0.6) add(1, `Proffsen äger ${pct(inst)}. Många fonder har granskat bolaget och valt att äga det.`);
  else if (inst < 0.3) add(-1, `Proffsen äger bara ${pct(inst)}. Få fonder har valt att äga aktien.`);

  if (ins >= 0.05 && ins <= 0.5) add(1, `Ledningen och grundarna äger ${pct(ins)} – de har egna pengar på spel.`);

  if (små > 0.6) add(-1, `Småsparare äger ${pct(små)}. Kursen kan svänga mycket på nyheter och hype.`);

  const ih = ä.insiderhandel;
  if (ih && ih.netto != null) {
    if (ih.netto >= 0.01) add(ih.netto >= 0.05 ? 2 : 1, `Ledningen har köpt fler aktier än de sålt senaste halvåret (+${pct(ih.netto, 1)} av deras innehav).`);
    else if (ih.netto <= -0.05) add(ih.netto <= -0.2 ? -2 : -1, `Ledningen har sålt mycket aktier senaste halvåret (${pct(ih.netto, 1)} av deras innehav).`);
  }

  // Har de största ägarna ökat eller minskat? (vägt efter hur mycket de äger)
  const ch = (ä.största || []).filter((o) => o.förändring != null && isFinite(o.förändring) && o.andel > 0);
  if (ch.length >= 3) {
    const w = ch.reduce((s, o) => s + o.andel, 0), d = ch.reduce((s, o) => s + o.andel * clip(o.förändring, -1, 1), 0) / w;
    if (d >= 0.02) add(1, `De största ägarna har ökat sina innehav (i snitt +${pct(d, 1)} senaste kvartalet).`);
    else if (d <= -0.02) add(-1, `De största ägarna har minskat sina innehav (i snitt ${pct(d, 1)} senaste kvartalet).`);
  }

  const sh = num(f.blankning);
  if (sh != null) {
    if (sh >= 0.2) add(-2, `Hela ${pct(sh)} av aktierna är blankade – många proffs satsar på att kursen ska falla.`);
    else if (sh >= 0.1) add(-1, `${pct(sh)} av aktierna är blankade – en del proffs satsar på att kursen ska falla.`);
    else if (sh < 0.03) add(0.5, `Få satsar på att kursen ska falla (${pct(sh, 1)} blankat).`);
  }

  const poäng = [...plus, ...minus].reduce((s, x) => s + x.p, 0);
  return {
    betyg: poäng >= 2 ? "Bra" : poäng <= -2 ? "Dålig" : "Neutral", poäng,
    plus: plus.map((x) => x.text), minus: minus.map((x) => x.text),
  };
}

// ---------------------------------------------------------------------------
// Risknivå 1–10 (samma regel som risk_level() i modell.py)
// ---------------------------------------------------------------------------

export const RISK_VOL = [0.15, 0.2, 0.25, 0.3, 0.37, 0.45, 0.55, 0.7, 0.9];
const SKULD_OK = ["Financial Services", "Real Estate", "Utilities"];

export function riskLevel(vol, dd = null, beta = null, loss = false, de = null, mcap = null, sector = null) {
  if (vol == null || !isFinite(vol)) return null;
  let lvl = 1 + RISK_VOL.filter((x) => vol > x).length;
  if (loss) lvl += 1;
  if (dd != null && dd < -0.6) lvl += 1;
  if (de != null && de > 200 && !SKULD_OK.includes(sector)) lvl += 1;
  if (mcap != null && mcap < 2e9) lvl += 1;
  if (!loss && beta != null && beta < 0.6 && dd != null && dd > -0.25) lvl -= 1;
  return clip(lvl, 1, 10);
}

/** Risknivå med förklaring, för aktiesidan. */
export function risk(f, t) {
  f = f || {};
  const loss = f.vinstmarginal != null && f.vinstmarginal < 0;
  const nivå = riskLevel(t.volatilitet, t.max_drawdown_2år, f.beta, loss, f.skuld_eget_kapital, f.börsvärde, f.sektor);
  if (nivå == null) return null;
  const p = (x) => `${Math.round(Math.abs(x) * 100)} %`;
  const skäl = [`Aktien svänger normalt ungefär ±${p(t.volatilitet)} på ett år.`];
  if (loss) skäl.push("Bolaget går med förlust. (+1)");
  if (t.max_drawdown_2år != null && t.max_drawdown_2år < -0.6) skäl.push(`Kursen har rasat ${p(t.max_drawdown_2år)} från toppen de senaste 2 åren. (+1)`);
  if (f.skuld_eget_kapital != null && f.skuld_eget_kapital > 200 && !SKULD_OK.includes(f.sektor)) skäl.push("Bolaget har hög skuld. (+1)");
  if (f.börsvärde != null && f.börsvärde < 2e9) skäl.push("Litet bolag (börsvärde under 2 miljarder dollar). (+1)");
  if (!loss && f.beta != null && f.beta < 0.6 && t.max_drawdown_2år != null && t.max_drawdown_2år > -0.25) skäl.push("Lönsamt bolag som rör sig lugnt även när börsen svänger. (−1)");
  return { nivå, skäl };
}
