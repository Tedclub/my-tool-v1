const state = {
  stage: "BREAKOUT_CANDIDATE",
  market: "",
  query: "",
  sort: "volume",
  rows: [],
  status: null,
  loading: false
};

const stageNames = {
  BREAKOUT_CANDIDATE: "突破候選",
  STRENGTHENING: "多頭轉強",
  BULLISH_ALIGNMENT: "多頭排列",
  ALL: "全部股票"
};

const signalNames = {
  BREAKOUT_CANDIDATE: "突破候選",
  STRENGTHENING: "多頭轉強",
  BULLISH_ALIGNMENT: "多頭排列",
  NONE: "觀察中"
};

const els = Object.fromEntries([
  "serviceStatus", "tradeDate", "twseDays", "tpexDays", "twseState", "tpexState",
  "resultCount", "resultDescription", "stageFilter", "marketFilter", "stockSearch",
  "sortFilter", "refreshButton", "marketNotice", "sectionTitle", "lastUpdated",
  "loadingState", "errorState", "errorMessage", "retryButton", "emptyState",
  "results", "stockTableBody", "stockCards"
].map(id => [id, document.getElementById(id)]));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(parsed)
    : "—";
}

function riskClass(value) {
  const risk = Number(value);
  if (!Number.isFinite(risk)) return "";
  if (risk <= 5) return "risk-low";
  if (risk <= 10) return "risk-mid";
  return "risk-high";
}

function signalClass(stage) {
  return {
    BREAKOUT_CANDIDATE: "breakout",
    STRENGTHENING: "strengthening",
    BULLISH_ALIGNMENT: "bullish",
    NONE: "none"
  }[stage] || "none";
}

function sortedRows() {
  return [...state.rows].sort((a, b) => {
    if (state.sort === "risk") {
      return (Number(a.risk_percent) || Infinity) - (Number(b.risk_percent) || Infinity);
    }
    if (state.sort === "code") {
      return String(a.stock_id).localeCompare(String(b.stock_id), "zh-Hant", { numeric: true });
    }
    return (Number(b.volume_ratio) || 0) - (Number(a.volume_ratio) || 0);
  });
}

function tableRow(row) {
  return `
    <tr>
      <td class="stock-cell"><strong>${escapeHtml(row.stock_name)}</strong><span>${escapeHtml(row.stock_id)}</span></td>
      <td><span class="market-badge">${row.market === "TPEX" ? "上櫃" : "上市"}</span></td>
      <td class="metric-secondary">${number(row.close)}</td>
      <td><span class="metric-primary">${number(row.ma5)}</span> <span class="metric-secondary">/ ${number(row.ma20)}</span></td>
      <td class="metric-primary">${number(row.volume_ratio)}×</td>
      <td class="metric-secondary">${number(row.r5)}</td>
      <td class="${riskClass(row.risk_percent)}">${number(row.risk_percent)}%</td>
      <td><span class="signal-badge ${signalClass(row.trend_stage)}">${signalNames[row.trend_stage] || row.trend_stage}</span></td>
    </tr>`;
}

function stockCard(row) {
  return `
    <article class="stock-card">
      <div class="card-top">
        <div class="card-title"><strong>${escapeHtml(row.stock_name)}</strong><span>${escapeHtml(row.stock_id)} · ${row.market === "TPEX" ? "上櫃" : "上市"}</span></div>
        <span class="signal-badge ${signalClass(row.trend_stage)}">${signalNames[row.trend_stage] || row.trend_stage}</span>
      </div>
      <div class="card-price"><span>收盤價</span><strong>${number(row.close)}</strong></div>
      <div class="card-metrics">
        <div class="card-metric"><span>MA5 / MA20</span><strong>${number(row.ma5)} / ${number(row.ma20)}</strong></div>
        <div class="card-metric"><span>量比</span><strong class="metric-primary">${number(row.volume_ratio)}×</strong></div>
        <div class="card-metric"><span>風險</span><strong class="${riskClass(row.risk_percent)}">${number(row.risk_percent)}%</strong></div>
      </div>
    </article>`;
}

function render() {
  const rows = sortedRows();
  els.sectionTitle.textContent = stageNames[state.stage];
  els.resultCount.textContent = number(rows.length, 0);
  els.resultDescription.textContent = state.query ? `搜尋「${state.query}」` : "符合篩選條件";
  els.stockTableBody.innerHTML = rows.map(tableRow).join("");
  els.stockCards.innerHTML = rows.map(stockCard).join("");

  const hasRows = rows.length > 0;
  els.results.hidden = !hasRows || state.loading;
  els.emptyState.hidden = hasRows || state.loading;
  els.marketNotice.hidden = Number(state.status?.tpex_trading_days || 0) >= 21;
}

function renderStatus(scan) {
  const status = state.status || {};
  const twseDays = Number(status.twse_trading_days || 0);
  const tpexDays = Number(status.tpex_trading_days || 0);
  els.tradeDate.textContent = scan.trade_date || status.latest_trade_date || "—";
  els.twseDays.textContent = number(twseDays, 0);
  els.tpexDays.textContent = number(tpexDays, 0);
  els.twseState.textContent = twseDays >= 21 ? "指標資料完整" : "資料累積中";
  els.twseState.className = twseDays >= 21 ? "complete" : "pending";
  els.tpexState.textContent = tpexDays >= 21 ? "指標資料完整" : "歷史資料回補中";
  els.tpexState.className = tpexDays >= 21 ? "complete" : "pending";
  els.lastUpdated.textContent = `資料日期 ${scan.trade_date || "—"} · 顯示最多 500 筆`;
}

async function loadData() {
  if (state.loading) return;
  state.loading = true;
  els.loadingState.hidden = false;
  els.errorState.hidden = true;
  els.emptyState.hidden = true;
  els.results.hidden = true;
  els.refreshButton.disabled = true;

  const params = new URLSearchParams({ stage: state.stage, limit: "500" });
  if (state.market) params.set("market", state.market);
  if (state.query) params.set("q", state.query);

  try {
    const [scanResponse, statusResponse] = await Promise.all([
      fetch(`/api/scan?${params}`, { headers: { Accept: "application/json" } }),
      fetch("/api/backfill-status", { headers: { Accept: "application/json" } })
    ]);
    if (!scanResponse.ok || !statusResponse.ok) throw new Error("伺服器回應異常");
    const [scan, status] = await Promise.all([scanResponse.json(), statusResponse.json()]);
    if (!scan.ok || !status.ok) throw new Error(scan.error || status.error || "資料格式錯誤");

    state.rows = scan.data || [];
    state.status = status;
    renderStatus(scan);
    els.serviceStatus.className = "hero-status online";
    els.serviceStatus.lastElementChild.textContent = "服務正常";
    render();
  } catch (error) {
    els.serviceStatus.className = "hero-status error";
    els.serviceStatus.lastElementChild.textContent = "連線異常";
    els.errorMessage.textContent = error.message || "請稍後再試。";
    els.errorState.hidden = false;
  } finally {
    state.loading = false;
    els.loadingState.hidden = true;
    els.refreshButton.disabled = false;
  }
}

let searchTimer;
els.stockSearch.addEventListener("input", event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    loadData();
  }, 350);
});

els.stageFilter.addEventListener("click", event => {
  const button = event.target.closest("button[data-stage]");
  if (!button || button.classList.contains("active")) return;
  els.stageFilter.querySelectorAll("button").forEach(item => item.classList.remove("active"));
  button.classList.add("active");
  state.stage = button.dataset.stage;
  loadData();
});

els.marketFilter.addEventListener("change", event => {
  state.market = event.target.value;
  loadData();
});

els.sortFilter.addEventListener("change", event => {
  state.sort = event.target.value;
  render();
});

els.refreshButton.addEventListener("click", loadData);
els.retryButton.addEventListener("click", loadData);

loadData();
