function calculateSMA(data, idx, period) {
    if (idx < period - 1) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) { sum += data[idx - i]; }
    return Number((sum / period).toFixed(2));
}

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

    // 🚀 【核心更換】把這裡換成你剛剛在 Cloudflare Workers 得到的專屬網址！
    var workerUrl = `https://taiwan-stock-api.tedclub.workers.dev?stock=${stockId}`;

    try {
        var response = await fetch(workerUrl);
        if (!response.ok) throw new Error("後端伺服器回應異常");
        
        var resData = await response.json();
        
        // 解析 FinMind 回傳的資料結構
        if (!resData.data || resData.data.length === 0) {
            throw new Error("查無此股票代碼或今日未開盤");
        }

        // 將 FinMind 數據轉換為前端需要的 K 線結構
        var validData = resData.data.map(function(item) {
            return {
                date: item.date,
                close: item.close,
                high: item.max, // FinMind 的最高價欄位是 max
                low: item.min   // FinMind 的最低價欄位是 min
            };
        });

        var len = validData.length;
        var closeArr = validData.map(function(d) { return d.close; });

        var currentClose = validData[len - 1].close;
        var currentHigh = validData[len - 1].high;
        var currentLow = validData[len - 1].low;
        var currentAmplitude = Number((currentHigh - currentLow).toFixed(2)); 

        var maShort = calculateSMA(closeArr, len - 1, maShortPeriod);
        var maLong = calculateSMA(closeArr, len - 1, maLongPeriod);
        var isBullish = (maShort && maLong) ? (currentClose > maShort && maShort > maLong) : false;

        var stopLoss = Number((currentClose - (currentAmplitude * paramN)).toFixed(2));
        var takeProfit = Number((currentClose + (currentAmplitude * paramN * 2)).toFixed(2));

        var trailingStopPrice = stopLoss; 
        var navigationStatus = "SAFE";    
        var adviceText = isBullish ? "🟢 均線呈多頭排列，目前屬於安全蓄勢上漲區。" : "⚖️ 趨勢偏弱，未滿足進場訊號。";

        if (currentClose >= takeProfit) {
            var trailOption1 = Number((currentClose - currentAmplitude).toFixed(2));
            trailingStopPrice = Math.max(trailOption1, maShort || 0);
            navigationStatus = "TARGET";
            adviceText = "🎯 【獲利滿足提示】價格已觸及波段預期目標點！";
        }

        if(loading) loading.style.display = 'none';
        if(report) report.style.display = 'block';

        // 渲染畫面數據
        document.getElementById('technical-data').innerHTML = 
            '• <b>當前真實收盤價：</b> <span class="highlight text-bullish">' + currentClose + '</span> 元<br>' +
            '• <b>' + maShortPeriod + '日均線價位：</b> ' + maShort + ' 元<br>' +
            '• <b>' + maLongPeriod + '日均線價位：</b> ' + maLong + ' 元<br>' +
            '• <b>今日真實振幅 (高-低)：</b> <span class="text-bullish">' + currentAmplitude + '</span> 元 (最高 ' + currentHigh + ' / 最低 ' + currentLow + ')';

        document.getElementById('risk-data').innerHTML = 
            '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
            '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b><br>' +
            '• <b>波段預期停利點：</b> <span class="text-danger" style="font-weight:bold;">' + takeProfit + ' 元</span><br>' +
            '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
            '• <b>🚨 今日實戰防守價：</b> <span class="text-bullish highlight" style="font-size:1.4em;">' + trailingStopPrice + ' 元</span><br>' +
            '</div>' +
            '<div style="margin-top:10px; font-size:13px; font-weight:bold; color:#2c3e50; background:#f8f9fa; padding:8px; border-radius:4px;">' + adviceText + '</div>';

    } catch (e) {
        if(loading) loading.style.display = 'none';
        alert('數據直連失敗，原因: ' + e.message);
    }
}
