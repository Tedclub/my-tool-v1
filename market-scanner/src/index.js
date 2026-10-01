const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const BACKFILL_MAX_TRADING_DAYS = 10;
const MIN_TURNOVER = 20_000_000;
const MAX_MA20_DEVIATION_PERCENT = 15;
const RS_PERIOD = 20;
const TARGET_HISTORY_DAYS = 60;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    try {
      const url = new URL(request.url);
      await ensureSchema(env);

      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "taiwan-market-scanner",
          source: ["TWSE", "TPEx"]
        });
      }

      if (url.pathname === "/api/scan" && request.method === "GET") {
        return handleScan(url, env);
      }

      if (url.pathname === "/api/backfill-status" && request.method === "GET") {
        return json({ ok: true, ...(await getBackfillStatus(env)) });
      }

      if (url.pathname === "/admin/update" && request.method === "POST") {
        requireAdmin(request, env);
        const date = url.searchParams.get("date") || taipeiToday();
        const result = await updateOneDate(env, date);
        return json(result);
      }

      if (url.pathname === "/admin/backfill" && request.method === "POST") {
        requireAdmin(request, env);
        const days = clamp(
          parseInt(url.searchParams.get("days") || "10", 10),
          1,
          BACKFILL_MAX_TRADING_DAYS
        );
        const before = url.searchParams.get("before") || taipeiToday();
        const result = await backfillPriceHistory(env, days, before);
        return json(result);
      }

      if (url.pathname === "/admin/rebuild-latest" && request.method === "POST") {
        requireAdmin(request, env);
        const result = await rebuildLatestScanner(env);
        return json(result);
      }

      return json({
        ok: true,
        endpoints: {
          health: "GET /health",
          scan: "GET /api/scan?stage=BREAKOUT_CANDIDATE&limit=100",
          backfill_status: "GET /api/backfill-status",
          update: "POST /admin/update?date=YYYY-MM-DD",
          backfill: "POST /admin/backfill?days=10&before=YYYY-MM-DD",
          rebuild_latest: "POST /admin/rebuild-latest"
        }
      });
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      return json({ ok: false, error: error.message || String(error) }, status);
    }
  },

  async scheduled(controller, env) {
    await ensureSchema(env);
    if (controller.cron === "*/30 * * * *") {
      const status = await getBackfillStatus(env);
      if (
        status.tpex_trading_days >= TARGET_HISTORY_DAYS &&
        status.twse_adjusted_days >= TARGET_HISTORY_DAYS &&
        status.twse_index_days >= TARGET_HISTORY_DAYS &&
        status.tpex_index_days >= TARGET_HISTORY_DAYS
      ) {
        const rebuild = status.latest_rs_rows > 0
          ? { rebuilt: false, reason: "quality_metrics_current" }
          : await rebuildLatestScanner(env);
        console.log(JSON.stringify({ event: "backfill_complete", ...status, rebuild }));
        return;
      }

      const scheduledAt = new Date(controller.scheduledTime || Date.now());
      if (scheduledAt.getUTCMinutes() !== 0 || scheduledAt.getUTCHours() >= 10) return;

      const result = await backfillMissingHistory(env, 1);
      const nextStatus = await getBackfillStatus(env);
      if (
        nextStatus.tpex_trading_days >= TARGET_HISTORY_DAYS &&
        nextStatus.twse_adjusted_days >= TARGET_HISTORY_DAYS &&
        nextStatus.twse_index_days >= TARGET_HISTORY_DAYS &&
        nextStatus.tpex_index_days >= TARGET_HISTORY_DAYS &&
        nextStatus.latest_trade_date
      ) {
        if (nextStatus.latest_rs_rows === 0) await rebuildLatestScanner(env);
      }
      console.log(JSON.stringify({
        event: "backfill_batch",
        ...result,
        status: nextStatus
      }));
      return;
    }

    const result = await updateOneDate(env, taipeiToday());
    console.log(JSON.stringify({ event: "daily_update", ...result }));
  }
};

async function ensureSchema(env) {
  const sentinel = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'market_indices'"
  ).first();
  if (sentinel?.name === "market_indices") return;

  const dailyColumns = new Set(((await env.DB.prepare("PRAGMA table_info(daily_prices)").all()).results || [])
    .map(row => row.name));
  const scannerColumns = new Set(((await env.DB.prepare("PRAGMA table_info(scanner_results)").all()).results || [])
    .map(row => row.name));

  const statements = [];
  const addColumn = (table, columns, name, definition) => {
    if (!columns.has(name)) statements.push(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };

  addColumn("daily_prices", dailyColumns, "reference_price", "REAL");
  addColumn("daily_prices", dailyColumns, "last_ask_price", "REAL");
  addColumn("daily_prices", dailyColumns, "last_ask_volume", "INTEGER");
  addColumn("daily_prices", dailyColumns, "security_type", "TEXT NOT NULL DEFAULT 'COMMON_STOCK'");
  addColumn("daily_prices", dailyColumns, "is_restricted", "INTEGER NOT NULL DEFAULT 0");

  addColumn("scanner_results", scannerColumns, "amount", "INTEGER");
  addColumn("scanner_results", scannerColumns, "ma20_deviation_percent", "REAL");
  addColumn("scanner_results", scannerColumns, "distance_to_20d_high_percent", "REAL");
  addColumn("scanner_results", scannerColumns, "stock_return_20_percent", "REAL");
  addColumn("scanner_results", scannerColumns, "benchmark_return_20_percent", "REAL");
  addColumn("scanner_results", scannerColumns, "rs_excess_20_percent", "REAL");
  addColumn("scanner_results", scannerColumns, "rs_rank", "REAL");
  addColumn("scanner_results", scannerColumns, "adjusted_price_used", "INTEGER NOT NULL DEFAULT 0");
  addColumn("scanner_results", scannerColumns, "is_liquid", "INTEGER NOT NULL DEFAULT 0");
  addColumn("scanner_results", scannerColumns, "is_limit_up_locked", "INTEGER NOT NULL DEFAULT 0");
  addColumn("scanner_results", scannerColumns, "is_restricted", "INTEGER NOT NULL DEFAULT 0");
  addColumn("scanner_results", scannerColumns, "eligible", "INTEGER NOT NULL DEFAULT 1");

  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (error) {
      if (!String(error.message || error).toLowerCase().includes("duplicate column")) throw error;
    }
  }

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_daily_prices_market_date ON daily_prices (market, trade_date DESC)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_scanner_results_date_eligible_rs ON scanner_results (trade_date DESC, eligible, rs_rank DESC)"
  ).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `).run();
  await env.DB.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql')").run();
  await env.DB.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_scanner_quality.sql')").run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS market_indices (
      market TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      index_name TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (market, trade_date)
    )
  `).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_market_indices_date ON market_indices (trade_date DESC, market)"
  ).run();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    const err = new Error("ADMIN_TOKEN secret is not configured");
    err.status = 503;
    throw err;
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth !== "Bearer " + env.ADMIN_TOKEN) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return map.year + "-" + map.month + "-" + map.day;
}

function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function toTwseDate(isoDate) {
  return isoDate.replaceAll("-", "");
}

function toRocDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return (y - 1911) + "/" + String(m).padStart(2, "0") + "/" + String(d).padStart(2, "0");
}

function n(value) {
  if (value == null) return null;
  const s = String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/−/g, "-");
  if (!s || s === "--" || s === "---" || s === "-" || s === "除權" || s === "除息") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function signedChange(sign, value) {
  const amount = n(value);
  if (!Number.isFinite(amount)) return null;
  return cleanText(sign).includes("-") ? -Math.abs(amount) : Math.abs(amount);
}

function referencePrice(close, change) {
  if (!Number.isFinite(close) || !Number.isFinite(change)) return null;
  const value = close - change;
  return value > 0 ? value : null;
}

function isCommonStockCode(code) {
  return /^\d{4}$/.test(code) && !code.startsWith("0") && !code.startsWith("91");
}

function findFieldIndex(fields, candidates) {
  return fields.findIndex(f => {
    const text = cleanText(f);
    return candidates.some(c => text.includes(c));
  });
}

function pickMarketTable(payload) {
  const tables = Array.isArray(payload.tables) ? payload.tables : [];
  return tables.find(t => {
    const fields = Array.isArray(t.fields) ? t.fields.map(cleanText) : [];
    return fields.some(f => f.includes("證券代號") || f === "代號") &&
           fields.some(f => f.includes("收盤"));
  }) || null;
}

async function fetchTwse(date, restrictedCodes = new Set()) {
  const url =
    "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX" +
    "?date=" + encodeURIComponent(toTwseDate(date)) +
    "&type=ALLBUT0999&response=json";

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "taiwan-market-scanner/1.0"
    }
  });
  if (!res.ok) throw new Error("TWSE HTTP " + res.status);

  const body = await res.json();
  if (body.stat !== "OK") return { prices: [], index: null };

  const table = pickMarketTable(body);
  if (!table) return { prices: [], index: null };

  const indexTable = (body.tables || []).find(t =>
    Array.isArray(t.fields) && t.fields.some(f => cleanText(f).includes("收盤指數"))
  );
  const indexRow = indexTable?.data?.find(row =>
    cleanText(row[0]).includes("發行量加權股價指數")
  );
  const indexClose = indexRow ? n(indexRow[1]) : null;

  const fields = table.fields.map(cleanText);
  const idx = {
    code: findFieldIndex(fields, ["證券代號", "代號"]),
    name: findFieldIndex(fields, ["證券名稱", "名稱"]),
    volume: findFieldIndex(fields, ["成交股數"]),
    tx: findFieldIndex(fields, ["成交筆數"]),
    amount: findFieldIndex(fields, ["成交金額"]),
    open: findFieldIndex(fields, ["開盤價", "開盤"]),
    high: findFieldIndex(fields, ["最高價", "最高"]),
    low: findFieldIndex(fields, ["最低價", "最低"]),
    close: findFieldIndex(fields, ["收盤價", "收盤"]),
    sign: findFieldIndex(fields, ["漲跌(+/-)", "漲跌"]),
    change: findFieldIndex(fields, ["漲跌價差"]),
    ask: findFieldIndex(fields, ["最後揭示賣價", "最後賣價"]),
    askVolume: findFieldIndex(fields, ["最後揭示賣量", "最後賣量"])
  };

  const prices = table.data.map(row => {
    const stockId = cleanText(row[idx.code]);
    const close = n(row[idx.close]);
    const change = signedChange(row[idx.sign], row[idx.change]);
    return {
      market: "TWSE",
      stock_id: stockId,
      stock_name: cleanText(row[idx.name]),
      trade_date: date,
      open: n(row[idx.open]),
      high: n(row[idx.high]),
      low: n(row[idx.low]),
      close,
      volume: n(row[idx.volume]),
      amount: idx.amount >= 0 ? n(row[idx.amount]) : null,
      transactions: idx.tx >= 0 ? n(row[idx.tx]) : null,
      reference_price: referencePrice(close, change),
      last_ask_price: idx.ask >= 0 ? n(row[idx.ask]) : null,
      last_ask_volume: idx.askVolume >= 0 ? n(row[idx.askVolume]) : null,
      security_type: "COMMON_STOCK",
      is_restricted: restrictedCodes.has(stockId) ? 1 : 0
    };
  }).filter(r =>
    isCommonStockCode(r.stock_id) &&
    [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)
  );

  return {
    prices,
    index: Number.isFinite(indexClose)
      ? { market: "TWSE", trade_date: date, index_name: "發行量加權股價指數", close: indexClose }
      : null
  };
}

async function fetchTpexIndex(date, cache = new Map()) {
  const month = date.slice(0, 7);
  if (!cache.has(month)) {
    const url = "https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=" +
      encodeURIComponent(date.replaceAll("-", "/"));
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("TPEx index HTTP " + res.status);
    cache.set(month, await res.json());
  }
  const body = cache.get(month);
  const table = body?.tables?.[0];
  const row = table?.data?.find(item => cleanText(item[0]).replaceAll("/", "-") === date);
  const close = row ? n(row[4]) : null;
  return Number.isFinite(close)
    ? { market: "TPEX", trade_date: date, index_name: "櫃買指數", close }
    : null;
}

async function fetchTpex(date, restrictedCodes = new Set(), indexCache = new Map()) {
  const url =
    "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=" +
    encodeURIComponent(date.replaceAll("-", "/"));

  let res = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await fetch(url, {
        redirect: "manual",
        headers: {
          "Accept": "application/json",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          "Referer": "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/pricing.html",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
        }
      });
      if (res.ok) break;
      if (res.status >= 300 && res.status < 400) {
        console.warn(JSON.stringify({
          event: "tpex_fetch_redirect_skipped",
          date,
          status: res.status,
          location: res.headers.get("location") || null
        }));
        return { prices: [], index: null };
      }
      console.warn(JSON.stringify({
        event: "tpex_fetch_retry",
        date,
        attempt,
        status: res.status
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: "tpex_fetch_retry",
        date,
        attempt,
        error: error.message || String(error)
      }));
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }

  if (!res || !res.ok) {
    console.error(JSON.stringify({
      event: "tpex_fetch_skipped",
      date,
      status: res?.status || null
    }));
    return { prices: [], index: null };
  }

  let body;
  try {
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      throw new Error(`unexpected content type: ${contentType || "unknown"}`);
    }
    body = await res.json();
  } catch (error) {
    console.error(JSON.stringify({
      event: "tpex_fetch_skipped",
      date,
      status: res.status,
      error: error.message || String(error)
    }));
    return { prices: [], index: null };
  }

  const table = pickMarketTable(body);
  if (!table || !Array.isArray(table.data)) return { prices: [], index: null };

  const fields = table.fields.map(cleanText);
  const idx = {
    code: findFieldIndex(fields, ["代號", "證券代號"]),
    name: findFieldIndex(fields, ["名稱", "證券名稱"]),
    close: findFieldIndex(fields, ["收盤"]),
    open: findFieldIndex(fields, ["開盤"]),
    high: findFieldIndex(fields, ["最高"]),
    low: findFieldIndex(fields, ["最低"]),
    volume: findFieldIndex(fields, ["成交股數"]),
    amount: findFieldIndex(fields, ["成交金額"]),
    tx: findFieldIndex(fields, ["成交筆數"]),
    change: findFieldIndex(fields, ["漲跌"]),
    ask: findFieldIndex(fields, ["最後賣價"]),
    askVolume: findFieldIndex(fields, ["最後賣量"])
  };

  const prices = table.data.map(row => {
    const stockId = cleanText(row[idx.code]);
    const close = n(row[idx.close]);
    const change = n(row[idx.change]);
    return {
      market: "TPEX",
      stock_id: stockId,
      stock_name: cleanText(row[idx.name]),
      trade_date: date,
      open: n(row[idx.open]),
      high: n(row[idx.high]),
      low: n(row[idx.low]),
      close,
      volume: n(row[idx.volume]),
      amount: idx.amount >= 0 ? n(row[idx.amount]) : null,
      transactions: idx.tx >= 0 ? n(row[idx.tx]) : null,
      reference_price: referencePrice(close, change),
      last_ask_price: idx.ask >= 0 ? n(row[idx.ask]) : null,
      last_ask_volume: idx.askVolume >= 0 ? n(row[idx.askVolume]) : null,
      security_type: "COMMON_STOCK",
      is_restricted: restrictedCodes.has(stockId) ? 1 : 0
    };
  }).filter(r =>
    isCommonStockCode(r.stock_id) &&
    [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)
  );

  return { prices, index: await fetchTpexIndex(date, indexCache) };
}

async function fetchJsonOrEmpty(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.warn(JSON.stringify({ event: "reference_list_skipped", url, error: error.message || String(error) }));
    return null;
  }
}

async function fetchRestrictedCodes(date) {
  const [twseAltered, twseDisposal, tpexAltered, tpexDisposal] = await Promise.all([
    fetchJsonOrEmpty("https://openapi.twse.com.tw/v1/exchangeReport/TWT85U"),
    fetchJsonOrEmpty("https://openapi.twse.com.tw/v1/announcement/punish"),
    fetchJsonOrEmpty("https://www.tpex.org.tw/www/zh-tw/afterTrading/chtm?date=" + encodeURIComponent(date.replaceAll("-", "/"))),
    fetchJsonOrEmpty("https://www.tpex.org.tw/www/zh-tw/bulletin/disposal")
  ]);

  const twse = new Set();
  for (const row of Array.isArray(twseAltered) ? twseAltered : []) {
    if (row.Code) twse.add(cleanText(row.Code));
  }
  for (const row of Array.isArray(twseDisposal) ? twseDisposal : []) {
    if (row.Code) twse.add(cleanText(row.Code));
  }

  const tpex = new Set();
  for (const row of tpexAltered?.tables?.[0]?.data || []) {
    if (row[0]) tpex.add(cleanText(row[0]));
  }
  for (const row of tpexDisposal?.tables?.[0]?.data || []) {
    if (row[2]) tpex.add(cleanText(row[2]));
  }
  return { TWSE: twse, TPEX: tpex };
}

async function fetchMarketDay(date, { includeRestrictions = false, indexCache = new Map() } = {}) {
  const restricted = includeRestrictions
    ? await fetchRestrictedCodes(date)
    : { TWSE: new Set(), TPEX: new Set() };
  const [twse, tpex] = await Promise.all([
    fetchTwse(date, restricted.TWSE),
    fetchTpex(date, restricted.TPEX, indexCache)
  ]);
  return { twse, tpex };
}

async function insertPrices(env, rows) {
  if (!rows.length) return 0;

  const sql = `
    INSERT INTO daily_prices
      (market, stock_id, stock_name, trade_date, open, high, low, close, volume, amount, transactions,
       reference_price, last_ask_price, last_ask_volume, security_type, is_restricted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market, stock_id, trade_date) DO UPDATE SET
      stock_name = excluded.stock_name,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      amount = excluded.amount,
      transactions = excluded.transactions,
      reference_price = excluded.reference_price,
      last_ask_price = excluded.last_ask_price,
      last_ask_volume = excluded.last_ask_volume,
      security_type = excluded.security_type,
      is_restricted = excluded.is_restricted
    WHERE stock_name IS NOT excluded.stock_name
       OR open IS NOT excluded.open
       OR high IS NOT excluded.high
       OR low IS NOT excluded.low
       OR close IS NOT excluded.close
       OR volume IS NOT excluded.volume
       OR amount IS NOT excluded.amount
       OR transactions IS NOT excluded.transactions
       OR reference_price IS NOT excluded.reference_price
       OR last_ask_price IS NOT excluded.last_ask_price
       OR last_ask_volume IS NOT excluded.last_ask_volume
       OR security_type IS NOT excluded.security_type
       OR is_restricted IS NOT excluded.is_restricted
  `;

  let total = 0;
  const chunkSize = 80;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const stmts = chunk.map(r =>
      env.DB.prepare(sql).bind(
        r.market, r.stock_id, r.stock_name, r.trade_date,
        r.open, r.high, r.low, r.close,
        Math.round(r.volume),
        Number.isFinite(r.amount) ? Math.round(r.amount) : null,
        Number.isFinite(r.transactions) ? Math.round(r.transactions) : null,
        Number.isFinite(r.reference_price) ? r.reference_price : null,
        Number.isFinite(r.last_ask_price) ? r.last_ask_price : null,
        Number.isFinite(r.last_ask_volume) ? Math.round(r.last_ask_volume) : null,
        r.security_type || "COMMON_STOCK",
        r.is_restricted ? 1 : 0
      )
    );
    await env.DB.batch(stmts);
    total += chunk.length;
  }
  return total;
}

async function insertMarketIndices(env, rows) {
  const valid = rows.filter(row => row && Number.isFinite(row.close));
  if (!valid.length) return 0;
  const sql = `
    INSERT INTO market_indices (market, trade_date, index_name, close)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(market, trade_date) DO UPDATE SET
      index_name = excluded.index_name,
      close = excluded.close
    WHERE index_name IS NOT excluded.index_name OR close IS NOT excluded.close
  `;
  await env.DB.batch(valid.map(row =>
    env.DB.prepare(sql).bind(row.market, row.trade_date, row.index_name, row.close)
  ));
  return valid.length;
}

async function updateOneDate(env, date) {
  const { twse, tpex } = await fetchMarketDay(date, { includeRestrictions: true });

  const rows = [...twse.prices, ...tpex.prices];
  if (!rows.length) {
    return {
      ok: true,
      trade_date: date,
      trading_day: false,
      inserted: 0,
      message: "No market rows returned; likely a non-trading day or source not yet published."
    };
  }

  const inserted = await insertPrices(env, rows);
  const indices = await insertMarketIndices(env, [twse.index, tpex.index]);
  const scanned = await rebuildScannerForDate(env, date);

  return {
    ok: true,
    trade_date: date,
    trading_day: true,
    inserted,
    by_market: { TWSE: twse.prices.length, TPEX: tpex.prices.length },
    market_indices: indices,
    scanner_rows: scanned
  };
}

async function backfillPriceHistory(env, requestedDays, beforeDate) {
  let cursor = beforeDate;
  let tradingDays = 0;
  let calendarAttempts = 0;
  const maxCalendarAttempts = requestedDays * 3 + 10;
  const dates = [];
  const indexCache = new Map();

  while (tradingDays < requestedDays && calendarAttempts < maxCalendarAttempts) {
    const { twse, tpex } = await fetchMarketDay(cursor, { indexCache });
    const rows = [...twse.prices, ...tpex.prices];
    calendarAttempts++;

    if (rows.length) {
      const inserted = await insertPrices(env, rows);
      await insertMarketIndices(env, [twse.index, tpex.index]);
      tradingDays++;
      dates.push({
        date: cursor,
        inserted,
        by_market: { TWSE: twse.prices.length, TPEX: tpex.prices.length }
      });
    }

    cursor = addDays(cursor, -1);
  }

  return {
    ok: true,
    requested_trading_days: requestedDays,
    completed_trading_days: tradingDays,
    dates,
    next_before: cursor,
    scanner_rows: 0,
    note: "Price history only. Call POST /admin/rebuild-latest once after enough trading days are stored."
  };
}

async function backfillMissingHistory(env, requestedDays) {
  const existing = await env.DB.prepare(`
    SELECT DISTINCT trade_date
    FROM daily_prices
    WHERE market = 'TPEX'
    ORDER BY trade_date DESC
    LIMIT 120
  `).all();
  const existingDates = new Set((existing.results || []).map(row => row.trade_date));
  // The current trading day's official files may not be published yet. Starting
  // from yesterday also avoids TPEx's /errors redirect loop for future data.
  let cursor = addDays(taipeiToday(), -1);
  let completed = 0;
  let attempts = 0;
  const dates = [];
  const indexCache = new Map();

  // One trading day is normally found within four calendar days. Keep a small
  // ceiling so an upstream block cannot consume the Worker's subrequest quota.
  while (completed < requestedDays && attempts < 8) {
    attempts++;
    if (!existingDates.has(cursor)) {
      // Fetch TPEx first. If it has no rows, do not spend a TWSE subrequest on a
      // weekend, holiday, or unpublished date.
      const tpex = await fetchTpex(cursor, new Set(), indexCache);
      if (tpex.prices.length) {
        const twse = await fetchTwse(cursor, new Set());
        const rows = [...twse.prices, ...tpex.prices];
        const inserted = await insertPrices(env, rows);
        await insertMarketIndices(env, [twse.index, tpex.index]);
        dates.push({
          date: cursor,
          inserted,
          by_market: { TWSE: twse.prices.length, TPEX: tpex.prices.length }
        });
        completed++;
      }
    }
    cursor = addDays(cursor, -1);
  }

  return { ok: true, requested_trading_days: requestedDays, completed_trading_days: completed, dates };
}

async function getBackfillStatus(env) {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT trade_date) AS trading_days,
      MIN(trade_date) AS earliest_trade_date,
      MAX(trade_date) AS latest_trade_date,
      COUNT(*) AS price_rows,
      COUNT(DISTINCT CASE WHEN market = 'TWSE' THEN trade_date END) AS twse_trading_days,
      COUNT(DISTINCT CASE WHEN market = 'TPEX' THEN trade_date END) AS tpex_trading_days,
      COUNT(DISTINCT CASE WHEN market = 'TWSE' AND reference_price IS NOT NULL THEN trade_date END) AS twse_adjusted_days,
      COUNT(DISTINCT CASE WHEN market = 'TPEX' AND reference_price IS NOT NULL THEN trade_date END) AS tpex_adjusted_days,
      (SELECT COUNT(*) FROM market_indices WHERE market = 'TWSE') AS twse_index_days,
      (SELECT COUNT(*) FROM market_indices WHERE market = 'TPEX') AS tpex_index_days,
      (SELECT COUNT(*) FROM scanner_results
       WHERE trade_date = (SELECT MAX(trade_date) FROM scanner_results)
         AND rs_rank IS NOT NULL) AS latest_rs_rows
    FROM daily_prices
  `).first();

  return {
    trading_days: Number(row?.trading_days || 0),
    earliest_trade_date: row?.earliest_trade_date || null,
    latest_trade_date: row?.latest_trade_date || null,
    price_rows: Number(row?.price_rows || 0),
    twse_trading_days: Number(row?.twse_trading_days || 0),
    tpex_trading_days: Number(row?.tpex_trading_days || 0),
    twse_adjusted_days: Number(row?.twse_adjusted_days || 0),
    tpex_adjusted_days: Number(row?.tpex_adjusted_days || 0),
    twse_index_days: Number(row?.twse_index_days || 0),
    tpex_index_days: Number(row?.tpex_index_days || 0),
    latest_rs_rows: Number(row?.latest_rs_rows || 0)
  };
}

function sma(values, period, endIndex) {
  if (endIndex < period - 1) return null;
  let total = 0;
  for (let i = 0; i < period; i++) total += values[endIndex - i];
  return total / period;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function adjustmentFactors(rows) {
  const factors = Array(rows.length).fill(1);
  for (let i = rows.length - 2; i >= 0; i--) {
    const nextReference = Number(rows[i + 1].reference_price);
    const currentClose = Number(rows[i].close);
    const eventFactor = Number.isFinite(nextReference) && currentClose > 0
      ? nextReference / currentClose
      : 1;
    factors[i] = factors[i + 1] * (eventFactor > 0.2 && eventFactor < 5 ? eventFactor : 1);
  }
  return factors;
}

function percentileRanks(rows, valueKey, outputKey) {
  const byMarket = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row[valueKey])) continue;
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market).push(row);
  }
  for (const marketRows of byMarket.values()) {
    marketRows.sort((a, b) => a[valueKey] - b[valueKey]);
    const denominator = Math.max(1, marketRows.length - 1);
    marketRows.forEach((row, index) => {
      row[outputKey] = Math.round((index / denominator) * 1000) / 10;
    });
  }
}

async function rebuildLatestScanner(env) {
  const latest = await env.DB.prepare(
    "SELECT MAX(trade_date) AS trade_date FROM daily_prices"
  ).first();

  if (!latest?.trade_date) {
    return {
      ok: true,
      rebuilt: false,
      trade_date: null,
      scanner_rows: 0,
      message: "No price history is available."
    };
  }

  const scannerRows = await rebuildScannerForDate(env, latest.trade_date);
  return {
    ok: true,
    rebuilt: true,
    trade_date: latest.trade_date,
    scanner_rows: scannerRows
  };
}

async function rebuildLatestScannerIfNeeded(env, latestTradeDate) {
  if (!latestTradeDate) {
    return { rebuilt: false, trade_date: null, scanner_rows: 0 };
  }

  const latestScanner = await env.DB.prepare(
    "SELECT MAX(trade_date) AS trade_date FROM scanner_results"
  ).first();

  if (latestScanner?.trade_date === latestTradeDate) {
    return { rebuilt: false, trade_date: latestTradeDate, reason: "already_current" };
  }

  const scannerRows = await rebuildScannerForDate(env, latestTradeDate);
  return { rebuilt: true, trade_date: latestTradeDate, scanner_rows: scannerRows };
}

async function rebuildScannerForDate(env, tradeDate) {
  const prior = await env.DB.prepare(`
    SELECT market, stock_id, stock_name, trade_date, open, high, low, close, volume,
           amount, reference_price, last_ask_price, last_ask_volume, security_type, is_restricted
    FROM daily_prices
    WHERE trade_date IN (
      SELECT trade_date
      FROM daily_prices
      WHERE trade_date <= ?
      GROUP BY trade_date
      ORDER BY trade_date DESC
      LIMIT 30
    )
    ORDER BY stock_id ASC, trade_date ASC
  `).bind(tradeDate).all();

  const indexHistory = await env.DB.prepare(`
    SELECT market, trade_date, close
    FROM market_indices
    WHERE trade_date IN (
      SELECT trade_date
      FROM market_indices
      WHERE trade_date <= ?
      GROUP BY trade_date
      ORDER BY trade_date DESC
      LIMIT 30
    )
    ORDER BY market ASC, trade_date ASC
  `).bind(tradeDate).all();
  const indices = new Map();
  for (const row of indexHistory.results || []) {
    if (!indices.has(row.market)) indices.set(row.market, []);
    indices.get(row.market).push(row);
  }

  const grouped = new Map();
  for (const row of prior.results || []) {
    const key = row.market + ":" + row.stock_id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const results = [];

  for (const rows of grouped.values()) {
    const series = rows.slice(-30);
    if (series.length < 21) continue;
    const latest = series[series.length - 1];
    if (latest.trade_date !== tradeDate) continue;

    const factors = adjustmentFactors(series);
    const closes = series.map((r, i) => Number(r.close) * factors[i]);
    const highs = series.map((r, i) => Number(r.high) * factors[i]);
    const idx = closes.length - 1;
    const ma5 = sma(closes, 5, idx);
    const ma20 = sma(closes, 20, idx);
    const ma5Prev = sma(closes, 5, idx - 1);
    const ma20Prev = sma(closes, 20, idx - 1);
    if (![ma5, ma20, ma5Prev, ma20Prev].every(Number.isFinite)) continue;

    const prior20 = series.slice(-21, -1);
    const prior20High = Math.max(...highs.slice(-21, -1));
    const avgVol20 = average(prior20.map(r => Number(r.volume)).filter(Number.isFinite));
    const currentVolume = Number(latest.volume);
    const volumeRatio = avgVol20 > 0 ? currentVolume / avgVol20 : null;

    const trs = [];
    for (let i = Math.max(1, series.length - 5); i < series.length; i++) {
      const cur = series[i];
      const prev = series[i - 1];
      trs.push(Math.max(
        (Number(cur.high) - Number(cur.low)) * factors[i],
        Math.abs(Number(cur.high) * factors[i] - Number(prev.close) * factors[i - 1]),
        Math.abs(Number(cur.low) * factors[i] - Number(prev.close) * factors[i - 1])
      ));
    }
    const r5 = average(trs);

    const benchmarkSeries = indices.get(latest.market) || [];
    const benchmarkLatestIndex = benchmarkSeries.findIndex(row => row.trade_date === tradeDate);
    const benchmarkCurrent = benchmarkLatestIndex >= 0 ? Number(benchmarkSeries[benchmarkLatestIndex].close) : null;
    const benchmarkPrior = benchmarkLatestIndex >= RS_PERIOD
      ? Number(benchmarkSeries[benchmarkLatestIndex - RS_PERIOD].close)
      : null;
    const stockReturn20 = idx >= RS_PERIOD && closes[idx - RS_PERIOD] > 0
      ? ((closes[idx] / closes[idx - RS_PERIOD]) - 1) * 100
      : null;
    const benchmarkReturn20 = Number.isFinite(benchmarkCurrent) && Number.isFinite(benchmarkPrior) && benchmarkPrior > 0
      ? ((benchmarkCurrent / benchmarkPrior) - 1) * 100
      : null;
    const rsExcess20 = Number.isFinite(stockReturn20) && Number.isFinite(benchmarkReturn20)
      ? stockReturn20 - benchmarkReturn20
      : null;

    const bullish = Number(latest.close) > ma5 && ma5 > ma20;
    const strengthening = bullish && ma5 > ma5Prev && ma20 >= ma20Prev;
    const priceBreakout = Number(latest.close) > prior20High;
    const volumeConfirmed = Number.isFinite(volumeRatio) && volumeRatio >= 1.3;
    const breakoutCandidate = strengthening && priceBreakout && volumeConfirmed;
    const ma20DeviationPercent = ((Number(latest.close) / ma20) - 1) * 100;
    const distanceTo20dHighPercent = ((Number(latest.close) / prior20High) - 1) * 100;
    const dayChangePercent = Number(latest.reference_price) > 0
      ? ((Number(latest.close) / Number(latest.reference_price)) - 1) * 100
      : null;
    const limitUpLocked = Number.isFinite(dayChangePercent) && dayChangePercent >= 9.5 &&
      (!Number.isFinite(Number(latest.last_ask_price)) || Number(latest.last_ask_volume || 0) <= 0);
    const liquid = Number(latest.amount) >= MIN_TURNOVER;
    const restricted = Number(latest.is_restricted) === 1;
    const commonStock = (latest.security_type || "COMMON_STOCK") === "COMMON_STOCK";
    const eligible = commonStock && liquid && ma20DeviationPercent <= MAX_MA20_DEVIATION_PERCENT &&
      !limitUpLocked && !restricted;

    let trendStage = "NONE";
    if (bullish) trendStage = "BULLISH_ALIGNMENT";
    if (strengthening) trendStage = "STRENGTHENING";
    if (breakoutCandidate) trendStage = "BREAKOUT_CANDIDATE";

    results.push({
      trade_date: tradeDate,
      market: latest.market,
      stock_id: latest.stock_id,
      stock_name: latest.stock_name,
      close: Number(latest.close),
      ma5, ma20, ma5Prev, ma20Prev,
      prior20High,
      avgVol20,
      volumeRatio,
      r5,
      riskPercent: r5 > 0 ? (2 * r5 / Number(latest.close)) * 100 : null,
      amount: Number.isFinite(Number(latest.amount)) ? Number(latest.amount) : null,
      ma20DeviationPercent,
      distanceTo20dHighPercent,
      stockReturn20Percent: stockReturn20,
      benchmarkReturn20Percent: benchmarkReturn20,
      rsExcess20Percent: rsExcess20,
      rsRank: null,
      adjustedPriceUsed: factors.some(value => Math.abs(value - 1) > 1e-8),
      liquid,
      limitUpLocked,
      restricted,
      eligible,
      bullish,
      strengthening,
      priceBreakout,
      volumeConfirmed,
      trendStage
    });
  }

  percentileRanks(results.filter(row => row.eligible), "rsExcess20Percent", "rsRank");

  const sql = `
    INSERT INTO scanner_results (
      trade_date, market, stock_id, stock_name, close,
      ma5, ma20, ma5_prev, ma20_prev,
      prior_20d_high, avg_volume_20, volume_ratio,
      r5, risk_percent,
      amount, ma20_deviation_percent, distance_to_20d_high_percent,
      stock_return_20_percent, benchmark_return_20_percent, rs_excess_20_percent, rs_rank,
      adjusted_price_used, is_liquid, is_limit_up_locked, is_restricted, eligible,
      bullish_alignment, strengthening, price_breakout, volume_confirmed,
      trend_stage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date, market, stock_id) DO UPDATE SET
      stock_name = excluded.stock_name,
      close = excluded.close,
      ma5 = excluded.ma5,
      ma20 = excluded.ma20,
      ma5_prev = excluded.ma5_prev,
      ma20_prev = excluded.ma20_prev,
      prior_20d_high = excluded.prior_20d_high,
      avg_volume_20 = excluded.avg_volume_20,
      volume_ratio = excluded.volume_ratio,
      r5 = excluded.r5,
      risk_percent = excluded.risk_percent,
      amount = excluded.amount,
      ma20_deviation_percent = excluded.ma20_deviation_percent,
      distance_to_20d_high_percent = excluded.distance_to_20d_high_percent,
      stock_return_20_percent = excluded.stock_return_20_percent,
      benchmark_return_20_percent = excluded.benchmark_return_20_percent,
      rs_excess_20_percent = excluded.rs_excess_20_percent,
      rs_rank = excluded.rs_rank,
      adjusted_price_used = excluded.adjusted_price_used,
      is_liquid = excluded.is_liquid,
      is_limit_up_locked = excluded.is_limit_up_locked,
      is_restricted = excluded.is_restricted,
      eligible = excluded.eligible,
      bullish_alignment = excluded.bullish_alignment,
      strengthening = excluded.strengthening,
      price_breakout = excluded.price_breakout,
      volume_confirmed = excluded.volume_confirmed,
      trend_stage = excluded.trend_stage
    WHERE stock_name IS NOT excluded.stock_name
       OR close IS NOT excluded.close
       OR ma5 IS NOT excluded.ma5
       OR ma20 IS NOT excluded.ma20
       OR ma5_prev IS NOT excluded.ma5_prev
       OR ma20_prev IS NOT excluded.ma20_prev
       OR prior_20d_high IS NOT excluded.prior_20d_high
       OR avg_volume_20 IS NOT excluded.avg_volume_20
       OR volume_ratio IS NOT excluded.volume_ratio
       OR r5 IS NOT excluded.r5
       OR risk_percent IS NOT excluded.risk_percent
       OR amount IS NOT excluded.amount
       OR ma20_deviation_percent IS NOT excluded.ma20_deviation_percent
       OR distance_to_20d_high_percent IS NOT excluded.distance_to_20d_high_percent
       OR stock_return_20_percent IS NOT excluded.stock_return_20_percent
       OR benchmark_return_20_percent IS NOT excluded.benchmark_return_20_percent
       OR rs_excess_20_percent IS NOT excluded.rs_excess_20_percent
       OR rs_rank IS NOT excluded.rs_rank
       OR adjusted_price_used IS NOT excluded.adjusted_price_used
       OR is_liquid IS NOT excluded.is_liquid
       OR is_limit_up_locked IS NOT excluded.is_limit_up_locked
       OR is_restricted IS NOT excluded.is_restricted
       OR eligible IS NOT excluded.eligible
       OR bullish_alignment IS NOT excluded.bullish_alignment
       OR strengthening IS NOT excluded.strengthening
       OR price_breakout IS NOT excluded.price_breakout
       OR volume_confirmed IS NOT excluded.volume_confirmed
       OR trend_stage IS NOT excluded.trend_stage
  `;

  const chunkSize = 80;
  for (let i = 0; i < results.length; i += chunkSize) {
    const chunk = results.slice(i, i + chunkSize);
    await env.DB.batch(chunk.map(r =>
      env.DB.prepare(sql).bind(
        r.trade_date, r.market, r.stock_id, r.stock_name, r.close,
        r.ma5, r.ma20, r.ma5Prev, r.ma20Prev,
        r.prior20High, r.avgVol20, r.volumeRatio,
        r.r5, r.riskPercent,
        r.amount, r.ma20DeviationPercent, r.distanceTo20dHighPercent,
        r.stockReturn20Percent, r.benchmarkReturn20Percent, r.rsExcess20Percent, r.rsRank,
        r.adjustedPriceUsed ? 1 : 0,
        r.liquid ? 1 : 0,
        r.limitUpLocked ? 1 : 0,
        r.restricted ? 1 : 0,
        r.eligible ? 1 : 0,
        r.bullish ? 1 : 0,
        r.strengthening ? 1 : 0,
        r.priceBreakout ? 1 : 0,
        r.volumeConfirmed ? 1 : 0,
        r.trendStage
      )
    ));
  }

  return results.length;
}

async function handleScan(url, env) {
  const stage = (url.searchParams.get("stage") || "BREAKOUT_CANDIDATE").toUpperCase();
  const market = (url.searchParams.get("market") || "").toUpperCase();
  const query = (url.searchParams.get("q") || "").trim().slice(0, 40);
  const limit = clamp(parseInt(url.searchParams.get("limit") || "100", 10), 1, 500);

  const latest = await env.DB.prepare(
    "SELECT MAX(trade_date) AS trade_date FROM scanner_results"
  ).first();

  if (!latest || !latest.trade_date) {
    return json({ ok: true, trade_date: null, data: [] });
  }

  let sql = `
    SELECT *
    FROM scanner_results
    WHERE trade_date = ? AND eligible = 1
  `;
  const binds = [latest.trade_date];

  if (stage !== "ALL") {
    sql += " AND trend_stage = ?";
    binds.push(stage);
  }

  if (market === "TWSE" || market === "TPEX") {
    sql += " AND market = ?";
    binds.push(market);
  }

  if (query) {
    sql += " AND (stock_id LIKE ? OR stock_name LIKE ?)";
    const pattern = "%" + query + "%";
    binds.push(pattern, pattern);
  }

  sql += " ORDER BY COALESCE(rs_rank, -1) DESC, volume_ratio DESC, risk_percent ASC LIMIT ?";
  binds.push(limit);

  const result = await env.DB.prepare(sql).bind(...binds).all();

  return json({
    ok: true,
    trade_date: latest.trade_date,
    stage,
    market: market || "ALL",
    query,
    filters: {
      minimum_turnover: MIN_TURNOVER,
      maximum_ma20_deviation_percent: MAX_MA20_DEVIATION_PERCENT,
      excludes_restricted: true,
      excludes_limit_up_locked: true,
      rs_period: RS_PERIOD
    },
    count: (result.results || []).length,
    data: result.results || []
  });
}
