// ==========================================
// 1. 初始化與動態歷史按鈕渲染 (最多10檔，第一檔固定0050)
// ==========================================
document.addEventListener("DOMContentLoaded", function() {
    // 網頁載入完成後，初始化歷史按鈕與雙重綁定
    try {
        initHistoryButtons();
    } catch (e) {
        console.error("初始化按鈕失敗:", e);
    }

    try {
        // 雙重保險：萬一 HTML 的 onclick 被瀏覽器封鎖，這裡主動幫按鈕綁定點擊事件
        var calcBtn = document.querySelector('button');
        if (calcBtn) {
            calcBtn.addEventListener('click', function(e) {
                // 如果是包裹在 form 中防止重整，這裡預防萬一
                if (e && e.preventDefault) e.preventDefault();
                analyzeTaiwanStock();
            });
        }
    } catch(e) {
        console.log("主按鈕監聽綁定跳過");
    }
});

function initHistoryButtons() {
    try {
        var history = JSON.parse(localStorage.getItem('stock_history')) || [];
        
        // 確保 0050 永遠在歷史清單的第一個
        if (!history.includes('0050')) {
            history.unshift('0050');
        } else {
            // 如果已存在，將其移到最前面
            history = history.filter(function(item) { return item !== '0050'; });
            history.unshift('0050');
        }
        
        localStorage.setItem('stock_history', JSON.stringify(history));

        // 精準對接 HTML 中的 id="history-tags"
        var container = document.getElementById('history-tags');
        if (container) {
            container.innerHTML = '';
            history.forEach(function(code) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'quick-btn';
                btn.innerText = code === '0050' ? '0050 元大台灣50' : code;
                
                // 點擊歷史按鈕：直接填入代碼並觸發計算
                btn.onclick = function(e) {
                    if (e && e.preventDefault) e.preventDefault();
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
        console.error("歷史按鈕渲染失敗:", err);
    }
}

// 儲存新查詢的股票（排除0050重覆加入，最多保留10檔歷史）
function saveToHistory(code) {
    try {
        if (!code || code === '0050') return; // 0050 已固定，不重複處理
        var history = JSON.parse(localStorage.getItem('stock_history')) || ['0050'];
        
        // 移除已存在的相同代碼，以便移到最新位置
        history = history.filter(function(item) { return item !== code; });
        
        // 插入到 0050 之後的第一個位子 (index 1)
        history.splice(1, 0, code);
        
        // 超過 10 檔則刪除最後面的
        if (history.length > 10) {
            history = history.slice(0, 10);
        }
        
        localStorage.setItem('stock_history', JSON.stringify(history));
        initHistoryButtons(); // 立即重新整理按鈕列
    } catch (err) {
        console.error("儲存歷史紀錄失敗:", err);
    }
}

// ==========================================
// 2. 均線與真實波幅計算核心
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
// 3. 主控程式流程
// ==========================================
async function analyzeTaiwanStock() {
    var stockCodeEl = document.getElementById('stock-code');
    if (!stockCodeEl) { alert('系統錯誤：找不到股票代碼輸入框！'); return; }
    
    var stockId = stockCodeEl.value.trim();
    if (!stockId) { alert('請輸入股票代碼！'); return; }

    // 🎯 100% 全面防護：使用最安全的取值法，絕對不拋出錯誤斷頭
    var paramNEl = document.getElementById('param-n');
    var maShortEl = document.getElementById('param-ma-short');
    var maLongEl = document.getElementById('param-ma-long');

    var paramN = paramNEl ? parseFloat(paramNEl.value) : 2;
    var maShortPeriod = maShortEl ? parseInt(maShortEl.value) : 5;
    var maLongPeriod = maLongEl ? parseInt(maLongEl.value) : 20;

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

        // 自動由 API 解析股票名稱
        var stockName = resData.data[0].stock_name || "台灣個股";
        var displayTitle = `${stockId} ${stockName}`;

        // 成功查詢後，動態將該代碼寫入歷史紀錄
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

        // 計算進場風險百分比與智慧決策閾值
        var riskPercent = Number((((currentClose - stopLoss) / currentClose) * 100).toFixed(1));
        var perfectPriceThreshold = Number((stopLoss * 1.04).toFixed(2)); 
        var buyDecisionHtml = '';

        // 🟢 頂部三大狀態燈號重設
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
                        目前股價已噴發，此區域為舊部位「收割/移動停利」專專屬，此時開新倉追高風險極大。
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

        if(loading) loading.style.display = 'none';
        if(report) report.style.display = 'block';

        // 🎯 注入動態標題
        var leftTitle = document.getElementById('report-title-left');
        var rightTitle = document.getElementById('report-title-right');
        if(leftTitle) leftTitle.innerHTML = `📊 【${displayTitle}】均線與週期數據`;
        if(rightTitle) rightTitle.innerHTML = `💼 【${displayTitle}】動態風控導航面板`;

        // 🎯 渲染左側數據
        var techDataEl = document.getElementById('technical-data');
        if(techDataEl) {
            techDataEl.innerHTML = 
                '• <b>當前真實收盤價：</b> <span class="text-bullish highlight">' + currentClose + '</span> 元<br>' +
                '• <b>' + maShortPeriod + '日均線價位：</b> ' + (maShort ? maShort + ' 元' : '計算中...') + '<br>' +
                '• <b>' + maLongPeriod + '日均線價位：</b> ' + (maLong ? maLong + ' 元' : '計算中...') + '<br>' +
                '• <b>今日單日真實 TR：</b> ' + todayTrueRange + ' 元<br>' +
                '• <b>🔥 操作週期採計：' + maShortPeriod + ' 日平均真實波幅 (R)：</b> <span class="text-bullish">' + R + '</span> 元';
        }

        // 🎯 渲染右側數據與智慧決策框
        var riskDataEl = document.getElementById('risk-data');
        if(riskDataEl) {
            riskDataEl.innerHTML = 
                '• <b>設定風控倍數 (N)：</b> ' + paramN + ' 倍<br>' +
                '• <b>當前進場潛在風險：</b> <span style="color:#e67e22; font-weight:bold;">' + riskPercent + '%</span><br>' +
                '• <b>原始動態停損價：</b> <b>' + stopLoss + ' 元</b> (剛進場防守線)<br>' +
                '• <b>波段預期停利點：</b> <span class="text-danger"><b>' + takeProfit + ' 元</b></span> (1:2 盈虧比目標)<br>' +
                '<div style="margin-top:10px; padding-top:10px; border-top:2px dashed #bdc3c7;">' +
                '• <b>🚨 今日實戰防守價：</b> <span class="text-bullish" style="font-size:1.4em;">' + trailingStopPrice + ' 元</span><br>' +
                '</div>' +
                '<div style="margin-top:12px; font-size:13px; line-height: 1.5; color:#2c3e50; background:#f8f9fa; padding:10px; border-radius:6px; border-left: 4px solid #1abc9c;">' + adviceText + '</div>' +
                buyDecisionHtml; 
        }
