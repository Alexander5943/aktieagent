/**
 * Djupanalys av bolagets rapporter – ren matematik, inga nätverksanrop.
 *
 *   parseSeries()  gör om Yahoos rapportdata till rader per år och kvartal
 *   tillvaxt()     tillväxt per år med felmarginal (regression på logaritmen av värdena)
 *   dupont()       delar upp avkastningen på eget kapital i marginal × kapitalomsättning × belåning
 *   piotroski()    F-score 0–9: finansiell styrka (Piotroski 2000)
 *   altman()       Z-score: risk för obestånd (Altman 1968)
 *   beneish()      M-score: varningsflagga för friserad bokföring (Beneish 1999)
 *   dcf()          värde per aktie från framtida kassaflöden, simulerat tusentals gånger (Monte Carlo)
 *   omvandDcf()    vilken tillväxt dagens kurs kräver
 *   djupanalys()   sätter ihop allt
 */

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const ok = (...xs) => xs.every((x) => x != null && isFinite(x));
const div = (a, b) => (ok(a, b) && b !== 0 ? a / b : null);

// Yahoos namn -> korta namn
export const FALT = {
  oms: "TotalRevenue", kost: "CostOfRevenue", brutto: "GrossProfit", ror: "OperatingIncome", ebit: "EBIT", res: "NetIncome",
  eps: "DilutedEPS", aktier: "DilutedAverageShares", sga: "SellingGeneralAndAdministration", fou: "ResearchAndDevelopment",
  cfo: "OperatingCashFlow", capex: "CapitalExpenditure", fcf: "FreeCashFlow", avskr: "DepreciationAndAmortization",
  sbc: "StockBasedCompensation", aterkop: "RepurchaseOfCapitalStock", utd: "CashDividendsPaid",
  tillg: "TotalAssets", oms_tillg: "CurrentAssets", kort_skuld: "CurrentLiabilities", skulder: "TotalLiabilitiesNetMinorityInterest",
  ek: "StockholdersEquity", balanserat: "RetainedEarnings", lan: "TotalDebt", langa: "LongTermDebt",
  kassa: "CashCashEquivalentsAndShortTermInvestments", cfo2: "CashFlowFromContinuingOperatingActivities", kundf: "AccountsReceivable", lager: "Inventory", ppe: "NetPPE", antal: "OrdinarySharesNumber",
};
const KVARTAL = ["oms", "ror", "res", "eps", "cfo", "capex", "fcf", "sbc"];
export const TYPER = [...Object.values(FALT).map((x) => "annual" + x), ...KVARTAL.map((k) => "quarterly" + FALT[k])];

export function parseSeries(d) {
  const res = (d && d.timeseries && d.timeseries.result) || [];
  const rader = { annual: new Map(), quarterly: new Map() };
  let valuta = null;
  for (const [kort, namn] of Object.entries(FALT)) {
    for (const per of ["annual", "quarterly"]) {
      const typ = per + namn;
      const r = res.find((x) => x.meta && x.meta.type && x.meta.type[0] === typ);
      for (const x of (r && r[typ]) || []) {
        if (!x || !x.asOfDate || !x.reportedValue || !isFinite(x.reportedValue.raw)) continue;
        if (!rader[per].has(x.asOfDate)) rader[per].set(x.asOfDate, { d: x.asOfDate });
        rader[per].get(x.asOfDate)[kort] = x.reportedValue.raw;
        if (x.currencyCode && kort === "oms") valuta = x.currencyCode;
      }
    }
  }
  const sort = (m) => [...m.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  return { år: sort(rader.annual).filter((y) => ok(y.oms) || ok(y.res)), kv: sort(rader.quarterly), valuta };
}

// ---------------------------------------------------------------------------
// Tillväxt med felmarginal
// ---------------------------------------------------------------------------
const T80 = [null, 3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397];   // t-fördelningens 90:e percentil per frihetsgrad

/** Tillväxt per år: rät linje genom ln(värde) mot år (minsta kvadrat). Lutningen är tillväxten. 80 % intervall från linjens osäkerhet. */
export function tillvaxt(vals) {
  const v = vals.filter((x) => ok(x));
  if (v.length < 3 || v.some((x) => x <= 0)) return null;
  const n = v.length, y = v.map(Math.log), mx = (n - 1) / 2, my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  y.forEach((yi, i) => { sxx += (i - mx) ** 2; sxy += (i - mx) * (yi - my); });
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0, sst = 0;
  y.forEach((yi, i) => { sse += (yi - a - b * i) ** 2; sst += (yi - my) ** 2; });
  const se = Math.sqrt(sse / (n - 2) / sxx), t = T80[Math.min(n - 2, 8)];
  return { per_år: Math.exp(b) - 1, låg: Math.exp(b - t * se) - 1, hög: Math.exp(b + t * se) - 1, r2: sst > 0 ? 1 - sse / sst : 1, år: n, se };
}

// ---------------------------------------------------------------------------
// DuPont, Piotroski, Altman, Beneish
// ---------------------------------------------------------------------------
export function dupont(y) {
  const marginal = div(y.res, y.oms), omsattning = div(y.oms, y.tillg), belaning = div(y.tillg, y.ek);
  if (!ok(marginal, omsattning, belaning) || y.ek <= 0) return null;
  return { d: y.d, marginal, omsättning: omsattning, belåning: belaning, roe: marginal * omsattning * belaning };
}

export function piotroski(y1, y0) {
  if (!y1 || !y0) return null;
  const roa1 = div(y1.res, y1.tillg), roa0 = div(y0.res, y0.tillg);
  const t = (namn, v, text) => ({ namn, ok: v, text });
  const st = (a, b, f) => (ok(a, b) ? f(a, b) : null);
  const test = [
    t("Går med vinst", ok(y1.res) ? y1.res > 0 : null, "Årets resultat är positivt."),
    t("Pengar kommer in", ok(y1.cfo) ? y1.cfo > 0 : null, "Verksamheten ger mer pengar än den gör av med."),
    t("Lönsamheten ökar", st(roa1, roa0, (a, b) => a > b), "Vinst i förhållande till tillgångarna är högre än förra året."),
    t("Vinsten är riktiga pengar", st(y1.cfo, y1.res, (a, b) => a > b), "Kassaflödet är större än den bokförda vinsten."),
    t("Lägre långa skulder", st(div(y1.langa ?? 0, y1.tillg), div(y0.langa ?? 0, y0.tillg), (a, b) => a <= b), "Långa lån i förhållande till tillgångarna har inte ökat."),
    t("Bättre betalningsförmåga", st(div(y1.oms_tillg, y1.kort_skuld), div(y0.oms_tillg, y0.kort_skuld), (a, b) => a > b), "Mer omsättningstillgångar per krona korta skulder."),
    t("Inga nya aktier", st(y1.antal ?? y1.aktier, y0.antal ?? y0.aktier, (a, b) => a <= b * 1.01), "Ägarna har inte spätts ut."),
    t("Högre bruttomarginal", st(div(y1.brutto, y1.oms), div(y0.brutto, y0.oms), (a, b) => a > b), "Mer blir över av varje såld krona."),
    t("Effektivare tillgångar", st(div(y1.oms, y1.tillg), div(y0.oms, y0.tillg), (a, b) => a > b), "Mer försäljning per krona tillgångar."),
  ];
  const med = test.filter((x) => x.ok != null);
  if (med.length < 7) return null;
  const poang = med.filter((x) => x.ok).length;
  // Räknas om till skalan 0–9 om något test saknar data
  const p9 = Math.round((poang / med.length) * 9);
  return { poäng: poang, av: med.length, nivå: p9 >= 7 ? "stark" : p9 >= 4 ? "okej" : "svag", test, år: y1.d.slice(0, 4) };
}

const FINANS = /Financial|Real Estate/i;

export function altman(y, borsvarde, sektor) {
  if (!y || FINANS.test(sektor || "")) return null;
  const x1 = div(y.oms_tillg - y.kort_skuld, y.tillg), x2 = div(y.balanserat, y.tillg), x3 = div(y.ebit ?? y.ror, y.tillg);
  const x4 = div(borsvarde, y.skulder), x5 = div(y.oms, y.tillg);
  if (!ok(x1, x2, x3, x4, x5) || !ok(y.oms_tillg, y.kort_skuld)) return null;
  const z = 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * Math.min(x4, 20) + 1.0 * x5;   // börsvärdets del begränsas så att den inte dränker resten
  return { z, nivå: z > 2.99 ? "trygg" : z >= 1.81 ? "gråzon" : "risk", delar: { rörelsekapital: x1, sparad_vinst: x2, rörelseresultat: x3, börsvärde_mot_skulder: x4, försäljning: x5 } };
}

export function beneish(y1, y0, sektor) {
  if (!y1 || !y0 || FINANS.test(sektor || "")) return null;
  const k = (a, b) => { const q = div(a, b); return ok(q) && q > 0 ? q : null; };
  const dsri = k(div(y1.kundf, y1.oms), div(y0.kundf, y0.oms));
  const gmi = k(div(y0.brutto, y0.oms), div(y1.brutto, y1.oms));
  const aq = (y) => (ok(y.oms_tillg, y.ppe, y.tillg) ? 1 - (y.oms_tillg + y.ppe) / y.tillg : null);
  const aqi = k(aq(y1), aq(y0));
  const sgi = k(y1.oms, y0.oms);
  const dep = (y) => div(y.avskr, ok(y.avskr, y.ppe) ? y.avskr + y.ppe : null);
  const depi = k(dep(y0), dep(y1));
  const sgai = k(div(y1.sga, y1.oms), div(y0.sga, y0.oms));
  const lev = (y) => div((y.langa ?? 0) + y.kort_skuld, y.tillg);
  const lvgi = k(lev(y1), lev(y0));
  const tata = div(y1.res - y1.cfo, y1.tillg);
  if (!ok(dsri, sgi, tata)) return null;
  const n = (x) => (x == null ? 1 : clip(x, 0.2, 5));   // saknas en del räknas den som oförändrad (1)
  const m = -4.84 + 0.92 * n(dsri) + 0.528 * n(gmi) + 0.404 * n(aqi) + 0.892 * n(sgi) + 0.115 * n(depi) - 0.172 * n(sgai) + 4.679 * tata - 0.327 * n(lvgi);
  return { m, flagga: m > -1.78, delar: { kundfordringar: dsri, bruttomarginal: gmi, tillgångskvalitet: aqi, försäljningstillväxt: sgi, avskrivningar: depi, omkostnader: sgai, periodiseringar: tata, belåning: lvgi } };
}

// ---------------------------------------------------------------------------
// Kassaflödesvärdering med simulering
// ---------------------------------------------------------------------------
function slump(seed) {   // mulberry32 + Box–Muller: samma aktie ger samma slumptal, så att siffran inte hoppar
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}

export const DCF_ÅR = 10;

/** Värdet idag av alla framtida kassaflöden. Tillväxten g avtar rakt ner mot den eviga tillväxten gT under 10 år. */
export function nuvarde(fcf0, g, r, gT) {
  let f = fcf0, v = 0;
  for (let k = 1; k <= DCF_ÅR; k++) {
    f *= 1 + (g + ((gT - g) * (k - 1)) / (DCF_ÅR - 1));
    v += f / (1 + r) ** k;
  }
  return v + (f * (1 + gT)) / (r - gT) / (1 + r) ** DCF_ÅR;
}

const kvantil = (s, q) => { const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };

/**
 * in_: { fcf0, g, sg, r, sr, gT, sgT, nettokassa, aktier, pris, seed, n }
 * Varje simulering drar en egen tillväxt, ett eget avkastningskrav och en egen evig tillväxt ur normalfördelningar.
 */
export function dcf(in_) {
  const { fcf0, g, sg, r, sr, gT = 0.025, sgT = 0.005, nettokassa = 0, aktier, pris, seed = "x", n = 4000 } = in_;
  if (!ok(fcf0, g, r, aktier) || fcf0 <= 0 || aktier <= 0) return null;
  const z = slump(seed), ut = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gi = clip(g + sg * z(), -0.15, 0.5), ti = clip(gT + sgT * z(), 0.01, 0.035), ri = Math.max(clip(r + sr * z(), 0.06, 0.16), ti + 0.03);
    ut[i] = Math.max(0, (nuvarde(fcf0, gi, ri, ti) + nettokassa) / aktier);
  }
  const s = Array.from(ut).sort((a, b) => a - b);
  const lo = kvantil(s, 0.02), hi = kvantil(s, 0.98), B = 24, hist = new Array(B).fill(0);
  for (const x of s) if (x >= lo && x <= hi) hist[Math.min(B - 1, Math.floor(((x - lo) / (hi - lo || 1)) * B))]++;
  const mitt = (nuvarde(fcf0, g, r, gT) + nettokassa) / aktier;
  const kans = (a, b) => (nuvarde(fcf0, a, b, gT) + nettokassa) / aktier;
  return {
    median: kvantil(s, 0.5), p10: kvantil(s, 0.1), p25: kvantil(s, 0.25), p75: kvantil(s, 0.75), p90: kvantil(s, 0.9), mitt,
    sannolikhet: ok(pris) ? s.filter((x) => x > pris).length / n : null,
    hist: { från: lo, till: hi, antal: hist },
    känslighet: { tillväxt: [g - sg, g, g + sg], krav: [r - 0.01, r, r + 0.01], värde: [g - sg, g, g + sg].map((a) => [r - 0.01, r, r + 0.01].map((b) => kans(a, Math.max(b, gT + 0.03)))) },
    antal: n,
  };
}

/** Vilken tillväxt i kassaflödet (första året, sedan avtagande) som gör att värdet blir lika med dagens kurs. Halveringssökning. */
export function omvandDcf(fcf0, r, gT, nettokassa, aktier, pris) {
  if (!ok(fcf0, r, aktier, pris) || fcf0 <= 0 || pris <= 0) return null;
  const f = (g) => (nuvarde(fcf0, g, r, gT) + nettokassa) / aktier - pris;
  let lo = -0.3, hi = 1.0;
  if (f(lo) > 0) return { g: lo, under: true };
  if (f(hi) < 0) return { g: hi, över: true };
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
  return { g: (lo + hi) / 2 };
}

// ---------------------------------------------------------------------------
// Allt tillsammans
// ---------------------------------------------------------------------------
/**
 * serier  från parseSeries()
 * f       nyckeltal (börsvärde, beta, sektor, valuta, omsättningstillväxt_nästa_år …)
 * pris    dagens kurs
 * ranta   USA:s 10-åriga statsränta som decimaltal (t.ex. 0.043)
 */
export function djupanalys(serier, f, pris, ranta, t = "") {
  f = f || {};
  const ar = serier.år, kv = serier.kv, y1 = ar.at(-1), y0 = ar.at(-2);
  if (!y1) return { saknas: true };
  // Totala skulder saknas ibland hos Yahoo: då är de tillgångar minus eget kapital
  for (const y of [...ar, ...kv]) if (y.cfo == null && y.cfo2 != null) y.cfo = y.cfo2;
  for (const y of ar) if (y.skulder == null && ok(y.tillg, y.ek)) y.skulder = y.tillg - y.ek;
  const sammaValuta = !serier.valuta || !f.valuta || serier.valuta === f.valuta;
  const sum4 = (k) => { const q = kv.slice(-4); return q.length === 4 && q.every((x) => ok(x[k])) ? q.reduce((a, x) => a + x[k], 0) : null; };
  // Senaste 12 månaderna (fyra kvartal) om de finns, annars senaste året
  const tolv = { oms: sum4("oms") ?? y1.oms, res: sum4("res") ?? y1.res, fcf: sum4("fcf") ?? y1.fcf, sbc: sum4("sbc") ?? y1.sbc ?? 0, cfo: sum4("cfo") ?? y1.cfo };

  const tabell = ar.slice(-5).map((y) => ({
    d: y.d, oms: y.oms ?? null, brutto: y.brutto ?? null, ror: y.ror ?? null, res: y.res ?? null, eps: y.eps ?? null, fcf: y.fcf ?? null,
    bruttomarginal: div(y.brutto, y.oms), rörelsemarginal: div(y.ror, y.oms), vinstmarginal: div(y.res, y.oms), fcf_marginal: div(y.fcf, y.oms),
  }));
  const tv = { omsättning: tillvaxt(ar.map((y) => y.oms)), vinst: tillvaxt(ar.map((y) => y.res)), kassaflöde: tillvaxt(ar.map((y) => y.fcf)) };
  // Senaste kvartalet mot samma kvartal året före
  const kvt = kv.length >= 5 && ok(kv.at(-1).oms, kv.at(-5).oms) && kv.at(-5).oms > 0 ? kv.at(-1).oms / kv.at(-5).oms - 1 : null;

  const kvalitet = ok(y1.res, y1.cfo, y1.tillg) ? { periodisering: (y1.res - y1.cfo) / y1.tillg, kassa_per_vinstkrona: y1.res > 0 ? y1.cfo / y1.res : null,
    sbc_andel: ok(y1.sbc, y1.oms) && y1.oms > 0 ? y1.sbc / y1.oms : null } : null;
  const antalNu = y1.antal ?? y1.aktier, antalFore = ar[0].antal ?? ar[0].aktier;
  const aktier = { nu: antalNu ?? null, förändring_per_år: ok(antalNu, antalFore) && ar.length > 1 && antalFore > 0 ? (antalNu / antalFore) ** (1 / (ar.length - 1)) - 1 : null,
    återköp: y1.aterkop != null ? Math.abs(y1.aterkop) : null, utdelning: y1.utd != null ? Math.abs(y1.utd) : null };

  // --- Kassaflödesvärdering ---
  let varde = null;
  const beta = clip(0.67 * (ok(f.beta) ? f.beta : 1) + 0.33, 0.6, 2.0);       // beta dras mot 1 (Blumes justering)
  const rf = ok(ranta) ? clip(ranta, 0.02, 0.07) : 0.043, premie = 0.045;
  const r = clip(rf + beta * premie, 0.065, 0.14);                             // avkastningskrav enligt CAPM
  const agar = ok(tolv.fcf) ? tolv.fcf - (tolv.sbc || 0) : null;               // kassaflöde efter att aktielöner räknats som kostnad
  const antal = y1.aktier ?? y1.antal ?? (ok(f.börsvärde, pris) && pris > 0 ? f.börsvärde / pris : null);
  const netto = (y1.kassa ?? 0) - (y1.lan ?? 0);
  const finans = FINANS.test(f.sektor || "");
  if (finans) varde = { saknas: "Kassaflödesvärdering fungerar inte för banker, försäkringsbolag och fastighetsbolag. Deras kassaflöden styrs av in- och utlåning, inte av vinsten." };
  else if (!sammaValuta) varde = { saknas: `Bolaget redovisar i ${serier.valuta} men aktien handlas i ${f.valuta}. Värdet per aktie kan därför inte räknas här.` };
  else if (!ok(agar, antal)) varde = { saknas: "Kassaflödet saknas i rapportdatan." };
  else if (agar <= 0) varde = { saknas: "Bolaget gör av med mer pengar än det tjänar (negativt kassaflöde efter aktielöner). Då går värdet inte att räkna från dagens kassaflöde – det hänger helt på framtida vinster." };
  else {
    // Förväntad tillväxt: snittet av analytikernas prognos och den historiska takten, dämpat mot rimliga gränser
    const kallor = [f.omsättningstillväxt_nästa_år, tv.omsättning && tv.omsättning.per_år, kvt].filter((x) => ok(x));
    const g = clip(kallor.length ? kallor.reduce((a, b) => a + b, 0) / kallor.length : 0.05, -0.05, 0.3);
    const sg = clip(0.03 + 0.35 * Math.abs(g) + (kallor.length > 1 ? (Math.max(...kallor) - Math.min(...kallor)) / 4 : 0.02), 0.03, 0.15);
    const sim = dcf({ fcf0: agar, g, sg, r, sr: 0.01, nettokassa: netto, aktier: antal, pris, seed: t + ":" + y1.d });
    varde = { ...sim, kräver: omvandDcf(agar, r, 0.025, netto, antal, pris),
      antaganden: { kassaflöde: agar, tillväxt: g, tillväxt_osäkerhet: sg, krav: r, ränta: rf, beta, riskpremie: premie, evig_tillväxt: 0.025, nettokassa: netto, aktier: antal } };
  }

  const F = piotroski(y1, y0);
  const Z = sammaValuta ? altman(y1, f.börsvärde, f.sektor) : null;
  const M = beneish(y1, y0, f.sektor);
  // Samlat omdöme om den finansiella hälsan
  const plus = [], minus = [];
  if (F) (F.nivå === "stark" ? plus : F.nivå === "svag" ? minus : []).push(`Finansiell styrka ${F.poäng} av ${F.av}`);
  if (Z) (Z.nivå === "trygg" ? plus : Z.nivå === "risk" ? minus : []).push(Z.nivå === "trygg" ? "Låg risk för obestånd" : "Förhöjd risk för obestånd");
  if (M && M.flagga) minus.push("Bokföringen har varningstecken");
  if (!finans && kvalitet && kvalitet.kassa_per_vinstkrona != null) (kvalitet.kassa_per_vinstkrona >= 1 ? plus : kvalitet.kassa_per_vinstkrona < 0.6 ? minus : []).push(kvalitet.kassa_per_vinstkrona >= 1 ? "Vinsten blir riktiga pengar" : "Vinsten blir inte pengar i kassan");
  const halsa = minus.length >= 2 || (Z && Z.nivå === "risk") ? "Svag" : plus.length >= 2 && !minus.length ? "Stark" : "Okej";

  return {
    senaste_år: y1.d, valuta: serier.valuta || f.valuta || null, samma_valuta: sammaValuta, tolv,
    tabell, tillväxt: { ...tv, senaste_kvartal: kvt },
    dupont: ar.slice(-4).map(dupont).filter(Boolean),
    styrka: F, obestånd: Z, bokföring: M, kvalitet, aktier, värde: varde,
    hälsa: { betyg: halsa, plus, minus },
    finans,
    saknar: Object.keys(FALT).filter((k) => k !== "cfo2" && y1[k] == null).concat(ok(f.börsvärde) ? [] : ["börsvärde"]),
  };
}
