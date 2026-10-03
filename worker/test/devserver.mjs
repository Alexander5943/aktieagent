// Lokal testserver: visar appen (docs/) och kör Worker med låtsasdata.  node test/devserver.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { installMocks, makeEnv, ctx } from "./mock.mjs";

installMocks();
const worker = (await import("../src/index.js")).default;
const env = makeEnv();
const DOCS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../docs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/") || req.method === "OPTIONS") {
    let body; if (req.method === "POST") { body = ""; for await (const c of req) body += c; }
    const r = await worker.fetch(new Request("http://w" + req.url, { method: req.method, headers: req.headers, body: body || undefined }), env, ctx);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  let f = path.join(DOCS, decodeURIComponent(url.pathname));
  if (f.endsWith("/")) f += "index.html";
  if (!f.startsWith(DOCS) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(8787, () => console.log("http://localhost:8787"));
