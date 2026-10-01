CREATE TABLE IF NOT EXISTS backfill_progress (
  trade_date TEXT PRIMARY KEY,
  twse_rows INTEGER NOT NULL DEFAULT 0,
  tpex_rows INTEGER NOT NULL DEFAULT 0,
  twse_adjusted INTEGER NOT NULL DEFAULT 0,
  tpex_adjusted INTEGER NOT NULL DEFAULT 0,
  twse_index INTEGER NOT NULL DEFAULT 0,
  tpex_index INTEGER NOT NULL DEFAULT 0
);

INSERT INTO backfill_progress
  (trade_date, twse_rows, tpex_rows, twse_adjusted, tpex_adjusted, twse_index, tpex_index)
SELECT
  p.trade_date,
  SUM(CASE WHEN p.market = 'TWSE' THEN 1 ELSE 0 END),
  SUM(CASE WHEN p.market = 'TPEX' THEN 1 ELSE 0 END),
  MAX(CASE WHEN p.market = 'TWSE' AND p.reference_price IS NOT NULL THEN 1 ELSE 0 END),
  MAX(CASE WHEN p.market = 'TPEX' AND p.reference_price IS NOT NULL THEN 1 ELSE 0 END),
  COALESCE(i.twse_index, 0),
  COALESCE(i.tpex_index, 0)
FROM daily_prices p
LEFT JOIN (
  SELECT
    trade_date,
    MAX(CASE WHEN market = 'TWSE' THEN 1 ELSE 0 END) AS twse_index,
    MAX(CASE WHEN market = 'TPEX' THEN 1 ELSE 0 END) AS tpex_index
  FROM market_indices
  GROUP BY trade_date
) i ON i.trade_date = p.trade_date
GROUP BY p.trade_date
ON CONFLICT(trade_date) DO UPDATE SET
  twse_rows = excluded.twse_rows,
  tpex_rows = excluded.tpex_rows,
  twse_adjusted = excluded.twse_adjusted,
  tpex_adjusted = excluded.tpex_adjusted,
  twse_index = excluded.twse_index,
  tpex_index = excluded.tpex_index;
