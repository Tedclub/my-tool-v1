import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const output = path.resolve("public/backfill/tpex");
const targetDays = Number(process.argv[2] || 60);
const start = process.argv[3] || "2026-09-30";
const indexMonths = new Map();

function addDays(iso, delta) {
  const date = new Date(iso + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function clean(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function number(value) {
  const text = clean(value).replaceAll(",", "").replaceAll("−", "-");
  if (!text || text === "--" || text === "---" || text === "-") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function commonStock(code) {
  return /^\d{4}$/.test(code) && !code.startsWith("0") && !code.startsWith("91");
}

async function json(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function indexClose(date) {
  const month = date.slice(0, 7);
  if (!indexMonths.has(month)) {
    const payload = await json(
      "https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=" +
      encodeURIComponent(date.replaceAll("-", "/"))
    );
    indexMonths.set(month, payload?.tables?.[0]?.data || []);
  }
  const row = indexMonths.get(month).find(item => clean(item[0]).replaceAll("/", "-") === date);
  return row ? number(row[4]) : null;
}

await mkdir(output, { recursive: true });
let date = start;
let completed = 0;

while (completed < targetDays) {
  const payload = await json(
    "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=" +
    encodeURIComponent(date.replaceAll("-", "/"))
  );
  const table = (payload.tables || []).find(item => item.title === "上櫃股票行情");
  if (table?.data?.length) {
    const fields = table.fields.map(clean);
    const at = label => fields.findIndex(field => field.includes(label));
    const idx = {
      code: at("代號"), name: at("名稱"), close: at("收盤"), change: at("漲跌"),
      open: at("開盤"), high: at("最高"), low: at("最低"), volume: at("成交股數"),
      amount: at("成交金額"), tx: at("成交筆數"), ask: at("最後賣價"), askVolume: at("最後賣量")
    };
    const rows = table.data.map(row => {
      const code = clean(row[idx.code]);
      const close = number(row[idx.close]);
      const change = number(row[idx.change]);
      const reference = Number.isFinite(close) && Number.isFinite(change) && close - change > 0
        ? close - change
        : null;
      return [
        code, clean(row[idx.name]), number(row[idx.open]), number(row[idx.high]),
        number(row[idx.low]), close, number(row[idx.volume]), number(row[idx.amount]),
        number(row[idx.tx]), reference, number(row[idx.ask]), number(row[idx.askVolume])
      ];
    }).filter(row => commonStock(row[0]) && row.slice(2, 7).every(Number.isFinite));

    const seed = { d: date, i: await indexClose(date), r: rows };
    await writeFile(path.join(output, `${date}.json.gz`), gzipSync(JSON.stringify(seed), { level: 9 }));
    completed++;
    console.log(`${completed}/${targetDays} ${date} ${rows.length}`);
  }
  date = addDays(date, -1);
}
