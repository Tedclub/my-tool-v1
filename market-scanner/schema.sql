CREATE TABLE IF NOT EXISTS daily_prices (
  market TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  stock_name TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,
  amount INTEGER,
  transactions INTEGER,
  reference_price REAL,
  last_ask_price REAL,
  last_ask_volume INTEGER,
  security_type TEXT NOT NULL DEFAULT 'COMMON_STOCK',
  is_restricted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market, stock_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_prices_date
  ON daily_prices (trade_date);

CREATE INDEX IF NOT EXISTS idx_daily_prices_stock_date
  ON daily_prices (stock_id, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_prices_market_date
  ON daily_prices (market, trade_date DESC);

CREATE TABLE IF NOT EXISTS scanner_results (
  trade_date TEXT NOT NULL,
  market TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  stock_name TEXT NOT NULL,
  close REAL NOT NULL,
  ma5 REAL,
  ma20 REAL,
  ma5_prev REAL,
  ma20_prev REAL,
  prior_20d_high REAL,
  avg_volume_20 REAL,
  volume_ratio REAL,
  r5 REAL,
  risk_percent REAL,
  amount INTEGER,
  ma20_deviation_percent REAL,
  distance_to_20d_high_percent REAL,
  stock_return_20_percent REAL,
  benchmark_return_20_percent REAL,
  rs_excess_20_percent REAL,
  rs_rank REAL,
  adjusted_price_used INTEGER NOT NULL DEFAULT 0,
  is_liquid INTEGER NOT NULL DEFAULT 0,
  is_limit_up_locked INTEGER NOT NULL DEFAULT 0,
  is_restricted INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 1,
  bullish_alignment INTEGER NOT NULL DEFAULT 0,
  strengthening INTEGER NOT NULL DEFAULT 0,
  price_breakout INTEGER NOT NULL DEFAULT 0,
  volume_confirmed INTEGER NOT NULL DEFAULT 0,
  trend_stage TEXT NOT NULL,
  PRIMARY KEY (trade_date, market, stock_id)
);

CREATE INDEX IF NOT EXISTS idx_scanner_results_date_stage
  ON scanner_results (trade_date DESC, trend_stage);

CREATE INDEX IF NOT EXISTS idx_scanner_results_volume_ratio
  ON scanner_results (trade_date DESC, volume_ratio DESC);

CREATE INDEX IF NOT EXISTS idx_scanner_results_date_eligible_rs
  ON scanner_results (trade_date DESC, eligible, rs_rank DESC);

CREATE TABLE IF NOT EXISTS market_indices (
  market TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  index_name TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (market, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_market_indices_date
  ON market_indices (trade_date DESC, market);

CREATE TABLE IF NOT EXISTS backfill_progress (
  trade_date TEXT PRIMARY KEY,
  twse_rows INTEGER NOT NULL DEFAULT 0,
  tpex_rows INTEGER NOT NULL DEFAULT 0,
  twse_adjusted INTEGER NOT NULL DEFAULT 0,
  tpex_adjusted INTEGER NOT NULL DEFAULT 0,
  twse_index INTEGER NOT NULL DEFAULT 0,
  tpex_index INTEGER NOT NULL DEFAULT 0
);
