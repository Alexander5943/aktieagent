// Kör: node test/test.mjs
import assert from "node:assert/strict";
import { installMocks, makeEnv, ctx, calls } from "./mock.mjs";

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("OK  ", name); } catch (e) { failed++; console.log("FEL ", name, "\n     ", e.message); }
}

installMocks();
const worker = (await import("../src/index.js")).default;
const call = (env, path, opts = {}) => worker.fetch(new Request("https://w.dev" + path, {
  method: opts.method || "GET", headers: { "X-App-Key": opts.key ?? "hemlig", "Content-Type": "application/json" },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}), env, ctx);

await test("fel app-kod ger 401", async () => {
  const r = await call(makeEnv(), "/api/ping", { key: "fel" });
  assert.equal(r.status, 401);
});

await test("för många fel app-koder spärrar i en timme, rätt kod fungerar från annan adress", async () => {
  const env = makeEnv();
  const from = (ip, key) => worker.fetch(new Request("https://w.dev/api/ping", { headers: { "X-App-Key": key, "CF-Connecting-IP": ip } }), env, ctx);
  for (let i = 0; i < 10; i++) assert.equal((await from("1.2.3.4", "gissning" + i)).status, 401);
  assert.equal((await from("1.2.3.4", "hemlig")).status, 429, "spärrad även med rätt kod");
  assert.equal((await from("5.6.7.8", "hemlig")).status, 200, "andra adresser påverkas inte");
  assert.equal((await from("5.6.7.8", "hemli")).status, 401, "nästan rätt räcker inte");
  const ping = await (await from("5.6.7.8", "hemlig")).json();
  assert.equal(ping.svagKod, true, "kort kod flaggas");
});

await test("ping och CORS", async () => {
  const r = await call(makeEnv(), "/api/ping");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
});

await test("sök hittar NVIDIA", async () => {
  const d = await (await call(makeEnv(), "/api/search?q=nvid")).json();
  assert.equal(d.results[0].t, "NVDA");
});

await test("aktiedata: historik, nyckeltal, poäng, förväntad avkastning, rapporter, nyheter", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=nvda")).json();
  assert.equal(d.t, "NVDA");
  assert.ok(d.historik.length > 1000, "5 år historik");
  assert.equal(d.nyckeltal.forward_pe, 28);
  assert.ok(Math.abs(d.nyckeltal.vinsttillväxt_nästa_år - 0.36) < 1e-9);
  assert.ok(d.poäng.total > 0 && d.poäng.total <= 100);
  assert.equal(d.poäng.datatäckning, 5);
  assert.ok(d.förväntad.förväntad != null && "analytiker" in d.förväntad.delar);
  assert.equal(d.rapporter.kvartal.length, 8);
  assert.ok(d.nyheter.length >= 1);
  assert.ok(d.teknik.rsi14 >= 0 && d.teknik.rsi14 <= 100);
});

await test("förväntad avkastning 1, 3, 5 och 10 år med kursmål", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=NVDA")).json();
  const h = d.horisonter;
  assert.deepEqual(h.rader.map((r) => r.år), [1, 3, 5, 10]);
  for (const r of h.rader) {
    assert.ok(Math.abs((1 + r.årlig) ** r.år - 1 - r.total) < 1e-9, "total stämmer med årlig");
    assert.ok(r.låg < r.kurs && r.kurs < r.hög, "kursmål ligger i spannet");
    assert.ok(r.årlig >= -0.5 && r.årlig <= 1);
  }
  assert.ok(Math.abs(h.rader[0].årlig - d.förväntad.förväntad) < 1e-9, "1 år = 12-månadersmodellen");
  assert.ok(d.historik.length > 2400, "10 år historik");
});

await test("värdering: rimligt värde, läge och inprisad tillväxt", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=NVDA")).json();
  const v = d.värdering;
  assert.ok(v.rimligt > 0);
  assert.ok(Math.abs(d.teknik.kurs / v.rimligt - 1 - v.gap) < 1e-9);
  assert.ok(["Kraftigt undervärderad", "Undervärderad", "Rimligt värderad", "Övervärderad", "Kraftigt övervärderad"].includes(v.läge));
  assert.ok(v.inprisat.tillväxt > -0.3 && v.inprisat.tillväxt < 0.9);
  // Högre kurs ska kräva högre tillväxt
  const tab = v.inprisat.tabell;
  assert.ok(tab.length > 10);
  for (let i = 1; i < tab.length; i++) assert.ok(tab[i][1] >= tab[i - 1][1] - 1e-6, "tabellen stiger");
  assert.ok(d.hype.poäng >= 0 && d.hype.poäng <= 100);
});

await test("bolagsinfo: VD, anställda, ägare", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=NVDA")).json();
  assert.equal(d.nyckeltal.vd, "Jane Doe");
  assert.equal(d.nyckeltal.anställda, 36000);
  assert.equal(d.nyckeltal.ägare.största[0].namn, "Vanguard Group Inc");
  assert.ok(Math.abs(d.nyckeltal.ägare.institutioner - 0.68) < 1e-9);
});

await test("säsong: hittar mönstret i en aktie som stiger i november och faller i september", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=SEAS")).json();
  const s = d.säsong;
  assert.equal(s.månader.length, 12);
  assert.equal(s.bästa[0], 11, "november bäst");
  assert.equal(s.sämsta[0], 9, "september sämst");
  assert.ok([9, 10].includes(s.strategi.köp_efter), "köp efter september/oktober, var " + s.strategi.köp_efter);
  assert.ok(s.strategi.snitt > 0.03 && s.strategi.andel_rätt >= 0.75, "strategin lönar sig");
  assert.ok(s.år.length >= 9 && s.år[0].r.length === 12);
});

await test("makrokänslighet: hittar beta mot börsen", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=NVDA")).json();
  const m = d.makro;
  assert.ok(m && m.veckor > 150, "minst 150 veckor, var " + (m && m.veckor));
  assert.ok(Math.abs(m.beta - 1.3) < 0.2, "beta nära 1,3, var " + m.beta);
  assert.deepEqual(m.faktorer.map((f) => f.id), ["marknad", "ranta", "dollar", "olja", "inflation"]);
  const r = m.faktorer.find((f) => f.id === "ranta");
  assert.equal(r.enhet, "procentenheter");
  assert.ok(m.förklaringsgrad > 0.3 && m.förklaringsgrad < 1);
});

await test("ägarbetyg: bra, neutral och dålig ägarbild", async () => {
  const { ownership } = await import("../src/analys.js");
  const d = await (await call(makeEnv(), "/api/stock?t=NVDA")).json();
  // Testaktien: 68 % institutioner (+1), storägarna ökar (+1), lite blankning 1 % (+0,5), insiders säljer bara lite (0)
  assert.equal(d.ägarbetyg.betyg, "Bra");
  assert.equal(d.ägarbetyg.poäng, 2.5);
  assert.equal(d.nyckeltal.ägare.insiderhandel.netto, -0.03);
  const bra = ownership({ blankning: 0.01, ägare: { institutioner: 0.75, insiders: 0.12, insiderhandel: { netto: 0.06 }, största: [] } });
  assert.equal(bra.betyg, "Bra"); assert.equal(bra.minus.length, 0);
  const dålig = ownership({ blankning: 0.25, ägare: { institutioner: 0.2, insiders: 0.01, insiderhandel: { netto: -0.3 },
    största: [{ andel: 0.05, förändring: -0.1 }, { andel: 0.04, förändring: -0.05 }, { andel: 0.03, förändring: -0.02 }] } });
  assert.equal(dålig.betyg, "Dålig"); assert.equal(dålig.plus.length, 0);
  assert.ok(dålig.minus.some((t) => t.includes("blankade")) && dålig.minus.some((t) => t.includes("Småsparare")));
  assert.equal(ownership({ ägare: { institutioner: 0.45, insiders: 0.02, största: [] } }).betyg, "Neutral");
  assert.equal(ownership({ ägare: { insiders: 0.3, största: [] } }), null, "utan institutionernas andel blir det inget betyg");
  assert.equal(ownership({ ägare: { institutioner: 1.4, insiders: 0.1, största: [] } }).betyg, "Neutral", "över 100 % kapas");
});

await test("risknivå på aktiesidan", async () => {
  const d = await (await call(makeEnv(), "/api/stock?t=NVDA")).json();
  assert.ok(d.risk.nivå >= 1 && d.risk.nivå <= 10);
  assert.ok(d.risk.skäl[0].includes("svänger"));
  const s = await (await call(makeEnv(), "/api/stock?t=SEAS")).json();
  assert.ok(s.risk.nivå < d.risk.nivå, `lugn aktie (${s.risk.nivå}) under volatil (${d.risk.nivå})`);
});

await test("okänd ticker ger 404", async () => {
  const r = await call(makeEnv(), "/api/stock?t=NOPE");
  assert.equal(r.status, 404);
});

await test("ogiltig ticker ger 400", async () => {
  const r = await call(makeEnv(), "/api/stock?t=" + encodeURIComponent("<script>"));
  assert.equal(r.status, 400);
});

await test("snabbkurser för bevakningslistan", async () => {
  const d = await (await call(makeEnv(), "/api/quotes?symbols=NVDA,AAPL")).json();
  assert.equal(d.quotes.length, 2);
  assert.ok(d.quotes[0].spark.length > 10 && d.quotes[0].pris > 0);
});

await test("bevakningslista: lägg till, inga dubbletter, ta bort", async () => {
  const env = makeEnv();
  assert.deepEqual(await (await call(env, "/api/watchlist")).json(), []);
  await call(env, "/api/watchlist", { method: "POST", body: { action: "add", t: "nvda", namn: "NVIDIA" } });
  await call(env, "/api/watchlist", { method: "POST", body: { action: "add", t: "NVDA", namn: "NVIDIA" } });
  let l = await (await call(env, "/api/watchlist", { method: "POST", body: { action: "add", t: "MU", namn: "Micron" } })).json();
  assert.deepEqual(l.map((x) => x.t), ["NVDA", "MU"]);
  l = await (await call(env, "/api/watchlist", { method: "POST", body: { action: "remove", t: "NVDA" } })).json();
  assert.deepEqual(l.map((x) => x.t), ["MU"]);
});

await test("AI-analys: betyg, svenska fältnamn tillbaka, källor, cache", async () => {
  const env = makeEnv();
  assert.equal((await (await call(env, "/api/ai?t=NVDA")).json()).saknas, true);
  const n0 = calls.filter((u) => u.includes("anthropic")).length;
  const a = await (await call(env, "/api/ai?t=NVDA", { method: "POST" })).json();
  assert.equal(a.betyg, "Köpvärd");
  assert.equal(a.säkerhet, "Medel");
  assert.ok(a.värdering.includes("P/E"));
  assert.equal(a.värderingsläge, "Rimligt värderad");
  assert.ok(a.idé && a.mål && a.hype && a.inprisat);
  assert.equal(a.kontrakt.length, 1);
  assert.equal(a.källor[0].länk, "https://investor.example.com/q2-2026");
  await call(env, "/api/ai?t=NVDA", { method: "POST" }); // ska komma från cachen
  assert.equal(calls.filter((u) => u.includes("anthropic")).length, n0 + 1, "andra anropet ska inte kosta");
  const g = await (await call(env, "/api/ai?t=NVDA")).json();
  assert.equal(g.betyg, "Köpvärd");
});

await test("AI: pause_turn hanteras", async () => {
  installMocks({ claudeMode: "pause" });
  const a = await (await call(makeEnv(), "/api/ai?t=MU", { method: "POST" })).json();
  assert.equal(a.betyg, "Köpvärd");
});

await test("AI: slut på krediter ger tydligt meddelande", async () => {
  installMocks({ claudeMode: "nocredit" });
  const r = await call(makeEnv(), "/api/ai?t=AAPL", { method: "POST" });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Krediterna är slut/);
});

await test("AI: dagsgräns", async () => {
  installMocks();
  const env = makeEnv({ AI_DAILY_LIMIT: "1" });
  await call(env, "/api/ai?t=AAPL", { method: "POST" });
  const r = await call(env, "/api/ai?t=MSFT", { method: "POST" });
  assert.equal(r.status, 429);
});

await test("AI avstängd: inga anrop till Claude", async () => {
  installMocks();
  const env = makeEnv({ AI_AV: "1" });
  const n = calls.filter((u) => u.includes("anthropic")).length;
  assert.equal((await call(env, "/api/ai?t=AAPL", { method: "POST" })).status, 403);
  assert.notEqual((await call(env, "/api/portfolio/advice", { method: "POST", body: { innehav: [{ t: "NVDA", andel: 1 }] } })).status, 200);
  assert.equal(calls.filter((u) => u.includes("anthropic")).length, n);
  assert.equal((await (await call(env, "/api/ping")).json()).aiAv, true);
});

await test("portfölj: lägg till, ändra, ta bort, felaktiga värden", async () => {
  installMocks();
  const env = makeEnv();
  assert.deepEqual(await (await call(env, "/api/portfolio")).json(), []);
  await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "nvda", namn: "NVIDIA", antal: 10, gav: 120 } });
  let l = await (await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "NVDA", antal: 15, gav: 110 } })).json();
  assert.equal(l.length, 1); assert.equal(l[0].antal, 15); assert.equal(l[0].namn, "NVDA");
  let r = await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "MU", antal: -1, gav: 10 } });
  assert.equal(r.status, 400);
  r = await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "MU", antal: 5, gav: "abc" } });
  assert.equal(r.status, 400);
  l = await (await call(env, "/api/portfolio", { method: "POST", body: { action: "remove", t: "NVDA" } })).json();
  assert.deepEqual(l, []);
});

await test("signal: det viktigaste om en aktie i liten form", async () => {
  const d = await (await call(makeEnv(), "/api/signal?t=NVDA")).json();
  assert.equal(d.t, "NVDA");
  assert.ok(d.horisonter["3"].årlig != null && d.horisonter["10"].kurs > 0);
  assert.ok(d.värdering.läge && d.hype.poäng >= 0 && d.poäng > 0);
  assert.ok(JSON.stringify(d).length < 2000, "liten nog");
});

await test("AI-råd för portföljen: bara alternativ ur listan, bara egna innehav, sparas", async () => {
  installMocks();
  const env = makeEnv();
  assert.equal((await call(env, "/api/portfolio/advice", { method: "POST", body: {} })).status, 400, "tom portfölj");
  await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "NVDA", antal: 10, gav: 100 } });
  await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "MU", antal: 20, gav: 90 } });
  const sigs = [await (await call(env, "/api/signal?t=NVDA")).json(), await (await call(env, "/api/signal?t=MU")).json()];
  const kand = [{ t: "MSFT", namn: "Microsoft", årlig_3år: 0.14, lista: "1–3 år" }, { t: "NVDA", namn: "NVIDIA", årlig_3år: 0.2 }, { t: "<x>", namn: "hack" }];
  const a = await (await call(env, "/api/portfolio/advice", { method: "POST", body: { signaler: sigs, kandidater: kand } })).json();
  assert.equal(a.innehav.length, 2, "ZZZZ ägs inte och tas bort");
  const mu = a.innehav.find((x) => x.t === "MU");
  assert.equal(mu.råd, "Sälj");
  assert.deepEqual(mu.alternativ.map((x) => x.t), ["MSFT"], "bara kandidater som inte redan ägs");
  assert.equal(a.kandidater[0].ticker, "MSFT");
  assert.ok(Math.abs(a.efter - 0.11) < 1e-9);
  assert.ok(!globalThis.lastAdvicePrompt.includes("<x>"), "ogiltig ticker skickas inte till AI:n");
  assert.ok(globalThis.lastAdvicePrompt.includes("\"andel\""));
  const g = await (await call(env, "/api/portfolio/advice")).json();
  assert.equal(g.portfölj, "MU::20,NVDA::10");
});

await test("AI-råd: svarar AI:n med text först så frågar vi igen", async () => {
  installMocks({ claudeMode: "textfirst" });
  const env = makeEnv();
  await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "NVDA", antal: 1, gav: 100 } });
  const a = await (await call(env, "/api/portfolio/advice", { method: "POST", body: {} })).json();
  assert.ok(a.sammanfattning.length > 0);
});

await test("portfölj med andelar i procent: sparas, valideras, vägs rätt", async () => {
  installMocks();
  const env = makeEnv();
  for (const [t, andel] of [["NVDA", 50], ["MU", 25], ["AVGO", 15], ["AAPL", 10]]) {
    const r = await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t, andel } });
    assert.equal(r.status, 200, t);
  }
  const l = await (await call(env, "/api/portfolio")).json();
  assert.deepEqual(l.map((x) => x.andel), [50, 25, 15, 10]);
  assert.equal(l[0].antal, null);
  assert.equal((await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "MSFT", andel: 120 } })).status, 400, "över 100 %");
  assert.equal((await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "MSFT" } })).status, 400, "varken andel eller antal");
  assert.equal((await call(env, "/api/portfolio", { method: "POST", body: { action: "set", t: "MSFT", antal: 5 } })).status, 400, "antal utan köpkurs");
  // AI-rådet får rätt andelar och en exakt viktad förväntad avkastning
  const sigs = [];
  for (const t of ["NVDA", "MU", "AVGO", "AAPL"]) sigs.push(await (await call(env, "/api/signal?t=" + t)).json());
  const a = await (await call(env, "/api/portfolio/advice", { method: "POST", body: { signaler: sigs } })).json();
  const r3 = sigs.map((x) => x.horisonter["3"].årlig);
  const väntat = 0.5 * r3[0] + 0.25 * r3[1] + 0.15 * r3[2] + 0.1 * r3[3];
  assert.ok(Math.abs(a.före - väntat) < 1e-9, `före ${a.före} väntat ${väntat}`);
  assert.ok(globalThis.lastAdvicePrompt.includes('"andel":0.5'));
});

await test("vikter: andelar, marknadsvärde, lika, blandat", async () => {
  const { weightsFor } = await import("../src/index.js");
  const close = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
  let r = weightsFor([{ andel: 50 }, { andel: 25 }, { andel: 15 }, { andel: 10 }]);
  assert.equal(r.sätt, "andel"); assert.ok(close(r.w, [0.5, 0.25, 0.15, 0.1]));
  r = weightsFor([{ andel: 40 }, { andel: 50 }]); // summerar till 90: räknas om till 100
  assert.ok(close(r.w, [4 / 9, 5 / 9])); assert.equal(r.summa, 90);
  r = weightsFor([{ t: "A", antal: 10 }, { t: "B", antal: 10 }], (t) => (t === "A" ? 30 : 10));
  assert.equal(r.sätt, "värde"); assert.ok(close(r.w, [0.75, 0.25]));
  r = weightsFor([{}, {}, {}, {}]); assert.equal(r.sätt, "lika"); assert.ok(close(r.w, [0.25, 0.25, 0.25, 0.25]));
  r = weightsFor([{ andel: 60 }, { antal: 3 }, {}]); // 60 % + resten (40 %) delas lika
  assert.equal(r.sätt, "blandat"); assert.ok(close(r.w, [0.6, 0.2, 0.2]));
});

await test("dagens tips sparas och gårdagens finns kvar att jämföra med", async () => {
  const env = makeEnv();
  await call(env, "/api/portfolio/tips", { method: "POST", body: { datum: "2026-10-06", tips: { NVDA: "Behåll", MU: "Köp mer", "<x>": "Sälj", AAPL: "Kanske" } } });
  await call(env, "/api/portfolio/tips", { method: "POST", body: { datum: "2026-10-07", tips: { NVDA: "Sälj delvis" } } });
  let d = await (await call(env, "/api/portfolio/tips", { method: "POST", body: { datum: "2026-10-07", tips: { NVDA: "Sälj" } } })).json();
  assert.equal(d.förra.datum, "2026-10-06");
  assert.deepEqual(d.förra.tips, { NVDA: "Behåll", MU: "Köp mer" }, "ogiltiga tips och tickers sparas inte");
  assert.deepEqual(d.senast.tips, { NVDA: "Sälj" });
  assert.equal((await call(env, "/api/portfolio/tips", { method: "POST", body: { datum: "igår" } })).status, 400);
});

await test("inställning för daglig AI-genomgång", async () => {
  const env = makeEnv();
  assert.equal((await (await call(env, "/api/portfolio/settings")).json()).dagligAI, false);
  await call(env, "/api/portfolio/settings", { method: "POST", body: { dagligAI: true } });
  assert.equal((await (await call(env, "/api/portfolio/settings")).json()).dagligAI, true);
});


// ---------- Djupanalys av rapporterna ----------
const R = await import("../src/rapport.js");
const nara = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

await test("tillväxt: exakt serie ger exakt svar, ojämn serie ger felmarginal", () => {
  const g = R.tillvaxt([100, 120, 144, 172.8]);
  nara(g.per_år, 0.2, 1e-9); nara(g.låg, 0.2, 1e-6); nara(g.hög, 0.2, 1e-6); nara(g.r2, 1, 1e-9);
  const o = R.tillvaxt([100, 150, 110, 190]);
  assert.ok(o.låg < o.per_år && o.per_år < o.hög && o.hög - o.låg > 0.2, "ojämn tillväxt ska ge brett intervall");
  assert.equal(R.tillvaxt([100, 120]), null, "två år räcker inte");
  assert.equal(R.tillvaxt([100, -5, 120]), null, "förlustår går inte att logaritmera");
});

await test("DuPont: delarna gånger varandra är avkastningen på eget kapital", () => {
  const d = R.dupont({ d: "2025-12-31", res: 24, oms: 100, tillg: 150, ek: 100 });
  nara(d.marginal * d.omsättning * d.belåning, 0.24); nara(d.roe, 24 / 100);
  assert.equal(R.dupont({ res: 1, oms: 10, tillg: 20, ek: -5 }), null, "negativt eget kapital");
});

await test("Piotroski F-score: starkt bolag får 9, svagt får lågt", () => {
  const y0 = { d: "2024-12-31", res: 10, cfo: 12, tillg: 100, langa: 20, oms_tillg: 30, kort_skuld: 20, antal: 100, brutto: 40, oms: 100 };
  const bra = { d: "2025-12-31", res: 15, cfo: 20, tillg: 105, langa: 15, oms_tillg: 40, kort_skuld: 20, antal: 99, brutto: 50, oms: 120 };
  const dalig = { d: "2025-12-31", res: -5, cfo: -8, tillg: 110, langa: 40, oms_tillg: 20, kort_skuld: 25, antal: 130, brutto: 30, oms: 90 };
  assert.equal(R.piotroski(bra, y0).poäng, 9); assert.equal(R.piotroski(bra, y0).nivå, "stark");
  const f = R.piotroski(dalig, y0);
  assert.equal(f.poäng, 0); assert.equal(f.nivå, "svag");
  assert.equal(R.piotroski({ d: "2025-12-31", res: 1 }, y0), null, "för lite data");
});

await test("Altman Z-score: känt räkneexempel, zoner, hoppar över banker", () => {
  const y = { oms_tillg: 60, kort_skuld: 20, tillg: 200, balanserat: 50, ebit: 30, skulder: 100, oms: 240 };
  const z = R.altman(y, 300, "Technology");
  nara(z.z, 1.2 * 0.2 + 1.4 * 0.25 + 3.3 * 0.15 + 0.6 * 3 + 1.0 * 1.2); assert.equal(z.nivå, "trygg");
  assert.equal(R.altman({ ...y, ebit: -40, balanserat: -150, oms: 40 }, 20, "Industrials").nivå, "risk");
  assert.equal(R.altman(y, 300, "Financial Services"), null);
});

await test("Beneish M-score: oförändrat bolag flaggas inte, uppblåsta kundfordringar och vinst utan pengar flaggas", () => {
  const y0 = { oms: 100, kundf: 10, brutto: 40, oms_tillg: 40, ppe: 30, tillg: 100, avskr: 5, sga: 15, langa: 20, kort_skuld: 15, res: 10, cfo: 12 };
  const lugn = R.beneish({ ...y0 }, y0, "Technology");
  nara(lugn.m, -4.84 + 0.92 + 0.528 + 0.404 + 0.892 + 0.115 - 0.172 + 4.679 * (-0.02) - 0.327, 1e-9);
  assert.equal(lugn.flagga, false);
  const fusk = R.beneish({ ...y0, oms: 160, kundf: 45, res: 30, cfo: 2, brutto: 55 }, y0, "Technology");
  assert.equal(fusk.flagga, true);
  assert.equal(R.beneish(y0, y0, "Financial Services"), null);
});

await test("kassaflödesvärdering: utan osäkerhet lika med formeln, mer tillväxt ger högre värde", () => {
  // Ingen tillväxt alls: värdet är en evig ström = kassaflöde / avkastningskrav
  nara(R.nuvarde(100, 0, 0.1, 0), 1000, 1e-6);
  assert.ok(R.nuvarde(100, 0.15, 0.09, 0.025) > R.nuvarde(100, 0.05, 0.09, 0.025));
  assert.ok(R.nuvarde(100, 0.1, 0.08, 0.025) > R.nuvarde(100, 0.1, 0.11, 0.025), "högre krav ger lägre värde");
  const fast = R.dcf({ fcf0: 100, g: 0.08, sg: 0, r: 0.09, sr: 0, sgT: 0, nettokassa: 50, aktier: 10, pris: 100 });
  const facit = (R.nuvarde(100, 0.08, 0.09, 0.025) + 50) / 10;
  nara(fast.median, facit, 1e-6); nara(fast.p10, facit, 1e-6); nara(fast.p90, facit, 1e-6); nara(fast.mitt, facit, 1e-9);
  nara(fast.känslighet.värde[1][1], facit, 1e-9);
});

await test("simuleringen: spridning, sannolikhet mot kursen, samma svar varje gång", () => {
  const i = { fcf0: 100, g: 0.1, sg: 0.05, r: 0.09, sr: 0.01, nettokassa: 0, aktier: 10, seed: "TEST" };
  const a = R.dcf({ ...i, pris: 200 }), b = R.dcf({ ...i, pris: 200 });
  assert.deepEqual(a, b, "samma indata ska ge samma svar");
  assert.ok(a.p10 < a.p25 && a.p25 < a.median && a.median < a.p75 && a.p75 < a.p90);
  assert.equal(a.hist.antal.length, 24); assert.ok(a.hist.antal.reduce((x, y) => x + y, 0) > 3700);
  assert.ok(Math.abs(a.median / a.mitt - 1) < 0.08, "medianen ligger nära räkningen utan osäkerhet");
  assert.equal(R.dcf({ ...i, pris: 1 }).sannolikhet, 1); assert.equal(R.dcf({ ...i, pris: 1e6 }).sannolikhet, 0);
  nara(R.dcf({ ...i, pris: a.median }).sannolikhet, 0.5, 0.01);
  assert.ok(R.dcf({ ...i, pris: 150 }).sannolikhet > R.dcf({ ...i, pris: 250 }).sannolikhet);
  assert.equal(R.dcf({ ...i, fcf0: -5, pris: 10 }), null, "negativt kassaflöde går inte att värdera så");
  // Normalfördelade slumptal: ungefär 10 % ska ligga under −1,28 standardavvikelser
  const s = R.dcf({ fcf0: 100, g: 0.1, sg: 0.05, r: 0.09, sr: 0, sgT: 0, aktier: 10, pris: 1, seed: "N" });
  const under = (R.nuvarde(100, 0.1 - 1.2816 * 0.05, 0.09, 0.025)) / 10;
  assert.ok(Math.abs(s.p10 / under - 1) < 0.03, `p10 ${s.p10} mot ${under}`);
});

await test("omvänd värdering: tillväxten som kursen kräver ger tillbaka kursen", () => {
  const k = R.omvandDcf(100, 0.09, 0.025, 50, 10, 300);
  nara((R.nuvarde(100, k.g, 0.09, 0.025) + 50) / 10, 300, 1e-6);
  assert.ok(R.omvandDcf(100, 0.09, 0.025, 0, 10, 600).g > k.g, "högre kurs kräver mer tillväxt");
  assert.equal(R.omvandDcf(100, 0.09, 0.025, 0, 10, 1e9).över, true);
  assert.equal(R.omvandDcf(-1, 0.09, 0.025, 0, 10, 100), null);
});

await test("djupanalys från servern: tabell, tillväxt, styrka, värde – och ingen AI", async () => {
  installMocks();
  const env = makeEnv();
  const innan = calls.filter((u) => u.includes("anthropic")).length;
  const r = await call(env, "/api/djup?t=NVDA");
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.tabell.length, 4); nara(d.tabell.at(-1).bruttomarginal, 0.6, 1e-9);
  nara(d.tillväxt.omsättning.per_år, 0.2, 1e-6); assert.ok(d.tillväxt.senaste_kvartal > 0.15);
  assert.ok(d.styrka.poäng >= 4 && d.styrka.test.length === 9);
  assert.equal(d.obestånd.nivå, "trygg"); assert.equal(d.bokföring.flagga, false);
  assert.equal(d.dupont.length, 4); nara(d.dupont[0].roe, 24 / 100, 1e-9);
  const v = d.värde;
  assert.ok(v.median > 0 && v.p10 < v.median && v.median < v.p90 && v.sannolikhet >= 0 && v.sannolikhet <= 1);
  assert.ok(v.antaganden.krav > 0.065 && v.antaganden.krav < 0.14 && v.antaganden.tillväxt <= 0.3);
  assert.ok(v.antaganden.kassaflöde < d.tolv.fcf, "aktielöner dras från kassaflödet");
  nara((R.nuvarde(v.antaganden.kassaflöde, v.kräver.g, v.antaganden.krav, 0.025) + v.antaganden.nettokassa) / v.antaganden.aktier, d.pris, 1e-3);
  assert.equal(calls.filter((u) => u.includes("anthropic")).length, innan, "djupanalysen får inte kosta krediter");
  const n = calls.length;
  await call(env, "/api/djup?t=NVDA");
  assert.equal(calls.length, n, "andra gången kommer svaret ur minnet");
});

await test("djupanalys: förlustbolag och bolag som redovisar i annan valuta får förklaring i stället för värde", async () => {
  installMocks();
  const env = makeEnv();
  const f = await (await call(env, "/api/djup?t=LOSS")).json();
  assert.ok(f.värde.saknas.includes("negativt kassaflöde") && f.värde.median === undefined);
  assert.ok(f.styrka && f.styrka.nivå !== "stark"); assert.equal(f.tillväxt.vinst, null);
  const e = await (await call(env, "/api/djup?t=EURO")).json();
  assert.ok(e.värde.saknas.includes("EUR")); assert.equal(e.obestånd, null); assert.equal(e.samma_valuta, false);
  assert.ok(e.styrka, "kvoter fungerar oavsett valuta");
});

console.log(failed ? `\n${failed} test misslyckades` : "\nAlla test gick igenom");
process.exit(failed ? 1 : 0);
