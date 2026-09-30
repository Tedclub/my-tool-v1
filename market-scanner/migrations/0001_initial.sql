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
  PRIMARY KEY (market, stock_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_prices_date
  ON daily_prices (trade_date);

CREATE INDEX IF NOT EXISTS idx_daily_prices_stock_date
  ON daily_prices (stock_id, trade_date DESC);

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
