// Export-only calendar; Cron and ingestion are unchanged.
// TWSE: https://www.twse.com.tw/holidaySchedule/holidaySchedule?queryYear=115&response=html
// Extraordinary 10/23 closure: https://www.twfhcsec.com.tw/News/NewsContent?ID=1502
const CLOSED_2026 = new Set([
  "2026-01-01", "2026-02-12", "2026-02-13", "2026-02-16", "2026-02-17",
  "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-27", "2026-04-03",
  "2026-04-06", "2026-05-01", "2026-06-19", "2026-09-25", "2026-09-28",
  "2026-10-09", "2026-10-23", "2026-10-26", "2026-12-25"
]);

export function expectedTradeDate(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const date = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  // Today's market data becomes due at the existing 17:00 Asia/Taipei Cron time.
  if (local.getUTCHours() < 17) date.setUTCDate(date.getUTCDate() - 1);
  for (let i = 0; i < 14; i++) {
    if (date.getUTCFullYear() !== 2026) return null;
    const day = date.toISOString().slice(0, 10);
    if (![0, 6].includes(date.getUTCDay()) && !CLOSED_2026.has(day)) return day;
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return null;
}

export const CALENDAR_METADATA = Object.freeze({
  version: "TWSE-2026-reviewed-2026-10-28",
  valid_from: "2026-01-01", valid_through: "2026-12-31",
  timezone: "Asia/Taipei", daily_data_due_at: "17:00",
  basis: "TWSE calendar, known extraordinary closures, and existing daily data due time",
  limit: "Future extraordinary closures require maintenance; uncovered dates fail closed."
});
