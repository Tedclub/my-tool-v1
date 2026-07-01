// ==========================================
// 1. 初始化與動態歷史按鈕渲染 (相容舊版結構)
// ==========================================
document.addEventListener("DOMContentLoaded", function() {
    initHistoryButtons();
});

function initHistoryButtons() {
    var history = JSON.parse(localStorage.getItem('stock_history')) || [];
    
    // 0050 永遠在最前面
    if (!history.includes('0050')) {
        history.unshift('0050');
    } else {
        history = history.filter(item => item !== '0050');
        history.unshift('0050');
    }
    localStorage.setItem('stock_history', JSON.stringify(history));

    // 💡 關鍵相容：如果舊 HTML 找不到 history-tags，我們就直接把按鈕塞在「開始動態風控計算」按鈕的上方！
    var container = document.getElementById('history-tags');
    if (!container) {
        // 如果找不到容器，動態在畫面上創造一個，塞在輸入框群組的後面
        var inputGroup = document.querySelector('.input-group');
        if (inputGroup) {
            container = document.createElement('div');
            container.id = 'history-tags';
            container.className = 'quick-links';
            container.style.cssText = 'margin-top: 15px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 6px;';
            inputGroup.parentNode.insertBefore(container, inputGroup.nextSibling);
        }
    }

    if (container) {
        container.innerHTML = '';
        history.forEach(function(code) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.style.cssText = 'background: #ebdcb9; color: #333; border: none; padding: 6px 12px; margin-right: 5px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: bold; transition: background 0.2s;';
            btn.innerText = code === '0050' ? '0050 元大台灣50' : code;
            btn.onclick = function() {
                document.getElementById("stock-code").value = code;
                analyzeTaiwanStock();
            };
            container.appendChild(btn);
        });
    }
}

function saveToHistory(code) {
    if (code === '0050' || !code) return;
    var history = JSON.parse(localStorage.getItem('stock_history')) || ['0050'];
    history = history.filter(item => item !== code);
    history.splice(1, 0, code); // 插在 0050 後面
    if (history.length > 10) history = history.slice(0, 10);
    localStorage.setItem('stock_history', JSON.stringify(history));
    initHistoryButtons();
}

// ==========================================
// 2. 均線與振幅計算核心
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
        totalTR += Math.max(today.high - today.low, Math.abs(today.high - yesterday.close), Math.abs(today.low - yesterday.close));
        count++;
    }
    return count > 0 ? Number((totalTR / count).toFixed(2)) : Number((validData[len-1].high - validData[len-1].low).toFixed(2));
}

// ==========================================
// 3. 主控程式流程
// ==========================================
async function analyzeTaiwanStock() {
    var stockId = document.getElementById('stock-code').value.trim();
    if (!stockId) { alert('請輸入股票代碼！'); return; }

    var paramN = parseFloat(document.getElementById('param-n').value) || 2;
    var maShortPeriod = parseInt(document.getElementById('param-ma-short').value) || 5;
    var maLongPeriod = parseInt(document.getElementById('param-ma-long').value) || 20;

    var loading = document.getElementById('loading');
    var report = document.getElementById('report-section');
    if(loading) loading.style.display = 'block';
    if(report) report.style.display = 'none';

    var workerUrl = `https://taiwan-stock-api.tedclub.workers.dev?stock=${stockId}`;

    try {
        var response = await fetch(workerUrl);
        if (!response.ok) throw new Error("後端伺服器回應異常");
        var resData = await response.json();
        if (!resData.data || resData.data.length === 0) throw new Error("查無此股票或未開盤");

        // 🎯 1. 抓取股票名稱 (FinMind 欄位對接)
        var stockName = resData.data[0].stock_name || "台灣個股";
        var displayTitle = `${stockId} ${stockName}`;

        // 成功後記錄歷史紀錄
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

        // 🟢 2. 頂部燈號控制 (安全對接你畫面上的三個老格子)
        var s1 = document.getElementById('status-1') || document.querySelector('.status-container div:nth-child(1)');
        var s2 = document.getElementById('status-2') || document.querySelector('.status-container div:nth-child(2)');
        var s3 = document.getElementById('status-3') || document.querySelector('.status-container div:nth-child(3)');
        
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
        } else {
            if (isBullish) {
                if(s1) { s1.style.backgroundColor = '#dff9fb'; s1.style.color = '#0984e3'; s1.style.borderColor = '#74b9ff'; }
                adviceText = `📈 均線呈強勢多頭排列。目前 ${stockName} 屬於安全蓄勢上漲區，未達 2R 目標價前請安心持股，緊盯原始動態停損點即可。`;
            } else {
                adviceText = `⚖️ ${stockName} 股價目前低於短均線（${maShort} 元）或未形成多頭排列。目前趨勢偏弱或進入盤整，未滿足進場訊號，持股者請嚴守防守價。`;
            }
        }

        if(loading) loading.style.display = 'none';
        if(report) report.style.display = 'block';

        // 🎯 3. 動態修改左右兩邊的卡片大標題，直接秀出「代碼 + 股名」
        var leftTitle = document.getElementById('report-title-left') || document.querySelector('.report-grid .card:nth-child(1) h3');
        var rightTitle = document.getElementById('report-title-right') || document.querySelector('.report-grid .card:nth-child(2) h3');
        
        if(leftTitle) leftTitle.innerHTML = `📊 【${displayTitle}】均線與週期數據`;
        if(rightTitle) rightTitle.innerHTML = `💼 【${displayTitle}】動態風控導航面板`;

        document.getElementById('technical-data').innerHTML = 
            '• <b>當前真實收盤價：</b> <span style="color:#e74c3c; font-weight:bold; font-size:20px;">' + currentClose + '</span> 元<br>' +
            '• <b>' + maShortPeriod + '日均線價位：</b> ' + (maShort ? maShort + ' 元' : '計算中...') + '<br>' +
            '• <b>' + maLongPeriod + '日均線價位：</b> ' + (maLong ? maLong + ' 元' : '計算中...') + '<br>' +
            '• <b>今日單日真實 TR：</b> ' + todayTrueRange + ' 元<br>' +
            '• <b>🔥 操作週期採計：' + maShortPeriod + ' 日平均真實波幅 (R)：</b> <span style="color:#e74c3c; font-weight:bold;">' + R + '</span> 元';

        document.getElementById('risk-data').innerHTML = 
            '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
            '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b> (剛進場防守線)<br>' +
            '• <b>波段預期停利點：</b> <span style="color:#e74c3c; font-weight:bold;">' + takeProfit + ' 元</span> (1:2 盈虧比目標)<br>' +
            '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
            '• <b>🚨 今日實戰防守價：</b> <span style="color:#e74c3c; font-size:1.4em; font-weight:bold;">' + trailingStopPrice + ' 元</span><br>' +
            '</div>' +
            '<div style="margin-top:12px; font-size:13px; line-height: 1.5; color:#2c3e50; background:#f8f9fa; padding:10px; border-radius:6px; border-left: 4px solid #1abc9c;">' + adviceText + '</div>';

    } catch (e) {
        if(loading) loading.style.display = 'none';
        alert('數據直連失敗: ' + e.message);
    }
}
