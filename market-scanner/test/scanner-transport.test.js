import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import zlib from "node:zlib";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

const active = Boolean(process.env.V2_FIXTURE_PATH);
const measured = [];
let db, server, server2, port, port2, originalHash;
const hashFile = () => crypto.createHash("sha256").update(fs.readFileSync(process.env.V2_FIXTURE_PATH)).digest("hex");
const DB = { prepare(sql) {
  assert.match(sql.trim(), /^(SELECT|WITH)\b/i); let values = [];
  return { bind(...v) { values = v; return this; }, async all() { return { results: db.prepare(sql).all(...values) }; },
    async first() { return db.prepare(sql).get(...values); }, async run() { throw Error("Writes forbidden"); } };
}, async batch() { throw Error("Writes forbidden"); } };
async function serve(req, res) {
  try {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(":")));
    const response = await worker.fetch(new Request("http://localhost" + req.url, { headers }), { DB });
    let bytes = Buffer.from(await response.arrayBuffer());
    const outputHeaders = Object.fromEntries(response.headers.entries());
    const encoding = req.headers["accept-encoding"] || "";
    if (encoding.includes("br")) { bytes = zlib.brotliCompressSync(bytes); outputHeaders["content-encoding"] = "br"; }
    else if (encoding.includes("gzip")) { bytes = zlib.gzipSync(bytes); outputHeaders["content-encoding"] = "gzip"; }
    outputHeaders["content-length"] = bytes.length;
    res.writeHead(response.status, outputHeaders); res.end(bytes);
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
}
before(async () => {
  if (!active) return;
  originalHash = hashFile(); db = new DatabaseSync(process.env.V2_FIXTURE_PATH, { readOnly: true });
  server = http.createServer(serve); server2 = http2.createServer({}, serve);
  await Promise.all([new Promise(resolve => server.listen(0, "127.0.0.1", resolve)), new Promise(resolve => server2.listen(0, "127.0.0.1", resolve))]);
  port = server.address().port; port2 = server2.address().port;
});
after(async () => {
  if (!active) return;
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => server2.close(resolve))]);
  db.close(); assert.equal(hashFile(), originalHash);
  if (process.env.V2_TRANSPORT_REPORT) fs.writeFileSync(process.env.V2_TRANSPORT_REPORT, JSON.stringify({ tests: measured, fixture_unchanged: true, http2_test: "local cleartext HTTP/2; public TLS/HTTP2 verified separately after deployment" }, null, 2));
});

async function read(path, headers = {}, h2 = false) {
  const begin = Date.now();
  const result = await new Promise((resolve, reject) => {
    const chunks = []; let responseHeaders;
    if (h2) {
      const client = http2.connect("http://127.0.0.1:" + port2);
      const req = client.request({ ":path": "/api/v2/scanner/" + path, ...headers });
      req.on("response", h => { responseHeaders = h; }); req.on("data", b => chunks.push(b));
      req.on("end", () => { client.close(); resolve({ headers: responseHeaders, status: responseHeaders[":status"], raw: Buffer.concat(chunks) }); });
      req.on("error", reject); req.end();
    } else {
      http.get({ hostname: "127.0.0.1", port, path: "/api/v2/scanner/" + path, headers }, res => {
        responseHeaders = res.headers; res.on("data", b => chunks.push(b));
        res.on("end", () => resolve({ headers: responseHeaders, status: res.statusCode, raw: Buffer.concat(chunks) }));
        res.on("error", reject);
      }).on("error", reject);
    }
  });
  let bytes = result.raw; const encoding = result.headers["content-encoding"];
  if (encoding === "gzip") bytes = zlib.gunzipSync(bytes);
  if (encoding === "br") bytes = zlib.brotliDecompressSync(bytes);
  const body = JSON.parse(bytes.toString());
  assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-v2-response-id"], body.response_id);
  assert.equal(result.headers["x-v2-scan-date"], body.scan_date);
  assert.equal(result.headers["x-v2-generated-at"], body.response_generated_at);
  measured.push({ path, protocol: h2 ? "h2c" : "http1", encoding: encoding || "identity", bytes: bytes.length, wire_bytes: result.raw.length, elapsed_ms: Date.now() - begin, candidate_count: body.candidate_count, response_id: body.response_id, snapshot_hash: body.snapshot_hash });
  return body;
}
const candidates = "candidates?market=TWSE&scan_date=2026-10-27&compact=1";
test("HTTP client: lightweight summary and compact all-candidate response", { skip: !active }, async () => {
  const a = await read("summary"), b = await read(candidates);
  assert.equal(a.snapshot_hash, b.snapshot_hash); assert.equal(a.markets.TWSE.fresh, true);
  assert.equal(b.candidates.length, 108); assert.equal(b.fresh, true);
  assert.ok(measured[0].bytes < 7000); assert.ok(measured[1].bytes < 100000);
});
test("ChatGPT-User UA and HTML Accept still receive valid JSON", { skip: !active }, async () => {
  const result = await read("summary", { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.equal(result.scan_date, "2026-10-27");
});
test("gzip and Brotli preserve the same snapshot and all compact candidates", { skip: !active }, async () => {
  const a = await read(candidates, { "accept-encoding": "gzip" });
  const b = await read(candidates, { "accept-encoding": "br" });
  assert.equal(a.snapshot_hash, b.snapshot_hash); assert.deepEqual(a.candidates, b.candidates);
});
test("HTTP/2 carries matching response headers and JSON for summary and compact", { skip: !active }, async () => {
  const a = await read("summary", {}, true);
  const b = await read(candidates, { "accept-encoding": "br" }, true);
  assert.equal(a.snapshot_hash, b.snapshot_hash); assert.equal(b.candidates.length, 108);
});
test("snapshot hash is stable across repeat requests, formats and response IDs", { skip: !active }, async () => {
  const a = await read("latest"), b = await read("summary"), c = await read(candidates);
  assert.equal(a.snapshot_hash, b.snapshot_hash); assert.equal(a.snapshot_hash, c.snapshot_hash);
  assert.notEqual(a.response_id, b.response_id); assert.notEqual(b.response_id, c.response_id);
});
