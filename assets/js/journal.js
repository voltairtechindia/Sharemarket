/* ============================================================================
   Trade journal. Entries live in this browser only - never uploaded, never in
   the repo. The passcode gate keeps a casual passer-by out of the log on a
   shared machine; it is not security, because this is a public static page.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var KEY = 'journal';
  var AUTH_KEY = 'journalAuth';
  var state = { unlocked: false, trades: [], profile: 'default' };

  function digest(salt, user, pass) {
    var msg = salt + ':' + user + ':' + pass;
    if (!(window.crypto && crypto.subtle)) return Promise.resolve('nocrypto:' + msg.length);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  /* Credential comes from the gitignored local config when present, otherwise
     from whatever the viewer set on this browser. Nothing is ever sent away. */
  function storedAuth() {
    var local = window.KT_LOCAL && window.KT_LOCAL.journalAuth;
    if (local && local.hash) return local;
    return core.store.get(AUTH_KEY, null);
  }

  function hasAuth() { return !!storedAuth(); }

  function setAuth(user, pass) {
    var salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return digest(salt, user, pass).then(function (h) {
      core.store.set(AUTH_KEY, { user: user, salt: salt, hash: h });
      return true;
    });
  }

  function verify(user, pass) {
    var a = storedAuth();
    if (!a) return Promise.resolve(false);
    if (a.user && a.user !== user) return Promise.resolve(false);
    return digest(a.salt, user, pass).then(function (h) { return h === a.hash; });
  }

  /* ------------------------------------------------------------- the trades */
  function load() {
    var raw = core.store.get(KEY + ':' + state.profile, []);
    state.trades = Array.isArray(raw) ? raw.filter(function (t) { return t && t.id; }) : [];
    state.trades.sort(function (a, b) { return b.ts - a.ts; });
    return state.trades;
  }

  function save() {
    core.store.set(KEY + ':' + state.profile, state.trades);
  }

  function add(entry) {
    var t = {
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: entry.ts,
      symbol: entry.symbol || 'NIFTY',
      side: entry.side === 'SELL' ? 'SELL' : 'BUY',
      qty: Number(entry.qty) || 0,
      price: Number(entry.price) || 0,
      note: String(entry.note || '').slice(0, 200),
      added: Math.floor(Date.now() / 1000),
    };
    state.trades.unshift(t);
    state.trades.sort(function (a, b) { return b.ts - a.ts; });
    save();
    return t;
  }

  function remove(id) {
    state.trades = state.trades.filter(function (t) { return t.id !== id; });
    save();
  }

  function all() { return state.trades; }

  function forSymbol(sym) {
    return state.trades.filter(function (t) { return t.symbol === sym; });
  }

  /* Net position and running P&L for one symbol, marked to the live price.
     Average cost is recomputed on the buy side only, which is the simple
     convention and matches how a broker shows an averaged long. */
  function position(sym, livePrice) {
    var rows = forSymbol(sym).slice().sort(function (a, b) { return a.ts - b.ts; });
    var qty = 0, cost = 0, realised = 0;
    rows.forEach(function (t) {
      if (t.side === 'BUY') {
        cost += t.qty * t.price;
        qty += t.qty;
      } else {
        var avg = qty > 0 ? cost / qty : t.price;
        realised += (t.price - avg) * Math.min(t.qty, qty);
        cost -= avg * Math.min(t.qty, qty);
        qty -= t.qty;
      }
    });
    var avgCost = qty > 0 ? cost / qty : 0;
    var unrealised = (livePrice && qty > 0) ? (livePrice - avgCost) * qty : 0;
    return {
      qty: qty, avgCost: avgCost, invested: Math.max(0, cost),
      realised: realised, unrealised: unrealised,
      total: realised + unrealised,
      pctOnCost: cost > 0 ? (unrealised / cost) * 100 : 0,
      trades: rows.length,
    };
  }

  /* Markers the chart draws alongside the news reason points. */
  function markers(sym) {
    return forSymbol(sym).map(function (t) {
      var buy = t.side === 'BUY';
      return {
        time: t.ts,
        position: buy ? 'belowBar' : 'aboveBar',
        color: buy ? '#2a78d6' : '#eb6834',
        shape: buy ? 'arrowUp' : 'arrowDown',
        size: 1.2,
        text: (buy ? 'B ' : 'S ') + t.qty + ' @ ' + Math.round(t.price),
        __trade: t,
      };
    });
  }

  /* -------------------------------------------------------- export / import */
  function exportJson() {
    return JSON.stringify({
      exported: new Date().toISOString(),
      profile: state.profile,
      note: 'NIFTY Terminal trade journal. Local file, keep it private.',
      trades: state.trades,
    }, null, 2);
  }

  function importJson(text) {
    var parsed = JSON.parse(text);
    var incoming = Array.isArray(parsed) ? parsed : (parsed.trades || []);
    var seen = {};
    state.trades.forEach(function (t) { seen[t.id] = true; });
    var added = 0;
    incoming.forEach(function (t) {
      if (!t || !t.id || seen[t.id]) return;
      if (typeof t.ts !== 'number' || typeof t.price !== 'number') return;
      seen[t.id] = true;
      state.trades.push(t);
      added++;
    });
    state.trades.sort(function (a, b) { return b.ts - a.ts; });
    save();
    return added;
  }

  function unlock() { state.unlocked = true; }
  function isUnlocked() { return state.unlocked; }
  function lock() { state.unlocked = false; }

  KT.journal = {
    hasAuth: hasAuth, setAuth: setAuth, verify: verify,
    unlock: unlock, lock: lock, isUnlocked: isUnlocked,
    load: load, add: add, remove: remove, all: all, forSymbol: forSymbol,
    position: position, markers: markers,
    exportJson: exportJson, importJson: importJson,
  };
})(window.KT);
