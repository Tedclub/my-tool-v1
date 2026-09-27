var lastAnalysis = null;

document.addEventListener("DOMContentLoaded", function() {
    initHistoryButtons();

    document.getElementById("analyze-btn").addEventListener("click", analyzeTaiwanStock);
    document.getElementById("scenario-btn").addEventListener("click", calculateScenario);
    document.getElementById("use-current-btn").addEventListener("click", useCurrentAsReference);

    document.getElementById("stock-code").addEventListener("keydown", function(e) {
        if (e.key === "Enter") analyzeTaiwanStock();
    });
});

function initHistoryButtons() {
    try {
        var history = JSON.parse(localStorage.getItem("stock_history")) || ["0050"];
        if (!history.includes("0050")) history.unshift("0050");
        localStorage.setItem("stock_history", JSON.stringify(history));

        var container = document.getElementById("history-tags");
        if (!container) return;

        container.innerHTML = "";
        history.forEach(function(code) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "quick-btn";
            btn.innerText = code === "0050" ? "0050 元大台灣50" : code;
            btn.addEventListener("click", function() {
                document.getElementById("stock-code").value = code;
                analyzeTaiwanStock();
            });
            container.appendChild(btn);
        });
    } catch (err) {
        console.error(err);
    }
}

function saveToHistory(code) {
    try {
        if (!code || code === "0050") return;
        var history = JSON.parse(localStorage.getItem("stock_history")) || ["0050"];
        history = history.filter(function(item) { return item !== code; });
        history.splice(1, 0, code);
        if (history.length > 10) history = history.slice(0, 10);
        localStorage.setItem("stock_history", JSON.stringify(history));
        initHistoryButtons();
    } catch (err) {
        console.error(err);
    }
}

function calculateSMA(data, idx, period) {
    if (idx < period - 1) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += data[idx - i];
    return Number((sum / period).toFixed(2));
}

function calculateTrueRangeAverage(validData, period) {
    if (validData.length < 2) return null;
    var actualPeriod = Math.min(period, validData.length - 1);
    var totalTR = 0;
    var count = 0;

    for (var i = 0; i < actualPeriod; i++) {
        var currentIdx = validData.length - 1 - i;
        var today = validData[currentIdx];
        var yesterday = validData[currentIdx - 1];
        if (!yesterday) break;

        var tr = Math.max(
            today.high - today.low,
            Math.abs(today.high - yesterday.close),
            Math.abs(today.low - yesterday.close)
        );
        totalTR += tr;
        count++;
    }

    return count > 0 ? Number((totalTR / count).toFixed(2)) : null;
}

function formatDate(value) {
    if (!value) return "未知";
    var s = String(value).replace(/\//g, "-");
    var parts = s.split("-");
    if (parts.length === 3) return parts[0] + "/" + parts[1].padStart(2, "0") + "/" + parts[2].padStart(2, "0");
    return String(value);
}

function resetStatusBox(el) {
    if (!el) return;
    el.style.backgroundColor = "#e2e8f0";
    el.style.color = "#64748b";
    el.style.borderColor = "#cbd5e1";
}

function setStatusBox(el, html, bg, color, border) {
    if (!el) return;
    el.innerHTML = html;
    el.style.backgroundColor = bg;
    el.style.color = color;
    el.style.borderColor = border;
}

function classifyRisk(riskPercent, isBullish) {
    if (!isBullish) {
        return {
            title: "⚪ 未符合多頭排列",
            detail: "目前未同時滿足 Close > 短均線 > 長均線；本計算器不把這個狀態視為多頭條件成立。",
            bg: "#eef2f7", border: "#94a3b8", color: "#334155"
        };
    }
    if (riskPercent <= 4) {
        return {
            title: "🟢 符合低風險區間",
            detail: "今日收盤至參考防守價的距離為 " + riskPercent + "%，落在本工具自訂的 ≤4% 分級。",
            bg: "#e8f5e9", border: "#34a853", color: "#1b5e20"
        };
    }
    if (riskPercent <= 7) {
        return {
            title: "🔵 符合一般風險區間",
            detail: "今日收盤至參考防守價的距離為 " + riskPercent + "%，落在本工具自訂的 4%～7% 分級。",
            bg: "#e3f2fd", border: "#2196f3", color: "#0d47a1"
        };
    }
    return {
        title: "🟡 風險距離偏高",
        detail: "今日收盤至參考防守價的距離為 " + riskPercent + "%，高於本工具自訂的 7% 分級門檻。",
        bg: "#fff8e1", border: "#f9a825", color: "#6d4c00"
    };
}

async function analyzeTaiwanStock() {
    var stockId = document.getElementById("stock-code").value.trim();
    var paramN = parseFloat(document.getElementById("param-n").value);
    var maShortPeriod = parseInt(document.getElementById("param-ma-short").value, 10);
    var maLongPeriod = parseInt(document.getElementById("param-ma-long").value, 10);

    if (!stockId) return alert("請輸入股票代碼。");
    if (!Number.isFinite(paramN) || paramN <= 0) return alert("風控乘數 N 必須大於 0。");
    if (!Number.isInteger(maShortPeriod) || maShortPeriod < 2) return alert("短均線／R 週期至少為 2 天。");
    if (!Number.isInteger(maLongPeriod) || maLongPeriod < 3) return alert("長均線週期至少為 3 天。");
    if (maShortPeriod >= maLongPeriod) return alert("短均線天數必須小於長均線天數。");

    var loading = document.getElementById("loading");
    var report = document.getElementById("report-section");
    loading.style.display = "block";
    report.style.display = "none";

    try {
        var response = await fetch("https://taiwan-stock-api.tedclub.workers.dev?stock=" + encodeURIComponent(stockId));
        if (!response.ok) throw new Error("後端回應異常");

        var resData = await response.json();
        if (!resData.data || !Array.isArray(resData.data) || resData.data.length === 0) {
            throw new Error("查無此股票");
        }

        var validData = resData.data.map(function(item) {
            return {
                date: item.date,
                stock_name: item.stock_name,
                close: parseFloat(item.close),
                high: parseFloat(item.max),
                low: parseFloat(item.min)
            };
        }).filter(function(item) {
            return item.date && Number.isFinite(item.close) && Number.isFinite(item.high) && Number.isFinite(item.low);
        }).sort(function(a, b) {
            return new Date(a.date) - new Date(b.date);
        });

        var required = Math.max(maLongPeriod, maShortPeriod) + 1;
        if (validData.length < required) {
            throw new Error("歷史資料不足，至少需要 " + required + " 個交易日資料");
        }

        var len = validData.length;
        var latest = validData[len - 1];
        var previous = validData[len - 2];
        var stockName = latest.stock_name || resData.data[0].stock_name || "台灣個股";
        var closeArr = validData.map(function(d) { return d.close; });

        var currentClose = latest.close;
        var todayTrueRange = Number(Math.max(
            latest.high - latest.low,
            Math.abs(latest.high - previous.close),
            Math.abs(latest.low - previous.close)
        ).toFixed(2));

        var R = calculateTrueRangeAverage(validData, maShortPeriod);
        if (!Number.isFinite(R) || R <= 0) throw new Error("無法計算有效的平均 True Range");

        var maShort = calculateSMA(closeArr, len - 1, maShortPeriod);
        var maLong = calculateSMA(closeArr, len - 1, maLongPeriod);
        var isBullish = currentClose > maShort && maShort > maLong;

        var riskDistance = Number((R * paramN).toFixed(2));
        var referenceDefense = Number((currentClose - riskDistance).toFixed(2));
        var reference2RUpper = Number((currentClose + riskDistance * 2).toFixed(2));
        var riskPercent = Number(((riskDistance / currentClose) * 100).toFixed(1));
        var maShortBias = Number((((currentClose - maShort) / maShort) * 100).toFixed(1));
        var maLongBias = Number((((currentClose - maLong) / maLong) * 100).toFixed(1));
        var isHighDeviation = maShortBias >= 8;

        lastAnalysis = {
            stockId: stockId,
            stockName: stockName,
            currentClose: currentClose,
            R: R,
            paramN: paramN,
            date: latest.date
        };

        saveToHistory(stockId);

        var s1 = document.getElementById("status-1");
        var s2 = document.getElementById("status-2");
        var s3 = document.getElementById("status-3");
        resetStatusBox(s1); resetStatusBox(s2); resetStatusBox(s3);

        if (isBullish) {
            setStatusBox(s1, "📈 趨勢狀態<br>多頭排列成立", "#dff9fb", "#0984e3", "#74b9ff");
        } else {
            setStatusBox(s1, "📉 趨勢狀態<br>多頭排列未成立", "#eef2f7", "#475569", "#94a3b8");
        }

        updateScenarioStatus();

        if (isHighDeviation) {
            setStatusBox(s3, "📏 MA乖離狀態<br>短均線乖離 ≥ 8%", "#ffebee", "#c62828", "#ef5350");
        } else {
            setStatusBox(s3, "📏 MA乖離狀態<br>短均線乖離 " + maShortBias + "%", "#e8f5e9", "#2e7d32", "#81c784");
        }

        var assessment = classifyRisk(riskPercent, isBullish);

        document.getElementById("data-date").textContent =
            "資料日期：" + formatDate(latest.date) + " 收盤｜本頁不是即時報價";

        document.getElementById("report-title-left").textContent =
            "📊 【" + stockId + " " + stockName + "】均線與波動數據";
        document.getElementById("report-title-right").textContent =
            "💼 【" + stockId + " " + stockName + "】今日動態風控空間";

        document.getElementById("technical-data").innerHTML =
            "• <b>最新收盤價：</b> <span class=\"text-bullish highlight\">" + currentClose + "</span> 元<br>" +
            "• <b>" + maShortPeriod + " 日均線：</b> " + maShort + " 元<br>" +
            "• <b>" + maLongPeriod + " 日均線：</b> " + maLong + " 元<br>" +
            "• <b>現價距短均線：</b> " + (maShortBias >= 0 ? "+" : "") + maShortBias + "%<br>" +
            "• <b>現價距長均線：</b> " + (maLongBias >= 0 ? "+" : "") + maLongBias + "%<br>" +
            "• <b>今日 True Range：</b> " + todayTrueRange + " 元<br>" +
            "• <b>" + maShortPeriod + " 日平均 True Range (R)：</b> <span class=\"text-bullish\">" + R + "</span> 元" +
            "<div class=\"metric-note\">R 為最近 " + maShortPeriod + " 個 TR 的簡單平均，不等同 Wilder 平滑 ATR。</div>";

        document.getElementById("risk-data").innerHTML =
            "• <b>風控倍數 N：</b> " + paramN + " 倍<br>" +
            "• <b>今日風控距離 N×R：</b> " + riskDistance + " 元<br>" +
            "• <b>今日參考風險：</b> <span style=\"color:#e67e22;font-weight:bold;\">" + riskPercent + "%</span><br>" +
            "• <b>今日參考防守價：</b> <b>" + referenceDefense + " 元</b><br>" +
            "• <b>今日 2R 參考上緣：</b> <b>" + reference2RUpper + " 元</b><br>" +
            "<div class=\"metric-note\">以上兩個價位都以「今天最新收盤價」重新計算，是今日風險空間尺規，不是既有部位的固定停損或固定目標。</div>" +
            "<div style=\"margin-top:14px;padding:12px;border-radius:6px;background:" + assessment.bg + ";border-left:6px solid " + assessment.border + ";color:" + assessment.color + ";line-height:1.6;\">" +
            "<b>條件評估：" + assessment.title + "</b><br><span style=\"font-size:12px;\">" + assessment.detail + "</span></div>";

        loading.style.display = "none";
        report.style.display = "block";

        if (document.getElementById("reference-price").value && document.getElementById("reference-r").value) {
            calculateScenario();
        }
    } catch (e) {
        loading.style.display = "none";
        alert("數據讀取或計算失敗：" + e.message);
    }
}

function useCurrentAsReference() {
    if (!lastAnalysis) {
        alert("請先完成一次股票技術指標計算。");
        return;
    }
    document.getElementById("reference-price").value = lastAnalysis.currentClose;
    document.getElementById("reference-r").value = lastAnalysis.R;
    calculateScenario();
}

function calculateScenario() {
    var referencePrice = parseFloat(document.getElementById("reference-price").value);
    var referenceR = parseFloat(document.getElementById("reference-r").value);
    var paramN = parseFloat(document.getElementById("param-n").value);
    var result = document.getElementById("scenario-result");

    if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(referenceR) || referenceR <= 0) {
        result.innerHTML = '<div class="metric-note">請輸入有效的「基準價格」與「基準 R」。</div>';
        updateScenarioStatus();
        return;
    }
    if (!Number.isFinite(paramN) || paramN <= 0) {
        result.innerHTML = '<div class="metric-note">風控乘數 N 必須大於 0。</div>';
        return;
    }

    var oneR = Number((referenceR * paramN).toFixed(2));
    var defense = Number((referencePrice - oneR).toFixed(2));
    var plus1R = Number((referencePrice + oneR).toFixed(2));
    var plus2R = Number((referencePrice + oneR * 2).toFixed(2));

    var currentRMultiple = null;
    if (lastAnalysis && Number.isFinite(lastAnalysis.currentClose)) {
        currentRMultiple = Number(((lastAnalysis.currentClose - referencePrice) / oneR).toFixed(2));
    }

    result.innerHTML =
        '<div class="card" style="padding:16px;">' +
        '<h3 style="margin-top:0;">🎯 固定基準結果</h3>' +
        '• <b>基準價格：</b> ' + referencePrice.toFixed(2) + ' 元<br>' +
        '• <b>基準 R：</b> ' + referenceR.toFixed(2) + ' 元<br>' +
        '• <b>固定 1R 距離：</b> ' + oneR.toFixed(2) + ' 元<br>' +
        '• <b>固定基準防守：</b> ' + defense.toFixed(2) + ' 元<br>' +
        '• <b>+1R：</b> ' + plus1R.toFixed(2) + ' 元<br>' +
        '• <b>+2R：</b> <span class="text-bullish">' + plus2R.toFixed(2) + ' 元</span><br>' +
        (currentRMultiple === null ? '' : '• <b>目前相對基準：</b> ' + (currentRMultiple >= 0 ? '+' : '') + currentRMultiple.toFixed(2) + 'R<br>') +
        '<div class="metric-note" style="margin-top:8px;">這組基準值只由你輸入的基準價格、基準 R 與 N 決定，不會因為今日收盤價改變而自動往前移。</div>' +
        '</div>';

    updateScenarioStatus(plus2R);
}

function updateScenarioStatus(plus2R) {
    var s2 = document.getElementById("status-2");
    var referencePrice = parseFloat(document.getElementById("reference-price").value);
    var referenceR = parseFloat(document.getElementById("reference-r").value);

    if (!Number.isFinite(referencePrice) || !Number.isFinite(referenceR) || !lastAnalysis) {
        setStatusBox(s2, "🎯 2R 基準狀態<br>尚未建立基準", "#e2e8f0", "#64748b", "#cbd5e1");
        return;
    }

    if (!Number.isFinite(plus2R)) {
        var paramN = parseFloat(document.getElementById("param-n").value);
        plus2R = referencePrice + referenceR * paramN * 2;
    }

    if (lastAnalysis.currentClose >= plus2R) {
        setStatusBox(s2, "🎯 2R 基準狀態<br>已達 +2R", "#fff3cd", "#856404", "#ffc107");
    } else {
        var progressR = (lastAnalysis.currentClose - referencePrice) / (referenceR * lastAnalysis.paramN);
        setStatusBox(s2, "🎯 2R 基準狀態<br>目前 " + (progressR >= 0 ? "+" : "") + progressR.toFixed(2) + "R", "#eef2ff", "#4338ca", "#a5b4fc");
    }
}

window.analyzeTaiwanStock = analyzeTaiwanStock;
