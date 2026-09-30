ALTER TABLE daily_prices ADD COLUMN reference_price REAL;
ALTER TABLE daily_prices ADD COLUMN last_ask_price REAL;
ALTER TABLE daily_prices ADD COLUMN last_ask_volume INTEGER;
ALTER TABLE daily_prices ADD COLUMN security_type TEXT NOT NULL DEFAULT 'COMMON_STOCK';
ALTER TABLE daily_prices ADD COLUMN is_restricted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_daily_prices_market_date
  ON daily_prices (market, trade_date DESC);

ALTER TABLE scanner_results ADD COLUMN amount INTEGER;
ALTER TABLE scanner_results ADD COLUMN ma20_deviation_percent REAL;
ALTER TABLE scanner_results ADD COLUMN distance_to_20d_high_percent REAL;
ALTER TABLE scanner_results ADD COLUMN stock_return_20_percent REAL;
ALTER TABLE scanner_results ADD COLUMN benchmark_return_20_percent REAL;
ALTER TABLE scanner_results ADD COLUMN rs_excess_20_percent REAL;
ALTER TABLE scanner_results ADD COLUMN rs_rank REAL;
ALTER TABLE scanner_results ADD COLUMN adjusted_price_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scanner_results ADD COLUMN is_liquid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scanner_results ADD COLUMN is_limit_up_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scanner_results ADD COLUMN is_restricted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scanner_results ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1;

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
