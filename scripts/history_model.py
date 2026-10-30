"""The twenty-year model: tomorrow's odds, learned from the whole daily record.

What it is. A gradient-boosted classifier (LightGBM, the baseline Microsoft's
Qlib ships) on a factor set in the spirit of Qlib's Alpha158: candle shape,
returns and moving-average distances over several windows, volatility, trend
slope and fit, where the close sits in its recent range, up-day counts, India
VIX, and the overnight world from fetch_history.py. It answers one question
per index: will the next session close above this one, and how sure is it.

Why it can be trusted as far as it says and no further. It is trained
walk-forward: the model that scores 2015 was fitted on 2007 to 2014 only, and
refitted every January. So every number in `record` is out of sample, the same
standard the frozen calls are held to, and it is printed next to two simple
baselines (always up; tomorrow repeats today). A model that cannot beat those
says so in the file and the page shrinks its vote.

Two information sets, because what is known depends on the clock:
  evening   after NSE's close: India to today, Asia today (shut before 15:30
            IST), Europe, the US, crude and the rupee as of yesterday
  preopen   before 09:15 IST next morning: the US session that ran overnight,
            Europe, crude and the rupee as of today, and Tokyo and Hong Kong's
            opens next morning
The model trained on each set is the one used at that hour. The preopen set
also gets a gap model: how far from today's close the next session opens.

Writes data/history_model.json. Needs pandas, numpy and lightgbm, installed
only in .github/workflows/history.yml (the main workflows stay stdlib plus
requests). Never raises: a failure is written into the file as ok: false and
the last good model is carried forward.
"""
import json
import math
import sys
import time
import traceback
from datetime import date, datetime, timedelta

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import DATA, carry_forward, now_iso, previous, write_json  # noqa: E402

TARGETS = ["NIFTY", "SENSEX", "BANKNIFTY"]
# Source groups, for the "what helps" table. Every feature name starts with one.
GROUPS = {
    "px": "its own price action", "vix": "India VIX", "us": "US markets", "asia": "Asia",
    "eu": "Europe", "cmd": "crude, gold and copper", "fx": "the rupee, the dollar and US yields",
    "in": "India's sectors and midcaps", "cal": "the calendar",
}
# Series, the group each belongs to, and whether its date-t close is known
# before NSE's close (Asia shuts before 15:30 IST; India's own sector indices
# close with it, so their date-t close is known when the call is made).
GLOBALS = [
    ("SPX", "us", False), ("NASDAQ", "us", False), ("DOW", "us", False), ("ES", "us", False),
    ("NQ", "us", False), ("VIXUS", "us", False), ("SOX", "us", False), ("HYG", "us", False),
    ("EEM", "us", False),
    ("NIKKEI", "asia", True), ("HANGSENG", "asia", True), ("KOSPI", "asia", True), ("TAIWAN", "asia", True),
    ("ASX", "asia", True), ("SHANGHAI", "asia", True), ("STI", "asia", True),
    ("FTSE", "eu", False), ("DAX", "eu", False),
    ("BRENT", "cmd", False), ("WTI", "cmd", False), ("GOLD", "cmd", False), ("COPPER", "cmd", False),
    ("USDINR", "fx", False), ("DXY", "fx", False), ("US10Y", "fx", False),
    ("CNXIT", "in", True), ("CNXAUTO", "in", True), ("CNXPHARMA", "in", True), ("CNXMETAL", "in", True),
    ("CNXFMCG", "in", True), ("MIDCAP", "in", True),
]
MIN_TRAIN_YEARS = 3
PARAMS = dict(objective="binary", learning_rate=0.03, num_leaves=15, min_child_samples=80,
              subsample=0.8, subsample_freq=1, colsample_bytree=0.7, reg_lambda=2.0,
              n_estimators=300, verbose=-1)
GAP_PARAMS = dict(objective="regression_l1", learning_rate=0.03, num_leaves=15, min_child_samples=80,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.7, reg_lambda=2.0,
                  n_estimators=300, verbose=-1)


# ------------------------------------------------------------------- loading
def load_series():
    import pandas as pd
    with open(DATA / "history_daily.json", "r", encoding="utf-8") as f:
        j = json.load(f)
    out = {}
    for k, s in (j.get("series") or {}).items():
        if not s.get("d"):
            continue
        df = pd.DataFrame({"c": s["c"]}, index=pd.to_datetime(s["d"]))
        for fld in ("o", "h", "l"):
            if fld in s:
                df[fld] = s[fld]
        df = df[~df.index.duplicated(keep="last")].sort_index()
        df = df[df["c"] > 0]
        out[k] = df
    return out, j


def holidays():
    ev = previous("events.json")
    return {h.get("date") for h in (ev.get("holidays") or []) if isinstance(h, dict) and h.get("date")}


def next_session(after, hol):
    d = after + timedelta(days=1)
    while d.weekday() >= 5 or d.isoformat() in hol:
        d += timedelta(days=1)
    return d


# ------------------------------------------------------------------ features
def asof(series, when, index):
    """The last value of `series` dated on or before each date in `when`,
    labelled with `index` (the panel's own rows).

    The label is the whole point. Returned under `when` itself, a value looked
    up for "the day before row t" carried the label t-1, pandas aligned it
    onto row t-1 on assignment, and every row ended up holding the US session
    of its own date: tomorrow's gap, known the evening before. Caught on a
    synthetic record with a planted lead-lag (selfcheck below), where the
    evening model scored 62% on a signal it could not have seen."""
    import pandas as pd
    s = series.dropna()
    pos = s.index.searchsorted(when, side="right") - 1
    vals = [s.iloc[i] if i >= 0 else float("nan") for i in pos]
    return pd.Series(vals, index=index)


def own_factors(df):
    """Alpha158-style factors from the index's own OHLC (no volume: Yahoo's
    index volume is empty). Every one is a ratio, so the same tree works at
    NIFTY 8,000 and NIFTY 26,000."""
    import numpy as np
    import pandas as pd
    o, h, l, c = df["o"], df["h"], df["l"], df["c"]
    f = pd.DataFrame(index=df.index)
    f["px_kmid"] = (c - o) / o
    f["px_klen"] = (h - l) / o
    f["px_kup"] = (h - np.maximum(o, c)) / o
    f["px_klow"] = (np.minimum(o, c) - l) / o
    f["px_ksft"] = (2 * c - h - l) / o
    f["px_gap"] = o / c.shift(1) - 1
    r = np.log(c).diff()
    for n in (1, 2, 5, 10, 20, 60):
        f["px_roc%d" % n] = c / c.shift(n) - 1
    for n in (5, 10, 20, 60, 120):
        f["px_ma%d" % n] = c / c.rolling(n).mean() - 1
    for n in (5, 20, 60):
        f["px_std%d" % n] = r.rolling(n).std()
        f["px_max%d" % n] = h.rolling(n).max() / c - 1
        f["px_min%d" % n] = l.rolling(n).min() / c - 1
        lo, hi = l.rolling(n).min(), h.rolling(n).max()
        f["px_rsv%d" % n] = (c - lo) / (hi - lo).replace(0, np.nan)
        f["px_rank%d" % n] = c.rolling(n).apply(lambda x: (x[-1] >= x).mean(), raw=True)
        f["px_cntp%d" % n] = (r > 0).rolling(n).mean()
        up, dn = r.clip(lower=0), (-r).clip(lower=0)
        f["px_sumd%d" % n] = (up.rolling(n).sum() - dn.rolling(n).sum()) / (up.rolling(n).sum() + dn.rolling(n).sum()).replace(0, np.nan)
        f["px_imax%d" % n] = h.rolling(n).apply(lambda x: (len(x) - 1 - x.argmax()) / len(x), raw=True)
        f["px_imin%d" % n] = l.rolling(n).apply(lambda x: (len(x) - 1 - x.argmin()) / len(x), raw=True)
    for n in (10, 20, 60):
        y = np.log(c)
        t = np.arange(n, dtype=float)
        tm, tv = t.mean(), ((t - t.mean()) ** 2).sum()

        def slope(x, tm=tm, tv=tv, t=t):
            return ((t - tm) * (x - x.mean())).sum() / tv

        def rsq(x, tm=tm, tv=tv, t=t):
            b = ((t - tm) * (x - x.mean())).sum() / tv
            fit = x.mean() + b * (t - tm)
            ss = ((x - x.mean()) ** 2).sum()
            return 1 - ((x - fit) ** 2).sum() / ss if ss > 0 else 0.0
        f["px_beta%d" % n] = y.rolling(n).apply(slope, raw=True)
        f["px_rsqr%d" % n] = y.rolling(n).apply(rsq, raw=True)
    # Average true range against price, the unit every pattern rule uses.
    tr = np.maximum(h - l, np.maximum((h - c.shift(1)).abs(), (l - c.shift(1)).abs()))
    f["px_atr14"] = tr.rolling(14).mean() / c
    return f


def build_panel(S, target, info_set, next_date=None):
    """One row per session of `target` (the decision is made at its close for
    the next session). Global inputs are aligned by what was known at that
    hour, never by the date label alone."""
    import numpy as np
    import pandas as pd
    base = S[target]
    if not {"o", "h", "l"}.issubset(base.columns):
        raise ValueError(target + " has no OHLC")
    base = base.dropna(subset=["o", "h", "l", "c"])
    idx = base.index
    f = own_factors(base)
    # The session being predicted: the next row, or for the last row the next
    # trading day from the exchange calendar.
    tail = pd.Timestamp(next_date) if next_date is not None else pd.NaT
    nxt = pd.Series(list(idx[1:]) + [tail], index=idx)

    # Built as one dict and joined once: a column at a time fragments the frame.
    x = {}
    if "INDIAVIX" in S:
        v = asof(S["INDIAVIX"]["c"], idx, idx)
        x["vix_level"] = v
        x["vix_chg1"] = np.log(v).diff()
        x["vix_chg5"] = np.log(v).diff(5)
        x["vix_vs20"] = v / v.rolling(20).mean() - 1

    one_day = pd.Timedelta(days=1)
    for key, grp, closes_before in GLOBALS:
        if key not in S:
            continue
        g = S[key]
        known_today = closes_before or info_set == "preopen"
        when = idx if known_today else idx - one_day
        lvl = asof(g["c"], when, idx)
        lg = np.log(lvl.astype(float))
        name = key.lower()
        if key == "US10Y" or key == "VIXUS":
            x["%s_%s_chg1" % (grp, name)] = lvl.diff()
            x["%s_%s_chg5" % (grp, name)] = lvl.diff(5)
        else:
            x["%s_%s_ret1" % (grp, name)] = lg.diff()
            x["%s_%s_ret5" % (grp, name)] = lg.diff(5)
        # Asia's markets open before NSE does: next morning's open against
        # their last close is known at the pre-open run.
        if info_set == "preopen" and grp == "asia" and "o" in g.columns:
            gopen = g["o"].reindex(nxt.values)
            gopen.index = idx
            last = asof(g["c"], idx, idx)
            x["asia_%s_gapnext" % name] = (np.log(gopen.astype(float)) - np.log(last.astype(float))).fillna(0.0)

    nd = pd.DatetimeIndex(nxt.fillna(idx[-1] + one_day))
    x["cal_dow"] = nd.dayofweek
    x["cal_month"] = nd.month
    x["cal_dom"] = nd.day
    x["cal_gapdays"] = (nd - idx).days
    f = pd.concat([f, pd.DataFrame(x, index=idx)], axis=1)

    c, o = base["c"], base["o"]
    y = pd.DataFrame(index=idx)
    y["ret"] = np.log(c.shift(-1) / c)
    y["up"] = (y["ret"] > 0).astype(float)
    y.loc[y["ret"].isna(), "up"] = np.nan
    y["gap"] = np.log(o.shift(-1) / c)
    f = f.replace([np.inf, -np.inf], np.nan)
    return f, y


# ------------------------------------------------------------------- scoring
def wilson(k, n):
    if not n:
        return None
    p, z = k / n, 1.96
    den = 1 + z * z / n
    centre = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round((centre - half) / den * 100, 1), round((centre + half) / den * 100, 1)]


def auc(y, p):
    import numpy as np
    y, p = np.asarray(y), np.asarray(p)
    pos, neg = y == 1, y == 0
    if pos.sum() == 0 or neg.sum() == 0:
        return None
    ranks = np.argsort(np.argsort(p)) + 1
    return float((ranks[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * neg.sum()))


def walk_forward(X, y, years, params, kind):
    """Refit every January on everything before it; predict that year."""
    import lightgbm as lgb
    import numpy as np
    import pandas as pd
    preds = pd.Series(np.nan, index=X.index)
    col = "up" if kind == "clf" else "gap"
    for yr in years:
        tr = (X.index.year < yr) & y[col].notna()
        te = (X.index.year == yr) & y[col].notna()
        if tr.sum() < 250 * MIN_TRAIN_YEARS or te.sum() == 0:
            continue
        if kind == "clf":
            m = lgb.LGBMClassifier(**params)
            m.fit(X[tr], y.loc[tr, col])
            preds[te] = m.predict_proba(X[te])[:, 1]
        else:
            m = lgb.LGBMRegressor(**params)
            m.fit(X[tr], y.loc[tr, col])
            preds[te] = m.predict(X[te])
    return preds


def record_of(p, y):
    import numpy as np
    ok = p.notna() & y["up"].notna()
    pp, yy, rr = p[ok], y.loc[ok, "up"], y.loc[ok, "ret"]
    if len(pp) < 100:
        return None
    hit = ((pp >= 0.5) == (yy == 1))
    base_rate = float(yy.mean())
    out = {
        "from": pp.index[0].strftime("%Y-%m-%d"), "to": pp.index[-1].strftime("%Y-%m-%d"),
        "n": int(len(pp)), "hit": round(float(hit.mean()) * 100, 1), "ci": wilson(int(hit.sum()), int(len(pp))),
        "auc": round(auc(yy.values, pp.values) or 0.5, 3),
        "brier": round(float(((pp - yy) ** 2).mean()), 4),
        "brierBase": round(float(((base_rate - yy) ** 2).mean()), 4),
        "baselines": {
            "alwaysUp": round(base_rate * 100, 1),
            # Tomorrow repeats today: the simplest momentum rule there is.
            "repeat": round(float(((rr.shift(1) > 0) == (yy == 1))[1:].mean()) * 100, 1),
        },
    }
    conf = (pp - 0.5).abs() >= 0.05
    if conf.sum() >= 30:
        h2 = hit[conf]
        out["confident"] = {"coverage": round(float(conf.mean()) * 100, 1), "n": int(conf.sum()),
                            "hit": round(float(h2.mean()) * 100, 1), "ci": wilson(int(h2.sum()), int(conf.sum()))}
    by = []
    for yr in sorted(set(pp.index.year)):
        m = pp.index.year == yr
        by.append({"year": int(yr), "n": int(m.sum()), "hit": round(float(hit[m].mean()) * 100, 1)})
    out["byYear"] = by
    bins = np.clip(((pp - 0.3) / 0.05).astype(int), 0, 7)
    cal = []
    for b in range(8):
        m = bins == b
        if m.sum() >= 25:
            cal.append([round(float(pp[m].mean()) * 100, 1), round(float(yy[m].mean()) * 100, 1), int(m.sum())])
    out["calibration"] = cal
    return out


def importance(X, y, model, years_back=3):
    """Which inputs carry the out-of-sample signal: the drop in AUC on the last
    few years when one group of inputs is shuffled, summed by source."""
    import numpy as np
    rng = np.random.default_rng(11)
    last_year = X.index.year.max()
    m = (X.index.year > last_year - years_back) & y["up"].notna()
    Xv, yv = X[m], y.loc[m, "up"]
    if len(Xv) < 150:
        return []
    base = auc(yv.values, model.predict_proba(Xv)[:, 1]) or 0.5
    out = []
    for g in GROUPS:
        cols = [c for c in X.columns if c.startswith(g + "_")]
        if not cols:
            continue
        drops = []
        for _ in range(3):
            Xp = Xv.copy()
            perm = rng.permutation(len(Xp))
            Xp[cols] = Xp[cols].values[perm]
            drops.append(base - (auc(yv.values, model.predict_proba(Xp)[:, 1]) or 0.5))
        out.append({"group": g, "label": GROUPS[g], "aucDrop": round(float(np.mean(drops)), 4), "features": len(cols)})
    out.sort(key=lambda r: -r["aucDrop"])
    return out


# ------------------------------------------------------------------- one index
def fit_target(S, target, hol):
    import lightgbm as lgb
    import numpy as np
    t0 = time.time()
    res = {"symbol": target}
    based = S[target].dropna(subset=["c"]).index[-1].date()
    session = next_session(based, hol)
    for info in ("evening", "preopen"):
        X, y = build_panel(S, target, info, next_date=session)
        X = X.iloc[130:]              # the longest window needs this much history
        y = y.loc[X.index]
        years = sorted(set(X.index.year))[MIN_TRAIN_YEARS:]
        p = walk_forward(X, y, years, PARAMS, "clf")
        rec = record_of(p, y)
        trm = y["up"].notna()
        final = lgb.LGBMClassifier(**PARAMS).fit(X[trm], y.loc[trm, "up"])
        last = X.iloc[[-1]]
        part = {"record": rec, "importance": importance(X, y, final),
                "pUp": round(float(final.predict_proba(last)[:, 1][0]), 4)}
        gains = sorted(zip(X.columns, final.booster_.feature_importance("gain")), key=lambda r: -r[1])[:12]
        tot = float(sum(g for _, g in zip(X.columns, final.booster_.feature_importance("gain")))) or 1.0
        part["topFeatures"] = [{"name": n, "share": round(float(g) / tot, 4)} for n, g in gains]
        if info == "preopen":
            gp = walk_forward(X, y, years, GAP_PARAMS, "reg")
            ok = gp.notna() & y["gap"].notna()
            if ok.sum() > 100:
                err = (gp[ok] - y.loc[ok, "gap"]).abs()
                part["gap"] = {"n": int(ok.sum()), "maePct": round(float(err.mean()) * 100, 3),
                               "maeNaivePct": round(float(y.loc[ok, "gap"].abs().mean()) * 100, 3)}
            gm = lgb.LGBMRegressor(**GAP_PARAMS).fit(X[y["gap"].notna()], y.loc[y["gap"].notna(), "gap"])
            part["gapPct"] = round(float(gm.predict(last)[0]) * 100, 3)
        res[info] = part
    res["basedOn"] = X.index[-1].date().isoformat()
    res["session"] = session.isoformat()
    # Which set applies right now: the preopen one once the US session dated
    # on the base day exists in the data, the evening one before that.
    spx = S.get("SPX")
    us_done = spx is not None and len(spx.index) and spx.index[-1].date() >= based
    res["infoSet"] = "preopen" if us_done else "evening"
    use = res[res["infoSet"]]
    res["pUp"] = use["pUp"]
    res["seconds"] = round(time.time() - t0, 1)
    return res


def synthetic(seed=3):
    """A twenty-year record with one planted lead-lag: NIFTY's gap follows
    the US session that runs after its close (beta 0.45) and a little of its
    day follows Tokyo's open. Known only before the next open, never the
    evening before."""
    import numpy as np
    import pandas as pd
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2005-01-03", "2026-10-29")
    n = len(days)
    S = {}
    spx_r = rng.normal(0.0003, 0.012, n)
    spx = 1200 * np.exp(np.cumsum(spx_r))
    S["SPX"] = pd.DataFrame({"c": spx, "o": spx}, index=days)
    for k, sd in (("NASDAQ", .015), ("DOW", .011), ("ES", .012), ("NQ", .015), ("FTSE", .011), ("DAX", .013),
                  ("BRENT", .02), ("WTI", .021), ("GOLD", .01), ("COPPER", .016), ("USDINR", .003), ("DXY", .004),
                  ("US10Y", .02), ("VIXUS", .06)):
        S[k] = pd.DataFrame({"c": 100 * np.exp(np.cumsum(rng.normal(0, sd, n)))}, index=days)
    nik = 10000 * np.exp(np.cumsum(rng.normal(0, 0.011, n)))
    nik_open = np.roll(nik, 1) * np.exp(0.5 * spx_r + rng.normal(0, 0.002, n))
    S["NIKKEI"] = pd.DataFrame({"c": nik, "o": nik_open}, index=days)
    hsi = 14000 * np.exp(np.cumsum(rng.normal(0, 0.013, n)))
    S["HANGSENG"] = pd.DataFrame({"c": hsi, "o": hsi}, index=days)
    st = days.get_loc(pd.Timestamp("2007-09-17"))
    m = n - st
    c, o, h, lo = np.empty(m), np.empty(m), np.empty(m), np.empty(m)
    prev = 5000.0
    for i in range(m):
        j = st + i
        o[i] = prev * math.exp(0.45 * spx_r[j - 1] + rng.normal(0, 0.003))
        c[i] = o[i] * math.exp(0.15 * math.log(nik_open[j] / nik[j - 1]) + rng.normal(0.0002, 0.010))
        h[i] = max(o[i], c[i]) * math.exp(abs(rng.normal(0, 0.004)))
        lo[i] = min(o[i], c[i]) * math.exp(-abs(rng.normal(0, 0.004)))
        prev = c[i]
    S["NIFTY"] = pd.DataFrame({"o": o, "h": h, "l": lo, "c": c}, index=days[st:])
    S["INDIAVIX"] = pd.DataFrame({"c": 15 * np.exp(np.cumsum(rng.normal(0, 0.01, m)))}, index=days[st:])
    return S


def selfcheck():
    """The leak test. On the planted record the evening model must not beat
    always-up by more than noise (the signal is in the US session it cannot
    have seen), and the preopen model must find it. Run by history.yml before
    the real fit; a leak fails the workflow rather than publishing odds that
    looked brilliant for the wrong reason."""
    S = synthetic()
    m = fit_target(S, "NIFTY", set())
    ev, po = m["evening"]["record"], m["preopen"]["record"]
    base = ev["baselines"]["alwaysUp"]
    print("selfcheck: always-up %.1f%%, evening %.1f%%, preopen %.1f%%" % (base, ev["hit"], po["hit"]))
    ok = ev["hit"] <= base + 3.0 and po["hit"] >= base + 5.0
    print("selfcheck:", "ok" if ok else "FAILED: a feature sees the future, or the model cannot see the planted signal")
    return 0 if ok else 1


def main():
    if "--selfcheck" in sys.argv:
        return selfcheck()
    payload = {"generated_at": now_iso(), "ok": False, "source": "scripts/history_model.py",
               "method": "LightGBM on Alpha158-style factors, walk-forward refit every January",
               "models": {}, "errors": []}
    try:
        S, raw = load_series()
        payload["dataThrough"] = {k: v.index[-1].strftime("%Y-%m-%d") for k, v in S.items()}
        hol = holidays()
        for t in TARGETS:
            if t not in S:
                payload["errors"].append({"symbol": t, "error": "no history"})
                continue
            try:
                m = fit_target(S, t, hol)
                payload["models"][t] = m
                r = m[m["infoSet"]]["record"] or {}
                print("  [ok ] %-9s next %s  p(up)=%.3f (%s)  out of sample %s%% of %s, always-up %s%%  %ss" % (
                    t, m["session"], m["pUp"], m["infoSet"], r.get("hit"), r.get("n"),
                    (r.get("baselines") or {}).get("alwaysUp"), m["seconds"]))
            except Exception as exc:  # noqa: BLE001
                payload["errors"].append({"symbol": t, "error": repr(exc)[:300]})
                print("  [FAIL] %s %r" % (t, exc))
        payload["ok"] = bool(payload["models"])
    except Exception as exc:  # noqa: BLE001
        payload["error"] = repr(exc)[:300]
        payload["trace"] = traceback.format_exc()[-1500:]
        print("history model failed:", exc)
    write_json("history_model.json", carry_forward("history_model.json", payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
