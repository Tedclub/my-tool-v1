import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { COMPACT_FIELDS } from "../src/scanner-read.js";
import { buildStaticSnapshot, validateStaticSnapshot } from "../src/static-snapshot.js";

const filename = process.env.V2_FIXTURE_PATH;
const baselineJson = process.env.V2_BASELINE_JSON;
const baselineSource = process.env.V2_BASELINE_SOURCE;
const active = Boolean(filename && baselineJson && baselineSource);
if (active) mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T03:46:21Z") });
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const originalHash = active ? digest(filename) : null;
const db = active ? new DatabaseSync(filename, { readOnly: true }) : null;
let selectCalls = 0;
const DB = { prepare(sql) {
  assert.match(sql.trim(), /^(WITH|SELECT)\b/i, "Read-only endpoints may only SELECT");
  let args = [];
  return { bind(...values) { args = values; return this; },
    async all() { selectCalls++; return { results: db.prepare(sql).all(...args) }; },
    async first() { selectCalls++; return db.prepare(sql).get(...args) || null; },
    async run() { throw Error("D1 write forbidden"); }
  };
}, async batch() { throw Error("D1 write batch forbidden"); } };
const get = path => worker.fetch(new Request("https://scanner.test/api/v2/scanner/" + path), { DB });
const stored = active ? JSON.parse(fs.readFileSync(baselineJson)) : null;
after(() => { if (db) { db.close(); assert.equal(digest(filename), originalHash, "Fixture bytes must remain unchanged"); } });

test("real SQLite: TWSE candidates match Production and historical TPEX does not affect freshness", { skip: !active }, async () => {
  const before = selectCalls; const response = await get("latest"); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(selectCalls - before, 1);
  assert.equal(body.scan_date, stored.scan_date); assert.deepEqual(body.candidates, stored.candidates.filter(row => row.market === "TWSE"));
  for (const key of ["api_version", "scan_completed_at", "pool_complete", "counts_by_stage", "definitions", "unavailable_fields"]) assert.deepEqual(body[key], stored[key]);
  assert.equal(body.fresh, true);
  assert.equal(body.markets.TWSE.fresh, true);
  assert.equal(body.market_data_complete, true);
  assert.deepEqual(body.latest_price_dates, { TWSE: stored.latest_price_dates.TWSE });
  assert.deepEqual(Object.keys(body.markets), ["TWSE"]);
  assert.ok(!body.warnings.some(warning => warning.startsWith("TPEX")));
  assert.equal(body.markets.TWSE.checks.scanner_rows, 1080);
  assert.equal(body.markets.TWSE.checks.expected_scanner_rows, 1080);
});
test("real SQLite: summary is lightweight and matches full snapshot", { skip: !active }, async () => {
  const full = await (await get("latest")).json(); const response = await get("summary"); const text = await response.text(); const summary = JSON.parse(text);
  assert.ok(!("candidates" in summary)); assert.equal(summary.snapshot_hash, full.snapshot_hash);
  assert.equal(summary.candidate_count, 108); assert.equal(summary.markets.TWSE.candidate_count, 108);
  assert.ok(Buffer.byteLength(text) < 7000);
});
test("real SQLite: TWSE-only API builds a valid static backup with the same hash", { skip: !active }, async () => {
  const full = await (await get("latest")).json();
  const { manifest, summary, compact } = await buildStaticSnapshot(full);
  assert.equal(manifest.snapshot_hash, full.snapshot_hash);
  assert.equal(compact.candidates.length, full.candidates.length);
  assert.equal(validateStaticSnapshot(manifest, summary, compact).ok, true);
});

test("real SQLite: compact returns all 108 TWSE candidates, exactly the 23 requested fields", { skip: !active }, async () => {
  const full = await (await get("latest")).json();
  const response = await get("candidates?market=TWSE&scan_date=2026-10-27&compact=1&snapshot_hash=" + full.snapshot_hash);
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.fresh, true);
  assert.equal(body.snapshot_hash, full.snapshot_hash); assert.equal(body.candidates.length, 108);
  body.candidates.forEach((row, i) => { assert.deepEqual(Object.keys(row), [...COMPACT_FIELDS]); for (const field of COMPACT_FIELDS) assert.equal(row[field], full.candidates[i][field] ?? null); });
});
test("real SQLite: rejects retired TPEX and keeps TWSE date validation", { skip: !active }, async () => {
  const retired = await get("candidates?market=TPEX&scan_date=2026-10-27");
  assert.equal(retired.status, 400);
  assert.equal((await retired.json()).error, "MARKET_NOT_SUPPORTED");
  const wrongDate = await get("candidates?market=TWSE&scan_date=2026-10-22");
  const body = await wrongDate.json();
  assert.equal(wrongDate.status, 409);
  assert.equal(body.fresh, false);
  assert.deepEqual(body.candidates, []);
});
test("Scanner calculations, constants and schema initialization remain unchanged", { skip: !active }, () => {
  const normalize = text => text.replaceAll("\r\n", "\n");
  const old = normalize(fs.readFileSync(baselineSource, "utf8"));
  const current = normalize(fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8"));
  const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
  for (const [start, end] of [
    ["async function ensureSchema(", "function cleanText("],
    ["function sma(", "async function rebuildLatestScanner("],
    ["  const indices = new Map();", "async function handleScan("]
  ]) assert.equal(section(current, start, end), section(old, start, end));
  const constants = text => text.slice(text.indexOf("const BACKFILL_MAX_TRADING_DAYS"), text.indexOf("export default"));
  assert.equal(constants(current), constants(old));
});
test("original /api/scan remains read-only and returns the current five candidates", { skip: !active }, async () => {
  const response = await worker.fetch(new Request("https://scanner.test/api/scan?stage=ALL&limit=5"), { DB });
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.trade_date, "2026-10-27"); assert.equal(body.count, 5);
});
