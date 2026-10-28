import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expectedTradeDate } from "../src/trading-calendar.js";
import { snapshotMetadata, snapshotHash, canonicalJson, handleScannerRead, COMPACT_FIELDS } from "../src/scanner-read.js";

before(() => mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T00:33:42Z") }));
after(() => mock.timers.reset());
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { ok: true, api_version: "v2-scanner-export-1", scan_date: "2026-10-27",
    exported_at: "2026-10-28T00:33:41Z", scan_completed_at: null,
    pool_complete: true, market_data_complete: false, total_count: 1, returned_count: 1, truncated: false,
    latest_price_dates: { TWSE: "2026-10-27", TPEX: "2026-10-16" },
    warnings: ["SCAN_COMPLETION_UNVERIFIED", "TPEX_DATA_NOT_CURRENT"],
    candidates: [{ scan_date: "2026-10-27", trade_date: "2026-10-27", market: "TWSE", stock_id: "2330",
      stock_name: "test", close: 100, ma5: 99, ma20: 95, ma5_slope: 1, ma20_slope: 0.5,
      prior_20d_high: 101, volume: 1000, volume_ratio: 1.5, r5: 2, risk_percent: 4,
      ma20_deviation_percent: 5, distance_to_20d_high_percent: -1, rs_excess_20_percent: 3, rs_rank: 90,
      bullish_alignment: 1, strengthening: 1, price_breakout: 0, volume_confirmed: 1,
      scanner_status: "STRENGTHENING", trend_stage: "STRENGTHENING", eligible: 1 }],
    _read_integrity: {
      TWSE: { price_rows: 1, recorded_price_rows: 1, adjusted_presence_recorded: 1, index_presence_recorded: 1,
        index_rows: 1, scanner_rows: 1, expected_scanner_rows: 1, missing_scanner_rows: 0,
        unexpected_scanner_rows: 0, candidate_rows: 1 },
      TPEX: { price_rows: 0, recorded_price_rows: 0, adjusted_presence_recorded: 0, index_presence_recorded: 0,
        index_rows: 0, scanner_rows: 0, expected_scanner_rows: 0, missing_scanner_rows: 0,
        unexpected_scanner_rows: 0, candidate_rows: 0 }
    }
  };
}
const request = path => new Request("https://scanner.test/api/v2/scanner/" + path);
const load = data => async () => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("calendar handles pre/post 17:00, weekends, holidays and extraordinary closure", () => {
  assert.equal(expectedTradeDate(new Date("2026-10-28T00:33:42Z")), "2026-10-27");
  assert.equal(expectedTradeDate(new Date("2026-10-28T09:00:00Z")), "2026-10-28");
  assert.equal(expectedTradeDate(new Date("2026-10-27T00:00:00Z")), "2026-10-22");
  assert.equal(expectedTradeDate(new Date("2026-10-26T10:00:00Z")), "2026-10-22");
  assert.equal(expectedTradeDate(new Date("2026-10-23T10:00:00Z")), "2026-10-22");
  assert.equal(expectedTradeDate(new Date("2026-02-23T00:00:00Z")), "2026-02-11");
  assert.equal(expectedTradeDate(new Date("2027-01-04T10:00:00Z")), null);
});
test("fresh TWSE remains available while TPEX is stale", async () => {
  const result = await snapshotMetadata(fixture());
  assert.equal(result.markets.TWSE.fresh, true); assert.equal(result.markets.TPEX.fresh, false);
  assert.equal(result.fresh, false); assert.equal(result.fresh_candidate_count, 1);
  assert.equal(result.dates_consistent, false); assert.equal(result.markets.TWSE.dates_consistent, true);
  assert.ok(!("run_id" in result)); assert.ok(!("candidates_same_run" in result));
});
for (const [name, change] of [
  ["stale scan", data => { data.scan_date = "2026-10-22"; }],
  ["stale TWSE price", data => { data.latest_price_dates.TWSE = "2026-10-22"; }],
  ["candidate date", data => { data.candidates[0].scan_date = "2026-10-22"; }],
  ["raw date", data => { data.candidates[0].trade_date = "2026-10-22"; }],
  ["missing integrity", data => { delete data._read_integrity.TWSE; }],
  ["price row count", data => { data._read_integrity.TWSE.recorded_price_rows = 2; }],
  ["index missing", data => { data._read_integrity.TWSE.index_rows = 0; }],
  ["adjustment presence unknown", data => { data._read_integrity.TWSE.adjusted_presence_recorded = null; }],
  ["partial scanner", data => { data._read_integrity.TWSE.expected_scanner_rows = 2; }],
  ["missing scanner key", data => { data._read_integrity.TWSE.missing_scanner_rows = 1; }],
  ["unexpected scanner key", data => { data._read_integrity.TWSE.unexpected_scanner_rows = 1; }],
  ["candidate truncation", data => { data._read_integrity.TWSE.candidate_rows = 2; }],
  ["missing price join", data => { data.candidates[0].volume = null; }],
  ["missing RS", data => { data.candidates[0].rs_rank = null; }],
  ["duplicate candidate", data => { data.candidates.push(copy(data.candidates[0])); data._read_integrity.TWSE.candidate_rows = 2; }]
]) test("fail closed: " + name, async () => {
  const data = fixture(); change(data); const result = await snapshotMetadata(data);
  assert.equal(result.markets.TWSE.fresh, false);
  const response = await handleScannerRead(request("candidates?market=TWSE&scan_date=2026-10-27"), {}, load(data));
  assert.equal(response.status, 409); assert.deepEqual((await response.json()).candidates, []);
});
test("uncovered calendar fails closed", async () => {
  const result = await snapshotMetadata(fixture(), new Date("2027-01-04T10:00:00Z"));
  assert.equal(result.expected_trade_date, null); assert.equal(result.markets.TWSE.fresh, false);
  assert.ok(result.warnings.includes("EXPECTED_TRADE_DATE_UNVERIFIED"));
});
test("a verified market with zero candidates is fresh, not a failed scan", async () => {
  const data = fixture(); data.candidates = []; data.total_count = 0; data.returned_count = 0;
  data._read_integrity.TWSE.candidate_rows = 0;
  assert.equal((await snapshotMetadata(data)).markets.TWSE.fresh, true);
});
test("snapshot hashes exclude export time, canonicalize object keys and change with data", async () => {
  const a = fixture(), b = fixture(); b.exported_at = "2026-10-28T03:00:00Z";
  assert.equal(await snapshotHash(a), await snapshotHash(b));
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  b.candidates[0].close++; assert.notEqual(await snapshotHash(a), await snapshotHash(b));
});
test("latest preserves all legacy candidate fields and headers match JSON", async () => {
  const data = fixture();
  const response = await handleScannerRead(request("latest"), {}, load(data)); const body = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(body.candidates, data.candidates);
  assert.equal(body.scan_completed_at, null); assert.equal(body.api_version, data.api_version);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-V2-Response-ID"), body.response_id);
  assert.equal(response.headers.get("X-V2-Scan-Date"), body.scan_date);
  assert.equal(response.headers.get("X-V2-Generated-At"), body.response_generated_at);
  assert.equal(body.exported_at, body.response_generated_at); assert.ok(!("_read_integrity" in body));
});
test("summary contains no candidates; compact projection preserves every requested value", async () => {
  const data = fixture(); const summary = await (await handleScannerRead(request("summary"), {}, load(data))).json();
  assert.ok(!("candidates" in summary));
  const response = await handleScannerRead(request("candidates?market=TWSE&scan_date=2026-10-27&compact=1&snapshot_hash=" + summary.snapshot_hash), {}, load(data));
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.fresh, true);
  assert.equal(body.snapshot_fresh, false); assert.equal(body.snapshot_hash, summary.snapshot_hash);
  assert.deepEqual(Object.keys(body.candidates[0]), [...COMPACT_FIELDS]);
  for (const key of COMPACT_FIELDS) assert.equal(body.candidates[0][key], data.candidates[0][key]);
});
test("response IDs differ while full/summary/compact hashes stay equal", async () => {
  const data = fixture(); const a = await (await handleScannerRead(request("latest"), {}, load(data))).json();
  const b = await (await handleScannerRead(request("summary"), {}, load(data))).json();
  assert.notEqual(a.response_id, b.response_id); assert.equal(a.snapshot_hash, b.snapshot_hash);
});
test("a full response's hash can be recomputed from public JSON alone", async () => {
  const body = await (await handleScannerRead(request("latest"), {}, load(fixture()))).json();
  const input = { hash_version: body.snapshot_hash_version, api_version: body.api_version,
    scan_date: body.scan_date, latest_price_dates: body.latest_price_dates,
    pool_complete: body.pool_complete, market_data_complete: body.market_data_complete,
    candidate_count: body.candidate_count,
    checks: Object.fromEntries(Object.entries(body.markets).map(([market, value]) => [market, value.checks])),
    candidates: body.candidates };
  const sort = value => value === null || typeof value !== "object" ? value : Array.isArray(value)
    ? value.map(sort) : Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  const expected = "sha256:" + createHash("sha256").update(JSON.stringify(sort(input))).digest("hex");
  assert.equal(body.snapshot_hash, expected);
});
for (const [query, code] of [
  ["market=TPEX&scan_date=2026-10-27", "MARKET_NOT_FRESH"],
  ["market=TWSE&scan_date=2026-10-22", "SCAN_DATE_MISMATCH"],
  ["market=TWSE&scan_date=2026-10-27&snapshot_hash=sha256:" + "0".repeat(64), "SNAPSHOT_CHANGED"]
]) test("candidate rejection: " + code, async () => {
  const response = await handleScannerRead(request("candidates?" + query), {}, load(fixture())); const body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.error, code); assert.equal(body.fresh, false);
  assert.equal(body.candidate_count, 0); assert.deepEqual(body.candidates, []);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
for (const query of ["", "market=ALL&scan_date=2026-10-27", "market=TWSE&scan_date=2026-02-30", "market=TWSE&scan_date=2026-10-27&compact=yes", "market=TWSE&scan_date=2026-10-27&snapshot_hash=bad"]) {
  test("invalid query never accesses the DB: " + query, async () => {
    const response = await handleScannerRead(request("candidates?" + query), {}, () => { throw Error("DB must not be read"); });
    assert.equal(response.status, 400);
  });
}
test("non-GET and OPTIONS never read DB; unavailable snapshots return no-store errors", async () => {
  const noDb = () => { throw Error("DB must not be read"); };
  const post = await handleScannerRead(new Request(request("latest"), { method: "POST" }), {}, noDb);
  assert.equal(post.status, 405); assert.equal(post.headers.get("Cache-Control"), "no-store");
  const options = await handleScannerRead(new Request(request("summary"), { method: "OPTIONS" }), {}, noDb);
  assert.equal(options.status, 204);
  const failure = await handleScannerRead(request("summary"), {}, noDb);
  assert.equal(failure.status, 503); const body = await failure.json();
  assert.equal(body.fresh, false); assert.equal(failure.headers.get("X-V2-Response-ID"), body.response_id);
});
