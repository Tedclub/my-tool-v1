import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker, { fetchJsonOrEmpty } from "../src/index.js";
import { buildStaticSnapshot, validateStaticSnapshot, publishR2, publishGitHub,
  exportCompletedSnapshot } from "../src/static-snapshot.js";
import { COMPACT_FIELDS } from "../src/scanner-read.js";
import { readStaticSnapshot, usableStaticCandidates } from "../src/static-retrieval.js";

const full = JSON.parse(fs.readFileSync(new URL("./fixtures/v2-public-20261027.json", import.meta.url)));
const now = new Date(full.response_generated_at);
const copy = value => structuredClone(value);
class Bucket {
  constructor(fail) { this.objects = new Map(); this.writes = []; this.fail = fail; }
  async get(key) { const value = this.objects.get(key); return value ? { json: async () => JSON.parse(value.body) } : null; }
  async put(key, body, options) {
    this.writes.push(key);
    if (this.fail?.(key)) throw Error("injected failure");
    if (options.onlyIf && this.objects.has(key)) return null;
    this.objects.set(key, { body, options }); return {};
  }
}

test("static uses existing Primary hash; all 108 candidates and all compact values match", async () => {
  const b = await buildStaticSnapshot(copy(full));
  assert.equal(b.manifest.snapshot_hash, full.snapshot_hash);
  assert.equal(b.summary.snapshot_hash, full.snapshot_hash);
  assert.equal(b.compact.snapshot_hash, full.snapshot_hash);
  assert.equal(b.compact.candidates.length, 108);
  assert.equal(validateStaticSnapshot(b.manifest, b.summary, b.compact, now).ok, true);
  b.compact.candidates.forEach((row, index) => {
    assert.deepEqual(Object.keys(row), [...COMPACT_FIELDS]);
    for (const field of COMPACT_FIELDS) assert.deepEqual(row[field], full.candidates[index][field] ?? null);
  });
  assert.equal(b.manifest.markets.TPEX.fresh, false);
  assert.ok(!("run_id" in b.manifest)); assert.ok(!("candidates_same_run" in b.manifest));
  assert.ok(!("scan_completed_at" in b.manifest));
});

for (const [name, change] of [
  ["hash mismatch", b => b.compact.snapshot_hash = "sha256:" + "0".repeat(64)],
  ["stale date", b => b.manifest.expected_trade_date = "2026-10-29"],
  ["fresh false", b => b.manifest.markets.TWSE.fresh = false],
  ["missing integrity", b => delete b.summary.markets.TWSE.integrity_verified],
  ["truncation", b => b.compact.candidates.pop()],
  ["candidate wrong date", b => b.compact.candidates[0].scan_date = "2026-10-22"],
  ["NONE", b => b.compact.candidates[0].scanner_status = "NONE"],
  ["missing field", b => delete b.compact.candidates[0].rs_rank]
]) test("static reader fails closed: " + name, async () => {
  const b = await buildStaticSnapshot(copy(full)); change(b);
  assert.equal(validateStaticSnapshot(b.manifest, b.summary, b.compact, now).ok, false);
});

test("static reader rejects yesterday's successful export on a later trading day and unknown year", async () => {
  const b = await buildStaticSnapshot(copy(full));
  for (const time of ["2026-10-30T00:33:00Z", "2027-01-04T09:00:00Z"])
    assert.equal(validateStaticSnapshot(b.manifest, b.summary, b.compact, new Date(time)).ok, false);
});

test("tampered source fields cannot reuse Primary hash", async () => {
  const data = copy(full); data.candidates[0].close++;
  await assert.rejects(buildStaticSnapshot(data), /PRIMARY_SNAPSHOT_HASH_INVALID/);
});

test("R2 latest marker is last and every manifest links to complete immutable files", async () => {
  const b = await buildStaticSnapshot(copy(full)); const bucket = new Bucket(); await publishR2(b, bucket);
  assert.equal(bucket.writes.at(-1), "v2/latest/manifest.json");
  for (const prefix of ["v2/latest/", "v2/archive/2026-10-27/", b.immutable]) {
    const url = new URL(prefix + "manifest.json", "https://static.example/root/");
    const manifest = await (await bucket.get(prefix + "manifest.json")).json();
    for (const file of Object.values(manifest.files)) {
      const path = new URL(file, url).pathname.replace(/^\/root\//, "");
      assert.ok(bucket.objects.has(path), path);
    }
  }
  assert.equal(bucket.objects.get("v2/latest/manifest.json").options.httpMetadata.cacheControl, "no-cache");
  assert.match(bucket.objects.get(b.immutable + "summary.json").options.httpMetadata.cacheControl, /immutable/);
});

test("R2 interrupted latest compact upload preserves the previous readable manifest", async () => {
  const b = await buildStaticSnapshot(copy(full)); const bucket = new Bucket(key => key === "v2/latest/TWSE-compact.json");
  const old = '{"snapshot_hash":"old","files":{"summary":"old-summary.json"}}';
  bucket.objects.set("v2/latest/manifest.json", { body: old });
  await assert.rejects(publishR2(b, bucket));
  assert.equal(bucket.objects.get("v2/latest/manifest.json").body, old);
});

test("R2 immutable date archive is never overwritten on a changed snapshot", async () => {
  const b = await buildStaticSnapshot(copy(full)); const bucket = new Bucket();
  bucket.objects.set("v2/archive/2026-10-27/manifest.json", { body: '{"snapshot_hash":"old"}' });
  await assert.rejects(publishR2(b, bucket), /ARCHIVE_DATE_CONFLICT/);
  assert.equal(await bucket.get("v2/latest/manifest.json"), null);
});

test("GitHub commits all nine JSON files in one tree/ref update and never force pushes", async () => {
  const b = await buildStaticSnapshot(copy(full)); const calls = [];
  const fake = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, ...options, body });
    const data = url.includes("/git/ref/heads/") ? { object: { sha: "head" } } :
      url.endsWith("/git/commits/head") ? { tree: { sha: "tree" } } :
      url.includes("?recursive=1") ? { truncated: false, tree: [{ path: "README.md", type: "blob" }] } :
      { sha: "next" };
    return Response.json(data);
  };
  await publishGitHub(b, { repository: "Tedclub/my-tool-v1", branch: "v2-snapshots" }, "fake-test-only", fake);
  assert.equal(calls.find(c => c.url.endsWith("/git/trees")).body.tree.length, 9);
  assert.deepEqual(calls.at(-1).body, { sha: "next", force: false });
  await assert.rejects(publishGitHub(b, { repository: "Tedclub/my-tool-v1", branch: "main" }, "test", fake));
});

test("GitHub failed tree upload never advances its branch", async () => {
  const b = await buildStaticSnapshot(copy(full)); let patched = false;
  await assert.rejects(publishGitHub(b, { repository: "Tedclub/my-tool-v1", branch: "v2-snapshots" }, "test", async (url, options) => {
    if (options.method === "PATCH") patched = true;
    if (options.method === "POST") return new Response("failure", { status: 503 });
    return Response.json(url.includes("/git/ref/heads/") ? { object: { sha: "head" } } :
      url.endsWith("/git/commits/head") ? { tree: { sha: "tree" } } : { tree: [], truncated: false });
  }));
  assert.equal(patched, false);
});

test("both publishing failures resolve normally and never expose secrets or error bodies", async () => {
  const logs = []; const warn = console.warn; console.warn = line => logs.push(line);
  try {
    const result = await exportCompletedSnapshot({ V2_SNAPSHOTS: new Bucket(() => true),
      SNAPSHOT_R2_ENABLED: "true",
      SNAPSHOT_GITHUB_REPOSITORY: "Tedclub/my-tool-v1", SNAPSHOT_GITHUB_BRANCH: "v2-snapshots",
      GITHUB_SNAPSHOT_TOKEN: "never-log-me" }, async () => Response.json(copy(full)), {
      fetcher: async () => { throw Error("never-log-me"); }
    });
    assert.equal(result.prepared, true); assert.deepEqual(result.targets, { R2: false, GITHUB: false });
    assert.deepEqual(result.failures, {
      R2: { reason: "UNKNOWN_ERROR", stage: "unknown" },
      GITHUB: { reason: "UNKNOWN_ERROR", stage: "get_ref" }
    });
    assert.deepEqual(logs.map(JSON.parse), [
      { event: "R2_SNAPSHOT_EXPORT_FAILED", ...result.failures.R2 },
      { event: "GITHUB_SNAPSHOT_EXPORT_FAILED", ...result.failures.GITHUB }
    ]);
    assert.ok(!logs.join("").includes("never-log-me"));
    assert.ok(!JSON.stringify(result).includes("never-log-me"));
  } finally { console.warn = warn; }
});

test("R2 is not accessed or logged as failed while deferred", async () => {
  const result = await exportCompletedSnapshot({}, async () => Response.json(copy(full)));
  assert.equal(result.prepared, true); assert.deepEqual(result.targets, { GITHUB: false });
});

test("Primary completely unavailable: static-only retrieval gets all 108 and PASS", async () => {
  const b = await buildStaticSnapshot(copy(full)); const calls = [];
  const fetcher = async url => {
    assert.ok(!String(url).includes("workers.dev")); calls.push(String(url));
    const name = new URL(url).pathname.split("/").at(-1);
    return new Response(b.files[name]);
  };
  const result = await usableStaticCandidates("https://raw.githubusercontent.com/Tedclub/my-tool-v1/v2-snapshots/v2/latest/manifest.json", { fetcher, now });
  assert.equal(result.status, "PASS"); assert.equal(result.candidates.length, 108); assert.equal(calls.length, 3);
});

test("stale static retrieval succeeds but returns zero usable candidates", async () => {
  const b = await buildStaticSnapshot(copy(full));
  const result = await usableStaticCandidates("https://static.example/v2/latest/manifest.json", {
    fetcher: async url => new Response(b.files[new URL(url).pathname.split("/").at(-1)]),
    now: new Date("2026-10-30T00:00:00Z")
  });
  assert.equal(result.status, "DATA_FAIL"); assert.equal(result.retrieved_candidate_count, 108);
  assert.deepEqual(result.candidates, []);
});

test("manifest cannot redirect its static reader to another host", async () => {
  const b = await buildStaticSnapshot(copy(full)); b.manifest.files.summary = "https://untrusted.example/data.json";
  await assert.rejects(readStaticSnapshot("https://static.example/v2/latest/manifest.json", {
    fetcher: async () => Response.json(b.manifest), now
  }), /INVALID_MANIFEST_FILE_PATH/);
});

test("snapshot preparation failure emits safe diagnostic reason only", async () => {
  const logs = []; const original = console.warn; console.warn = line => logs.push(line);
  try {
    const result = await exportCompletedSnapshot({}, async () => new Response("unavailable", { status: 503 }));
    assert.deepEqual(result, { prepared: false, reason: "PRIMARY_UNAVAILABLE" });
    assert.deepEqual(JSON.parse(logs.at(-1)), {
      event: "STATIC_SNAPSHOT_EXPORT_SKIPPED", reason: "PRIMARY_UNAVAILABLE"
    });
  } finally { console.warn = original; }
});

test("snapshot preparation unknown exception does not leak sensitive text", async () => {
  const logs = []; const original = console.warn; console.warn = line => logs.push(line);
  try {
    const result = await exportCompletedSnapshot({}, async () => { throw Error("private-secret-value"); });
    assert.deepEqual(result, { prepared: false, reason: "UNKNOWN_ERROR" });
    assert.deepEqual(JSON.parse(logs.at(-1)), {
      event: "STATIC_SNAPSHOT_EXPORT_SKIPPED", reason: "UNKNOWN_ERROR"
    });
    assert.ok(!logs.join("").includes("private-secret-value"));
  } finally { console.warn = original; }
});

test("GitHub export supports existing Cloudflare SNAPSHOT_GITHUB_REPO variable", async () => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, method: options.method });
    const data = url.includes("/git/ref/heads/") ? { object: { sha: "head" } } :
      url.endsWith("/git/commits/head") ? { tree: { sha: "tree" } } :
      url.includes("?recursive=1") ? { truncated: false, tree: [{ path: "README.md", type: "blob" }] } :
      { sha: "next" };
    return Response.json(data);
  };
  const result = await exportCompletedSnapshot({
    SNAPSHOT_GITHUB_REPO: "Tedclub/my-tool-v1", SNAPSHOT_GITHUB_BRANCH: "v2-snapshots",
    GITHUB_SNAPSHOT_TOKEN: "test-token"
  }, async () => Response.json(copy(full)), { fetcher: fake });
  assert.equal(result.prepared, true);
  assert.deepEqual(result.targets, { GITHUB: true });
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.url.startsWith("https://api.github.com/repos/Tedclub/my-tool-v1/")));
});

const testToken = "test-only-secret";
const githubConfig = {
  SNAPSHOT_GITHUB_REPOSITORY: "Tedclub/my-tool-v1",
  SNAPSHOT_GITHUB_BRANCH: "v2-snapshots",
  GITHUB_SNAPSHOT_TOKEN: testToken
};

function githubResponse(url) {
  const path = new URL(url).pathname;
  if (path.endsWith("/git/ref/heads/v2-snapshots")) return Response.json({ object: { sha: "head" } });
  if (path.endsWith("/git/commits/head")) return Response.json({ tree: { sha: "tree" } });
  if (path.endsWith("/git/trees/tree")) return Response.json({ tree: [], truncated: false });
  return Response.json({ sha: "next" });
}

for (const [name, failure, reason, atPatch] of [
  ["subrequest limit", () => { throw Error("Too many subrequests " + testToken); }, "SUBREQUEST_LIMIT", true],
  ["type error", () => { throw TypeError(testToken); }, "TYPE_ERROR", false],
  ["unknown error", () => { throw Error("GITHUB_HTTP_418 " + testToken); }, "UNKNOWN_ERROR", false],
  ["HTTP 418", () => new Response(testToken, { status: 418 }), "GITHUB_HTTP_418", false],
  ["HTTP 422 conflict", () => new Response(testToken, { status: 422 }), "GITHUB_HTTP_422", true],
  ["timeout", () => { throw new DOMException(testToken, "TimeoutError"); }, "REQUEST_TIMEOUT", false],
  ["JSON parse failure", () => new Response(testToken), "UNKNOWN_ERROR", false]
]) test("GitHub diagnostics classify " + name, async t => {
  const warn = t.mock.method(console, "warn", () => {});
  const result = await exportCompletedSnapshot(githubConfig, () => Response.json(copy(full)), {
    fetcher: async (url, options) => atPatch && options.method !== "PATCH" ? githubResponse(url) : failure()
  });
  const diagnostic = { reason, stage: atPatch ? "patch_ref" : "get_ref" };
  assert.deepEqual(result.targets, { GITHUB: false });
  assert.deepEqual(result.failures, { GITHUB: diagnostic });
  const log = warn.mock.calls[0].arguments[0];
  assert.deepEqual(JSON.parse(log), { event: "GITHUB_SNAPSHOT_EXPORT_FAILED", ...diagnostic });
  assert.ok(!log.includes(testToken));
  assert.ok(!JSON.stringify(result).includes(testToken));
});

test("reference list skips 302 after one manual fetch", async t => {
  const warn = t.mock.method(console, "warn", () => {});
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 302, headers: { Location: "https://example.invalid/" + testToken } }));
  assert.equal(await fetchJsonOrEmpty("https://example.invalid/list"), null);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(fetchMock.mock.calls[0].arguments[1], {
    redirect: "manual", headers: { Accept: "application/json" }
  });
  assert.deepEqual(JSON.parse(warn.mock.calls[0].arguments[0]), {
    event: "reference_list_redirect_skipped", status: 302
  });
});

test("reference list still parses 200 JSON", async t => {
  const payload = [{ Code: "2330" }];
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  assert.deepEqual(await fetchJsonOrEmpty("https://example.invalid/list"), payload);
});

function mockExportDb(scanDate) {
  const statements = [];
  const sqlRead = {
    stock_id: "2330", market: "TWSE", trade_date: scanDate, joined_price_date: scanDate,
    daily_volume: 100, ma5: 100, ma20: 95, volume_ratio: 2, rs_excess_20_percent: 3,
    rs_rank: 1, eligible: 1, trend_stage: "BULLISH_ALIGNMENT",
    export_scan_date: scanDate, export_twse_date: scanDate, export_total_count: 1,
    export_twse_rows: 1, export_twse_adjusted: 1, export_twse_index: 1,
    export_read_integrity: JSON.stringify({ TWSE: {
      price_rows: 1, recorded_price_rows: 1, adjusted_presence_recorded: 1,
      index_presence_recorded: 1, index_rows: 1, scanner_rows: 1, expected_scanner_rows: 1,
      missing_scanner_rows: 0, unexpected_scanner_rows: 0, candidate_rows: 1
    }, TPEX: null })
  };
  return {
    statements,
    prepare(sql) {
      statements.push(sql);
      return {
        sql,
        first: async () => ({ name: "backfill_progress" }),
        all: async () => ({ results: [sqlRead] }),
        run: async () => ({ success: true })
      };
    },
    batch: async queries => queries.map(() => ({ success: true }))
  };
}

const exportRequest = (token = testToken) => new Request("https://example.invalid/admin/export-snapshot", {
  method: "POST", headers: { Authorization: "Bearer " + token }
});

const sentinel = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backfill_progress'";
for (const [name, admin, flag, status] of [
  ["missing admin secret", undefined, "true", 503],
  ["incorrect admin token", "different-test-token", "true", 401],
  ["disabled", testToken, "false", 409]
]) test("manual export rejects " + name, async t => {
  const DB = mockExportDb(full.scan_date);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const result = await worker.fetch(exportRequest(), {
    DB, ...githubConfig, ADMIN_TOKEN: admin, STATIC_SNAPSHOT_EXPORT_ENABLED: flag
  });
  const body = await result.json();
  assert.equal(result.status, status);
  assert.equal(body.ok, false);
  if (status === 503) assert.deepEqual(body, { ok: false, reason: "ADMIN_NOT_CONFIGURED" });
  if (status === 401) assert.deepEqual(body, { ok: false, reason: "UNAUTHORIZED" });
  if (status === 409) assert.deepEqual(body, { ok: false, reason: "EXPORT_DISABLED" });
  assert.deepEqual(DB.statements, [sentinel]);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.ok(!JSON.stringify(body).includes(testToken));
});

test("manual export sanitizes an unexpected D1 exception", async () => {
  const result = await worker.fetch(exportRequest(), {
    ADMIN_TOKEN: testToken, STATIC_SNAPSHOT_EXPORT_ENABLED: "true",
    DB: { prepare() { throw Error(testToken); } }
  });
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { ok: false, reason: "UNKNOWN_ERROR" });
});

for (const [name, scanDate, githubStatus, status] of [
  ["succeeds", full.scan_date, 200, 200],
  ["reports GitHub failure", full.scan_date, 418, 503],
  ["rejects a stale snapshot", "2026-10-22", 200, 503]
]) test("manual export " + name + " without market fetches or D1 writes", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const DB = mockExportDb(scanDate);
  const fetchMock = t.mock.method(globalThis, "fetch", async url => githubStatus === 200
    ? githubResponse(url) : new Response(testToken, { status: githubStatus }));
  const result = await worker.fetch(exportRequest(), {
    DB, ...githubConfig, ADMIN_TOKEN: testToken, STATIC_SNAPSHOT_EXPORT_ENABLED: "true"
  });
  const body = await result.json();
  assert.equal(result.status, status);
  assert.equal(body.ok, status === 200);
  assert.equal(DB.statements.length, 2);
  assert.equal(DB.statements[0], sentinel);
  assert.match(DB.statements[1], /^\s*WITH latest AS/);
  assert.ok(DB.statements.every(sql => !/\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)));
  assert.ok(fetchMock.mock.calls.every(call => new URL(call.arguments[0]).hostname === "api.github.com"));
  assert.ok(!JSON.stringify(body).includes(testToken));
  if (scanDate !== full.scan_date) {
    assert.equal(body.prepared, false);
    assert.match(body.reason, /SNAPSHOT_NOT_CURRENT/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } else {
    assert.equal(body.targets.GITHUB, status === 200);
    assert.equal(fetchMock.mock.callCount(), status === 200 ? 6 : 1);
    if (status === 503) assert.deepEqual(body.failures.GITHUB, { reason: "GITHUB_HTTP_418", stage: "get_ref" });
  }
});
