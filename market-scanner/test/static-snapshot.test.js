import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
    assert.ok(logs.some(line => line.includes("R2_SNAPSHOT_EXPORT_FAILED")));
    assert.ok(logs.some(line => line.includes("GITHUB_SNAPSHOT_EXPORT_FAILED")));
    assert.ok(!logs.join("").includes("never-log-me"));
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
