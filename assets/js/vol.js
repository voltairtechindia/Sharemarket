/* ============================================================================
   Volatility.

   The band used to be one number: stdev of the last 120 closes, blended 60/40
   with a VIX conversion, widened by a hand-tuned 1.15. Three things were wrong
   with that, and this file fixes each one.

   1. It threw away the high and the low. Every candle in this repo carries
      OHLC, and a range estimator extracts several times more information per
      bar than close-to-close does. On the same 300-bar NIFTY daily series the
      Parkinson estimator's sampling error is a fraction of the close-to-close
      one, for free, from data already loaded.

   2. It had no memory. Realised vol over a trailing window treats a bar from
      four months ago exactly like yesterday's, and carries no notion that
      today's variance depends on yesterday's. An index does not behave that
      way, and after a fall it does not behave symmetrically either: down moves
      raise volatility more than up moves of the same size. GJR-GARCH models
      that asymmetry explicitly, which matters most on exactly the day a
      forecast panel is read hardest.

   3. The 1.15 multiplier was a constant standing where a measurement belongs.
      Here the multiplier is read off the model's own standardised residuals -
      empirically where the sample supports the tail, from the fitted Student-t
      where it does not - and the number actually used is returned so the panel
      can show it.

   Ported, with thanks, from tripolskypetr/garch (MIT): the variance recursions,
   the Nelder-Mead fitting, QLIKE selection, the calibrated z and the Kupiec
   test. Adaptive Conformal Inference is Gibbs & Candes 2021, by way of
   salesforce/online_conformal (BSD-3).

   Units are percent throughout, matching forecast.js: a return of 0.5% is 0.5,
   and a variance is therefore in percent-squared. Mixing fractional and percent
   units silently scales the band by 10,000, so nothing in this file works in
   fractions.
   ========================================================================== */
(function (KT) {
  'use strict';

  var LN2_4 = 4 * Math.LN2;

  /* ==================================================== special functions */

  /* Lanczos, g=7, n=9. Accurate to about 15 digits over the range a Student-t
     degrees-of-freedom search will ask for, which is far more than needed. */
  var LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    var x = LANCZOS[0];
    for (var i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
    var t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  /* Normal CDF - Abramowitz and Stegun 7.1.26. forecast.js has its own copy for
     the probability it prints; this one exists so vol.js stands alone and can
     be tested without loading the rest of the app. */
  function ncdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  /* Regularised incomplete beta, by the continued fraction of Numerical
     Recipes 6.4. Needed for the Student-t CDF, which is needed for the far
     tail of the band multiplier. */
  function betacf(a, b, x) {
    var qab = a + b, qap = a + 1, qam = a - 1;
    var c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= 200; m++) {
      var m2 = 2 * m;
      var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-12) break;
    }
    return h;
  }
  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }

  /* CDF of the standardised Student-t: unit variance, not unit scale. The
     distinction matters - a raw t(df) has variance df/(df-2), so using it
     directly would widen the band by that factor on top of the variance the
     model already estimated, double-counting the fat tail. */
  function tcdf(t, df) {
    var scaled = t * Math.sqrt(df / (df - 2));
    var p = 0.5 * betai(df / 2, 0.5, df / (df + scaled * scaled));
    return scaled > 0 ? 1 - p : p;
  }
  /* Inverse by bisection. A closed form exists only for a few df, and this is
     called once per fit, so fifty halvings of a bracket is cheap and exact
     enough to the 1e-6 it stops at. */
  function tquantile(p, df) {
    if (!(df > 2)) df = 2.05;
    var lo = -40, hi = 40;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (tcdf(mid, df) < p) lo = mid; else hi = mid;
      if (hi - lo < 1e-7) break;
    }
    return (lo + hi) / 2;
  }

  /* =============================================== realised variance ===== */

  /* Parkinson 1980. Uses only the high and the low, so it measures the ground
     price actually covered rather than where it happened to stop. */
  function parkinson(c) {
    if (!c || !(c.high > 0) || !(c.low > 0) || c.high <= c.low) return null;
    var r = Math.log(c.high / c.low);
    return r * r / LN2_4 * 10000;
  }

  /* Garman-Klass 1980. Adds the open-to-close leg, so it is more efficient
     again, at the cost of needing a trustworthy open. */
  function garmanKlass(c) {
    if (!c || !(c.high > 0) || !(c.low > 0) || !(c.open > 0) || !(c.close > 0)) return null;
    if (c.high <= c.low) return null;
    var hl = Math.log(c.high / c.low), co = Math.log(c.close / c.open);
    var v = 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
    return v > 0 ? v * 10000 : null;
  }

  function rogersSatchell(c) {
    if (!c || !(c.high > 0) || !(c.low > 0) || !(c.open > 0) || !(c.close > 0)) return null;
    var v = Math.log(c.high / c.close) * Math.log(c.high / c.open) +
            Math.log(c.low / c.close) * Math.log(c.low / c.open);
    return v > 0 ? v * 10000 : null;
  }

  /* Close-to-close, the fallback. Not an estimator of choice - it is what a bar
     degrades to when its own high and low are unusable, which happens on thin
     bars where high equals low. Dropping such a bar instead would break the
     alignment between the return series and the variance series, and a
     misaligned GARCH fit is worse than a noisy one. */
  function closeToClose(prevClose, close) {
    if (!(prevClose > 0) || !(close > 0)) return null;
    var r = Math.log(close / prevClose);
    return r * r * 10000;
  }

  /* Per-bar returns in percent, aligned so rets[i] belongs to candles[i]. The
     first element is dropped from both series, because a return needs two
     closes and a variance series that starts one bar earlier than its returns
     is the classic off-by-one in this kind of code. */
  function series(candles, kind) {
    var rets = [], rv = [], times = [], used = { range: 0, fallback: 0 };
    if (!candles || candles.length < 3) return { rets: rets, rv: rv, times: times, used: used };
    for (var i = 1; i < candles.length; i++) {
      var prev = candles[i - 1].close, c = candles[i];
      if (!(prev > 0) || !(c.close > 0)) continue;
      var r = (c.close - prev) / prev * 100;
      if (!isFinite(r)) continue;
      var v = kind === 'gk' ? garmanKlass(c) : kind === 'rs' ? rogersSatchell(c) : parkinson(c);
      if (v === null || !isFinite(v) || v <= 0) {
        v = closeToClose(prev, c.close);
        if (v === null || !isFinite(v)) continue;
        // A bar that did not move at all still carries information, but zero
        // variance breaks every log in the likelihood. Floor it.
        if (v <= 0) v = 1e-8;
        used.fallback++;
      } else {
        used.range++;
      }
      rets.push(r); rv.push(v); times.push(c.time);
    }
    return { rets: rets, rv: rv, times: times, used: used };
  }

  /* ------------------------------------------------- intraday seasonality

     An index is several times noisier in the first half hour than at lunch.
     Fit a GARCH to raw 5-minute returns and it spends its ARCH coefficient
     describing that daily cycle instead of describing volatility clustering -
     measured on the live NIFTY 5m series, alpha came out at 0.664 against a
     beta of 0.077, which is a model that has learned the clock rather than the
     market.

     That matters here specifically because forecast.js already models the same
     cycle, bar by bar, in volProfile(). Feeding it a GARCH that has absorbed
     the cycle too would apply the open spike twice and put the band roughly
     three times too wide at 09:15.

     So: divide it out before fitting (Andersen-Bollerslev), fit on what is
     left, and let forecast.js put it back through the profile it already has.
     The profile function passed in is exactly volProfile().mult. */
  function deseason(s, profile) {
    if (!profile) return s;
    var rets = [], rv = [], times = [], i, m;
    for (i = 0; i < s.rets.length; i++) {
      m = profile(s.times[i]);
      if (!(m > 0) || !isFinite(m)) m = 1;
      rets.push(s.rets[i] / Math.sqrt(m));
      rv.push(s.rv[i] / m);
      times.push(s.times[i]);
    }
    return { rets: rets, rv: rv, times: times, used: s.used, deseasonalised: true };
  }

  /* Yang-Zhang 1990: overnight jump + open-to-close + Rogers-Satchell, with the
     weight k chosen to minimise the variance of the estimate. Returns one
     number for the whole window rather than a per-bar series, so it is used to
     sanity-check the level of a fitted model rather than to drive it. On a
     daily or longer series the overnight gap is a real part of the variance,
     and a per-bar estimator that only looks inside the session understates the
     band by however much of the move happened while the market was shut. */
  function yangZhang(candles, n) {
    if (!candles || candles.length < 4) return null;
    var start = Math.max(1, candles.length - (n || candles.length));
    var o = [], c = [], rs = [];
    for (var i = start; i < candles.length; i++) {
      var p = candles[i - 1], b = candles[i];
      if (!(p.close > 0) || !(b.open > 0) || !(b.close > 0)) continue;
      var v = rogersSatchell(b);
      if (v === null) continue;
      o.push(Math.log(b.open / p.close) * 100);
      c.push(Math.log(b.close / b.open) * 100);
      rs.push(v);
    }
    if (o.length < 3) return null;
    var vo = variance(o), vc = variance(c);
    var vrs = rs.reduce(function (s, x) { return s + x; }, 0) / rs.length;
    var k = 0.34 / (1.34 + (o.length + 1) / (o.length - 1));
    var v2 = vo + k * vc + (1 - k) * vrs;
    return v2 > 0 ? v2 : null;
  }

  function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  function variance(a) {
    if (!a || a.length < 2) return 0;
    var m = mean(a);
    return a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1);
  }

  /* =========================================================== optimiser */

  /* Nelder-Mead, multi-start. Derivative-free because the Student-t likelihood
     of a GARCH recursion has no clean gradient and finite differences on a
     recursive objective are unreliable.

     The starts are deterministic - a golden-ratio walk, never Math.random().
     A forecast panel whose numbers move on refresh with no new data is not
     defensible, and a random restart would do exactly that. */
  var PHI = 0.6180339887498949;

  function nelderMead(fn, x0, opts) {
    opts = opts || {};
    var maxIter = opts.maxIter || 1000, tol = opts.tol || 1e-8, step = opts.step || 0.2;
    var n = x0.length;
    var simplex = [], i, j;
    for (i = 0; i <= n; i++) {
      var p = x0.slice();
      if (i > 0) p[i - 1] += (p[i - 1] === 0 ? step : Math.abs(p[i - 1]) * step) || step;
      simplex.push({ x: p, f: fn(p) });
    }
    function order() { simplex.sort(function (a, b) { return a.f - b.f; }); }
    order();

    for (var it = 0; it < maxIter; it++) {
      if (Math.abs(simplex[n].f - simplex[0].f) <
          tol * (Math.abs(simplex[0].f) + Math.abs(simplex[n].f) + 1e-12)) break;

      var centroid = new Array(n);
      for (j = 0; j < n; j++) {
        var s = 0;
        for (i = 0; i < n; i++) s += simplex[i].x[j];
        centroid[j] = s / n;
      }
      function along(t) {
        var out = new Array(n);
        for (var k = 0; k < n; k++) out[k] = centroid[k] + t * (centroid[k] - simplex[n].x[k]);
        return out;
      }
      var xr = along(1), fr = fn(xr);
      if (fr < simplex[0].f) {
        var xe = along(2), fe = fn(xe);
        simplex[n] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr };
      } else if (fr < simplex[n - 1].f) {
        simplex[n] = { x: xr, f: fr };
      } else {
        var xc = along(fr < simplex[n].f ? 0.5 : -0.5), fc = fn(xc);
        if (fc < Math.min(fr, simplex[n].f)) {
          simplex[n] = { x: xc, f: fc };
        } else {
          for (i = 1; i <= n; i++) {
            var xs = new Array(n);
            for (j = 0; j < n; j++) xs[j] = simplex[0].x[j] + 0.5 * (simplex[i].x[j] - simplex[0].x[j]);
            simplex[i] = { x: xs, f: fn(xs) };
          }
        }
      }
      order();
    }
    return { x: simplex[0].x, f: simplex[0].f };
  }

  function multiStart(fn, x0, restarts, opts) {
    var best = nelderMead(fn, x0, opts);
    for (var k = 1; k <= restarts; k++) {
      var frac = (k * PHI) % 1;                       // deterministic, spread
      var start = x0.map(function (v, i) {
        return v + (frac - 0.5) * 2 * (1 + (i % 3) * 0.5);
      });
      var r = nelderMead(fn, start, opts);
      if (r.f < best.f) best = r;
    }
    return best;
  }

  /* ============================================================== models */

  /* Constraints are enforced by parameterisation, not by penalties. Every point
     the simplex can reach is a valid model, so the optimiser never has to walk
     back out of an infeasible region and no fit can return a non-stationary
     parameter set. Persistence is a sigmoid capped just under 1, and the split
     between the ARCH, leverage and GARCH terms is a share of it. */
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  function unpackGarch(p) {
    var persist = sigmoid(p[1]) * 0.9995;
    var share = sigmoid(p[2]);
    return {
      omega: Math.exp(p[0]),
      alpha: persist * share,
      beta: persist * (1 - share),
      gamma: 0,
      df: 2.1 + 48 * sigmoid(p[3]),
      persistence: persist,
    };
  }
  function unpackGjr(p) {
    var persist = sigmoid(p[1]) * 0.9995;
    // Two logits split the persistence three ways without ever leaving the
    // simplex: alpha, half the leverage term, and beta.
    var a = Math.exp(p[2]), g = Math.exp(p[3]), b = 1, tot = a + g + b;
    var alpha = persist * a / tot, halfGamma = persist * g / tot, beta = persist * b / tot;
    return {
      omega: Math.exp(p[0]),
      alpha: alpha, gamma: halfGamma * 2, beta: beta,
      df: 2.1 + 48 * sigmoid(p[4]),
      persistence: persist,
    };
  }

  /* sigma^2_t = omega + (alpha + gamma*I(r_{t-1}<0)) * RV_{t-1} + beta*sigma^2_{t-1}
     With gamma zero this is plain GARCH(1,1) driven by realised variance. */
  function varianceSeries(m, rv, rets) {
    var n = rv.length, out = new Array(n);
    var uncond = m.omega / Math.max(1e-9, 1 - m.persistence);
    var s2 = isFinite(uncond) && uncond > 0 ? Math.min(uncond, mean(rv) * 8) : mean(rv);
    if (!(s2 > 0)) s2 = 1e-6;
    out[0] = s2;
    for (var i = 1; i < n; i++) {
      var lev = m.gamma && rets[i - 1] < 0 ? m.gamma : 0;
      s2 = m.omega + (m.alpha + lev) * rv[i - 1] + m.beta * s2;
      if (!(s2 > 0) || !isFinite(s2)) s2 = 1e-6;
      out[i] = s2;
    }
    return out;
  }

  /* Negative log-likelihood of standardised Student-t innovations. Gaussian
     MLE would misfit precisely the tail this whole file exists to get right,
     so df is estimated jointly rather than assumed. */
  function negLogLik(m, rv, rets) {
    var s2 = varianceSeries(m, rv, rets), df = m.df, n = rets.length;
    var k = lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(Math.PI * (df - 2));
    var ll = 0;
    for (var i = 0; i < n; i++) {
      var v = s2[i];
      if (!(v > 0)) return 1e12;
      ll += k - 0.5 * Math.log(v) - (df + 1) / 2 * Math.log(1 + rets[i] * rets[i] / ((df - 2) * v));
    }
    return isFinite(ll) ? -ll : 1e12;
  }

  function fit(kind, rv, rets, opts) {
    opts = opts || {};
    var unpack = kind === 'gjr' ? unpackGjr : unpackGarch;
    var x0 = kind === 'gjr'
      ? [Math.log(Math.max(1e-6, mean(rv) * 0.05)), 2.2, -1.2, -1.2, 0.5]
      : [Math.log(Math.max(1e-6, mean(rv) * 0.05)), 2.2, -1.6, 0.5];
    function obj(p) {
      var m = unpack(p);
      if (!(m.omega > 0) || !isFinite(m.omega)) return 1e12;
      return negLogLik(m, rv, rets);
    }
    var best = multiStart(obj, x0, kind === 'gjr' ? 4 : 3,
                          { maxIter: opts.maxIter || 1000, tol: 1e-8 });
    var m = unpack(best.x);
    m.kind = kind;
    m.effectivePersistence = kind === 'gjr' ? m.alpha + m.gamma / 2 + m.beta : m.alpha + m.beta;
    m.stationary = m.effectivePersistence < 1;
    m.igarch = false;
    m.nll = best.f;
    m.params = kind === 'gjr' ? 5 : 4;
    m.aic = 2 * m.params + 2 * best.f;
    m.sigma2 = varianceSeries(m, rv, rets);
    m.converged = isFinite(best.f) && best.f < 1e11;
    return m;
  }

  /* EWMA is the floor, not a candidate to be proud of. When there is too little
     history to fit anything, or when the optimiser fails, the model degrades to
     this and says so - the panel must never show a fitted-looking number that
     no fit produced. */
  function fitEwma(rv, rets, lambda) {
    var lam = lambda || 0.94;
    var s2 = mean(rv), out = new Array(rv.length);
    out[0] = s2;
    for (var i = 1; i < rv.length; i++) {
      s2 = lam * s2 + (1 - lam) * rv[i - 1];
      out[i] = s2;
    }
    /* Persistence is exactly 1 by construction - EWMA is IGARCH, so it has no
       unconditional variance to revert to and its forward path is flat. That is
       a property, not a failed fit, but anything reading `persistence` to test
       stationarity has to know the difference, so it is flagged. */
    return {
      kind: 'ewma', omega: 0, alpha: 1 - lam, beta: lam, gamma: 0,
      persistence: 1, igarch: true, stationary: false,
      df: 6, sigma2: out, converged: true,
      nll: negLogLik({ omega: 0, alpha: 1 - lam, beta: lam, gamma: 0, df: 6, persistence: 0.9995 }, rv, rets),
      params: 1, aic: null,
    };
  }

  /* QLIKE (Patton 2011). Chosen over in-sample likelihood because it compares
     models on how well the variance they predict matches the variance that was
     realised, which is the job, and because it is robust to the realised
     variance being a noisy proxy for the true one. Lower is better. */
  function qlike(rv, s2) {
    var n = Math.min(rv.length, s2.length), tot = 0, used = 0;
    for (var i = 1; i < n; i++) {
      if (!(s2[i] > 0) || !(rv[i] > 0)) continue;
      var r = rv[i] / s2[i];
      tot += r - Math.log(r) - 1;
      used++;
    }
    return used ? tot / used : Infinity;
  }

  /* ============================================== the calibrated multiplier

     The band's half-width is z * sigma. Taking z from a normal table assumes
     the standardised residuals are normal, which for an equity index they are
     not - that is the whole reason df is fitted. So z is read off the model's
     own residuals instead.

     The empirical quantile is the honest answer wherever enough observations
     sit beyond it. In the far tail they do not: at 97.5% on 300 bars only
     about seven points are out there, and a quantile estimated from seven
     points is noise. So the weight on the empirical number is how many
     observations actually support it, and the fitted t takes over as that
     count falls. */
  function calibrateZ(rets, s2, df, coverage) {
    var z = [], i;
    for (i = 0; i < rets.length && i < s2.length; i++) {
      if (s2[i] > 0) z.push(rets[i] / Math.sqrt(s2[i]));
    }
    if (z.length < 30) return { z: tquantile((1 + coverage) / 2, df), basis: 'student-t', n: z.length };

    /* Rescale so the standardised residuals have unit second moment. Without
        this the model's level error is silently folded into the multiplier.

        Root mean square, not the sample standard deviation: a standardised
        residual is supposed to have zero mean as well as unit variance, and
        subtracting the sample mean throws away exactly the level error this is
        meant to catch. Measured on a pure-drift series - every bar up by the
        same tick, no noise - the variance-about-the-mean form collapsed to
        near zero and returned z68 = 381.57. The RMS form returns 1.00, which
        is the right answer for residuals that are all equal to one. */
    var ss = 0;
    for (i = 0; i < z.length; i++) ss += z[i] * z[i];
    var sd = Math.sqrt(ss / z.length);
    if (!(sd > 0) || !isFinite(sd)) return { z: tquantile((1 + coverage) / 2, df), basis: 'student-t', n: z.length };

    var abs = z.map(function (v) { return Math.abs(v / sd); }).sort(function (a, b) { return a - b; });
    var q = coverage;                                  // two-sided: |z| quantile
    var idx = q * (abs.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    var zEmp = abs[lo] + (abs[hi] - abs[lo]) * (idx - lo);
    var zT = tquantile((1 + coverage) / 2, df);

    var tailCount = abs.length * (1 - q);
    var wEmp = Math.max(0, Math.min(1, tailCount / 20));
    var blended = zEmp * wEmp + zT * (1 - wEmp);

    /* Last guard. Every path above can in principle produce a multiplier that
       is not a multiplier - a degenerate residual series, a df search that ran
       to the edge. A band 20 times too wide is not more honest than a band
       that admits the calibration failed, so it is clamped and the clamp is
       reported rather than hidden. */
    var clamped = Math.max(0.3, Math.min(6, blended));
    return {
      z: clamped,
      zEmpirical: zEmp, zStudentT: zT, weightEmpirical: Math.round(wEmp * 100) / 100,
      basis: clamped !== blended ? 'clamped' : (wEmp > 0.6 ? 'empirical' : wEmp > 0.1 ? 'blended' : 'student-t'),
      wasClamped: clamped !== blended, n: abs.length, residualRms: sd,
    };
  }

  /* ===================================================== forward variance

     Multi-step, by iterating the recursion with RV replaced by its expectation
     (which is sigma^2, so the recursion collapses to the persistence form).
     For GJR half the innovations are negative on average, so the effective
     persistence carries gamma/2. */
  function forecastPath(m, h, rvLast, retLast) {
    var out = new Array(h);
    var persist = m.kind === 'gjr' ? m.alpha + m.gamma / 2 + m.beta : m.alpha + m.beta;
    var lev = m.gamma && retLast < 0 ? m.gamma : 0;
    var s2 = m.sigma2[m.sigma2.length - 1];
    // First step still knows the sign of the last actual return, so it uses the
    // real leverage term rather than the average one. After that the sign is
    // unknown and only the expectation is available.
    var next = m.omega + (m.alpha + lev) * rvLast + m.beta * s2;
    for (var i = 0; i < h; i++) {
      out[i] = next > 0 && isFinite(next) ? next : s2;
      next = m.omega + persist * out[i];
    }
    return out;
  }

  /* ============================================ adaptive conformal inference

     Gibbs & Candes 2021. One line, and it is the only part of this file that
     keeps working when the model is wrong:

        alpha_t = alpha_{t-1} + gamma * (alpha - miss)

     Every time the band missed, alpha rises and the band widens; every time it
     held, alpha falls and the band tightens. Over any stretch the realised
     coverage is driven toward the target whatever the underlying model does,
     which is the guarantee a fitted sigma cannot give during a regime change.

     It needs settled outcomes to learn from, so it stays inert until the
     ledger has rows, and says so rather than pretending to be active. */
  function aci(target, misses, step) {
    var alpha = 1 - target, g = step || 0.02;
    var a = alpha, applied = 0;
    (misses || []).forEach(function (missed) {
      a = Math.max(0.005, Math.min(0.5, a + g * (alpha - (missed ? 1 : 0))));
      applied++;
    });
    return {
      alphaNominal: alpha, alphaAdapted: a,
      coverageAdapted: 1 - a,
      active: applied > 0, n: applied, step: g,
      widthRatio: applied ? null : 1,
    };
  }

  /* ================================================ Kupiec proportion-of-
     failures test.

     The reason this is here rather than a tolerance band on the hit rate: a
     coverage of 67.9% against a target of 68% is meaningless on 53 points and
     decisive on 2,000. The old panel painted green whenever the gap was under
     8 points, which on 53 replays is true of almost any result the model could
     produce. This returns the answer to the question actually being asked -
     is the gap distinguishable from chance - and refuses to answer when the
     sample cannot support one. */
  function kupiec(hits, n, target) {
    if (!n || n < 10) {
      return { n: n || 0, hitRate: n ? Math.round(hits / n * 1000) / 10 : null,
               expected: Math.round(target * 1000) / 10, pValue: null,
               verdict: 'insufficient-data',
               message: 'Only ' + (n || 0) + ' scored points. At least 10 are needed before a coverage number means anything.' };
    }
    var x = n - hits;                                  // failures
    var p = 1 - target;                                // expected failure rate
    var pHat = x / n;
    var lr;
    if (x === 0) {
      lr = -2 * n * Math.log(1 - p);
    } else if (x === n) {
      lr = -2 * n * Math.log(p);
    } else {
      lr = -2 * ((n - x) * Math.log(1 - p) + x * Math.log(p)) +
            2 * ((n - x) * Math.log(1 - pHat) + x * Math.log(pHat));
    }
    if (!isFinite(lr) || lr < 0) lr = 0;
    // chi-squared with 1 df: survival is 2*(1 - Phi(sqrt(LR)))
    var pValue = 2 * (1 - ncdf(Math.sqrt(lr)));
    pValue = Math.max(0, Math.min(1, pValue));

    var rate = hits / n;
    var verdict = pValue >= 0.05 ? 'well-calibrated' : (rate < target ? 'too-narrow' : 'too-wide');
    var msg;
    if (verdict === 'well-calibrated') {
      msg = 'Coverage ' + (Math.round(rate * 1000) / 10) + '% against a nominal ' +
            (Math.round(target * 1000) / 10) + '% over ' + n + ' points is consistent with a calibrated band (Kupiec p=' +
            pValue.toFixed(3) + '). That is not proof it is right, only that this sample cannot show it is wrong.';
    } else if (verdict === 'too-narrow') {
      msg = 'Price finished outside the band more often than it should: ' +
            (Math.round(rate * 1000) / 10) + '% inside against a nominal ' + (Math.round(target * 1000) / 10) +
            '% over ' + n + ' points (Kupiec p=' + pValue.toFixed(3) + '). Real risk is larger than the band shows.';
    } else {
      msg = 'The band is wider than it needs to be: ' + (Math.round(rate * 1000) / 10) +
            '% inside against a nominal ' + (Math.round(target * 1000) / 10) + '% over ' + n +
            ' points (Kupiec p=' + pValue.toFixed(3) + '). Decisions taken off it will be too cautious.';
    }
    return {
      n: n, hits: hits, hitRate: Math.round(rate * 1000) / 10,
      expected: Math.round(target * 1000) / 10,
      lr: Math.round(lr * 1000) / 1000, pValue: Math.round(pValue * 10000) / 10000,
      verdict: verdict, message: msg,
    };
  }

  /* ============================================================ CRPS
     Continuous ranked probability score for a Gaussian-shaped forecast, from
     properscoring (Apache-2.0). One number for "how good was that forecast",
     which a direction hit rate cannot give: it rewards a sharp band that was
     right and punishes a wide one that was merely not wrong. Lower is better,
     and it is in the same units as price. */
  function crpsGaussian(actual, mu, sigma) {
    if (!(sigma > 0)) return null;
    var z = (actual - mu) / sigma;
    var pdf = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    return sigma * (z * (2 * ncdf(z) - 1) + 2 * pdf - 1 / Math.sqrt(Math.PI));
  }

  /* ====================================================== the front door */

  /* Fit whatever the data will support and say which one it was. Returns null
     only when there is not enough to compute anything at all - every other
     path returns a usable model with an honest `kind`. */
  function model(candles, opts) {
    opts = opts || {};
    var minBars = opts.minBars || 80;
    var s = series(candles, opts.estimator || 'parkinson');
    if (s.rets.length < 20) return null;
    // Divide the time-of-day cycle out before fitting, so the fit describes
    // clustering and volProfile() keeps describing the clock. See deseason().
    var raw = s;
    s = deseason(s, opts.profile);

    if (s.rets.length < minBars) {
      var e = fitEwma(s.rv, s.rets, opts.lambda);
      e.qlike = qlike(s.rv, e.sigma2);
      e.rv = s.rv; e.rets = s.rets; e.times = s.times; e.used = s.used;
      e.deseasonalised = !!s.deseasonalised;
      e.rawRv = raw.rv; e.rawRets = raw.rets;
      e.reason = 'only ' + s.rets.length + ' usable bars; a GARCH fit needs at least ' + minBars;
      e.z68 = calibrateZ(s.rets, e.sigma2, e.df, 0.68);
      e.z95 = calibrateZ(s.rets, e.sigma2, e.df, 0.95);
      return e;
    }

    var cands = [fitEwma(s.rv, s.rets, opts.lambda)];
    try { cands.push(fit('garch', s.rv, s.rets, opts)); } catch (err) {}
    try { cands.push(fit('gjr', s.rv, s.rets, opts)); } catch (err) {}

    cands.forEach(function (m) { m.qlike = qlike(s.rv, m.sigma2); });
    var usable = cands.filter(function (m) { return m.converged && isFinite(m.qlike); });
    if (!usable.length) usable = [cands[0]];
    usable.sort(function (a, b) { return a.qlike - b.qlike; });

    var best = usable[0];
    best.rv = s.rv; best.rets = s.rets; best.times = s.times; best.used = s.used;
    best.deseasonalised = !!s.deseasonalised;
    best.rawRv = raw.rv; best.rawRets = raw.rets;
    best.candidates = cands.map(function (m) {
      return { kind: m.kind, qlike: Math.round(m.qlike * 10000) / 10000,
               aic: m.aic == null ? null : Math.round(m.aic * 10) / 10, converged: m.converged };
    });
    best.z68 = calibrateZ(s.rets, best.sigma2, best.df, 0.68);
    best.z95 = calibrateZ(s.rets, best.sigma2, best.df, 0.95);
    best.reason = best.kind === 'ewma'
      ? 'no GARCH variant beat EWMA on QLIKE'
      : 'selected on QLIKE over ' + cands.length + ' candidates';
    return best;
  }

  /* Pre-flight on a candle series, so a feed that quietly changed shape is
     caught where it happens rather than three layers up as a NaN in the band.
     Errors are conditions model() cannot work around; warnings degrade the fit
     without blocking it. */
  function checkData(candles) {
    var errors = [], warnings = [];
    if (!candles || !candles.length) { errors.push('no candles'); return { ok: false, errors: errors, warnings: warnings }; }
    if (candles.length < 20) errors.push('only ' + candles.length + ' candles; 20 is the floor for any variance estimate');
    var noHL = 0, flat = 0, badOrder = 0, gaps = 0, nonFinite = 0;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      if (!isFinite(c.close) || !isFinite(c.high) || !isFinite(c.low)) { nonFinite++; continue; }
      if (!(c.high > 0) || !(c.low > 0)) noHL++;
      else if (c.high === c.low) flat++;
      if (c.high < c.low || (c.open && (c.open > c.high || c.open < c.low))) badOrder++;
      if (i > 0 && c.time <= candles[i - 1].time) gaps++;
    }
    if (nonFinite) errors.push(nonFinite + ' candles carry a non-finite price');
    if (badOrder) errors.push(badOrder + ' candles have high/low/open out of order');
    if (gaps) warnings.push(gaps + ' candles are not strictly increasing in time');
    if (noHL) warnings.push(noHL + ' candles have no usable high or low; those bars fall back to close-to-close');
    if (flat > candles.length * 0.1) {
      warnings.push(Math.round(flat / candles.length * 100) + '% of candles have high equal to low, so the range estimator is degrading to close-to-close on most bars');
    }
    return { ok: !errors.length, errors: errors, warnings: warnings, n: candles.length };
  }

  KT.vol = {
    model: model, checkData: checkData, forecastPath: forecastPath,
    aci: aci, kupiec: kupiec, crpsGaussian: crpsGaussian, qlike: qlike,
    calibrateZ: calibrateZ, series: series, deseason: deseason,
    parkinson: parkinson, garmanKlass: garmanKlass, rogersSatchell: rogersSatchell,
    yangZhang: yangZhang,
    fit: fit, fitEwma: fitEwma, varianceSeries: varianceSeries, negLogLik: negLogLik,
    nelderMead: nelderMead, tquantile: tquantile, tcdf: tcdf, lgamma: lgamma, ncdf: ncdf,
  };
})(window.KT);
