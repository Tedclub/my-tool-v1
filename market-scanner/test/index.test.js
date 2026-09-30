import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ADMIN_TOKEN = "test-token";

function request(path) {
  return new Request(`https://scanner.example${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
  });
}

function twsePayload(date) {
  return {
    stat: "OK",
    tables: [{
      fields: ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價"],
      data: [["2330", "台積電", "1,000", "100", "1,000,000", "100", "105", "99", "104"]]
    }],
    date
  };
}

function installMarketFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes("twse.com.tw")) {
      return new Response(JSON.stringify(twsePayload()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (value.includes("tpex.org.tw")) {
      return new Response(JSON.stringify({ tables: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return originalFetch(url);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function mockDb({ latestTradeDate = null, priceHistory = [] } = {}) {
  const calls = [];

  function statement(sql, binds = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ type: "prepare", sql: normalized, binds });
    return {
      bind(...nextBinds) {
        return statement(sql, nextBinds);
      },
      async first() {
        calls.push({ type: "first", sql: normalized, binds });
        if (normalized.includes("MAX(trade_date) AS trade_date FROM daily_prices")) {
          return { trade_date: latestTradeDate };
        }
        if (normalized.includes("MAX(trade_date) AS trade_date FROM scanner_results")) {
          return { trade_date: null };
        }
        return null;
      },
      async all() {
        calls.push({ type: "all", sql: normalized, binds });
        if (normalized.includes("FROM daily_prices") && normalized.includes("ORDER BY stock_id")) {
          return { results: priceHistory };
        }
        return { results: [] };
      },
      async run() {
        calls.push({ type: "run", sql: normalized, binds });
        return { success: true };
      }
    };
  }

  return {
    calls,
    prepare: statement,
    async batch(statements) {
      calls.push({ type: "batch", count: statements.length });
      return statements.map(() => ({ success: true }));
    }
  };
}

test("admin backfill writes only price history and returns next_before", async () => {
  const restoreFetch = installMarketFetch();
  const DB = mockDb();
  try {
    const response = await worker.fetch(
      request("/admin/backfill?days=1&before=2026-09-29"),
      { DB, ADMIN_TOKEN }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.completed_trading_days, 1);
    assert.equal(body.scanner_rows, 0);
    assert.equal(body.next_before, "2026-09-28");
    assert.ok(DB.calls.some(call => call.sql?.includes("INSERT INTO daily_prices")));
    assert.ok(!DB.calls.some(call => call.sql?.includes("scanner_results")));
  } finally {
    restoreFetch();
  }
});

test("admin backfill caps each request at ten trading days", async () => {
  const restoreFetch = installMarketFetch();
  const DB = mockDb();
  try {
    const response = await worker.fetch(
      request("/admin/backfill?days=15&before=2026-09-29"),
      { DB, ADMIN_TOKEN }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.requested_trading_days, 10);
    assert.equal(body.completed_trading_days, 10);
    assert.equal(body.scanner_rows, 0);
  } finally {
    restoreFetch();
  }
});

test("admin update keeps the daily price-then-scanner flow", async () => {
  const restoreFetch = installMarketFetch();
  const DB = mockDb();
  try {
    const response = await worker.fetch(
      request("/admin/update?date=2026-09-29"),
      { DB, ADMIN_TOKEN }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.trading_day, true);
    assert.ok(DB.calls.some(call => call.sql?.includes("INSERT INTO daily_prices")));
    assert.ok(DB.calls.some(call => call.sql?.includes("ORDER BY stock_id ASC, trade_date ASC")));
  } finally {
    restoreFetch();
  }
});

test("rebuild-latest is protected and rebuilds only the newest price date", async () => {
  const unauthorized = await worker.fetch(
    new Request("https://scanner.example/admin/rebuild-latest", { method: "POST" }),
    { DB: mockDb(), ADMIN_TOKEN }
  );
  assert.equal(unauthorized.status, 401);

  const DB = mockDb({ latestTradeDate: "2026-09-29" });
  const response = await worker.fetch(request("/admin/rebuild-latest"), { DB, ADMIN_TOKEN });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.trade_date, "2026-09-29");
  assert.equal(body.scanner_rows, 0);
  assert.ok(DB.calls.some(call =>
    call.type === "all" && call.binds[0] === "2026-09-29"
  ));
  assert.ok(!DB.calls.some(call => call.sql?.startsWith("DELETE FROM scanner_results")));
});

test("scanner rebuild preserves the existing breakout rules", async () => {
  const priceHistory = Array.from({ length: 21 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const close = 100 + index;
    return {
      market: "TWSE",
      stock_id: "2330",
      stock_name: "台積電",
      trade_date: `2026-09-${day}`,
      open: close - 1,
      high: close,
      low: close - 2,
      close,
      volume: index === 20 ? 2000 : 1000
    };
  });
  const DB = mockDb({
    latestTradeDate: "2026-09-21",
    priceHistory
  });

  const response = await worker.fetch(request("/admin/rebuild-latest"), { DB, ADMIN_TOKEN });
  const body = await response.json();
  const scannerInsert = DB.calls.find(call =>
    call.type === "prepare" &&
    call.sql?.includes("INSERT INTO scanner_results") &&
    call.binds.length === 19
  );

  assert.equal(response.status, 200);
  assert.equal(body.scanner_rows, 1);
  assert.ok(scannerInsert);
  assert.equal(scannerInsert.binds[14], 1, "Close > MA5 > MA20");
  assert.equal(scannerInsert.binds[15], 1, "MA5 rises and MA20 does not fall");
  assert.equal(scannerInsert.binds[16], 1, "Close exceeds the prior 20-day high");
  assert.equal(scannerInsert.binds[17], 1, "volume ratio is at least 1.3");
  assert.equal(scannerInsert.binds[18], "BREAKOUT_CANDIDATE");
});
