// Låtsas-Yahoo, låtsas-Claude, låtsas-KV och låtsas-cache, så att Worker kan testas utan internet.
export const calls = [];

function seeded(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296); }

function fakeChart(t, range) {
  const days = range === "1mo" ? 22 : 1260, rnd = seeded(t);
  let p = 50 + rnd() * 150; const ts = [], close = [], vol = [];
  const start = Date.UTC(2026, 9, 2) / 1000 - days * 86400 * 1.4;
  for (let i = 0; i < days; i++) { p *= 1 + (rnd() - 0.48) * 0.04; ts.push(Math.round(start + i * 86400 * 1.4)); close.push(p); vol.push(1e6 + rnd() * 1e7); }
  return { chart: { result: [{ meta: { regularMarketPrice: close.at(-1), chartPreviousClose: close.at(-2), currency: "USD", longName: t + " Corp", fullExchangeName: "NasdaqGS" },
    timestamp: ts, indicators: { quote: [{ close, volume: vol }], adjclose: [{ adjclose: close }] } }] } };
}

const R = (x) => ({ raw: x, fmt: String(x) });

function fakeSummary(t) {
  return { quoteSummary: { result: [{
    price: { longName: t + " Corporation", currency: "USD", marketCap: R(2.1e12) },
    summaryProfile: { sector: "Technology", industry: "Semiconductors", longBusinessSummary: `${t} gör chip för AI och datacenter.`, website: "https://example.com" },
    summaryDetail: { trailingPE: R(45), forwardPE: R(28), priceToSalesTrailing12Months: R(18), beta: R(1.7), fiftyTwoWeekHigh: R(210), fiftyTwoWeekLow: R(90) },
    financialData: { targetMeanPrice: R(230), targetHighPrice: R(300), targetLowPrice: R(150), numberOfAnalystOpinions: R(55), recommendationKey: "buy",
      revenueGrowth: R(0.56), earningsGrowth: R(0.6), grossMargins: R(0.72), operatingMargins: R(0.58), profitMargins: R(0.52), returnOnEquity: R(0.9),
      debtToEquity: R(12), currentRatio: R(3.4), totalCash: R(5e10), totalDebt: R(9e9), freeCashflow: R(7e10) },
    defaultKeyStatistics: { pegRatio: R(1.1), enterpriseToEbitda: R(35), shortPercentOfFloat: R(0.01) },
    earningsTrend: { trend: [{ period: "0y", earningsEstimate: { avg: R(4.5), growth: R(0.5) } }, { period: "+1y", earningsEstimate: { avg: R(6.1), growth: R(0.36) }, revenueEstimate: { growth: R(0.3) } }] },
    calendarEvents: { earnings: { earningsDate: [R(1795000000)] } },
  }] } };
}

function fakeTimeseries() {
  const q = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
  const ser = (name, base) => ({ meta: { type: [name] }, [name]: q.map((d, i) => ({ asOfDate: d, reportedValue: { raw: base * (1 + i * 0.12) } })) });
  return { timeseries: { result: [ser("quarterlyTotalRevenue", 3e10), ser("quarterlyNetIncome", 1.6e10), ser("annualTotalRevenue", 1.3e11), ser("annualNetIncome", 7e10)] } };
}

const NAMES = { NVDA: "NVIDIA Corporation", AAPL: "Apple Inc.", MSFT: "Microsoft Corporation", TSLA: "Tesla, Inc.", MU: "Micron Technology, Inc." };

export function installMocks({ claudeMode = "ok" } = {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://fc.yahoo.com")) return new Response("", { status: 404, headers: { "set-cookie": "A3=abc123; Max-Age=31557600; Domain=.yahoo.com" } });
    if (url.includes("/v1/test/getcrumb")) return new Response("Crumb.Xy1", { status: 200 });
    if (url.includes("/v8/finance/chart/")) {
      const t = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
      if (t === "NOPE") return new Response("{}", { status: 404 });
      return ok(fakeChart(t, new URL(url).searchParams.get("range")));
    }
    if (url.includes("/v10/finance/quoteSummary/")) return ok(fakeSummary(decodeURIComponent(url.split("quoteSummary/")[1].split("?")[0])));
    if (url.includes("fundamentals-timeseries")) return ok(fakeTimeseries());
    if (url.includes("/v1/finance/search")) {
      const q = new URL(url).searchParams.get("q").toUpperCase();
      if (new URL(url).searchParams.get("newsCount") === "8")
        return ok({ news: [{ title: `${q} slår förväntningarna i kvartalsrapporten`, publisher: "Reuters", link: "https://example.com/n1", providerPublishTime: 1790000000 },
          { title: `Analytiker höjer riktkursen för ${q}`, publisher: "Bloomberg", link: "https://example.com/n2", providerPublishTime: 1789000000 }] });
      const quotes = Object.entries(NAMES).filter(([k, v]) => k.startsWith(q) || v.toUpperCase().includes(q))
        .map(([k, v]) => ({ symbol: k, longname: v, exchDisp: "NASDAQ", quoteType: "EQUITY" }));
      return ok({ quotes });
    }
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      const body = JSON.parse(init.body);
      if (!init.headers["x-api-key"]) return new Response(JSON.stringify({ error: { message: "no key" } }), { status: 401 });
      if (claudeMode === "nocredit") return new Response(JSON.stringify({ error: { message: "Your credit balance is too low" } }), { status: 400 });
      const names = body.tools.map((t) => t.name);
      if (!names.includes("web_search") || !names.includes("submit_verdict")) throw new Error("tools saknas");
      for (const k of Object.keys(body.tools[1].input_schema.properties)) if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(k)) throw new Error("Ogiltigt fältnamn " + k);
      const turn = body.messages.length;
      if (claudeMode === "pause" && turn === 1) return ok({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }] });
      return ok({ stop_reason: "tool_use", content: [
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://investor.example.com/q2-2026", title: "Q2 2026 Results", page_age: "2026-08-27" }] },
        { type: "text", text: "Här är min bedömning." },
        { type: "tool_use", id: "t1", name: "submit_verdict", input: { betyg: "Köpvärd", sakerhet: "Medel", kort: "Stark tillväxt till en rimlig värdering.",
          sammanfattning: "Bolaget växer snabbt. Marginalerna är höga. Värderingen är rimlig mot tillväxten.", senaste_rapport: "Q2 2026: omsättningen steg 56 % till 47 mdr USD.",
          vardering: "Forward P/E 28 är rimligt med 36 % vinsttillväxt.", styrkor: ["Hög tillväxt", "Höga marginaler"], risker: ["Konkurrens", "Exportregler"], att_bevaka: ["Nästa rapport"] } },
      ] });
    }
    throw new Error("Oväntat anrop: " + url);
  };

  const store = new Map();
  globalThis.caches = { default: { match: async (r) => { const v = store.get(r.url); return v ? new Response(v) : undefined; }, put: async (r, res) => store.set(r.url, await res.text()) } };
}

export function makeEnv(extra = {}) {
  const kv = new Map();
  return {
    APP_KEY: "hemlig", ANTHROPIC_API_KEY: "sk-ant-test", AI_DAILY_LIMIT: "25",
    AKTIE_KV: {
      get: async (k, type) => { const v = kv.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
      put: async (k, v) => kv.set(k, v),
    },
    _kv: kv, ...extra,
  };
}

export const ctx = { waitUntil: (p) => p };
