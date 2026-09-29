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

`/admin/update` 與 `/admin/backfill` 必須帶：

```
Authorization: Bearer <ADMIN_TOKEN>
```

## 初始化 60 個交易日

為避免單次 Worker 執行大量外部請求，回補 API 每次最多處理 15 個有效交易日。

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

重複約 6 次，即可累積約 60 個交易日。

## 每日更新

Wrangler cron 目前設定：

```
0 9 * * *
```

即 UTC 09:00，台灣時間約 17:00。非交易日若官方沒有資料，Worker 會正常略過。

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

正式上線後建議再加入證券主檔，改用 security_type 明確識別普通股。

## 重要說明

- 此 Worker 與現有 `taiwan-stock-api` 分離。
- 不會修改原本 V2 個股查詢。
- 掃描結果是技術條件分類，不等於買進訊號。
