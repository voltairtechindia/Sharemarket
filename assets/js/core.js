/* ============================================================================
   Core: formatting, IST clock, market session state, bounded storage, and the
   sentiment scorer that mirrors scripts/fetch_news.py so both lanes agree.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG;

  /* ------------------------------------------------------------ formatting */
  var IN = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var IN0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

  var fmt = {
    price: function (n) { return (n === null || n === undefined || isNaN(n)) ? '—' : IN.format(n); },
    int: function (n) { return (n === null || n === undefined || isNaN(n)) ? '—' : IN0.format(n); },
    pct: function (n, digits) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      var d = digits === undefined ? 2 : digits;
      return (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
    },
    signed: function (n, digits) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      var d = digits === undefined ? 2 : digits;
      return (n >= 0 ? '+' : '') + IN.format(Number(n.toFixed(d)));
    },
    cls: function (n) { return (n > 0) ? 'up' : (n < 0 ? 'down' : 'flat'); },
    clock: function (d) {
      return String(d.getHours()).padStart(2, '0') + ':' +
             String(d.getMinutes()).padStart(2, '0') + ':' +
             String(d.getSeconds()).padStart(2, '0');
    },
    /* Wall-clock time in IST regardless of where the viewer is. */
    ist: function (epochSec) {
      var d = new Date((epochSec === undefined ? Date.now() / 1000 : epochSec) * 1000);
      return new Date(d.getTime() + (d.getTimezoneOffset() + C.market.tzOffsetMin) * 60000);
    },
    timeShort: function (epochSec) {
      var d = fmt.ist(epochSec);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    },
    dayShort: function (epochSec) {
      var d = fmt.ist(epochSec);
      return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    },
    stamp: function (epochSec, bucketSec) {
      if (bucketSec >= 2592000) { var m = fmt.ist(epochSec); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m.getMonth()] + ' ' + m.getFullYear(); }
      if (bucketSec >= 86400) return fmt.dayShort(epochSec);
      return fmt.dayShort(epochSec) + ' ' + fmt.timeShort(epochSec);
    },
    ago: function (epochSec) {
      var s = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    },
  };

  /* -------------------------------------------------------- market session */
  function marketState(now) {
    var d = fmt.ist(now ? now / 1000 : undefined);
    var mins = d.getHours() * 60 + d.getMinutes();
    var isWeekday = C.market.weekdays.indexOf(d.getDay()) !== -1;
    if (!isWeekday) return { state: 'closed', label: 'Weekend', live: false, ist: d };
    if (mins >= C.market.preOpen.from && mins < C.market.preOpen.to) return { state: 'pre', label: 'Pre-open', live: true, ist: d };
    if (mins >= C.market.regular.from && mins <= C.market.regular.to) return { state: 'live', label: 'Live', live: true, ist: d };
    if (mins < C.market.preOpen.from) return { state: 'closed', label: 'Pre-market', live: false, ist: d };
    return { state: 'closed', label: 'Closed', live: false, ist: d };
  }

  /* ------------------------------------------------------- bounded storage
     Everything is wrapped: private windows and blocked site data throw.      */
  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(C.storage.prefix + key);
        if (!raw) return fallback;
        var parsed = JSON.parse(raw);
        if (parsed && parsed.__exp && Date.now() > parsed.__exp) {
          localStorage.removeItem(C.storage.prefix + key);
          return fallback;
        }
        return parsed && '__v' in parsed ? parsed.__v : parsed;
      } catch (e) { return fallback; }
    },
    set: function (key, value, ttlMs) {
      try {
        var payload = ttlMs ? { __v: value, __exp: Date.now() + ttlMs } : { __v: value };
        localStorage.setItem(C.storage.prefix + key, JSON.stringify(payload));
        return true;
      } catch (e) { return false; }
    },
    remove: function (key) { try { localStorage.removeItem(C.storage.prefix + key); } catch (e) {} },
    clearNews: function () { store.remove('news'); },
    sizeKb: function () {
      try {
        var total = 0;
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(C.storage.prefix) === 0) total += (localStorage.getItem(k) || '').length + k.length;
        }
        return Math.round(total / 1024 * 10) / 10;
      } catch (e) { return 0; }
    },
  };

  /* ------------------------------------------------------------- sentiment
     Loaded from config/lexicon.json so the browser and the Python worker use
     one table. Longest term wins and is blanked out, so "ban" cannot score
     inside "banking" and "surge" cannot double count after "surges".         */
  var lexicon = null, bullRx = [], bearRx = [], impactHi = [], impactMd = [], relevance = [], noise = [], procedural = [], sectorMap = {};

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function compile(table) {
    return Object.keys(table)
      .map(function (term) {
        return { term: term, w: table[term], len: term.length, rx: new RegExp('(?:^|[^a-z0-9])' + esc(term) + '(?![a-z0-9])') };
      })
      .sort(function (a, b) { return b.len - a.len; });
  }

  function setLexicon(lex) {
    lexicon = lex;
    bullRx = compile(lex.bullish);
    bearRx = compile(lex.bearish);
    impactHi = lex.impact_high.map(function (s) { return s.toLowerCase(); });
    impactMd = lex.impact_medium.map(function (s) { return s.toLowerCase(); });
    relevance = lex.relevance.map(function (s) { return s.toLowerCase(); });
    noise = lex.noise.map(function (s) { return s.toLowerCase(); });
    procedural = (lex.procedural || []).map(function (s) { return s.toLowerCase(); });
    sectorMap = {};
    Object.keys(lex.sector_map).forEach(function (k) {
      sectorMap[k] = lex.sector_map[k].map(function (s) { return s.toLowerCase(); });
    });
  }

  function score(text) {
    if (!lexicon) return { sentiment: 0, impact: 'low', terms: [] };
    var low = ' ' + String(text).toLowerCase() + ' ';
    var work = low, total = 0, terms = [];
    var all = bullRx.concat(bearRx);
    for (var i = 0; i < all.length; i++) {
      var m = all[i].rx.exec(work);
      if (m) {
        total += all[i].w;
        terms.push(all[i].term);
        var start = m.index, end = m.index + m[0].length;
        work = work.slice(0, start) + new Array(end - start + 1).join(' ') + work.slice(end);
      }
    }
    var sentiment = Math.max(-4, Math.min(4, total / 2));

    // Impact needs corroboration. One institution word is not a market event -
    // "RBI invites comments on draft KYC directions" mentions the RBI but moves
    // nothing, and tagging it HIGH made every Indian headline look urgent.
    var hiHits = 0;
    for (var h = 0; h < impactHi.length; h++) if (low.indexOf(impactHi[h]) !== -1) hiHits++;
    var mdHits = 0;
    for (var d = 0; d < impactMd.length; d++) if (low.indexOf(impactMd[d]) !== -1) mdHits++;

    var isProcedural = false;
    for (var q = 0; q < procedural.length; q++) if (low.indexOf(procedural[q]) !== -1) { isProcedural = true; break; }

    var impact = 'low';
    if (hiHits && (hiHits > 1 || Math.abs(sentiment) >= 1)) impact = 'high';
    else if (hiHits || mdHits) impact = 'medium';
    // A notice is still a notice however many keywords it contains.
    if (isProcedural) impact = (impact === 'high') ? 'medium' : 'low';

    return { sentiment: Math.round(sentiment * 100) / 100, impact: impact,
             terms: terms.slice(0, 6), procedural: isProcedural };
  }

  function isNoise(text) {
    if (!lexicon) return false;
    var low = String(text).toLowerCase();
    for (var i = 0; i < noise.length; i++) if (low.indexOf(noise[i]) !== -1) return true;
    for (var r = 0; r < relevance.length; r++) if (low.indexOf(relevance[r]) !== -1) return false;
    return true;
  }

  function sectorOf(text) {
    var low = String(text).toLowerCase(), best = 'general', bestN = 0;
    Object.keys(sectorMap).forEach(function (name) {
      var n = 0, terms = sectorMap[name];
      for (var i = 0; i < terms.length; i++) if (low.indexOf(terms[i]) !== -1) n++;
      if (n > bestN) { best = name; bestN = n; }
    });
    return best;
  }

  function keyOf(title) {
    var s = String(title).toLowerCase().replace(/[^a-z0-9]/g, ''), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'k' + (h >>> 0).toString(36) + s.length;
  }

  /* ---------------------------------------------------------------- helpers */
  function el(id) { return document.getElementById(id); }
  function text(id, value) { var n = el(id); if (n) n.textContent = value; }
  function cls(id, className) {
    var n = el(id);
    if (n) { n.classList.remove('up', 'down', 'flat'); if (className) n.classList.add(className); }
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function stdev(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length);
  }
  function debounce(fn, ms) {
    var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
  }

  /* ------------------------------------------------- bar spacing, measured
     Never trust the interval a provider says it gave you. Yahoo answers
     interval=1wk with monthly bars when the range is long enough, and a
     forecast that steps a week at a time through monthly data puts every
     projected date four times too close - silently, because nothing throws.

     The median gap is used rather than the mean so one overnight or holiday
     gap cannot skew it, and the config value is kept unless the data disagrees
     by more than a quarter, so ordinary weekend gaps change nothing. */
  function deriveBarSec(candles, declared) {
    if (!candles || candles.length < 12) return declared;
    var gaps = [];
    for (var i = 1; i < candles.length; i++) {
      var g = candles[i].time - candles[i - 1].time;
      if (g > 0) gaps.push(g);
    }
    if (gaps.length < 8) return declared;
    gaps.sort(function (a, b) { return a - b; });
    // The lower quartile, not the median: for intraday series the median is
    // inflated by every overnight gap, while the quartile lands on the real
    // in-session spacing.
    var q = gaps[Math.floor(gaps.length * 0.25)];
    if (!q) return declared;
    var ratio = q / declared;
    if (ratio > 0.75 && ratio < 1.33) return declared;
    return q;
  }

  KT.core = {
    fmt: fmt, marketState: marketState, store: store, deriveBarSec: deriveBarSec,
    setLexicon: setLexicon, score: score, isNoise: isNoise, sectorOf: sectorOf, keyOf: keyOf,
    hasLexicon: function () { return !!lexicon; },
    el: el, text: text, cls: cls, clamp: clamp, mean: mean, stdev: stdev, debounce: debounce,
  };
})(window.KT);
