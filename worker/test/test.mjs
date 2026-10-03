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
});

console.log(failed ? `\n${failed} test misslyckades` : "\nAlla test gick igenom");
process.exit(failed ? 1 : 0);
