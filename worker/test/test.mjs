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

await test("måndagskörning uppdaterar bevakningslistan", async () => {
  installMocks();
  const env = makeEnv();
  for (const t of ["NVDA", "MU"]) await call(env, "/api/watchlist", { method: "POST", body: { action: "add", t } });
  await worker.scheduled({}, env, ctx);
  assert.ok(env._kv.has("ai:NVDA") && env._kv.has("ai:MU"));
  // Färska analyser görs inte om
  const n = calls.filter((u) => u.includes("anthropic")).length;
  await worker.scheduled({}, env, ctx);
  assert.equal(calls.filter((u) => u.includes("anthropic")).length, n);
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

console.log(failed ? `\n${failed} test misslyckades` : "\nAlla test gick igenom");
process.exit(failed ? 1 : 0);
