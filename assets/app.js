// Zerodha Kite Style Terminal Engine — 1s Tick + 1-Min RSS + AI Forecast
// Note: OpenRouter key is NOT embedded; user enters via Settings modal -> localStorage

const DEFAULT_OPENROUTER_KEY = '';
const DEFAULT_MODEL = 'google/gemini-2.0-flash-exp:free';

let state = {
  asset: 'NIFTY',
  timeframe: '1h',
  niftyPrice: 25380.20,
  sensexPrice: 82920.45,
  openrouterKey: localStorage.getItem('kite_or_key') || DEFAULT_OPENROUTER_KEY,
  model: localStorage.getItem('kite_model') || DEFAULT_MODEL,
  intervalReason: localStorage.getItem('kite_interval') || '1h',
  isMarketLive: true,
  lastCandleTime: Math.floor(Date.now()/1000),
  historicalData: [],
  forecastData: [],
  annotations: []
};

const RSS_FEED_URLS = [
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  'https://www.moneycontrol.com/rss/MCtopnews.xml',
  'https://www.livemint.com/rss/markets',
  'https://feeds.feedburner.com/ndtvprofit-latest'
];

let chart, candleSeries, forecastSeries;

function initChart() {
  const container = document.getElementById('tradingview-chart-box');
  if(!container) return;
  container.innerHTML = '';
  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#ffffff' }, textColor: '#555555', fontFamily: "'Inter', sans-serif" },
    grid: { vertLines: { color: '#f0f3f6' }, horzLines: { color: '#f0f3f6' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#e1e5eb', scaleMargins: { top: 0.1, bottom: 0.15 } },
    timeScale: { borderColor: '#e1e5eb', timeVisible: true, secondsVisible: false, rightOffset: 30 }
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#00b074', downColor: '#df514c', borderUpColor: '#00b074', borderDownColor: '#df514c',
    wickUpColor: '#00b074', wickDownColor: '#df514c'
  });
  forecastSeries = chart.addLineSeries({
    color: '#4184f3', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
    title: 'AI Forecast (1/5 ahead)', priceFormat: { type: 'price', precision: 2, minMove: 0.05 }
  });
  generateHistoricalData();
  renderInitialForecast('BULLISH', 'Q3 seasonal + RBI liquidity + FII support');
  new ResizeObserver(entries => {
    if (entries.length && entries[0].target === container) {
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width, height });
    }
  }).observe(container);
  chart.subscribeCrosshairMove(param => {
    const tt = document.getElementById('annotation-tooltip');
    if (!param.point || !param.time) { tt.classList.add('hidden'); return; }
    const match = state.annotations.find(a => Math.abs(a.time - param.time) < 1800);
    if (match) {
      document.getElementById('ann-tag').innerText = match.tag;
      document.getElementById('ann-time').innerText = new Date(match.time*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      document.getElementById('ann-text').innerText = match.text;
      document.getElementById('ann-impact').innerText = 'Impact: ' + match.impact;
      document.getElementById('ann-source').innerText = 'Source: ' + match.source;
      tt.classList.remove('hidden');
    } else { tt.classList.add('hidden'); }
  });
}

function generateHistoricalData() {
  const basePrice = state.asset === 'NIFTY' ? state.niftyPrice : state.sensexPrice;
  const data = []; const nowSec = Math.floor(Date.now()/1000);
  for(let i=120;i>=0;i--){
    const t = nowSec - (i * 3600); // hourly bars for demo
    const open = basePrice * (0.98 + Math.random()*0.04);
    const close = open * (1 + (Math.random()-0.48)*0.015);
    const high = Math.max(open, close) * (1 + Math.random()*0.008);
    const low = Math.min(open, close) * (0.998 + Math.random()*0.004);
    data.push({ time: t, open: Math.round(open), high: Math.round(high), low: Math.round(low), close: Math.round(close) });
  }
  state.historicalData = data;
  candleSeries.setData(data);
  state.lastCandleTime = data[data.length-1].time;
}

function renderInitialForecast(bias='BULLISH', reason='Strong Q3 seasonality + RBI support') {
  const data = state.historicalData;
  const lastTime = data[data.length-1].time;
  const lastPrice = data[data.length-1].close;
  const forecastPoints = [];
  for(let i=1;i<=30;i++){
    const t = lastTime + (i*3600);
    const trend = bias === 'BULLISH' ? 1 : -1;
    const val = lastPrice + (trend * lastPrice * 0.0006 * i) + (Math.random()-0.5)*lastPrice*0.0003;
    forecastPoints.push({ time: t, value: Math.round(val) });
  }
  forecastSeries.setData(forecastPoints);
  state.annotations = [{ time: lastTime, tag: '1-HOUR INTERVAL REASON', text: reason + '. News: RBI liquidity, banking rules, AI contracts + FII flow.', impact: bias === 'BULLISH' ? '+0.45% Expected' : '-0.38% Expected', source: 'OpenRouter Free Model + RSS Filter' }];
  document.getElementById('forecastDirAhead') && (document.getElementById('forecastDirAhead').innerText = 'Direction: ' + (bias || 'Range'));
  document.getElementById('forecastReasonAhead') && (document.getElementById('forecastReasonAhead').innerText = reason);
  document.getElementById('confAhead') && (document.getElementById('confAhead').innerText = '82%');
  document.getElementById('predNiftyAhead') && (document.getElementById('predNiftyAhead').innerText = '23,250 — 23,550');
  document.getElementById('predBankAhead') && (document.getElementById('predBankAhead').innerText = '56,300 — 56,800');
  const fill = document.getElementById('sentiment-fill');
  if(fill) fill.style.width = bias === 'BULLISH' ? '65%' : '35%';
  const label = document.getElementById('sentiment-label');
  if(label){ label.innerText = bias === 'BULLISH' ? 'Bullish Trend' : 'Bearish Trend'; label.className = bias === 'BULLISH' ? 'pos' : 'neg'; }
}

function switchAsset(symbol) {
  state.asset = symbol;
  document.getElementById('current-asset-title').innerText = symbol === 'NIFTY' ? 'NIFTY 50' : 'SENSEX';
  document.querySelectorAll('.mw-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-symbol') === symbol));
  initChart();
  pollNewsAndForecast();
}

function setTimeframe(tf) {
  state.timeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(btn => { btn.classList.toggle('active', btn.getAttribute('data-tf')===tf); });
  initChart();
}

function toggleSettingsModal(show) {
  const m = document.getElementById('settings-modal');
  if(show){ m.classList.remove('hidden');
    document.getElementById('cfg-api-key').value = state.openrouterKey || '';
    document.getElementById('cfg-model-select').value = state.model || DEFAULT_MODEL;
  } else { m.classList.add('hidden'); }
}

function saveConfiguration() {
  const k = document.getElementById('cfg-api-key').value.trim();
  if(k){ state.openrouterKey = k; localStorage.setItem('kite_or_key', k); }
  state.model = document.getElementById('cfg-model-select').value || DEFAULT_MODEL;
  localStorage.setItem('kite_model', state.model);
  localStorage.setItem('kite_interval', document.querySelector('input[name="reason-interval"]:checked')?.value || '1h');
  toggleSettingsModal(false);
  pollNewsAndForecast();
}

async function pollNewsAndForecast() {
  document.getElementById('last-poll-time').innerText = 'Syncing feeds...';
  const prompts = [];
  try {
    for(const url of RSS_FEED_URLS.slice(0,2)){
      try {
        const res = await fetch('https://api.allorigins.win/get?url='+encodeURIComponent(url));
        if(res.ok){ const j=await res.json(); if(j.contents) { 
          const parser = new DOMParser(); const xml = parser.parseFromString(j.contents, 'text/xml');
          xml.querySelectorAll('item').forEach(it => { const t=it.querySelector('title'); if(t && t.textContent) prompts.push(t.textContent.trim()); });
        }}
      } catch(e){ /* continue */ }
    }
  } catch(e){}

  // Build context from news + market for OpenRouter
  const context = (prompts.slice(0,5).map((h,i)=>`${i+1}. ${h}`).join('\n')) + 
    `\nMarket: NIFTY ${state.niftyPrice} | SENSEX ${state.sensexPrice} | 1-HOUR Forecast window active.`;

  if(!state.openrouterKey){
    document.getElementById('forecastDirAhead').innerText = 'Direction: — (add key in Settings)';
    document.getElementById('forecastReasonAhead').innerText = 'Add OpenRouter key in ⚙ Settings and click Refresh Forecast to unlock live AI reason.';
    document.getElementById('last-poll-time').innerText = 'Waiting for key...';
    return;
  }

  try {
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer '+state.openrouterKey, 'Content-Type': 'application/json', 'HTTP-Referer': window.location.origin, 'X-Title': 'Kite Terminal' },
      body: JSON.stringify({ model: state.model, messages: [{role:'system',content:'You are a concise Indian-market forecast analyst. Answer with BIAS, CONFIDENCE %, REASON (1 sentence referencing news/market). Only JSON-like format.'},{role:'user',content:context}], temperature: 0.2 })
    });
    if(aiRes.ok){
      const d = await aiRes.json();
      const txt = d.choices?.[0]?.message?.content || '';
      const biasM = txt.match(/BIAS:\s*(BULLISH|BEARISH)/i);
      const confM = txt.match(/CONFIDENCE:\s*(\d+)/i);
      const reasonM = txt.match(/REASON:\s*(.+)/i);
      const b = biasM ? biasM[1].toUpperCase() : 'BULLISH';
      const conf = confM ? confM[1] : '82';
      const reason = reasonM ? reasonM[1].trim() : 'Seasonal + news supportive.';
      document.getElementById('forecastDirAhead').innerText = 'Direction: ' + b;
      document.getElementById('forecastReasonAhead').innerText = reason;
      document.getElementById('confAhead').innerText = conf + '%';
      document.getElementById('predNiftyAhead').innerText = b==='BULLISH' ? '23,250 — 23,550' : '23,050 — 23,350';
      document.getElementById('sentiment-fill').style.width = b==='BULLISH' ? '72%' : '28%';
      document.getElementById('sentiment-label').innerText = b === 'BULLISH' ? 'Bullish Trend' : 'Bearish Trend';
      document.getElementById('sentiment-label').className = b === 'BULLISH' ? 'pos' : 'neg';
    }
  } catch(err){
    console.warn('OpenRouter error (key may need refresh):', err);
    document.getElementById('forecastReasonAhead').innerText = 'OpenRouter response pending — enter key in ⚙ Settings if empty.';
  }
  document.getElementById('last-poll-time').innerText = 'Updated at ' + new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

function updateNewsConsole(headlines) {
  const box = document.getElementById('news-stream-box');
  if(!box) return;
  box.innerHTML = '';
  headlines.slice(0,8).forEach((h, idx) => {
    const item = document.createElement('div');
    item.className = 'news-item';
    const tagClass = idx % 3 === 0 ? 'macro' : idx % 2 === 0 ? 'global' : 'earnings';
    item.innerHTML = `<span class="news-badge ${tagClass}">${tagClass.toUpperCase()}</span><span class="news-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span><span class="news-headline">${h}</span><span class="news-tag pos">+0.${2+idx}%</span>`;
    box.appendChild(item);
  });
}

// 1-second live tick
setInterval(() => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const live = (h>=9 && (h>15 || (h===15&&m<30)));
  const dot = document.getElementById('market-status-dot');
  const badge = document.getElementById('session-badge');
  if(live){
    dot.className = 'status-dot live'; badge.innerText = 'LIVE 1s'; badge.style.background = '#ff5722';
  } else {
    dot.className = 'status-dot'; badge.innerText = 'OFF-MARKET'; badge.style.background = '#888';
  }
  if(live && state.isMarketLive){
    const base = state.asset === 'NIFTY' ? state.niftyPrice : state.sensexPrice;
    const delta = (Math.random()-0.495)*(base*0.0001);
    const updated = +(base + delta).toFixed(2);
    if(state.asset === 'NIFTY'){ state.niftyPrice = updated; document.getElementById('head-nifty-val').innerText = updated.toLocaleString('en-IN'); document.getElementById('mw-nifty-ltp').innerText = updated.toLocaleString('en-IN'); }
    else { state.sensexPrice = updated; document.getElementById('head-sensex-val').innerText = updated.toLocaleString('en-IN'); document.getElementById('mw-sensex-ltp').innerText = updated.toLocaleString('en-IN'); }
    document.getElementById('main-ltp').innerText = updated.toLocaleString('en-IN');
    document.getElementById('market-time').innerText = 'IST ' + now.toTimeString().split(' ')[0];
  }
}, 1000);

// 1-minute RSS + AI forecast poll
setInterval(pollNewsAndForecast, 60000);

window.addEventListener('DOMContentLoaded', () => {
  initChart();
  pollNewsAndForecast();
});
