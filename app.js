// 1. 均線計算核心
function calculateSMA(data, idx, period) {
    if (idx < period - 1) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) { sum += data[idx - i]; }
    return Number((sum / period).toFixed(2));
}

// 2. 正宗風控核心：計算包含跳空風險的 True Range 週期平均值 (ATR)
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

        var trueRange = Math.max(tr1, tr2, tr3);
        totalTR += trueRange;
        count++;
    }
    
    return count > 0 ? Number((totalTR / count).toFixed(2)) : Number((validData[len-1].high - validData[len-1].low).toFixed(2));
}

// 快速選擇按鈕
function quickSelect(code) {
    document.getElementById("stock-code").value = code;
    analyzeTaiwanStock();
}

// 3. 主控程式流程
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

    // 🚀 這裡請確保換成你自己的 Cloudflare Workers 網址（保留最後的 ?stock=）
    var workerUrl = `https://taiwan-stock-api.tedclub.workers.dev?stock=${stockId}`;

    try {
        var response = await fetch(workerUrl);
        if (!response.ok) throw new Error("後端伺服器回應異常");
        var resData = await response.json();
        
        if (!resData.data || resData.data.length === 0) throw new Error("查無此股票代碼或今日未開盤");

        // 🎯 欄位精準對接 FinMind
        var validData = resData.data.map(function(item) {
            return {
                date: item.date,
                close: parseFloat(item.close),
                high: parseFloat(item.max), 
                low: parseFloat(item.min)   
            };
        });

        var len = validData.length;
        if (len < 2) throw new Error("歷史數據不足，無法計算真實波幅。");

        var closeArr = validData.map(function(d) { return d.close; });

        var currentClose = validData[len - 1].close;
        var currentHigh = validData[len - 1].high;
        var currentLow = validData[len - 1].low;
        var yesterdayClose = validData[len - 2].close;

        // 計算今日 TR 三合一
        var todayTr1 = currentHigh - currentLow;
        var todayTr2 = Math.abs(currentHigh - yesterdayClose);
        var todayTr3 = Math.abs(currentLow - yesterdayClose);
        var todayTrueRange = Number(Math.max(todayTr1, todayTr2, todayTr3).toFixed(2));

        // 採計多日平均的真實波幅 R 
        var R = calculateTrueRangeAverage(validData, maShortPeriod); 

        var maShort = calculateSMA(closeArr, len - 1, maShortPeriod);
        var maLong = calculateSMA(closeArr, len - 1, maLongPeriod);
        var isBullish = (maShort && maLong) ? (currentClose > maShort && maShort > maLong) : false;

        // 🔥 經典實用風控價位推算（加入利潤滿足點與瘋漲區臨界值）
        var stopLoss = Number((currentClose - (R * paramN)).toFixed(2));
        var takeProfit = Number((currentClose + (R * paramN * 2)).toFixed(2)); // 2倍風控空間 = 2R 預期目標

        var trailingStopPrice = stopLoss; 
        var statusHtml = '';
        var adviceText = '';

        // 🎯 經典三燈號與提醒判定邏輯
        if (currentClose >= takeProfit) {
            // 狀態 2：利潤首要滿足點 (衝破 2R 預期目標區)
            var trailOption1 = Number((currentClose - R).toFixed(2));
            trailingStopPrice = Math.max(trailOption1, maShort || 0);
            
            statusHtml = `<div style="background-color: #ffeaa7; padding: 15px; border-radius: 8px; font-weight: bold; text-align: center; color: #d63031; border: 2px solid #fdcb6e; margin-bottom: 15px;">🔥 利潤首要滿足點 (建議分批落袋 1/3)</div>`;
            adviceText = `🎯 <b>【獲利滿足提示】</b> 價格已成功衝破 2R 預期目標區 (${takeProfit} 元)！建議採取強勢防守，剩餘部位開啟移動停利。`;
            
            if (isBullish && currentClose > (maShort * 1.08)) {
                // 狀態 3：瘋狂主升飆股區 (乖離率大於 8% 且多頭排列)
                statusHtml = `<div style="background-color: #ffcbdb; padding: 15px; border-radius: 8px; font-weight: bold; text-align: center; color: #c0392b; border: 2px solid #e74c3c; margin-bottom: 15px;">🚀 瘋狂主升飆股區 (啟動 ${maShortPeriod}MA 移動停利)</div>`;
                adviceText = `⚡ <b>【飆股區加速提示】</b> 股價已進入瘋漲高乖離區！防守線強制綁定短天數均線 (${maShort} 元) 或前日低點，牢牢抱緊直到跌破再離場。`;
                trailingStopPrice = Math.max(trailingStopPrice, maShort || 0);
            }
        } else {
            // 狀態 1：安全蓄勢區 (未達標)
            statusHtml = `<div style="background-color: #dff9fb; padding: 15px; border-radius: 8px; font-weight: bold; text-align: center; color: #0984e3; border: 2px solid #74b9ff; margin-bottom: 15px;">🟢 安全蓄勢區 (未達目標價)</div>`;
            adviceText = isBullish 
                ? `📈 均線呈強勢多頭排列。目前屬於安全蓄勢上漲區，未達 2R 目標價前請安心持股，緊盯原始動態停損點即可。`
                : `⚖️ 趨勢偏弱、進入盤整或回檔。目前未滿足強勢多頭進場訊號，請謹慎觀望。`;
        }

        if(loading) loading.style.display = 'none';
        if(report) report.style.display = 'block';

        // 渲染左邊：數據面板
        document.getElementById('technical-data').innerHTML = 
            '• <b>當前真實收盤價：</b> <span class="highlight text-bullish">' + currentClose + '</span> 元<br>' +
            '• <b>' + maShortPeriod + '日均線價位：</b> ' + (maShort ? maShort + ' 元' : '計算中...') + '<br>' +
            '• <b>' + maLongPeriod + '日均線價位：</b> ' + (maLong ? maLong + ' 元' : '計算中...') + '<br>' +
            '• <b>今日單日真實 TR：</b> ' + todayTrueRange + ' 元<br>' +
            '• <b>🔥 操作週期採計：' + maShortPeriod + ' 日平均真實波幅 (R)：</b> <span class="text-bullish" style="font-weight:bold;">' + R + '</span> 元';

        // 渲染右邊：風控面板 (完美塞入經典提醒編排)
        document.getElementById('risk-data').innerHTML = 
            statusHtml + // 注入最實用的動態彩色狀態大燈號
            '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
            '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b> (剛進場防守線)<br>' +
            '• <b>波段利潤滿足點 (2R)：</b> <span class="text-danger" style="font-weight:bold;">' + takeProfit + ' 元</span> (1:2 盈虧比目標)<br>' +
            '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
            '• <b>🚨 今日實戰防守價：</b> <span class="text-bullish highlight" style="font-size:1.4em;">' + trailingStopPrice + ' 元</span><br>' +
            '</div>' +
            '<div style="margin-top:12px; font-size:13px; line-height: 1.5; color:#2c3e50; background:#f8f9fa; padding:10px; border-radius:6px; border-left: 4px solid #1abc9c;">' + adviceText + '</div>';

    } catch (e) {
        if(loading) loading.style.display = 'none';
        alert('數據直連失敗，原因: ' + e.message);
    }
}
