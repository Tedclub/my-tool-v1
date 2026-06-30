function calculateSMA(data, idx, period) {
    if (idx < period - 1) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) { sum += data[idx - i]; }
    return Number((sum / period).toFixed(2));
}

function quickSelect(code) {
    document.getElementById("stock-code").value = code;
    analyzeTaiwanStock();
}

function runBacktest(validData, maShortPeriod, maLongPeriod, paramN) {
    var trades = [];
    var currentTrade = null;
    var logHTML = "";

    var closeArr = validData.map(function(d) { return d.close; });
    var maShortArr = [];
    var maLongArr = [];
    for (var i = 0; i < validData.length; i++) {
        maShortArr.push(calculateSMA(closeArr, i, maShortPeriod));
        maLongArr.push(calculateSMA(closeArr, i, maLongPeriod));
    }

    for (var i = maLongPeriod; i < validData.length; i++) {
        var today = validData[i];
        var yesterday = validData[i - 1];
        var todayAmp = Number((today.high - today.low).toFixed(2));

        var isBullishToday = today.close > maShortArr[i] && maShortArr[i] > maLongArr[i];
        var isBullishYesterday = yesterday.close > maShortArr[i-1] && maShortArr[i-1] > maLongArr[i-1];

        if (!currentTrade) {
            if (isBullishToday && !isBullishYesterday) {
                currentTrade = {
                    entryDate: today.date,
                    entryPrice: today.close,
                    stopLoss: Number((today.close - (todayAmp * paramN)).toFixed(2)),
                    takeProfit: Number((today.close + (todayAmp * paramN * 2)).toFixed(2)),
                    hasHitTarget: false,
                    maxCloseAfterTarget: today.close,
                    trailingStop: Number((today.close - (todayAmp * paramN)).toFixed(2))
                };
                logHTML += "🟢 <b>[" + today.date + "]</b> 滿足強勢多頭排列，模擬以收盤價 <b>" + today.close + "</b> 元進場（初始防守：" + currentTrade.stopLoss + " 元）<br>";
            }
        } else {
            if (!currentTrade.hasHitTarget) {
                if (today.high >= currentTrade.takeProfit) {
                    currentTrade.hasHitTarget = true;
                    currentTrade.maxCloseAfterTarget = Math.max(today.close, currentTrade.entryPrice);
                    var trailOpt = Number((today.close - todayAmp).toFixed(2));
                    currentTrade.trailingStop = Math.max(trailOpt, maShortArr[i] || 0);
                    logHTML += "🎯 <b>[" + today.date + "]</b> 衝破預期目標價 " + currentTrade.takeProfit + " 元！<b>啟動移動停利機制</b>，防守點抬高至 <b>" + currentTrade.trailingStop + "</b> 元。<br>";
                }
            } else {
                if (today.close > currentTrade.maxCloseAfterTarget) {
                    currentTrade.maxCloseAfterTarget = today.close;
                    var trailOpt = Number((today.close - todayAmp).toFixed(2));
                    var newTrail = Math.max(trailOpt, maShortArr[i] || 0);
                    if (newTrail > currentTrade.trailingStop) { currentTrade.trailingStop = newTrail; }
                }
            }

            if (!currentTrade.hasHitTarget) {
                if (today.close < currentTrade.stopLoss) {
                    var pnlPercent = Number(((today.close - currentTrade.entryPrice) / currentTrade.entryPrice * 100).toFixed(2));
                    logHTML += "❌ <b>[" + today.date + "]</b> 跌破初始停損 " + currentTrade.stopLoss + " 元出場。模擬損益：<span style=\"color:#e74c3c; font-weight:bold;\">" + pnlPercent + "%</span><br>----------------------------------<br>";
                    currentTrade.result = "LOSS"; currentTrade.pnl = pnlPercent; trades.push(currentTrade); currentTrade = null;
                }
            } else {
                if (today.close < currentTrade.trailingStop) {
                    var pnlPercent = Number(((today.close - currentTrade.entryPrice) / currentTrade.entryPrice * 100).toFixed(2));
                    logHTML += "🚀 <b>[" + today.date + "]</b> 跌破移動停利防守線 " + currentTrade.trailingStop + " 元，波段獲利結清！模擬報酬：<span style=\"color:#2ecc71; font-weight:bold;\">+" + pnlPercent + "%</span><br>----------------------------------<br>";
                    currentTrade.result = "WIN"; currentTrade.pnl = pnlPercent; trades.push(currentTrade); currentTrade = null;
                }
            }
        }
    }

    if (currentTrade) {
        var pnlPercent = Number(((validData[validData.length-1].close - currentTrade.entryPrice) / currentTrade.entryPrice * 100).toFixed(2));
        logHTML += "⏳ <b>[" + validData[validData.length-1].date + " 續抱中]</b> 目前防守價：<b>" + currentTrade.trailingStop + "</b> 元，未實現損益：+" + pnlPercent + "%<br>";
    }

    var total = trades.length;
    var wins = trades.filter(function(t) { return t.result === "WIN"; }).length;
    var losses = trades.filter(function(t) { return t.result === "LOSS"; }).length;
    var winRate = total > 0 ? Number((wins / total * 100).toFixed(1)) : 0;
    var totalProfit = trades.reduce(function(sum, t) { return sum + t.pnl; }, 0);

    return { total: total, wins: wins, losses: losses, winRate: winRate, totalProfit: Number(totalProfit.toFixed(2)), logHTML: logHTML };
}

async function analyzeTaiwanStock() {
    var stockId = document.getElementById('stock-code').value.trim();
    if (!stockId) { alert('請輸入股票代碼！'); return; }

    var paramN = parseFloat(document.getElementById('param-n').value) || 2;
    var maShortPeriod = parseInt(document.getElementById('param-ma-short').value) || 5;
    var maLongPeriod = parseInt(document.getElementById('param-ma-long').value) || 20;

    document.getElementById("th-ma-short").innerText = maShortPeriod + "日均線";
    document.getElementById("th-ma-long").innerText = maLongPeriod + "日均線";

    var loading = document.getElementById('loading');
    var report = document.getElementById('report-section');
    
    loading.style.display = 'block';
    report.style.display = 'none';

    // 🌐 使用 Stooq 全球開源不限流節點，100% 避開 CORS 封鎖
    var targetSymbol = stockId.endsWith(".TW") ? stockId.replace(".TW", "") : stockId;
    var url = `https://stooq.com/q/d/l/?s=${targetSymbol}.tw&i=d`;

    try {
        var response = await fetch(url);
        if (!response.ok) throw new Error("Stooq 數據源連線失敗");
        var csvText = await response.text();
        
        var lines = csvText.split('\n');
        if (lines.length <= 2 || lines[1].includes("No data")) {
            throw new Error("找不到該股票歷史行情，請檢查代碼是否正確（如：2330）");
        }

        var validData = [];
        // 解析 CSV 數據 (Date,Open,High,Low,Close,Volume)
        for (var i = 1; i < lines.length; i++) {
            var cols = lines[i].split(',');
            if (cols.length >= 5) {
                var closeVal = parseFloat(cols[4]);
                var highVal = parseFloat(cols[2]);
                var lowVal = parseFloat(cols[3]);
                if (!isNaN(closeVal) && !isNaN(highVal) && !isNaN(lowVal)) {
                    validData.push({
                        date: cols[0].trim(),
                        close: closeVal,
                        high: highVal,
                        low: lowVal
                    });
                }
            }
        }

        // 僅取最近 100 筆交易日做回測與精準均線計算
        if(validData.length > 100) {
            validData = validData.slice(-100);
        }

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
        var adviceText = "";

        if (currentClose >= takeProfit) {
            var trailOption1 = Number((currentClose - currentAmplitude).toFixed(2));
            trailingStopPrice = Math.max(trailOption1, maShort || 0);
            if (currentClose > (takeProfit * 1.05)) {
                navigationStatus = "MOON";
                adviceText = "🔥 【飆股續抱提示】價格已遠超波段預期！多頭動能極強，收盤未跌破今日防守價前讓利潤無限制狂飆！";
            } else {
                navigationStatus = "TARGET";
                adviceText = "🎯 【獲利滿足提示】價格已成功觸及目標區！建議分批落袋 1/3 鎖定利潤。其餘持股啟動「移動停利機制」抱緊博取大波段！";
            }
        } else {
            navigationStatus = "SAFE";
            adviceText = isBullish ? "🟢 均線呈多頭排列，目前屬於安全蓄勢上漲區，未達目標價前請安心持股，盯緊原始停損即可。" : "⚖️ 趨勢偏弱或處於盤整震盪，未滿足進場訊號，建議保持觀望。";
        }

        var btResult = runBacktest(validData, maShortPeriod, maLongPeriod, paramN);

        loading.style.display = 'none';
        report.style.display = 'block';

        document.getElementById("bt-total").innerText = btResult.total + " 次";
        document.getElementById("bt-wins").innerText = btResult.wins + " 次";
        document.getElementById("bt-losses").innerText = btResult.losses + " 次";
        document.getElementById("bt-winrate").innerText = btResult.winRate + " %";
        
        var profitBox = document.getElementById("bt-profit");
        profitBox.innerText = (btResult.totalProfit >= 0 ? "+" : "") + btResult.totalProfit + " %";
        profitBox.style.color = btResult.totalProfit >= 0 ? "var(--success)" : "var(--danger)";
        document.getElementById("backtest-log").innerHTML = btResult.logHTML;

        document.getElementById("nav-step-safe").className = "nav-light-step" + (navigationStatus === "SAFE" ? " active-safe" : "");
        document.getElementById("nav-step-target").className = "nav-light-step" + (navigationStatus === "TARGET" ? " active-target" : "");
        document.getElementById("nav-step-moon").className = "nav-light-step" + (navigationStatus === "MOON" ? " active-moon" : "");

        var signalCard = document.getElementById('signal-card');
        var strategySignal = document.getElementById('strategy-signal');

        if (isBullish) {
            signalCard.className = "card signal-card-bullish";
            strategySignal.className = "signal-box text-bullish";
            strategySignal.innerText = "🚀 強勢多頭排列：價格 > MA" + maShortPeriod + " > MA" + maLongPeriod;
        } else {
            signalCard.className = "card signal-card-neutral";
            strategySignal.className = "signal-box";
            strategySignal.style.color = "#7f8c8d";
            strategySignal.innerText = "⚖️ 趨勢非多頭排列 (建議保持觀望)";
        }

        document.getElementById('technical-data').innerHTML = 
            '• <b>當前真實收盤價位：</b> <span class="highlight text-bullish">' + currentClose + '</span> 元<br>' +
            '• <b>' + maShortPeriod + '日均線價位：</b> ' + maShort + ' 元<br>' +
            '• <b>' + maLongPeriod + '日均線價位：</b> ' + maLong + ' 元<br>' +
            '• <b>當日真實振幅 (高-低)：</b> <span class="text-bullish">' + currentAmplitude + '</span> 元 (最高 ' + currentHigh + ' / 最低 ' + currentLow + ')';

        document.getElementById('risk-data').innerHTML = 
            '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
            '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b><br>' +
            '• <b>波段預期停利點：</b> <span class="text-danger" style="font-weight:bold;">' + takeProfit + ' 元</span><br>' +
            '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
            '• <b>🚨 今日實戰防守價：</b> <span class="text-bullish highlight" style="font-size:1.4em;">' + trailingStopPrice + ' 元</span><br>' +
            '</div>' +
            '<div style="margin-top:10px; font-size:13px; font-weight:bold; color:#2c3e50; background:#f8f9fa; padding:8px; border-radius:4px;">' + adviceText + '</div>';

        var tbody = document.querySelector('#details-table tbody');
        tbody.innerHTML = '';
        var displayRows = validData.slice(-5).reverse();
        displayRows.forEach(function(row, i) {
            var actualIdx = (len - 1) - i;
            var amp = Number((row.high - row.low).toFixed(2));
            tbody.innerHTML += '<tr><td>' + row.date + '</td><td><b>' + row.close + '</b></td><td>' + row.high + '</td><td>' + row.low + '</td><td>' + amp + '</td><td>' + (calculateSMA(closeArr, actualIdx, maShortPeriod) || '-') + '</td><td>' + (calculateSMA(closeArr, actualIdx, maLongPeriod) || '-') + '</td></tr>';
        });

    } catch (e) {
        loading.style.display = 'none';
        alert('金融數據直連失敗，原因: ' + e.message);
    }
}
