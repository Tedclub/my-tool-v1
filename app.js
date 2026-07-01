// ==========================================
// 1. 均線計算核心 (SMA)
// ==========================================
function calculateSMA(data, idx, period) {
    if (idx < period - 1) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) { sum += data[idx - i]; }
    return Number((sum / period).toFixed(2));
}

// ==========================================
// 2. 正宗風控核心：計算包含跳空風險的 True Range 週期平均值 (ATR)
// ==========================================
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

// 快速選擇按鈕功能
function quickSelect(code) {
    document.getElementById("stock-code").value = code;
    analyzeTaiwanStock();
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

    // 🎯 雲端中繼站 API 網址
    var workerUrl = `https://taiwan-stock-api.tedclub.workers.dev?stock=${stockId}`;

    try {
        var response = await fetch(workerUrl);
        if (!response.ok) throw new Error("後端伺服器回應異常");
        var resData = await response.json();
        
        if (!resData.data || resData.data.length === 0) throw new Error("查無此股票代碼或今日未開盤");

        var validData = resData.data.map(function(item) {
            return {
                date: item.date,
                close: parseFloat(item.close),
                high: parseFloat(item.max), 
                low: parseFloat(item.min)   
            };
        });

        var len = validData.length;
        if (len < 2) throw new Error("歷史數據不足");

        var closeArr = validData.map(function(d) { return d.close; });

        var currentClose = validData[len - 1].close;
        var currentHigh = validData[len - 1].high;
        var currentLow = validData[len - 1].low;
        var yesterdayClose = validData[len - 2].close;

        // 計算單日 TR 與多日平均 R
        var todayTr1 = currentHigh - currentLow;
        var todayTr2 = Math.abs(currentHigh - yesterdayClose);
        var todayTr3 = Math.abs(currentLow - yesterdayClose);
        var todayTrueRange = Number(Math.max(todayTr1, todayTr2, todayTr3).toFixed(2));
        var R = calculateTrueRangeAverage(validData, maShortPeriod); 

        var maShort = calculateSMA(closeArr, len - 1, maShortPeriod);
        var maLong = calculateSMA(closeArr, len - 1, maLongPeriod);
        
        // 數值精準比對
        var isBullish = false;
        if (maShort && maLong) {
            if (currentClose > maShort && maShort > maLong) {
                isBullish = true;
            }
        }

        // 風控價格計算
        var stopLoss = Number((currentClose - (R * paramN)).toFixed(2));
        var takeProfit = Number((currentClose + (R * paramN * 2)).toFixed(2));

        var trailingStopPrice = stopLoss; 
        var adviceText = '';

        // 🔄 這裡直接對接你原本網頁頂端的三個格子 (ID分別為 status-1, status-2, status-3)
        // 先把所有格子顏色重設為灰色
        var s1 = document.getElementById('status-1');
        var s2 = document.getElementById('status-2');
        var s3 = document.getElementById('status-3');
        
        if(s1) s1.style.backgroundColor = '#e2e8f0'; 
        if(s2) s2.style.backgroundColor = '#e2e8f0';
        if(s3) s3.style.backgroundColor = '#e2e8f0';

        // 核心邏輯判定與亮燈
        if (currentClose >= takeProfit) {
            var trailOption1 = Number((currentClose - R).toFixed(2));
            trailingStopPrice = Math.max(trailOption1, maShort || 0);
            
            if(s2) s2.style.backgroundColor = '#ffeaa7'; // 亮黃燈：利潤滿足
            adviceText = `🎯 <b>【獲利滿足提示】</b> 價格已成功衝破 2R 預期目標區 (${takeProfit} 元)！建議分批落袋 1/3，剩餘部位開啟移動停利。`;
            
            if (maShort && currentClose > (maShort * 1.08)) {
                if(s2) s2.style.backgroundColor = '#e2e8f0';
                if(s3) s3.style.backgroundColor = '#ffcbdb'; // 亮紅燈：飆股區
                adviceText = `⚡ <b>【飆股區加速提示】</b> 股價已進入瘋漲高乖離區！防守線強制綁定短天數均線 (${maShort} 元)，牢牢抱緊直到跌破再離場。`;
                trailingStopPrice = Math.max(trailingStopPrice, maShort || 0);
            }
        } else {
            if (isBullish) {
                if(s1) s1.style.backgroundColor = '#dff9fb'; // 亮綠燈：安全蓄勢
                adviceText = `📈 均線呈強勢多頭排列。目前屬於安全蓄勢上漲區，未達 2R 目標價前請安心持股，緊盯原始動態停損點即可。`;
            } else {
                // 華邦電此時會完美走進這裡：不亮任何頂部燈號（保持灰色），並顯示提示
                adviceText = `⚖️ 股價目前低於短均線（${maShort} 元）或未形成多頭排列。目前趨勢偏弱或進入盤整，未滿足進場訊號，持股者請嚴守防守價。`;
            }
        }

        if(loading) loading.style.display = 'none';
        if(report) report.style.display = 'block';

        // 渲染左邊：均線與週期數據
        var techDataBox = document.getElementById('technical-data');
        if(techDataBox) {
            techDataBox.innerHTML = 
                '• <b>當前真實收盤價：</b> <span style="color:#e74c3c; font-weight:bold;">' + currentClose + '</span> 元<br>' +
                '• <b>' + maShortPeriod + '日均線價位：</b> ' + (maShort ? maShort + ' 元' : '計算中...') + '<br>' +
                '• <b>' + maLongPeriod + '日均線價位：</b> ' + (maLong ? maLong + ' 元' : '計算中...') + '<br>' +
                '• <b>今日單日真實 TR：</b> ' + todayTrueRange + ' 元<br>' +
                '• <b>🔥 操作週期採計：' + maShortPeriod + ' 日平均真實波幅 (R)：</b> <span style="color:#e74c3c; font-weight:bold;">' + R + '</span> 元';
        }

        // 渲染右邊：風控面板與經典編排
        var riskDataBox = document.getElementById('risk-data');
        if(riskDataBox) {
            riskDataBox.innerHTML = 
                '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
                '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b> (剛進場防守線)<br>' +
                '• <b>波段預期停利點：</b> <span style="color:#e74c3c; font-weight:bold;">' + takeProfit + ' 元</span> (1:2 盈虧比)<br>' +
                '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
                '• <b>🚨 今日實戰防守價：</b> <span style="color:#e74c3c; font-size:1.4em; font-weight:bold;">' + trailingStopPrice + ' 元</span><br>' +
                '</div>' +
                '<div style="margin-top:12px; font-size:13px; line-height: 1.5; color:#2c3e50; background:#f8f9fa; padding:10px; border-radius:6px; border-left: 4px solid #1abc9c;">' + adviceText + '</div>';
        }

    } catch (e) {
        if(loading) loading.style.display = 'none';
        alert('數據直連失敗，原因: ' + e.message);
    }
}
