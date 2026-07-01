// ==========================================
// 1. 初始化與歷史按鈕列
// ==========================================
document.addEventListener("DOMContentLoaded", function() {
    initHistoryButtons();
});

function initHistoryButtons() {
    try {
        var history = JSON.parse(localStorage.getItem('stock_history')) || ['0050'];
        if (!history.includes('0050')) history.unshift('0050');
        localStorage.setItem('stock_history', JSON.stringify(history));

        var container = document.getElementById('history-tags');
        if (container) {
            container.innerHTML = '';
            history.forEach(function(code) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'quick-btn';
                btn.innerText = code === '0050' ? '0050 元大台灣50' : code;
                btn.onclick = function() {
                    var inputEl = document.getElementById("stock-code");
                    if (inputEl) {
                        inputEl.value = code;
                        analyzeTaiwanStock();
                    }
                };
                container.appendChild(btn);
            });
        }
    } catch (err) {
        console.error(err);
    }
}

function saveToHistory(code) {
    try {
        if (!code || code === '0050') return;
        var history = JSON.parse(localStorage.getItem('stock_history')) || ['0050'];
        history = history.filter(function(item) { return item !== code; });
        history.splice(1, 0, code);
        if (history.length > 10) history = history.slice(0, 10);
        localStorage.setItem('stock_history', JSON.stringify(history));
        initHistoryButtons();
    } catch (err) {
        console.error(err);
    }
}

// ==========================================
// 2. 核心計算函式
// ==========================================
function calculateSMA(data, idx, period) {
    if (idx < period - 1) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) { sum += data[idx - i]; }
    return Number((sum / period).toFixed(2));
}

function calculateTrueRangeAverage(validData, period) {
    var len = validData.length;
    var actualPeriod = Math.min(period, len - 1);
    var totalTR = 0;
    var count = 0;
    for (var i = 0; i < actualPeriod; i++) {
        var currentIdx = len - 1 - i;
        var today = validData[currentIdx];
        var yesterday = validData[currentIdx - 1];
        if (!yesterday) break;
        var tr1 = today.high - today.low;
        var tr2 = Math.abs(today.high - yesterday.close);
        var tr3 = Math.abs(today.low - yesterday.close);
        totalTR += Math.max(tr1, tr2, tr3);
        count++;
    }
    return count > 0 ? Number((totalTR / count).toFixed(2)) : Number((validData[len-1].high - validData[len-1].low).toFixed(2));
}

// ==========================================
// 3. 主控程式流程（掛載在 window 確保 HTML 絕對抓得到）
// ==========================================
window.analyzeTaiwanStock = async function() {
    var stockCodeEl = document.getElementById('stock-code');
    if (!stockCodeEl) return;
    var stockId = stockCodeEl.value.trim();
    if (!stockId) { alert('請輸入股票代碼！'); return; }

    var paramN = parseFloat(document.getElementById('param-n').value) || 2;
    var maShortPeriod = parseInt(document.getElementById('param-ma-short').value) || 5;
    var maLongPeriod = parseInt(document.getElementById('param-ma-long').value) || 20;

    var loading = document.getElementById('loading');
    var report = document.getElementById('report-section');
    if (loading) loading.style.display = 'block';
    if (report) report.style.display = 'none';

    try {
        var response = await fetch(`https://taiwan-stock-api.tedclub.workers.dev?stock=${stockId}`);
        if (!response.ok) throw new Error("後端回應異常");
        var resData = await response.json();
        if (!resData.data || resData.data.length === 0) throw new Error("查無此股票");

        var stockName = resData.data[0].stock_name || "台灣個股";
        saveToHistory(stockId);

        var validData = resData.data.map(function(item) {
            return { date: item.date, close: parseFloat(item.close), high: parseFloat(item.max), low: parseFloat(item.min) };
        });

        var len = validData.length;
        var closeArr = validData.map(function(d) { return d.close; });
        var currentClose = validData[len - 1].close;
        var currentHigh = validData[len - 1].high;
        var currentLow = validData[len - 1].low;
        var yesterdayClose = validData[len - 2].close;

        var todayTrueRange = Number(Math.max(currentHigh - currentLow, Math.abs(currentHigh - yesterdayClose), Math.abs(currentLow - yesterdayClose)).toFixed(2));
        var R = calculateTrueRangeAverage(validData, maShortPeriod); 

        var maShort = calculateSMA(closeArr, len - 1, maShortPeriod);
        var maLong = calculateSMA(closeArr, len - 1, maLongPeriod);
        var isBullish = (maShort && maLong) ? (currentClose > maShort && maShort > maLong) : false;

        var stopLoss = Number((currentClose - (R * paramN)).toFixed(2));
        var takeProfit = Number((currentClose + (R * paramN * 2)).toFixed(2));
        var trailingStopPrice = stopLoss; 
        var adviceText = '';

        var riskPercent = Number((((currentClose - stopLoss) / currentClose) * 100).toFixed(1));
        var perfectPriceThreshold = Number((stopLoss * 1.04).toFixed(2)); 
        var buyDecisionHtml = '';

        var s1 = document.getElementById('status-1');
        var s2 = document.getElementById('status-2');
        var s3 = document.getElementById('status-3');
        if(s1) { s1.style.backgroundColor = '#e2e8f0'; s1.style.color = '#64748b'; s1.style.borderColor = '#cbd5e1'; }
        if(s2) { s2.style.backgroundColor = '#e2e8f0'; s2.style.color = '#64748b'; s2.style.borderColor = '#cbd5e1'; }
        if(s3) { s3.style.backgroundColor = '#e2e8f0'; s3.style.color = '#64748b'; s3.style.borderColor = '#cbd5e1'; }

        if (currentClose >= takeProfit) {
            var trailOption1 = Number((currentClose - R).toFixed(2));
            trailingStopPrice = Math.max(trailOption1, maShort || 0);
            if(s2) { s2.style.backgroundColor = '#ffeaa7'; s2.style.color = '#d63031'; s2.style.borderColor = '#fdcb6e'; }
            adviceText = `🎯 <b>【獲利滿足提示】</b> ${stockName} 價格已成功衝破 2R 預期目標區 (${takeProfit} 元)！建議分批落袋 1/3，剩餘部位開啟移動停利。`;
            
            if (maShort && currentClose > (maShort * 1.08)) {
                if(s2) { s2.style.backgroundColor = '#e2e8f0'; s2.style.color = '#64748b'; s2.style.borderColor = '#cbd5e1'; }
                if(s3) { s3.style.backgroundColor = '#ffcbdb'; s3.style.color = '#c0392b'; s3.style.borderColor = '#e74c3c'; }
                adviceText = `⚡ <b>【飆股區加速提示】</b> ${stockName} 已進入瘋漲高乖離區！防守線強制綁定短天數均線 (${maShort} 元)，牢牢抱緊直到跌破再離場。`;
                trailingStopPrice = Math.max(trailingStopPrice, maShort || 0);
            }

            buyDecisionHtml = `
                <div style="margin-top:15px; padding:12px; border-radius:6px; background-color:#ffeaa7; border-left:6px solid #e1b12c; color:#2c3e50; line-height: 1.6;">
                    <b>❌ 買進決策：【 🛑 禁買：已達獲利滿足/飆股高乖離區 】</b><br>
                    <span style="font-size:12px; display:block; margin-top:5px; color:#57606f;">
                        目前股價已噴發，此區域為舊部位「收割/移動停利」專屬，此時開新倉追高風險極大。
                    </span>
                </div>`;
        } else {
            if (isBullish) {
                if(s1) { s1.style.backgroundColor = '#dff9fb'; s1.style.color = '#0984e3'; s1.style.borderColor = '#74b9ff'; }
                adviceText = `📈 均線呈強勢多頭排列。目前 ${stockName} 屬於安全蓄勢上漲區，未達 2R 目標價前請安心持股，緊盯原始動態停損點即可。`;
                
                if (riskPercent <= 4.0) {
                    buyDecisionHtml = `
                        <div style="margin-top:15px; padding:12px; border-radius:6px; background-color:#d4edda; border-left:6px solid #28a745; color:#155724; line-height: 1.6;">
                            <b>🎯 買進決策：【 🔥 絕佳買點：拉回防守圈 】</b><br>
                            <span style="font-size:12px; display:block; margin-top:5px; color:#155724;">
                                當前進場潛在風險僅 <b>${riskPercent}%</b>（符合 <= 4% 完美盈虧比）。股價極度貼近防守底線（${stopLoss} 元），具備極高實戰勝率。
                            </span>
                        </div>`;
                } else if (riskPercent > 4.0 && riskPercent <= 7.0) {
                    buyDecisionHtml = `
                        <div style="margin-top:15px; padding:12px; border-radius:6px; background-color:#e3f2fd; border-left:6px solid #2196f3; color:#0d47a1; line-height: 1.6;">
                            <b>🟢 買進決策：【 👍 可嘗試買進：常態推進 】</b><br>
                            <span style="font-size:12px; display:block; margin-top:5px; color:#0d47a1;">
                                趨勢多頭健康，當前進場風險為 <b>${riskPercent}%</b>，屬於合理風控範圍 (4% ~ 7%)，可採取常態分批佈局。
                            </span>
                        </div>`;
                } else {
                    buyDecisionHtml = `
                        <div style="margin-top:15px; padding:12px; border-radius:6px; background-color:#fff3cd; border-left:6px solid #ffc107; color:#856404; line-height: 1.6;">
                            <b>⏳ 買進決策：【 ⚠️ 觀望：短線追高風險偏大 】</b><br>
                            <span style="font-size:12px; display:block; margin-top:5px; color:#856404;">
                                雖然均線健康，但當前進場風險達 <b>${riskPercent}%</b>（已超過 7% 紅線）。此時追高容易被洗盤，建議靜待股價拉回到 <b>${perfectPriceThreshold} 元</b> 以下再行出手。
                            </span>
                        </div>`;
                }
            } else {
                adviceText = `⚖️ ${stockName} 股價目前低於短均線（${maShort} 元）或未形成多頭排列。目前趨勢偏弱或進入盤整，未滿足進場訊號，持股者請嚴守防守價。`;
                buyDecisionHtml = `
                    <div style="margin-top:15px; padding:12px; border-radius:6px; background-color:#e2e8f0; border-left:6px solid #7f8c8d; color:#2c3e50; line-height: 1.6;">
                        <b>❌ 買進決策：【 🛑 禁買：趨勢偏弱未達進場訊號 】</b><br>
                        <span style="font-size:12px; display:block; margin-top:5px; color:#57606f;">
                            該股目前未形成多頭排列或跌破短均線，資金效益極低，絕對禁止開倉抄底。
                        </span>
                    </div>`;
            }
        }

        if (loading) loading.style.display = 'none';
        if (report) report.style.display = 'block';

        document.getElementById('report-title-left').innerHTML = `📊 【${stockId} ${stockName}】均線與週期數據`;
        document.getElementById('report-title-right').innerHTML = `💼 【${stockId} ${stockName}】動態風控導航面板`;

        document.getElementById('technical-data').innerHTML = 
            '• <b>當前真實收盤價：</b> <span class="text-bullish highlight">' + currentClose + '</span> 元<br>' +
            '• <b>' + maShortPeriod + '日均線價位：</b> ' + (maShort ? maShort + ' 元' : '計算中...') + '<br>' +
            '• <b>' + maLongPeriod + '日均線價位：</b> ' + (maLong ? maLong + ' 元' : '計算中...') + '<br>' +
            '• <b>今日單日真實 TR：</b> ' + todayTrueRange + ' 元<br>' +
            '• <b>🔥 操作週期採計：' + maShortPeriod + ' 日平均真實波幅 (R)：</b> <span class="text-bullish">' + R + '</span> 元';

        document.getElementById('risk-data').innerHTML = 
            '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
            '• <b>當前進場潛在風險：</b> <span style="color:#e67e22; font-weight:bold;">' + riskPercent + '%</span><br>' +
            '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b> (剛進場防守線)<br>' +
            '• <b>波段預期停利點：</b> <span class="text-danger"><b>' + takeProfit + ' 元</b></span> (1:2 盈虧比目標)<br>' +
            '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
            '• <b>🚨 今日實戰防守價：</b> <span class="text-bullish" style="font-size:1.4em;">' + trailingStopPrice + ' 元</span><br>' +
            '</div>' +
            '<div style="margin-top:12px; font-size:13px; line-height: 1.5; color:#2c3e50; background:#f8f9fa; padding:10px; border-radius:6px; border-left: 4px solid #1abc9c;">' + adviceText + '</div>' +
            buyDecisionHtml;

    } catch (e) {
        if (loading) loading.style.display = 'none';
        alert('數據直連失敗: ' + e.message);
    }
};
