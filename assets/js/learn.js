/* ============================================================================
   The part that learns.

   Everything else in this codebase is a fixed opinion. The eight lane weights
   in CONFIG are judgements written by hand, and the comment above them says so:
   "none of them has been fitted, because until the ledger has settled rows
   there is nothing to fit against". This file is what happens once there is.

   What it changes, and what it is not allowed to change:

     changes   the eight lane weights, and one scalar gain on the opening-gap
               betas. Two knobs, both bounded, both auditable.
     never     any price, any band, any probability, any narrative fact. The
               model stays deterministic arithmetic over the lanes; learning
               only moves how much each lane is listened to.

   An LLM is nowhere in that list. OpenRouter and Gemini rewrite the English
   post-mortem and may PROPOSE a weight change, which lands as a suggestion a
   human accepts - `proposal()` and `accept()` below. They cannot write a
   weight, because a free-tier router that once answered "User Safety: safe" to
   a forecast prompt (see CLAUDE.md) must not be one keystroke from the model's
   parameters.

   Three guardrails, each of which is a way this would otherwise go wrong:

     1. MIN_SAMPLE. A lane that has been right four times out of five has told
        you nothing; the Wilson interval on 4/5 runs from 38% to 99%. Nothing
        moves until a lane has MIN_SAMPLE settled calls, and then it moves by
        how far its interval clears a coin, not by its point estimate. This is
        the same test `aggregate()` already applies before calling a lane
        significant, reused rather than reinvented.

     2. MAX_STEP. A single bad Tuesday cannot rewrite the model. Each update
        moves a weight by at most MAX_STEP of its current value, so recovering
        from a run of noise takes as many sessions as creating it did. Momentum
        in the learner is the failure that turns a model into a weathervane.

     3. FLOOR. No lane is ever driven to zero. A lane at zero stops being
        scored, which means it can never earn its way back, which means one
        unlucky fortnight silently amputates an input forever. Every lane keeps
        a vote small enough not to matter and large enough to be measured.

   State lives in this browser, versioned, with every step kept. `history()` is
   what makes the claim "the model learned" checkable rather than decorative.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var KEY = 'fcLearn';
  /* Version 2 (30 Oct 2026). Version 1 stepped every hour on whatever the
     record said, new evidence or not, so a lane whose interval sat below a
     coin was cut by the full step every hour until it hit the floor: one
     browser's news lane went from 0.24 to 0.02 in a day and stayed there. A
     fit made that way is not kept; the learner starts again from CONFIG and
     now steps only on new settled calls. */
  var VERSION = 2;

  var MIN_SAMPLE = 20;      // settled calls before a lane may move at all
  var MAX_STEP = 0.08;      // at most 8% of its own weight per update
  var FLOOR = 0.02;         // no lane is ever silenced
  var MIN_OPEN_SAMPLE = 10; // settled opens before the gap gain may move
  var MAX_GAIN = 1.6, MIN_GAIN = 0.4;
  var UPDATE_EVERY_MS = 3600000;   // at most hourly; the evidence is daily
  /* A step needs fresh evidence: this many settled calls since the last
     step, or a tenth of the sample, whichever is larger. Without it the same
     record was applied again every hour. */
  var MIN_NEW_CALLS = 5;

  function blank() {
    return { version: VERSION, weights: null, openGain: 1, updatedAt: 0,
             samples: 0, openSamples: 0, history: [], proposal: null };
  }

  function load() {
    var st = core.store.get(KEY, null);
    if (!st || st.version !== VERSION) return blank();
    return st;
  }
  function save(st) { return core.store.set(KEY, st); }

  /* ------------------------------------------------------------- reading
     Called from build() on every tick, so it must not touch localStorage
     every time. The cache is invalidated by write, not by time. */
  var cache = null;

  function state() {
    if (!cache) cache = load();
    return cache;
  }
  function invalidate() { cache = null; }

  /* ------------------------------------------------------ the published fit

     The workflow fits the same two knobs, under the same guardrails, from the
     published record of session calls (scripts/daily_call.js writes it to
     data/calls.json as "learned"). That record is the same in every browser,
     does not depend on anyone having had the page open, and is longer than
     any one browser's, so where it has a fit, that fit is used, here and in
     the call the workflow freezes. This browser's own fit is the fallback. */
  var shared = null;

  function adoptShared(fit) {
    shared = null;
    if (!fit || typeof fit !== 'object') return false;
    var w = null;
    if (fit.weights && typeof fit.weights === 'object') {
      w = {};
      Object.keys(C.forecast.weights).forEach(function (k) {
        var v = Number(fit.weights[k]);
        w[k] = isFinite(v) && v > 0 && v <= 1 ? Math.max(FLOOR, v) : C.forecast.weights[k];
      });
      normalise(w);
    }
    var g = Number(fit.openGain);
    shared = {
      weights: w,
      openGain: isFinite(g) ? core.clamp(g, MIN_GAIN, MAX_GAIN) : 1,
      openSamples: +fit.openSamples || 0,
      samples: +fit.samples || 0,
      updatedAt: fit.updatedAt || 0,
      history: Array.isArray(fit.history) ? fit.history.slice(-60) : [],
    };
    return true;
  }

  function weights() {
    if (shared && shared.weights) {
      var sw = shallow(shared.weights);
      sw.fitted = true; sw.source = 'record';
      return sw;
    }
    var st = state();
    if (!st.weights) return null;                 // build() falls back to CONFIG
    var out = {};
    Object.keys(C.forecast.weights).forEach(function (k) {
      out[k] = st.weights[k] != null ? st.weights[k] : C.forecast.weights[k];
    });
    out.fitted = true;
    return out;
  }

  /* The gap betas, scaled by one learned gain. One parameter from N settled
     opens, not nine - fitting nine betas on the handful of mornings this will
     have by Christmas would produce nine confident numbers and no information.
     If the model is systematically calling gaps too big, every beta is too
     big together, and that is the thing N mornings can actually tell you. */
  function openBetas() {
    var st = state();
    var gain = st.openGain, n = st.openSamples;
    if (shared && shared.openSamples >= MIN_OPEN_SAMPLE && shared.openSamples >= (n || 0)) {
      gain = shared.openGain; n = shared.openSamples;
    }
    if (!gain || gain === 1 || n < MIN_OPEN_SAMPLE) return null;
    var base = KT.forecast && KT.forecast.openBetaDefaults;
    if (!base) return null;
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k] * gain; });
    out.fitted = true;
    return out;
  }

  /* ------------------------------------------------------------ updating

     Lane weights move toward the lanes whose Wilson interval clears 50%, and
     away from the ones whose interval sits entirely below it. A lane whose
     interval straddles 50% has not said anything yet and is left alone - that
     is most lanes, for a long time, and the panel should say so rather than
     manufacturing movement to look alive. */
  function update(symbol, timeframe, opts) {
    opts = opts || {};
    var st = load();
    if (!opts.force && Date.now() - st.updatedAt < UPDATE_EVERY_MS) {
      return { skipped: 'too soon', state: st };
    }
    if (!KT.ledger || !KT.ledger.aggregate) return { skipped: 'no ledger', state: st };

    var agg = KT.ledger.aggregate(symbol, timeframe);
    var fresh = (agg.n || 0) - (st.stepSamples || 0);
    if (!opts.force && st.weights && fresh < Math.max(MIN_NEW_CALLS, Math.ceil((st.stepSamples || 0) * 0.1))) {
      st.updatedAt = Date.now();
      save(st); invalidate();
      return { skipped: 'no new evidence since the last step', moved: [], held: [], agg: agg, state: st };
    }
    var moved = [], held = [];
    var base = st.weights || shallow(C.forecast.weights);
    var next = shallow(base);
    // A lane added after the weights were last fitted starts at its CONFIG
    // weight, so it is in the set the learner moves and renormalises.
    Object.keys(C.forecast.weights).forEach(function (k) { if (next[k] == null) next[k] = C.forecast.weights[k]; });

    (agg.lanes || []).forEach(function (l) {
      if (!next.hasOwnProperty(l.id)) return;
      if (l.n < MIN_SAMPLE) { held.push({ id: l.id, why: 'only ' + l.n + ' of ' + MIN_SAMPLE + ' calls' }); return; }
      var ci = l.ci;
      if (!ci) { held.push({ id: l.id, why: 'no interval' }); return; }

      /* The size of the step is how far the interval clears the coin, capped.
         Using the point estimate instead would step hardest exactly where the
         sample is thinnest, which is backwards. */
      var edge = ci[0] > 50 ? (ci[0] - 50) / 50 : (ci[1] < 50 ? (ci[1] - 50) / 50 : 0);
      if (!edge) { held.push({ id: l.id, why: 'interval straddles 50%' }); return; }

      var step = core.clamp(edge, -MAX_STEP, MAX_STEP);
      var was = next[l.id];
      next[l.id] = Math.max(FLOOR, was * (1 + step));
      // A lane already at the floor (or capped) has not moved; saying it
      // did fills the history with steps that changed nothing.
      if (round4(next[l.id]) === round4(was)) { held.push({ id: l.id, why: 'at the floor' }); return; }
      moved.push({ id: l.id, label: l.label, from: round4(was), to: round4(next[l.id]),
                   rate: l.rate, n: l.n, ci: ci });
    });

    // Renormalise so the eight still sum to one. build() renormalises over the
    // live lanes anyway, but a set that drifts away from 1 here makes every
    // printed weight harder to read against the CONFIG it started from.
    normalise(next);

    var open = openGainFrom(symbol);

    if (!moved.length && open.gain === st.openGain) {
      st.updatedAt = Date.now();
      st.samples = agg.n || 0;
      save(st); invalidate();
      return { moved: [], held: held, agg: agg, open: open, state: st };
    }

    st.weights = next;
    st.openGain = open.gain;
    st.openSamples = open.n;
    st.samples = agg.n || 0;
    st.stepSamples = agg.n || 0;
    st.updatedAt = Date.now();
    st.history.push({ at: Date.now(), symbol: symbol, timeframe: timeframe,
                      moved: moved, openGain: open.gain, openSamples: open.n,
                      sample: agg.n || 0 });
    if (st.history.length > 60) st.history = st.history.slice(-60);
    save(st); invalidate();
    return { moved: moved, held: held, agg: agg, open: open, state: st };
  }

  /* One number: are the gaps we call too big or too small, on average.

     A ratio of realised gap to called gap, over settled opens, shrunk toward 1
     by the sample size. The shrinkage is what stops ten mornings from
     producing a gain of 2.4 because one of them was a budget day. */
  function openGainFrom(symbol) {
    if (!KT.ledger || !KT.ledger.locks) return { gain: 1, n: 0 };
    var rows = KT.ledger.locks(symbol, 60);
    var called = 0, realised = 0, n = 0;
    rows.forEach(function (r) {
      if (r.openGapPct == null || !r.anchorPrice) return;
      var sc = r.outcome;
      if (!sc || sc.openActual == null) return;
      /* The session's own opening print where the judgement recorded it.
         The outcome's first price is the close of the first projected
         minute, which on a morning that sells off from the bell is a
         different number from the gap the call was making. */
      var did = r.postmortem && r.postmortem.did;
      var opened = did && did.open > 0 ? did.open : sc.openActual;
      var actualGap = (opened - r.anchorPrice) / r.anchorPrice * 100;
      // Only mornings where a gap was actually called. Dividing by a called
      // gap of 0.001% produces a gain of four hundred.
      if (Math.abs(r.openGapPct) < 0.05) return;
      called += Math.abs(r.openGapPct);
      realised += Math.abs(actualGap);
      n++;
    });
    if (n < MIN_OPEN_SAMPLE || !called) return { gain: 1, n: n };
    var raw = realised / called;
    // Shrink toward 1 in proportion to how thin the sample still is.
    var w = n / (n + MIN_OPEN_SAMPLE);
    var gain = core.clamp(1 + (raw - 1) * w, MIN_GAIN, MAX_GAIN);
    return { gain: Math.round(gain * 1000) / 1000, n: n, raw: Math.round(raw * 1000) / 1000 };
  }

  /* ----------------------------------------------------------- proposals

     Where the language model is allowed to stand. It reads the record and
     writes a sentence and, optionally, a suggested weight change; the change
     sits here until a person accepts it. Nothing on this path can move a
     number on its own, which is the whole reason the path exists separately
     from update(). */
  function propose(p) {
    if (!p || !p.text) return null;
    var st = load();
    st.proposal = {
      at: Date.now(), text: String(p.text).slice(0, 1200),
      model: p.model || null,
      changes: sanitiseChanges(p.changes),
    };
    save(st); invalidate();
    return st.proposal;
  }

  /* A proposal is data from a model, not an instruction. It gets the same
     bounds an arithmetic update gets, and anything outside them is dropped
     rather than clamped quietly - a model asking for a 4x weight has
     misunderstood the task, and honouring 8% of that request would hide it. */
  function sanitiseChanges(changes) {
    if (!changes) return [];
    var out = [];
    Object.keys(changes).forEach(function (k) {
      if (!C.forecast.weights.hasOwnProperty(k)) return;
      var v = Number(changes[k]);
      if (!isFinite(v)) return;
      var cur = (state().weights || C.forecast.weights)[k];
      var rel = (v - cur) / cur;
      if (Math.abs(rel) > MAX_STEP) return;
      out.push({ id: k, from: round4(cur), to: round4(Math.max(FLOOR, v)) });
    });
    return out;
  }

  function accept() {
    var st = load();
    if (!st.proposal || !st.proposal.changes.length) return null;
    var next = shallow(st.weights || C.forecast.weights);
    st.proposal.changes.forEach(function (c) { next[c.id] = c.to; });
    normalise(next);
    st.weights = next;
    st.history.push({ at: Date.now(), source: 'proposal', model: st.proposal.model,
                      moved: st.proposal.changes.map(function (c) {
                        return { id: c.id, from: c.from, to: c.to };
                      }) });
    st.proposal = null;
    st.updatedAt = Date.now();
    save(st); invalidate();
    return st;
  }

  function reject() {
    var st = load();
    st.proposal = null;
    save(st); invalidate();
    return st;
  }

  function reset() {
    save(blank()); invalidate();
    return state();
  }

  function history() {
    if (shared && shared.weights) return shared.history.slice().reverse();
    return state().history.slice().reverse();
  }
  function proposal() { return state().proposal; }
  function summary() {
    var st = state();
    var rec = shared && shared.weights ? shared : null;
    var openRec = shared && shared.openSamples >= MIN_OPEN_SAMPLE && shared.openSamples >= (st.openSamples || 0);
    return {
      fitted: !!(rec || st.weights),
      source: rec ? 'record' : st.weights ? 'browser' : 'config',
      samples: rec ? rec.samples : st.samples,
      openSamples: openRec ? shared.openSamples : st.openSamples,
      openGain: openRec ? shared.openGain : st.openGain,
      updatedAt: rec ? rec.updatedAt : st.updatedAt,
      steps: rec ? rec.history.length : st.history.length,
      recordSamples: shared ? shared.samples : 0,
      minSample: MIN_SAMPLE, maxStep: MAX_STEP,
      weights: rec ? shallow(rec.weights) : st.weights || shallow(C.forecast.weights),
    };
  }

  function shallow(o) { var c = {}; Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  /* Scale a weight set to sum to one, at four decimals. Rounding each of
     eleven weights on its own leaves the set up to half a basis point off
     one; the remainder goes to the largest weight, where it is smallest
     relative to the weight it lands on. */
  function normalise(w) {
    var keys = Object.keys(w), sum = 0, big = null;
    keys.forEach(function (k) { sum += w[k]; });
    if (!(sum > 0)) return w;
    var tot = 0;
    keys.forEach(function (k) {
      w[k] = round4(w[k] / sum); tot += w[k];
      if (big === null || w[k] > w[big]) big = k;
    });
    w[big] = round4(w[big] + (1 - tot));
    return w;
  }

  KT.learn = {
    weights: weights, openBetas: openBetas, update: update,
    propose: propose, accept: accept, reject: reject, proposal: proposal,
    history: history, summary: summary, reset: reset,
    openGainFrom: openGainFrom, adoptShared: adoptShared,
    MIN_SAMPLE: MIN_SAMPLE, MAX_STEP: MAX_STEP, FLOOR: FLOOR,
    MIN_OPEN_SAMPLE: MIN_OPEN_SAMPLE, MIN_GAIN: MIN_GAIN, MAX_GAIN: MAX_GAIN,
  };
})(window.KT);
