import { expectedTradeDate, CALENDAR_METADATA } from "./trading-calendar.js";

export const SCANNER_READ_PATHS = new Set([
  "/api/v2/scanner/latest", "/api/v2/scanner/summary", "/api/v2/scanner/candidates"
]);
export const COMPACT_FIELDS = Object.freeze([
  "scan_date", "market", "stock_id", "stock_name", "close", "ma5", "ma20",
  "ma5_slope", "ma20_slope", "prior_20d_high", "volume", "volume_ratio",
  "r5", "risk_percent", "ma20_deviation_percent", "distance_to_20d_high_percent",
  "rs_excess_20_percent", "rs_rank", "bullish_alignment", "strengthening",
  "price_breakout", "volume_confirmed", "scanner_status"
]);
const MARKETS = ["TWSE", "TPEX"];
const INTEGRITY_LIMIT = "Checks validate recorded ingestion counts, index presence, stored Scanner coverage and candidate fields; not the upstream exchange universe, historical adjustment quality, or a completed immutable Scanner run.";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

export async function snapshotHash(base) {
  const stable = {
    hash_version: "v2-snapshot-sha256-1", api_version: base.api_version,
    scan_date: base.scan_date, latest_price_dates: base.latest_price_dates,
    pool_complete: base.pool_complete, market_data_complete: base.market_data_complete,
    candidate_count: (base.candidates || []).length,
    checks: base._read_integrity || {}, candidates: base.candidates || []
  };
  const bytes = new TextEncoder().encode(canonicalJson(stable));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
}

export async function snapshotMetadata(base, now = new Date()) {
  const expected = expectedTradeDate(now);
  const candidates = base.candidates || [];
  const warnings = [...(base.warnings || [])];
  const warn = code => { if (!warnings.includes(code)) warnings.push(code); };
  if (!expected) warn("EXPECTED_TRADE_DATE_UNVERIFIED");
  if (expected && base.scan_date !== expected) warn("SCAN_DATE_NOT_EXPECTED_TRADE_DATE");
  const markets = {};
  for (const market of MARKETS) {
    const rows = candidates.filter(row => row.market === market);
    const checks = base._read_integrity?.[market];
    const date = base.latest_price_dates?.[market] || null;
    const dateConsistent = Boolean(base.scan_date && date === base.scan_date &&
      rows.every(row => row.scan_date === base.scan_date && row.trade_date === base.scan_date));
    const candidateFieldsValid = rows.every(row =>
      row.volume != null && row.ma5 != null && row.ma20 != null && row.volume_ratio != null &&
      row.rs_excess_20_percent != null && row.rs_rank != null && row.eligible === 1 && row.trend_stage !== "NONE"
    ) && new Set(rows.map(row => row.stock_id)).size === rows.length;
    const integrity = Boolean(checks &&
      Number.isInteger(checks.price_rows) && checks.price_rows > 0 &&
      checks.recorded_price_rows === checks.price_rows &&
      checks.adjusted_presence_recorded === 1 && checks.index_presence_recorded === 1 && checks.index_rows === 1 &&
      checks.scanner_rows > 0 && checks.expected_scanner_rows === checks.scanner_rows &&
      checks.missing_scanner_rows === 0 && checks.unexpected_scanner_rows === 0 &&
      checks.candidate_rows === rows.length && candidateFieldsValid);
    const current = Boolean(expected && date === expected && base.scan_date === expected);
    const marketWarnings = [];
    if (!current) marketWarnings.push(market + "_DATA_NOT_EXPECTED_TRADE_DATE");
    if (!dateConsistent) marketWarnings.push(market + "_DATES_INCONSISTENT");
    if (!integrity) marketWarnings.push(market + "_INTEGRITY_UNVERIFIED");
    if (!candidateFieldsValid) marketWarnings.push(market + "_CANDIDATE_FIELDS_INVALID");
    marketWarnings.forEach(warn);
    markets[market] = {
      latest_price_date: date, fresh: current && dateConsistent && integrity,
      candidate_count: rows.length, dates_consistent: dateConsistent,
      integrity_verified: integrity, checks: checks || null, warnings: marketWarnings
    };
  }
  const datesConsistent = MARKETS.every(market => markets[market].dates_consistent) &&
    candidates.every(row => MARKETS.includes(row.market));
  return {
    retrieval_version: "v2-retrieval-1", snapshot_hash_version: "v2-snapshot-sha256-1",
    snapshot_hash: await snapshotHash(base),
    expected_trade_date: expected, scan_date: base.scan_date || null,
    fresh: Boolean(base.pool_complete && datesConsistent && MARKETS.every(market => markets[market].fresh)),
    dates_consistent: datesConsistent, candidate_count: candidates.length,
    fresh_candidate_count: candidates.filter(row => markets[row.market]?.fresh).length,
    snapshot_candidate_count: candidates.length,
    markets, warnings, calendar: CALENDAR_METADATA,
    integrity_basis: "recorded_ingestion_counts_index_presence_and_expected_scanner_key_coverage",
    integrity_limit: INTEGRITY_LIMIT
  };
}

function response(request, payload, status = 200) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-V2-Response-ID, X-V2-Scan-Date, X-V2-Generated-At",
    "X-V2-Response-ID": payload.response_id,
    "X-V2-Scan-Date": payload.scan_date || "",
    "X-V2-Generated-At": payload.response_generated_at,
    ...(status === 405 ? { Allow: "GET, OPTIONS" } : {})
  };
  // Audit metadata only: never log candidate bodies, secrets or request credentials.
  console.log(JSON.stringify({
    event: "v2_scanner_response", response_id: payload.response_id,
    response_generated_at: payload.response_generated_at,
    snapshot_hash: payload.snapshot_hash, scan_date: payload.scan_date,
    expected_trade_date: payload.expected_trade_date, fresh: payload.fresh,
    candidate_count: payload.candidate_count, market: payload.market || "ALL",
    markets: payload.markets ? Object.fromEntries(MARKETS.map(market => [market, {
      latest_price_date: payload.markets[market].latest_price_date,
      fresh: payload.markets[market].fresh, candidate_count: payload.markets[market].candidate_count
    }])) : null,
    compact: payload.compact === true, warnings: payload.warnings,
    endpoint: new URL(request.url).pathname, cf_ray: request.headers.get("cf-ray"),
    http_status: status, response_bytes: new TextEncoder().encode(body).length
  }));
  return new Response(body, { status, headers });
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function handleScannerRead(request, env, loadLegacySnapshot) {
  const responseId = crypto.randomUUID();
  const fail = (code, status, extra = {}) => response(request, {
    ok: false, response_id: responseId, response_generated_at: new Date().toISOString(),
    snapshot_hash: null, scan_date: null, expected_trade_date: expectedTradeDate(),
    fresh: false, dates_consistent: false, candidate_count: 0,
    warnings: [code], error: code, ...extra
  }, status);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"
  } });
  if (request.method !== "GET") return fail("METHOD_NOT_ALLOWED", 405);
  const url = new URL(request.url);
  const scoped = url.pathname.endsWith("/candidates");
  const market = (url.searchParams.get("market") || "").toUpperCase();
  const requestedDate = url.searchParams.get("scan_date");
  const compact = url.searchParams.get("compact") === "1";
  const requestedHash = url.searchParams.get("snapshot_hash");
  if (scoped) {
    if (!MARKETS.includes(market)) return fail("INVALID_MARKET", 400);
    if (!validDate(requestedDate)) return fail("INVALID_SCAN_DATE", 400);
    if (url.searchParams.has("compact") && !["0", "1"].includes(url.searchParams.get("compact"))) return fail("INVALID_COMPACT", 400);
    if (requestedHash && !/^sha256:[a-f0-9]{64}$/.test(requestedHash)) return fail("INVALID_SNAPSHOT_HASH", 400);
  }
  try {
    const legacy = await loadLegacySnapshot(env);
    if (!legacy.ok) return fail("SNAPSHOT_UNAVAILABLE", 503);
    const base = await legacy.json();
    const generated = new Date();
    const metadata = await snapshotMetadata(base, generated);
    const generatedAt = generated.toISOString();
    const { _read_integrity, ...compatible } = base;
    const full = { ...compatible, ...metadata, response_id: responseId,
      response_generated_at: generatedAt, exported_at: generatedAt,
      quality: { ...compatible.quality, warnings: metadata.warnings } };
    if (url.pathname.endsWith("/latest")) return response(request, full);
    const { candidates, definitions, unavailable_fields, ...summary } = full;
    if (!scoped) return response(request, summary);
    const selected = metadata.markets[market];
    const scopedMetadata = {
      ...summary, market, compact, snapshot_fresh: metadata.fresh,
      total_count: selected.candidate_count,
      snapshot_dates_consistent: metadata.dates_consistent,
      fresh: selected.fresh, dates_consistent: selected.dates_consistent,
      scope: "fresh_market_eligible_signal_candidates", requested_scan_date: requestedDate
    };
    const reject = code => response(request, {
      ...scopedMetadata, ok: false, fresh: false, error: code,
      candidate_count: 0, returned_count: 0, candidates: [],
      warnings: [...new Set([...metadata.warnings, code])]
    }, 409);
    if (requestedDate !== full.scan_date) return reject("SCAN_DATE_MISMATCH");
    if (requestedHash && requestedHash !== full.snapshot_hash) return reject("SNAPSHOT_CHANGED");
    if (!selected.fresh) return reject("MARKET_NOT_FRESH");
    const rows = candidates.filter(row => row.market === market);
    return response(request, {
      ...scopedMetadata, candidate_count: rows.length, returned_count: rows.length,
      candidates: compact ? rows.map(row => Object.fromEntries(COMPACT_FIELDS.map(field => [field, row[field] ?? null]))) : rows
    });
  } catch {
    return fail("SNAPSHOT_UNAVAILABLE", 503);
  }
}
