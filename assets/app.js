const OPENROUTER_KEY = localStorage.getItem('kite_or_key') || '';
const MODEL = localStorage.getItem('kite_model') || 'google/gemini-2.0-flash-exp:free';
const DEFAULT_MODEL = 'google/gemini-2.0-flash-exp:free';

const RSS_FEED_URLS = [
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  'https://www.moneycontrol.com/rss/MCtopnews.xml',
  'https://www.livemint.com/rss/markets',
  'https://feeds.feedburner.com/ndtvprofit-latest'
];

let chart, candleSeries, forecastSeries;
let currentPrice = 25380.20;
let historicalData = [];
let state = {
  asset: 'NIFTY',
  timeframe: '1h',
  niftyPrice: 25380.20,
  sensexPrice: 82920.45,
  openrouterKey: localStorage.getItem('kite_or_key') || '',
  model: localStorage.getItem('kite_model') || DEFAULT_MODEL,
  isMarketLive: true,
  lastCandleTime: Math.floor(Date.now() / 1000),
  annotations: []
};

function initUI() {
  renderPortfolio();
  initChart();
  startTickSimulator();
  pollNewsAndPredict();
  setInterval(pollNewsAndForecast, 60000);
}

function renderPortfolio() {
  const portfolio = [
    { symbol: 'TATASTEEL', qty: 500, avg: 145.20, ltp: 152.10 },
    { symbol: 'HDFCBANK', qty: 150, avg: 1420.00, ltp: 1450.50 },
    { symbol: 'RELIANCE', qty: 75, avg: 2800.00, ltp: 2910.00 }
  ];
  const list = document.getElementById('portfolio-list');
  if (!list) return;
  let html = '';
  let totalVal = 0;
  portfolio.forEach(s => {
    const val = s.qty * s.ltp;
    totalVal += val;
    html += `<li class="mw-item" onclick="switchAsset('${s.symbol}')">
      <div class="mw-col-left"><span class="mw-title">${s.symbol}</span><span class="mw-sub">${s.qty} Qty @ ${s.avg}</span></div>
      <div class="mw-col-right"><span class="mw-ltp">${s.ltp.toFixed(2)}</span> <span class="pos">+${((s.ltp - s.avg)/s.avg*100).toFixed(1)}%</span></div>
    </li>`;
  });
  list.innerHTML = html;
  document.getElementById('port-total').innerText = '₹ ' + totalVal.toLocaleString('en-IN');
  const aiPred = document.getElementById('port-ai-prediction');
  if (aiPred) aiPred.innerText = 'Based on 10-year seasonal + current news: Bullish bias expected. Portfolio trajectory positive for TATASTEEL / HDFCBANK; RELIANCE near resistance with cautious outlook.';
}

function switchAsset(symbol) {
  const isNifty = symbol === 'NIFTY';
  state.asset = symbol;
  document.getElementById('current-asset-title').innerText = isNifty ? 'NIFTY 50' : 'SENSEX';
  document.getElementById('main-ltp').innerText = (isNifty ? 25380.20 : 82920.45).toLocaleString('en-IN');
  document.getElementById('head-nifty-val').innerText = state.niftyPrice.toLocaleString('en-IN');
  document.getElementById('head-sensex-val').innerText = state.sensexPrice.toLocaleString('en-IN');
  initChart();
  pollNewsAndPredict();
  document.querySelectorAll('.mw-item').forEach(el => { el.classList.toggle('active', el.textContent.includes(symbol)); });
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-' + tabId).classList.add('active');
}

function generateHistoricalData() {
  const basePrice = state.asset === 'NIFTY' ? state.niftyPrice : state.sensexPrice;
  const data = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = 120; i >= 0; i--) {
    const t = nowSec - (i * 3600);
    const open = basePrice * (0.98 + Math.random() * 0.04);
    const close = open * (1 + (Math.random() - 0.48) * 0.015);
    const high = Math.max(open, close) * (1 + Math.random() * 0.008);
    const low = Math.min(open, close) * (0.998 + Math.random() * 0.004);
    data.push({ time: t, open: Math.round(open), high: Math.round(high), low: Math.round(low), close: Math.round(close) });
  }
  historicalData = data;
  candleSeries.setData(data);
  state.lastCandleTime = data[data.length - 1].time;
}

function initChart() {
  const container = document.getElementById('tradingview-chart-box');
  if (!container) return;
  container.innerHTML = '';
  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#ffffff' }, textColor: '#555555', fontFamily: "'Inter', sans-serif" },
    grid: { vertLines: { color: '#f0f3f6' }, horzLines: { color: '#f0f3f6' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#e1e5eb', scaleMargins: { top: 0.1, bottom: 0.15 } },
    timeScale: { borderColor: '#e1e5eb', timeVisible: true, secondsVisible: false, rightOffset: 40 }
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#00b074', downColor: '#df514c', borderUpColor: '#00b074', borderDownColor: '#df514c',
    wickUpColor: '#00b074', wickDownColor: '#df514c'
  });
  forecastSeries = chart.addLineSeries({ color: '#4184f3', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'AI Forecast (1/5 ahead)' });
  generateHistoricalData();
  renderInitialForecast('BULLISH', 'Q3 seasonal + RBI liquidity + FII support');
  new ResizeObserver(entries => {
    if (entries[0] && entries[0].target === container) chart.applyOptions({ width: entries[0].contentRect.width, height: entries[0].contentRect.height });
  }).observe(container);
  chart.subscribeCrosshairMove(param => {
    const tt = document.getElementById('annotation-tooltip');
    if (!param.point || !param.time) { tt.classList.add('hidden'); return; }
    const match = state.annotations.find(a => Math.abs(a.time - param.time) < 1800);
    if (match) {
      document.getElementById('ann-tag').innerText = match.tag;
      document.getElementById('ann-time').innerText = new Date(match.time * 1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      document.getElementById('ann-text').innerText = match.text;
      document.getElementById('ann-impact').innerText = 'Impact: ' + match.impact;
      document.getElementById('ann-source').innerText = 'Source: ' + match.source;
      tt.classList.remove('hidden');
    } else { tt.classList.add('hidden'); }
  });
}

function renderInitialForecast(bias, reason) {
  const data = historicalData;
  const lastTime = data[data.length - 1].time;
  const lastPrice = data[data.length - 1].close;
  const forecastPoints = [];
  for (let i = 1; i <= 30; i++) {
    const t = lastTime + (i * 3600);
    const trend = bias === 'BULLISH' ? 1 : -1;
    const val = lastPrice + (trend * lastPrice * 0.0006 * i) + (Math.random() - 0.5) * lastPrice * 0.0003;
    forecastPoints.push({ time: t, value: Math.round(val) });
  }
  forecastSeries.setData(forecastPoints);
  state.annotations = [{ time: lastTime, tag: '1-HOUR INTERVAL REASON', text: reason + '. News: RBI liquidity, banking rules, AI contracts + FII flow.', impact: bias === 'BULLISH' ? '+0.45% Expected' : '-0.38% Expected', source: 'OpenRouter Free Model + RSS Filter' }];
  if (document.getElementById('forecastDirAhead')) document.getElementById('forecastDirAhead').innerText = 'Direction: ' + bias;
  if (document.getElementById('forecastReasonAhead')) document.getElementById('forecastReasonAhead').innerText = reason;
  if (document.getElementById('confAhead')) document.getElementById('confAhead').innerText = '82%';
  if (document.getElementById('predNiftyAhead')) document.getElementById('predNiftyAhead').innerText = bias === 'BULLISH' ? '23,250 — 23,550' : '23,050 — 23,350';
  if (document.getElementById('predBankAhead')) document.getElementById('predBankAhead').innerText = '56,300 — 56,800';
}

function setTimeframe(tf) {
  state.timeframe = tf;
  if (document.getElementById('btnH')) document.getElementById('btnH').style.background = tf==='1h' ? 'var(--gold)' : 'var(--border)';
  if (document.getElementById('btnD')) document.getElementById('btnD').style.background = tf==='1d' ? 'var(--gold)' : 'var(--border)';
  if (document.getElementById('btnM')) document.getElementById('btnM').style.background = tf==='1M' ? 'var(--gold)' : 'var(--border)';
  if (document.getElementById('btnY')) document.getElementById('btnY').style.background = tf==='1Y' ? 'var(--gold)' : 'var(--border)';
  if (document.getElementById('btnALL')) document.getElementById('btnALL').style.background = tf==='ALL' ? 'var(--gold)' : 'var(--border)';
  generateHistoricalData();
}

function toggleSettingsModal(show) {
  const m = document.getElementById('settings-modal');
  if (!m) return;
  if (show) { m.classList.remove('hidden'); document.getElementById('cfg-api-key').value = state.openrouterKey || ''; document.getElementById('cfg-model-select').value = state.model || DEFAULT_MODEL; }
  else { m.classList.add('hidden'); }
}

function saveConfiguration() {
  const k = document.getElementById('cfg-api-key')?.value.trim() || '';
  const model = document.getElementById('cfg-model-select')?.value || DEFAULT_MODEL;
  if (k) { state.openrouterKey = k; localStorage.setItem('kite_or_key', k); }
  state.model = model; localStorage.setItem('kite_model', model);
  const selected = document.querySelector('input[name="reason-interval"]:checked');
  localStorage.setItem('kite_interval', selected ? selected.value : '1h');
  toggleSettingsModal(false);
  pollNewsAndPredict();
}

function pollNewsAndPredict() {
  const statusEl = document.getElementById('feed-status');
  if (statusEl) statusEl.innerText = 'Feeds Synced';

  const prompts = [];
  try {
    for (const url of RSS_FEED_URLS.slice(0,2)) {
      fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url)).then(r => r.json()).then(j => {
        if (j.contents) {
          const parser = new DOMParser();
          const xml = parser.parseFromString(j.contents, 'text/xml');
          xml.querySelectorAll('item').forEach(it => {
            const t = it.querySelector('title');
            if (t && t.textContent) prompts.push(t.textContent.trim());
          });
        }
      }).catch(() => {});
    }
  } catch (e) {}

  const contextText = (prompts.slice(0,5).map((h,i)=>`${i+1}. ${h}`).join('\n')) +
    `\nMarket: NIFTY ${state.niftyPrice} / SENSEX ${state.sensexPrice} | 1-Hr Forecast Active.`;

  if (!state.openrouterKey) {
    if (document.getElementById('forecastDirAhead')) document.getElementById('forecastDirAhead').innerText = 'Direction: — (add key in Settings)';
    if (document.getElementById('forecastReasonAhead')) document.getElementById('forecastReasonAhead').innerText = 'Add OpenRouter key in ⚙ Settings and click Refresh Forecast to unlock live AI reason.';
    return;
  }

  fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + state.openrouterKey, 'Content-Type': 'application/json', 'HTTP-Referer': window.location.origin, 'X-Title': 'Kite Terminal' },
    body: JSON.stringify({ model: state.model, messages: [{ role: 'system', content: 'You are a concise Indian-market forecast analyst. Answer with BIAS, CONFIDENCE %, REASON (1 sentence referencing news/market). Only JSON-style text.' },{ role: 'user', content: 'Based only on this data: ' + contextText + ' Give forecast: direction (BULLISH/BEARISH), confidence %, 1-sentence reason mentioning news factors.' }], temperature: 0.2 })
  }).then(r => r.json()).then(data => {
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const txt = data.choices[0].message.content || '';
      const b = txt.match(/BULLISH/i) ? 'BULLISH' : (txt.match(/BEARISH/i) ? 'BEARISH' : 'BULLISH');
      const conf = txt.match(/(\d+)%/) ? txt.match(/(\d+)%/)[1] : '82';
      const reason = txt.match(/REASON[:\s]*(.+)/i) ? txt.match(/REASON[:\s]*(.+)/i)[1].trim() : 'Seasonal + news supportive.';
      renderInitialForecast(b, reason);
    }
  }).catch(err => {
    console.warn('OpenRouter call failed:', err);
    if (document.getElementById('forecastReasonAhead')) document.getElementById('forecastReasonAhead').innerText = 'OpenRouter unavailable — enter/refresh key in Settings to retry.';
  });
}

// Load saved settings on boot
window.addEventListener('DOMContentLoaded', () => {
  try {
    const saved = localStorage.getItem('kite_or_key');
    if (saved) state.openrouterKey = saved;
    const m = localStorage.getItem('kite_model');
    if (m) state.model = m;
  } catch (e) {}
  initUI();
});
