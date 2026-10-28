# Taiwan Market Scanner

獨立於既有 `taiwan-stock-api` 的全市場掃描 Worker。原本個股查詢 API 不需要修改。

## 官方資料來源

### TWSE
上市每日整批行情：

```
https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX
  ?date=YYYYMMDD
  &type=ALLBUT0999
  &response=json
```

### TPEx
上櫃每日整批行情：

```
https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php
  ?l=zh-tw
  &d=ROC/MM/DD
  &se=EW
  &o=json
```

兩個來源都以「指定日期、整批市場」方式抓取，不逐檔打 API。

## 掃描條件

### 多頭排列
```
Close > MA5 > MA20
```

### 多頭轉強
```
多頭排列
AND MA5 今日 > MA5 昨日
AND MA20 今日 >= MA20 昨日
```

### 突破候選
```
多頭轉強
AND 最新收盤價 > 前 20 個交易日最高價
AND 今日成交量 >= 前 20 日平均成交量 × 1.30
```

## D1

建立資料庫：

```bash
npx wrangler d1 create taiwan-market-data
```

把取得的 database_id 填入 `wrangler.jsonc`。

套用 schema：

```bash
npx wrangler d1 execute taiwan-market-data --remote --file=./schema.sql
```

## ADMIN_TOKEN

設定管理端 secret：

```bash
npx wrangler secret put ADMIN_TOKEN
```

`/admin/update`、`/admin/backfill` 與 `/admin/rebuild-latest` 必須帶：

```
Authorization: Bearer <ADMIN_TOKEN>
```

## 初始化 21～60 個交易日（D1 Free 寫入控制）

為符合 D1 Free 每日 100,000 Rows written 限制，歷史回補與日常更新採用不同流程：

- `/admin/backfill`：只寫入 `daily_prices`，不建立任何歷史日期的 `scanner_results`。
- `/admin/rebuild-latest`：歷史資料足夠後，只為資料庫中的最新交易日建立一次 `scanner_results`。
- 日常 cron 與 `/admin/update`：只寫入指定當日價格，再重建同一天的 scanner 結果。

回補 API 每次最多處理 **10 個有效交易日**。這是刻意採用 10～15 日建議區間的保守端，因為 D1 不只計算資料表列，主鍵與索引更新也會增加 Rows written（見 [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)）。

若每日約有 1,500～2,000 檔普通股，一批 10 日約新增 15,000～20,000 筆價格資料；考慮 `daily_prices` 的主鍵與兩個索引後，D1 計量寫入量可能約為 60,000～80,000。60 日合計約 90,000～120,000 筆價格資料（計量寫入量可能約 360,000～480,000），因此初始化應至少分 6 個額度日完成，而且不要在同一日反覆重跑不同回補批次。實際用量仍以 Cloudflare Dashboard 的 D1 Row Metrics 為準。

例如先跑：

```
POST /admin/backfill?days=10&before=2026-09-24
```

回傳會提供：

```
next_before
```

下一次把它帶回：

```
POST /admin/backfill?days=10&before=<next_before>
```

每天執行一批，重複約 6 個額度日，即可累積約 60 個交易日。

回補回應中的 `scanner_rows` 固定為 `0`，表示此流程只儲存價格；`next_before` 是下一批應使用的日期游標。若同一批不小心重跑，價格 UPSERT 只會更新實際有變動的資料，避免無條件重寫相同列。

至少累積 21 個有效交易日（建議 60 日）後，執行一次：

```text
POST /admin/rebuild-latest
Authorization: Bearer <ADMIN_TOKEN>
```

此端點會從 `daily_prices` 找出最新交易日，並只 UPSERT 該日的 `scanner_results`；不會替每個歷史日期建立掃描結果。

## 每日更新

Wrangler cron 目前設定：

```
0 9 * * *
```

即 UTC 09:00，台灣時間約 17:00。非交易日若官方沒有資料，Worker 會正常略過。正常交易日只會新增約 1,500～2,000 筆當日價格，以及約 1,500～2,000 筆當日 scanner 結果；連同兩張表的主鍵與索引，D1 計量寫入量粗估約 12,000～16,000，仍明顯低於每日 100,000，但應以 Dashboard 實測為準。

手動執行單日更新的行為相同：

```text
POST /admin/update?date=YYYY-MM-DD
Authorization: Bearer <ADMIN_TOKEN>
```

## 查詢掃描結果

突破候選：

```
GET /api/scan?stage=BREAKOUT_CANDIDATE
```

多頭轉強：

```
GET /api/scan?stage=STRENGTHENING
```

多頭排列：

```
GET /api/scan?stage=BULLISH_ALIGNMENT
```

全部：

```
GET /api/scan?stage=ALL
```

可加：

```
&market=TWSE
&market=TPEX
&limit=100
```

## 第一版普通股過濾

目前先採保守規則：

- 4 位純數字代碼
- 排除 0 開頭（ETF 等）
- 排除 91 開頭（TDR）

寫入資料時會標記 `security_type=COMMON_STOCK`，掃描只接受這個類型；櫃買管理股票表不會匯入。

## 掃描品質規則

- 僅處理交易所普通股代碼；ETF、ETN、權證、TDR 與管理股票不納入。
- 最新一日成交金額至少新台幣 2,000 萬元。
- 收盤價相對 MA20 的正乖離不得超過 15%。
- 排除交易所公告的處置、變更交易股票。
- 排除漲幅達 9.5% 且收盤時沒有賣單的鎖漲停股票。
- 均線、前高與 20 日報酬使用每日參考價建立的還原權息序列。
- RS 為個股 20 日還原報酬減去所屬市場指數 20 日報酬，再換算成同市場百分位。
- 風險百分比為 `2 × 近 5 日平均真實波幅 ÷ 收盤價 × 100`。

階段採遞進但結果互斥：

1. 多頭排列：`收盤 > MA5 > MA20`。
2. 多頭轉強：多頭排列，且 MA5 上升、MA20 不下降。
3. 突破候選：多頭轉強，且收盤突破前 20 個交易日最高價、量比至少 1.3。

## 重要說明

- 此 Worker 與現有 `taiwan-stock-api` 分離。
- 不會修改原本 V2 個股查詢。
- 掃描結果是技術條件分類，不等於買進訊號。

## V2 read-only retrieval endpoints

These routes run one SELECT only, bypass `ensureSchema()`, and never change ingestion,
Scanner formulas, candidate selection, Cron, D1 schema or existing `/api/scan` behavior.

- `GET /api/v2/scanner/latest`: backward-compatible full candidates and existing fields,
  plus response ID, generation time, snapshot hash and per-market freshness.
- `GET /api/v2/scanner/summary`: same snapshot metadata and hash, without candidates.
- `GET /api/v2/scanner/candidates?market=TWSE&scan_date=2026-10-27`: full candidates
  for that market only, only when the market passes the freshness/integrity checks.
- Add `compact=1` for exactly the 23 documented second-layer analysis fields.
- Add `snapshot_hash=sha256%3A...` from summary to refuse a changed snapshot.

### Safe consumer flow

1. Read summary and validate `response_generated_at`, `expected_trade_date`,
   `scan_date`, `pool_complete`, `snapshot_hash` and the selected market's `fresh` flag.
2. Only request candidates for a market with `markets[market].fresh === true`.
   An unfresh TPEX does **not** prevent a fresh TWSE request.
3. Pass both the summary's `scan_date` and `snapshot_hash` when fetching candidates.
4. Validate response headers against JSON, hash against summary, candidate count,
   market, and every candidate's scan date. Do not silently fall back to old answers.
5. HTTP 409 (`MARKET_NOT_FRESH`, `SCAN_DATE_MISMATCH`, `SNAPSHOT_CHANGED`) returns no
   candidates. On a changed snapshot, restart from summary; never merge snapshots.
   Invalid parameters return 400, unsupported methods 405, unavailable data 503.

Top-level `fresh` and `dates_consistent` describe the **whole** snapshot on latest
and summary. On candidates they describe the **selected market**;
`snapshot_fresh` and `snapshot_dates_consistent` retain the whole-snapshot status.
`candidate_count`/`returned_count` are scoped to that response;
`snapshot_candidate_count` is the original full candidate pool's size.

`snapshot_hash` is SHA-256 of canonical key-sorted snapshot content, including the
unchanged full candidate rows and stored integrity evidence. It excludes response
IDs, export/generation timestamps, wall-clock freshness and transport/compact
projection, so all three endpoints share the hash while data stays unchanged.
It is a content fingerprint, not a signature or an immutable run ID.

Hash input (`snapshot_hash_version = v2-snapshot-sha256-1`) is the canonical object
with `hash_version`, `api_version`, `scan_date`, `latest_price_dates`, `pool_complete`,
`market_data_complete`, `candidate_count`, `checks` (the two markets' stored `checks`)
and the full original `candidates`. All object keys are recursively sorted; array
order is retained. A full/latest consumer can independently recompute it. Compact
consumers compare it to summary and pass it as a snapshot guard; compact projection
alone cannot reproduce a hash of omitted full fields.

### Fail-closed checks and limits

Freshness requires the expected trade date, matching market/Scanner/candidate dates,
stored price counts equal to recorded ingestion counts, recorded adjustment/index
presence, one same-day market index, complete Scanner key coverage, and valid
candidate joins/required metrics. Scanner coverage uses the existing 30 market dates
and at-least-21-observations input eligibility; it does not recompute indicators or
change which candidates the original Scanner selects. Verified zero-candidate days
are valid; a missing or partial scan is not.

These checks verify consistency of **stored/recorded data**, not completeness of the
entire upstream exchange universe or historical adjustment accuracy. The existing
`SCAN_COMPLETION_UNVERIFIED` warning and `scan_completed_at: null` remain: there is
no immutable run-level record. No `run_id` or `candidates_same_run=true` is invented.
Legacy `market_data_complete` keeps its original market-presence semantics; the new
market `fresh` flag adds stricter count/coverage checks.

The export-only calendar covers 2026, using the TWSE annual holiday schedule and
the confirmed extraordinary 2026-10-23 closure. Today's data becomes due at the
existing 17:00 Asia/Taipei Cron time; before then the last trading day is expected.
Outside covered dates, `expected_trade_date` is null and all markets fail closed.
Maintain the calendar for a new year or newly announced extraordinary closures.
The calendar does not change Cron, fetch jobs or the source of prices.

All retrieval responses use `Cache-Control: no-store`; JSON and HTTP headers share
`response_id`, `scan_date` and generation time. Custom headers are CORS-exposed.
An audit log records response metadata, snapshot hash, market dates/flags/counts,
HTTP status and JSON byte size, never candidates, secrets or credentials.

### Tests

`npm test` runs the existing algorithm/flow tests and retrieval unit tests.
Optional real-data and local HTTP/HTTP2 transport tests use `V2_FIXTURE_PATH`,
`V2_BASELINE_JSON` and `V2_BASELINE_SOURCE` pointing to an offline Production copy,
its original API JSON and original Worker source. SQLite is opened read-only and
the tests assert its file hash is unchanged. `V2_TRANSPORT_REPORT` saves size and
transport results; local HTTP/2 uses h2c, with TLS/HTTP2 separately checked against
the public deployment. No test calls Production admin/update/rebuild endpoints.
