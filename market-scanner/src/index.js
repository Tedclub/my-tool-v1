const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    try {
      const url = new URL(request.url);

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
        const days = clamp(parseInt(url.searchParams.get("days") || "10", 10), 1, 15);
        const before = url.searchParams.get("before") || taipeiToday();
        const result = await backfillTradingDays(env, days, before);
        return json(result);
      }

      return json({
        ok: true,
        endpoints: {
          health: "GET /health",
          scan: "GET /api/scan?stage=BREAKOUT_CANDIDATE&limit=100",
          backfill_status: "GET /api/backfill-status",
          update: "POST /admin/update?date=YYYY-MM-DD",
          backfill: "POST /admin/backfill?days=10&before=YYYY-MM-DD"
        }
      });
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      return json({ ok: false, error: error.message || String(error) }, status);
    }
  },

  async scheduled(controller, env) {
    if (controller.cron === "*/5 * * * *") {
      const status = await getBackfillStatus(env);
      if (status.trading_days >= 60) {
        console.log(JSON.stringify({ event: "backfill_complete", ...status }));
        return;
      }

      const before = status.earliest_trade_date
        ? addDays(status.earliest_trade_date, -1)
        : taipeiToday();
      const result = await backfillPriceHistory(env, 5, before);
      const nextStatus = await getBackfillStatus(env);
      if (nextStatus.trading_days >= 60 && nextStatus.latest_trade_date) {
        await rebuildScannerForDate(env, nextStatus.latest_trade_date);
      }
      console.log(JSON.stringify({
        event: "backfill_batch",
        before,
        ...result,
        status: nextStatus
      }));
      return;
    }

    const result = await updateOneDate(env, taipeiToday());
    console.log(JSON.stringify({ event: "daily_update", ...result }));
  }
};

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

async function fetchTwse(date) {
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
  if (body.stat !== "OK") return [];

  const table = pickMarketTable(body);
  if (!table) return [];

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
    close: findFieldIndex(fields, ["收盤價", "收盤"])
  };

  return table.data.map(row => {
    const stockId = cleanText(row[idx.code]);
    return {
      market: "TWSE",
      stock_id: stockId,
      stock_name: cleanText(row[idx.name]),
      trade_date: date,
      open: n(row[idx.open]),
      high: n(row[idx.high]),
      low: n(row[idx.low]),
      close: n(row[idx.close]),
      volume: n(row[idx.volume]),
      amount: idx.amount >= 0 ? n(row[idx.amount]) : null,
      transactions: idx.tx >= 0 ? n(row[idx.tx]) : null
    };
  }).filter(r =>
    isCommonStockCode(r.stock_id) &&
    [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)
  );
}

async function fetchTpex(date) {
  const url =
    "https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php" +
    "?l=zh-tw&d=" + encodeURIComponent(toRocDate(date)) +
    "&se=EW&o=json";

  let res = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(url, {
        redirect: "manual",
        headers: {
          "Accept": "application/json",
          "User-Agent": "taiwan-market-scanner/1.0"
        }
      });
      if (res.ok) break;
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
    return [];
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
    return [];
  }

  const table = pickMarketTable(body);
  if (!table || !Array.isArray(table.data)) return [];

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
    tx: findFieldIndex(fields, ["成交筆數"])
  };

  return table.data.map(row => {
    const stockId = cleanText(row[idx.code]);
    return {
      market: "TPEX",
      stock_id: stockId,
      stock_name: cleanText(row[idx.name]),
      trade_date: date,
      open: n(row[idx.open]),
      high: n(row[idx.high]),
      low: n(row[idx.low]),
      close: n(row[idx.close]),
      volume: n(row[idx.volume]),
      amount: idx.amount >= 0 ? n(row[idx.amount]) : null,
      transactions: idx.tx >= 0 ? n(row[idx.tx]) : null
    };
  }).filter(r =>
    isCommonStockCode(r.stock_id) &&
    [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)
  );
}

async function insertPrices(env, rows) {
  if (!rows.length) return 0;

  const sql = `
    INSERT INTO daily_prices
      (market, stock_id, stock_name, trade_date, open, high, low, close, volume, amount, transactions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market, stock_id, trade_date) DO UPDATE SET
      stock_name = excluded.stock_name,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      amount = excluded.amount,
      transactions = excluded.transactions
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
        Number.isFinite(r.transactions) ? Math.round(r.transactions) : null
      )
    );
    await env.DB.batch(stmts);
    total += chunk.length;
  }
  return total;
}

async function updateOneDate(env, date) {
  const [twse, tpex] = await Promise.all([
    fetchTwse(date),
    fetchTpex(date)
  ]);

  const rows = [...twse, ...tpex];
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
  const scanned = await rebuildScannerForDate(env, date);

  return {
    ok: true,
    trade_date: date,
    trading_day: true,
    inserted,
    by_market: { TWSE: twse.length, TPEX: tpex.length },
    scanner_rows: scanned
  };
}

async function backfillTradingDays(env, requestedDays, beforeDate) {
  let cursor = beforeDate;
  let tradingDays = 0;
  let calendarAttempts = 0;
  const maxCalendarAttempts = requestedDays * 3 + 10;
  const dates = [];

  while (tradingDays < requestedDays && calendarAttempts < maxCalendarAttempts) {
    const result = await updateOneDate(env, cursor);
    calendarAttempts++;

    if (result.trading_day) {
      tradingDays++;
      dates.push({
        date: cursor,
        inserted: result.inserted,
        scanner_rows: result.scanner_rows
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
    note: "Call backfill again with before=next_before until 60 trading days are accumulated."
  };
}

async function backfillPriceHistory(env, requestedDays, beforeDate) {
  let cursor = beforeDate;
  let tradingDays = 0;
  let calendarAttempts = 0;
  const maxCalendarAttempts = requestedDays * 3 + 10;
  const dates = [];

  while (tradingDays < requestedDays && calendarAttempts < maxCalendarAttempts) {
    const [twse, tpex] = await Promise.all([
      fetchTwse(cursor),
      fetchTpex(cursor)
    ]);
    const rows = [...twse, ...tpex];
    calendarAttempts++;

    if (rows.length) {
      const inserted = await insertPrices(env, rows);
      tradingDays++;
      dates.push({
        date: cursor,
        inserted,
        by_market: { TWSE: twse.length, TPEX: tpex.length }
      });
    }

    cursor = addDays(cursor, -1);
  }

  return {
    ok: true,
    requested_trading_days: requestedDays,
    completed_trading_days: tradingDays,
    dates,
    next_before: cursor
  };
}

async function getBackfillStatus(env) {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT trade_date) AS trading_days,
      MIN(trade_date) AS earliest_trade_date,
      MAX(trade_date) AS latest_trade_date,
      COUNT(*) AS price_rows,
      COUNT(DISTINCT CASE WHEN market = 'TWSE' THEN trade_date END) AS twse_trading_days,
      COUNT(DISTINCT CASE WHEN market = 'TPEX' THEN trade_date END) AS tpex_trading_days
    FROM daily_prices
  `).first();

  return {
    trading_days: Number(row?.trading_days || 0),
    earliest_trade_date: row?.earliest_trade_date || null,
    latest_trade_date: row?.latest_trade_date || null,
    price_rows: Number(row?.price_rows || 0),
    twse_trading_days: Number(row?.twse_trading_days || 0),
    tpex_trading_days: Number(row?.tpex_trading_days || 0)
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

async function rebuildScannerForDate(env, tradeDate) {
  const prior = await env.DB.prepare(`
    SELECT market, stock_id, stock_name, trade_date, open, high, low, close, volume
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

    const closes = series.map(r => Number(r.close));
    const idx = closes.length - 1;
    const ma5 = sma(closes, 5, idx);
    const ma20 = sma(closes, 20, idx);
    const ma5Prev = sma(closes, 5, idx - 1);
    const ma20Prev = sma(closes, 20, idx - 1);
    if (![ma5, ma20, ma5Prev, ma20Prev].every(Number.isFinite)) continue;

    const prior20 = series.slice(-21, -1);
    const prior20High = Math.max(...prior20.map(r => Number(r.high)));
    const avgVol20 = average(prior20.map(r => Number(r.volume)).filter(Number.isFinite));
    const currentVolume = Number(latest.volume);
    const volumeRatio = avgVol20 > 0 ? currentVolume / avgVol20 : null;

    const trs = [];
    for (let i = Math.max(1, series.length - 5); i < series.length; i++) {
      const cur = series[i];
      const prev = series[i - 1];
      trs.push(Math.max(
        Number(cur.high) - Number(cur.low),
        Math.abs(Number(cur.high) - Number(prev.close)),
        Math.abs(Number(cur.low) - Number(prev.close))
      ));
    }
    const r5 = average(trs);

    const bullish = Number(latest.close) > ma5 && ma5 > ma20;
    const strengthening = bullish && ma5 > ma5Prev && ma20 >= ma20Prev;
    const priceBreakout = Number(latest.close) > prior20High;
    const volumeConfirmed = Number.isFinite(volumeRatio) && volumeRatio >= 1.3;
    const breakoutCandidate = strengthening && priceBreakout && volumeConfirmed;

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
      bullish,
      strengthening,
      priceBreakout,
      volumeConfirmed,
      trendStage
    });
  }

  await env.DB.prepare("DELETE FROM scanner_results WHERE trade_date = ?")
    .bind(tradeDate).run();

  const sql = `
    INSERT INTO scanner_results (
      trade_date, market, stock_id, stock_name, close,
      ma5, ma20, ma5_prev, ma20_prev,
      prior_20d_high, avg_volume_20, volume_ratio,
      r5, risk_percent,
      bullish_alignment, strengthening, price_breakout, volume_confirmed,
      trend_stage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    WHERE trade_date = ?
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

  sql += " ORDER BY volume_ratio DESC, risk_percent ASC LIMIT ?";
  binds.push(limit);

  const result = await env.DB.prepare(sql).bind(...binds).all();

  return json({
    ok: true,
    trade_date: latest.trade_date,
    stage,
    market: market || "ALL",
    count: (result.results || []).length,
    data: result.results || []
  });
}
