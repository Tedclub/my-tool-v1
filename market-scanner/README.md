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
