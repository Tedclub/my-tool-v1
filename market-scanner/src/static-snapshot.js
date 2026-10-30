// Downstream publishing only. No D1 writes, Scanner formulas or read API changes.
import { COMPACT_FIELDS, snapshotHash } from "./scanner-read.js";
import { expectedTradeDate } from "./trading-calendar.js";

const HASH = /^sha256:[a-f0-9]{64}$/;
const FILES = ["summary.json", "TWSE-compact.json", "manifest.json"];
const json = value => JSON.stringify(value) + "\n";

export function validateStaticSnapshot(manifest, summary, compact, now = new Date()) {
  const expected = expectedTradeDate(now);
  const warnings = [];
  if (!expected) warnings.push("EXPECTED_TRADE_DATE_UNVERIFIED");
  if (!HASH.test(manifest.snapshot_hash || "") ||
      manifest.snapshot_hash !== summary.snapshot_hash || manifest.snapshot_hash !== compact.snapshot_hash)
    warnings.push("SNAPSHOT_HASH_MISMATCH");
  for (const body of [manifest, summary, compact]) {
    if (!expected || body.scan_date !== expected || body.expected_trade_date !== expected)
      warnings.push("SNAPSHOT_NOT_CURRENT");
    const market = body.markets?.TWSE;
    if (!market || market.latest_price_date !== expected || market.fresh !== true ||
        market.dates_consistent !== true || market.integrity_verified !== true)
      warnings.push("TWSE_DATA_UNVERIFIED");
  }
  const count = manifest.markets?.TWSE?.candidate_count;
  if (!Number.isInteger(count) || count <= 0 || summary.markets?.TWSE?.candidate_count !== count ||
      compact.candidate_count !== count || compact.returned_count !== count ||
      compact.markets?.TWSE?.candidate_count !== count || compact.candidates?.length !== count ||
      compact.market !== "TWSE" || compact.compact !== true ||
      summary.pool_complete !== true || compact.pool_complete !== true || compact.truncated !== false)
    warnings.push("CANDIDATE_POOL_INCOMPLETE");
  if (compact.fresh !== true) warnings.push("TWSE_DATA_UNVERIFIED");
  const rows = compact.candidates || [];
  if (new Set(rows.map(row => row.stock_id)).size !== rows.length || rows.some(row =>
    row.market !== "TWSE" || row.scan_date !== manifest.scan_date ||
    !["BULLISH_ALIGNMENT", "STRENGTHENING", "BREAKOUT_CANDIDATE"].includes(row.scanner_status) ||
    COMPACT_FIELDS.some(field => !Object.hasOwn(row, field)))) warnings.push("CANDIDATE_FIELDS_INVALID");
  return { ok: warnings.length === 0, warnings: [...new Set(warnings)] };
}

export async function buildStaticSnapshot(full, { allowStale = false } = {}) {
  // Reuse the existing hash definition; verify it rather than inventing a static hash.
  const reconstructed = { ...full, _read_integrity: Object.fromEntries(
    Object.entries(full.markets || {}).map(([market, value]) => [market, value.checks])) };
  if (!HASH.test(full.snapshot_hash || "") || await snapshotHash(reconstructed) !== full.snapshot_hash)
    throw new Error("PRIMARY_SNAPSHOT_HASH_INVALID");
  const { candidates, definitions, unavailable_fields, ...summary } = full;
  const market = full.markets?.TWSE;
  const rows = (candidates || []).filter(row => row.market === "TWSE");
  const compact = {
    ...summary, market: "TWSE", compact: true, snapshot_fresh: full.fresh,
    snapshot_dates_consistent: full.dates_consistent,
    total_count: market?.candidate_count, candidate_count: rows.length, returned_count: rows.length,
    fresh: market?.fresh === true, dates_consistent: market?.dates_consistent === true,
    scope: "fresh_market_eligible_signal_candidates", requested_scan_date: full.scan_date,
    candidates: rows.map(row => Object.fromEntries(COMPACT_FIELDS.map(field => [field, row[field] ?? null])))
  };
  const safeHash = full.snapshot_hash.slice(7);
  const immutable = "v2/snapshots/" + safeHash + "/";
  const manifest = {
    schema_version: 1, scan_date: full.scan_date, expected_trade_date: full.expected_trade_date,
    response_id: full.response_id, response_generated_at: full.response_generated_at,
    snapshot_hash: full.snapshot_hash, snapshot_hash_version: full.snapshot_hash_version,
    candidate_count: full.candidate_count, pool_complete: full.pool_complete,
    market_data_complete: full.market_data_complete, fresh: full.fresh,
    dates_consistent: full.dates_consistent, latest_price_dates: full.latest_price_dates,
    markets: full.markets, warnings: full.warnings, calendar: full.calendar,
    // Relative immutable targets remain valid at latest, date archive and hash paths.
    files: { summary: "../snapshots/" + safeHash + "/summary.json",
      twse_compact: "../snapshots/" + safeHash + "/TWSE-compact.json" },
    integrity_basis: full.integrity_basis, integrity_limit: full.integrity_limit
  };
  const check = validateStaticSnapshot(manifest, summary, compact, new Date(full.response_generated_at));
  // A one-time bootstrap may preserve a stale recorded snapshot verbatim so
  // clients can independently read it and DATA FAIL. It must never claim fresh.
  const bootstrapAllowed = allowStale && check.warnings.every(code =>
    ["SNAPSHOT_NOT_CURRENT", "TWSE_DATA_UNVERIFIED", "CANDIDATE_POOL_INCOMPLETE"].includes(code)) &&
    market?.integrity_verified === true && market?.dates_consistent === true &&
    full.pool_complete === true && full.truncated === false &&
    rows.length > 0 && rows.length === market?.candidate_count &&
    rows.every(row => row.scan_date === full.scan_date && row.market === "TWSE");
  if (!check.ok && !bootstrapAllowed) throw new Error(check.warnings.join(","));
  return { manifest, summary, compact, immutable,
    files: { "manifest.json": json(manifest), "summary.json": json(summary), "TWSE-compact.json": json(compact) } };
}

function manifestAt(bundle, prefix) {
  if (prefix === "v2/latest/") return bundle.files["manifest.json"];
  const safeHash = bundle.manifest.snapshot_hash.slice(7);
  return json({ ...bundle.manifest, files: {
    summary: "../../snapshots/" + safeHash + "/summary.json",
    twse_compact: "../../snapshots/" + safeHash + "/TWSE-compact.json"
  } });
}

export async function publishR2(bundle, bucket) {
  if (!bucket) throw new Error("R2_NOT_CONFIGURED");
  const put = (key, value, immutable = false, onlyNew = false) => bucket.put(key, value, {
    httpMetadata: { contentType: "application/json; charset=utf-8",
      cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    ...(onlyNew ? { onlyIf: { etagDoesNotMatch: "*" } } : {})
  });
  // Never overwrite immutable files. Different exports of unchanged data can carry
  // different response IDs/times, so the first confirmed snapshot representation wins.
  for (const name of FILES) await put(bundle.immutable + name,
    name === "manifest.json" ? manifestAt(bundle, bundle.immutable) : bundle.files[name], true, true);
  const archive = "v2/archive/" + bundle.manifest.scan_date + "/";
  const oldArchive = await bucket.get(archive + "manifest.json");
  if (oldArchive) {
    const old = await oldArchive.json();
    if (old.snapshot_hash !== bundle.manifest.snapshot_hash) throw new Error("ARCHIVE_DATE_CONFLICT");
  } else {
    for (const name of FILES) await put(archive + name,
      name === "manifest.json" ? manifestAt(bundle, archive) : bundle.files[name], true, true);
  }
  // Both aliases are written before the marker. Readers MUST use manifest.files,
  // not mutable aliases; an interrupted publish leaves the old marker usable.
  for (const name of ["summary.json", "TWSE-compact.json", "manifest.json"])
    await put("v2/latest/" + name, bundle.files[name]);
}

export async function publishGitHub(bundle, config, token, fetcher = fetch) {
  if (!token) throw new Error("GITHUB_NOT_CONFIGURED");
  const { repository, branch } = config;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || branch !== "v2-snapshots")
    throw new Error("INVALID_GITHUB_TARGET");
  const root = "https://api.github.com/repos/" + repository;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "V2-static-snapshot-publisher", Authorization: "Bearer " + token,
    "Content-Type": "application/json" };
  const api = async (path, method = "GET", body) => {
    const response = await fetcher(root + path, { method, headers,
      signal: AbortSignal.timeout(15000), ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error("GITHUB_HTTP_" + response.status);
    return response.json();
  };
  // This branch must contain only static data files, never application files/main.
  const ref = await api("/git/ref/heads/" + branch);
  const head = await api("/git/commits/" + ref.object.sha);
  const current = await api("/git/trees/" + head.tree.sha + "?recursive=1");
  if (current.truncated || current.tree.some(entry => entry.type === "blob" &&
      !entry.path.startsWith("v2/") && entry.path !== "README.md")) throw new Error("GITHUB_BRANCH_NOT_DATA_ONLY");
  const existing = new Set(current.tree.map(entry => entry.path));
  const archive = "v2/archive/" + bundle.manifest.scan_date + "/";
  if (existing.has(archive + "manifest.json")) {
    const old = await api("/contents/" + archive + "manifest.json?ref=" + branch);
    const value = JSON.parse(atob(old.content.replace(/\s/g, "")));
    if (value.snapshot_hash !== bundle.manifest.snapshot_hash) throw new Error("ARCHIVE_DATE_CONFLICT");
  }
  const tree = [];
  for (const prefix of [bundle.immutable, archive, "v2/latest/"]) for (const name of FILES) {
    const path = prefix + name;
    if (prefix !== "v2/latest/" && existing.has(path)) continue;
    tree.push({ path, mode: "100644", type: "blob",
      content: name === "manifest.json" ? manifestAt(bundle, prefix) : bundle.files[name] });
  }
  const next = await api("/git/trees", "POST", { base_tree: head.tree.sha, tree });
  const commit = await api("/git/commits", "POST", {
    message: "Publish V2 snapshot " + bundle.manifest.scan_date + " " + bundle.manifest.snapshot_hash,
    tree: next.sha, parents: [ref.object.sha]
  });
  // Git tree update makes all files visible atomically; no forced ref updates.
  await api("/git/refs/heads/" + branch, "PATCH", { sha: commit.sha, force: false });
  return commit.sha;
}

export async function exportCompletedSnapshot(env, loadFullSnapshot, options = {}) {
  let bundle;
  try {
    const response = await loadFullSnapshot();
    if (!response.ok) throw new Error("PRIMARY_UNAVAILABLE");
    bundle = await buildStaticSnapshot(await response.json());
  } catch {
    console.warn(JSON.stringify({ event: "STATIC_SNAPSHOT_EXPORT_SKIPPED" }));
    return { prepared: false };
  }
  const outcomes = {};
  for (const [target, action] of [
    ...(env.SNAPSHOT_R2_ENABLED === "true" ? [["R2", () => publishR2(bundle, env.V2_SNAPSHOTS)]] : []),
    ["GITHUB", () => publishGitHub(bundle, {
      repository: env.SNAPSHOT_GITHUB_REPOSITORY, branch: env.SNAPSHOT_GITHUB_BRANCH
    }, env.GITHUB_SNAPSHOT_TOKEN, options.fetcher)]
  ]) {
    try { await action(); outcomes[target] = true; }
    catch { outcomes[target] = false; console.warn(JSON.stringify({ event: target + "_SNAPSHOT_EXPORT_FAILED" })); }
  }
  console.log(JSON.stringify({ event: "STATIC_SNAPSHOT_EXPORT", scan_date: bundle.manifest.scan_date,
    snapshot_hash: bundle.manifest.snapshot_hash, targets: outcomes }));
  return { prepared: true, snapshot_hash: bundle.manifest.snapshot_hash, targets: outcomes };
}
