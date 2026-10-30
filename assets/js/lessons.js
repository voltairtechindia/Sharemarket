/* ============================================================================
   Lessons: the AI desk's memory.

   Ported from the reflection loop in TradingAgents (TauricResearch, Apache
   2.0). There, every decision is settled against what the market then did,
   the model writes a short reflection on it, and the next decision in a
   similar situation is handed the most relevant reflections before it is
   made. That is the part of the project worth taking: it is what turns a
   prompt into something that gets better with use.

   What is kept here, and what is not:

     kept      one lesson per settled desk call, the situation it was made in,
               the call itself and the outcome. Retrieval by situation, so the
               desk reading a range-bound, VIX-calm, FII-selling morning is
               reminded what happened the last few times it saw one.
     not kept  anything that moves a price, a band or a weight. Lessons are
               read by the desk's final call only. The weights are the
               learner's job (learn.js) and stay bounded and auditable there.

   A situation is a coarse fingerprint, not a vector of raw numbers. RSI 61
   and RSI 63 are the same situation; "RSI 61" is not a lesson anyone can use.
   Buckets also make the memory honest about how thin it is: twelve lessons
   across forty possible situations is a sparse memory, and the panel says so.

   Storage is this browser. Export and import exist because a memory that is
   lost with a cleared cache is not much of a memory.
   ========================================================================== */
(function (KT) {
  'use strict';
  var core = KT.core;

  var KEY = 'deskLessons';
  var VERSION = 1;
  var MAX_LESSONS = 240;
  var HALF_LIFE_DAYS = 45;      // a lesson from last quarter still counts, at half
  var MIN_SIMILARITY = 0.45;    // below this the "similar situation" is not similar

  /* ------------------------------------------------------------ storage */
  function blank() { return { version: VERSION, items: [] }; }
  // Parsed once and kept until the next write; the panel reads it every render.
  var cache = null;
  function load() {
    if (cache) return cache;
    var st = core.store.get(KEY, null);
    cache = (!st || st.version !== VERSION || !Array.isArray(st.items)) ? blank() : st;
    return cache;
  }
  function save(st) {
    cache = null;
    st.items = st.items.slice(-MAX_LESSONS);
    if (core.store.set(KEY, st)) return true;
    // localStorage full: keep the newest half rather than losing everything.
    st.items = st.items.slice(-Math.floor(MAX_LESSONS / 2));
    return core.store.set(KEY, st);
  }

  /* -------------------------------------------------------- fingerprint */
  function band(v, cuts, names) {
    if (v == null || !isFinite(v)) return null;
    for (var i = 0; i < cuts.length; i++) if (v < cuts[i]) return names[i];
    return names[names.length - 1];
  }

  /* s holds plain numbers, every one optional:
       kind 'index' | 'stock', symbol, sector, timeframe, session,
       price, ema50, adx, rsi, vix, gapPct, newsTone (-1..1), fiiNetCr */
  function fingerprint(s) {
    s = s || {};
    var trend = null;
    if (s.adx != null && isFinite(s.adx) && s.adx < 18) trend = 'range';
    else if (s.price != null && s.ema50 != null && isFinite(s.price) && isFinite(s.ema50)) {
      trend = s.price >= s.ema50 ? 'uptrend' : 'downtrend';
    }
    return {
      kind: s.kind || 'index',
      symbol: s.symbol || null,
      sector: s.sector || null,
      tf: s.timeframe || null,
      session: s.session || null,
      trend: trend,
      rsi: band(s.rsi, [35, 65], ['oversold', 'neutral', 'overbought']),
      vix: band(s.vix, [12, 17], ['calm', 'normal', 'stressed']),
      gap: band(s.gapPct, [-0.25, 0.25], ['gap-down', 'flat-open', 'gap-up']),
      news: band(s.newsTone, [-0.15, 0.15], ['negative', 'mixed', 'positive']),
      flows: band(s.fiiNetCr, [-750, 750], ['fii-selling', 'fii-flat', 'fii-buying']),
    };
  }

  /* What counts most when deciding two situations are alike. The trend and
     the news tone are the two things a reader would name first; the symbol
     matters because NIFTY and a small-cap react to the same morning very
     differently; the timeframe matters least, because a lesson about a
     gap-down open is mostly the same lesson on the session and daily views. */
  var WEIGHTS = { symbol: 2.0, kind: 1.0, sector: 1.0, tf: 0.5, session: 0.5,
                  trend: 1.5, rsi: 1.0, vix: 1.0, gap: 1.0, news: 1.5, flows: 1.0 };

  function similarity(a, b) {
    if (!a || !b) return 0;
    var num = 0, den = 0;
    Object.keys(WEIGHTS).forEach(function (k) {
      if (a[k] == null || b[k] == null) return;
      den += WEIGHTS[k];
      if (a[k] === b[k]) num += WEIGHTS[k];
    });
    return den ? num / den : 0;
  }

  var WORDS = {
    trend: { range: 'a range-bound tape', uptrend: 'an uptrend', downtrend: 'a downtrend' },
    rsi: { oversold: 'RSI oversold', neutral: 'RSI mid-range', overbought: 'RSI overbought' },
    vix: { calm: 'VIX calm', normal: 'VIX normal', stressed: 'VIX elevated' },
    gap: { 'gap-down': 'a gap-down open', 'flat-open': 'a flat open', 'gap-up': 'a gap-up open' },
    news: { negative: 'negative news', mixed: 'mixed news', positive: 'positive news' },
    flows: { 'fii-selling': 'FII selling', 'fii-flat': 'FII flat', 'fii-buying': 'FII buying' },
  };
  function describe(fp) {
    if (!fp) return '';
    var out = [];
    ['trend', 'news', 'flows', 'vix', 'rsi', 'gap'].forEach(function (k) {
      if (fp[k] && WORDS[k][fp[k]]) out.push(WORDS[k][fp[k]]);
    });
    return out.join(', ');
  }

  /* ------------------------------------------------------------ writing */
  function add(lesson) {
    if (!lesson || !lesson.text) return null;
    var st = load();
    if (lesson.runId) {
      for (var i = 0; i < st.items.length; i++) {
        if (st.items[i].runId === lesson.runId) return st.items[i];   // first write wins
      }
    }
    var row = {
      id: lesson.id || ('L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      at: lesson.at || Date.now(),
      runId: lesson.runId || null,
      symbol: lesson.symbol || null,
      kind: lesson.kind || 'index',
      fp: lesson.fp || null,
      call: lesson.call || null,
      outcome: lesson.outcome || null,
      text: String(lesson.text).replace(/\s+/g, ' ').trim().slice(0, 280),
      source: lesson.source === 'ai' ? 'ai' : 'rule',
    };
    st.items.push(row);
    save(st);
    return row;
  }

  /* The lesson written when no AI call is available. Plain arithmetic about
     the call against the outcome, so the memory still fills on a day the
     free tier is spent. Marked 'rule' so the panel never presents it as the
     AI's own reflection. */
  function ruleText(call, outcome, fp) {
    if (!call || !outcome || outcome.movePct == null) return null;
    var where = describe(fp) || 'this setup';
    var move = (outcome.movePct >= 0 ? '+' : '') + outcome.movePct.toFixed(2) + '%';
    var lean = call.score > 0.05 ? 'up' : call.score < -0.05 ? 'down' : 'flat';
    if (lean === 'flat') {
      return 'In ' + where + ', the desk had no lean and price moved ' + move + '.';
    }
    if (outcome.right === true) {
      return 'In ' + where + ', leaning ' + lean + ' was right: price moved ' + move + '.';
    }
    if (outcome.right === false) {
      return 'In ' + where + ', leaning ' + lean + ' was wrong: price moved ' + move +
             '. Weigh the opposite case harder next time.';
    }
    return 'In ' + where + ', price barely moved (' + move + ') against a lean ' + lean + '.';
  }

  /* ------------------------------------------------------------ reading */
  function recencyOf(at, now) {
    var days = Math.max(0, ((now || Date.now()) - (at || 0)) / 86400000);
    return Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  /* The k lessons most worth reading before a call in situation fp. Ranked by
     similarity first and age second, and a lesson below MIN_SIMILARITY is not
     returned at all: handing the desk an irrelevant lesson is worse than
     handing it none, because it will dutifully apply it. */
  function relevant(fp, opts) {
    opts = opts || {};
    var k = opts.k || 4, now = opts.now || Date.now();
    var items = load().items;
    var scored = [];
    items.forEach(function (it) {
      var sim = similarity(fp, it.fp);
      if (sim < (opts.minSimilarity != null ? opts.minSimilarity : MIN_SIMILARITY)) return;
      scored.push({ lesson: it, sim: Math.round(sim * 1000) / 1000,
                    rank: sim * (0.55 + 0.45 * recencyOf(it.at, now)) });
    });
    scored.sort(function (a, b) { return b.rank - a.rank || b.lesson.at - a.lesson.at; });
    return scored.slice(0, k);
  }

  /* As the desk's final call reads them: one line each, with the outcome, so
     the model sees what happened and not only what was concluded. */
  function forPrompt(list) {
    if (!list || !list.length) return '';
    return list.map(function (r, i) {
      var l = r.lesson || r;
      var o = l.outcome || {};
      var tail = o.movePct != null
        ? ' (' + (o.right === true ? 'call was right' : o.right === false ? 'call was wrong' : 'unscored') +
          ', price ' + (o.movePct >= 0 ? '+' : '') + Number(o.movePct).toFixed(2) + '%)'
        : '';
      return (i + 1) + '. ' + l.text + tail;
    }).join('\n');
  }

  function recent(n, symbol) {
    var items = load().items.filter(function (x) { return !symbol || x.symbol === symbol; });
    return items.slice(-(n || 5)).reverse();
  }
  function all() { return load().items.slice(); }
  function count() { return load().items.length; }
  function clear() { cache = null; core.store.remove(KEY); }

  /* How the desk has done by situation: the lesson record grouped on one
     fingerprint field. This is what lets the panel say "in range-bound tapes
     the desk was right 3 of 9" rather than only listing sentences. */
  function tally(field) {
    var by = {};
    load().items.forEach(function (it) {
      var v = it.fp && it.fp[field];
      if (!v || !it.outcome || it.outcome.right == null) return;
      var t = by[v] || (by[v] = { value: v, n: 0, right: 0 });
      t.n++;
      if (it.outcome.right) t.right++;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.n - a.n; });
  }

  function exportJson() {
    return JSON.stringify({ kind: 'kt-desk-lessons', version: VERSION,
                            exportedAt: new Date().toISOString(), items: load().items }, null, 1);
  }
  function importJson(textIn) {
    var obj;
    try { obj = JSON.parse(textIn); } catch (e) { return { added: 0, error: 'not JSON' }; }
    var list = obj && Array.isArray(obj.items) ? obj.items : Array.isArray(obj) ? obj : null;
    if (!list) return { added: 0, error: 'no lessons in the file' };
    var st = load(), have = {}, added = 0;
    st.items.forEach(function (x) { have[x.id] = 1; if (x.runId) have['r:' + x.runId] = 1; });
    list.forEach(function (x) {
      if (!x || !x.text || have[x.id] || (x.runId && have['r:' + x.runId])) return;
      st.items.push({
        id: String(x.id || ('L' + Math.random().toString(36).slice(2, 10))),
        at: +x.at || Date.now(), runId: x.runId || null, symbol: x.symbol || null,
        kind: x.kind || 'index', fp: x.fp || null, call: x.call || null, outcome: x.outcome || null,
        text: String(x.text).slice(0, 280), source: x.source === 'ai' ? 'ai' : 'rule',
      });
      added++;
    });
    st.items.sort(function (a, b) { return a.at - b.at; });
    save(st);
    return { added: added };
  }

  KT.lessons = {
    fingerprint: fingerprint, similarity: similarity, describe: describe,
    add: add, ruleText: ruleText, relevant: relevant, forPrompt: forPrompt,
    recent: recent, all: all, count: count, clear: clear, tally: tally,
    exportJson: exportJson, importJson: importJson,
    MIN_SIMILARITY: MIN_SIMILARITY,
  };
})(window.KT);
