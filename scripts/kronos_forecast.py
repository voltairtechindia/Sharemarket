"""Price paths from Kronos, a model trained on candles, for NIFTY and SENSEX.

Kronos (github.com/shiyu-coder/Kronos, MIT licence) is a foundation model for
candlestick series, trained on twelve billion bars from forty-five exchanges.
It reads a window of real OHLC bars and writes the bars that come next, one
at a time, sampling each from what it learned. Asked many times it gives many
paths, and the spread of those paths is its own statement of uncertainty.

Why it is here. Every lane in forecast.js is either arithmetic over the chart
or a reading of text. This is a third kind of evidence: a learned model of
how price series move, that has never seen a headline. It enters the forecast
as one more lane (the price model), bounded and renormalised like the rest,
and it is scored in the ledger like the rest.

What it writes, data/kronos.json:
  series["NIFTY:5m"]   the next session, 75 five-minute bars, from the last close
  series["NIFTY:1d"]   the next ten sessions
  series["SENSEX:1d"]  the same for SENSEX
each with, per step, the 10/25/50/75/90th percentile close across the paths.

It runs in .github/workflows/kronos.yml twice a weekday, before the open and
after the close, because a CPU run takes minutes and the model has nothing new
to say between those times. It never raises: any failure is written into the
file as ok: false with the reason, and the last good run is kept, so the lane
goes dark with a note instead of the workflow going red.

Local check without the model (no torch needed):
  python scripts/kronos_forecast.py --stub --local
"""
import argparse
import math
import sys
import time
import traceback
from datetime import datetime, timedelta

from common import IST, get, now_iso, write_json, carry_forward, previous, DATA

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={iv}&range={rg}"

SERIES = [
    # The next session on five-minute bars: what the session view projects.
    {"key": "NIFTY:5m", "symbol": "NIFTY", "yahoo": "%5ENSEI", "interval": "5m", "range": "1mo",
     "pred_len": 75, "lookback": 400, "local": "candles_NIFTY_1D.json"},
    # The next ten sessions on daily bars: what the monthly and yearly views project.
    {"key": "NIFTY:1d", "symbol": "NIFTY", "yahoo": "%5ENSEI", "interval": "1d", "range": "2y",
     "pred_len": 10, "lookback": 400, "local": "candles_NIFTY_1Y.json"},
    {"key": "SENSEX:1d", "symbol": "SENSEX", "yahoo": "%5EBSESN", "interval": "1d", "range": "2y",
     "pred_len": 10, "lookback": 400, "local": "candles_SENSEX_1Y.json"},
]

OPEN_MIN, CLOSE_MIN = 9 * 60 + 15, 15 * 60 + 30


# --------------------------------------------------------------- the calendar
def holiday_set():
    ev = previous("events.json")
    return {h.get("date") for h in (ev.get("holidays") or []) if isinstance(h, dict) and h.get("date")}


def trading(d, hol):
    return d.weekday() < 5 and d.isoformat() not in hol


def future_times(last_t, interval, n, hol):
    """The next n bar times after last_t, in IST, walking the exchange
    calendar: weekends and NSE holidays are skipped, the session runs
    09:15-15:30, and a five-minute bar is stamped at its start."""
    out = []
    if interval == "5m":
        t = datetime.fromtimestamp(last_t, IST) + timedelta(minutes=5)
        guard = 0
        while len(out) < n and guard < 5000:
            guard += 1
            mins = t.hour * 60 + t.minute
            if not trading(t.date(), hol) or mins >= CLOSE_MIN:
                d = t.date() + timedelta(days=1)
                while not trading(d, hol):
                    d += timedelta(days=1)
                t = datetime(d.year, d.month, d.day, 9, 15, tzinfo=IST)
                continue
            if mins < OPEN_MIN:
                t = datetime(t.year, t.month, t.day, 9, 15, tzinfo=IST)
                continue
            out.append(t)
            t += timedelta(minutes=5)
    else:
        base = datetime.fromtimestamp(last_t, IST)
        d = base.date()
        while len(out) < n:
            d += timedelta(days=1)
            if trading(d, hol):
                out.append(datetime(d.year, d.month, d.day, base.hour, base.minute, tzinfo=IST))
    return out


# --------------------------------------------------------------------- input
def bars_from_yahoo(s):
    r = get(CHART.format(sym=s["yahoo"], iv=s["interval"], rg=s["range"]), timeout=25)
    res = r.json()["chart"]["result"][0]
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        vals = [q.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close", "volume")]
        if any(v is None for v in vals[:4]):
            continue
        rows.append([int(t)] + [float(v) for v in vals[:4]] + [float(vals[4] or 0)])
    return rows


def bars_from_local(s):
    import json
    with open(DATA / s["local"], "r", encoding="utf-8") as f:
        j = json.load(f)
    return [[int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5] if len(r) > 5 and r[5] else 0)]
            for r in j.get("candles", [])]


def complete_bars(rows, interval):
    """Drop a bar still forming. The model should read finished bars only; a
    half-built five-minute bar would be read as a finished one."""
    if not rows:
        return rows
    now = time.time()
    step = 300 if interval == "5m" else 86400
    if interval == "5m" and rows[-1][0] + step > now:
        return rows[:-1]
    return rows


# --------------------------------------------------------------------- model
class StubPredictor:
    """A random walk with the series' own volatility, shaped like Kronos's
    predict_batch. For checking this script end to end without torch; the
    output is labelled as a stub and the browser refuses it."""
    def __init__(self, seed=7):
        import numpy as np
        self.np = np
        self.rng = np.random.default_rng(seed)

    def predict_batch(self, df_list, x_ts_list, y_ts_list, pred_len, **kw):
        import pandas as pd
        np = self.np
        out = []
        for df, y_ts in zip(df_list, y_ts_list):
            c = df["close"].values
            r = np.diff(np.log(c))
            sd = float(np.std(r[-120:])) if len(r) > 10 else 0.002
            path = c[-1] * np.exp(np.cumsum(self.rng.normal(0, sd, pred_len)))
            out.append(pd.DataFrame({"open": path, "high": path, "low": path, "close": path,
                                     "volume": 0.0, "amount": 0.0}, index=y_ts))
        return out


def load_kronos(kronos_dir, model_id, tokenizer_id):
    sys.path.insert(0, kronos_dir)
    from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402
    tok = KronosTokenizer.from_pretrained(tokenizer_id)
    mdl = Kronos.from_pretrained(model_id)
    return KronosPredictor(mdl, tok, device="cpu", max_context=512)


# ----------------------------------------------------------------- one series
def forecast_series(pred, s, rows, hol, samples):
    import numpy as np
    import pandas as pd

    rows = complete_bars(rows, s["interval"])[-s["lookback"]:]
    if len(rows) < 120:
        raise ValueError("only %d bars, need 120" % len(rows))
    df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "volume"])
    # Kronos reads the clock (minute, hour, weekday, day, month) as features,
    # so the stamps are the exchange's own local time.
    x_ts = pd.Series(pd.to_datetime([datetime.fromtimestamp(t, IST).replace(tzinfo=None) for t in df["t"]]))
    fut = future_times(rows[-1][0], s["interval"], s["pred_len"], hol)
    y_ts = pd.Series(pd.to_datetime([f.replace(tzinfo=None) for f in fut]))
    data = df[["open", "high", "low", "close", "volume"]].copy()
    # Index volume from Yahoo is zero; Kronos fills a missing column with
    # zeros itself, which is the same thing said honestly.
    if (data["volume"] <= 0).all():
        data = data.drop(columns=["volume"])

    t0 = time.time()
    outs = pred.predict_batch([data] * samples, [x_ts] * samples, [y_ts] * samples,
                              pred_len=len(fut), T=1.0, top_p=0.9, sample_count=1, verbose=False)
    secs = round(time.time() - t0, 1)
    closes = np.array([o["close"].values for o in outs], dtype=float)
    if not np.isfinite(closes).all():
        raise ValueError("the model returned non-finite prices")
    q = np.percentile(closes, [10, 25, 50, 75, 90], axis=0)
    last_close = float(rows[-1][4])

    def r2(v):
        return round(float(v), 2)

    steps = []
    for i, f in enumerate(fut):
        steps.append({"t": int(f.timestamp()), "p10": r2(q[0][i]), "p25": r2(q[1][i]), "p50": r2(q[2][i]),
                      "p75": r2(q[3][i]), "p90": r2(q[4][i]), "mean": r2(closes[:, i].mean())})
    end = steps[-1]
    return {
        "symbol": s["symbol"], "interval": s["interval"],
        "base_time": int(rows[-1][0]), "base_close": r2(last_close),
        "bars_read": len(rows), "samples": samples, "seconds": secs,
        "end": {"t": end["t"], "p50": end["p50"], "p10": end["p10"], "p90": end["p90"],
                "change_pct": round((end["p50"] - last_close) / last_close * 100, 3),
                "up_share": round(float((closes[:, -1] > last_close).mean()), 3)},
        "steps": steps,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kronos", default="/tmp/kronos", help="path to a clone of shiyu-coder/Kronos")
    ap.add_argument("--model", default="NeoQuasar/Kronos-small")
    ap.add_argument("--tokenizer", default="NeoQuasar/Kronos-Tokenizer-base")
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--stub", action="store_true", help="random-walk stand-in for the model (no torch)")
    ap.add_argument("--local", action="store_true", help="read candles from data/ instead of Yahoo")
    args = ap.parse_args()

    payload = {"generated_at": now_iso(), "ok": False, "model": "stub" if args.stub else args.model,
               "source": "github.com/shiyu-coder/Kronos (MIT)", "stub": bool(args.stub),
               "series": {}, "errors": []}
    try:
        hol = holiday_set()
        pred = StubPredictor() if args.stub else load_kronos(args.kronos, args.model, args.tokenizer)
        for s in SERIES:
            try:
                rows = bars_from_local(s) if args.local else bars_from_yahoo(s)
                payload["series"][s["key"]] = forecast_series(pred, s, rows, hol, args.samples)
                e = payload["series"][s["key"]]["end"]
                print("  [ok ] %-10s %3d steps, end p50 %s (%+.2f%%), %.0f%% of paths up, %ss" % (
                    s["key"], len(payload["series"][s["key"]]["steps"]), e["p50"], e["change_pct"],
                    e["up_share"] * 100, payload["series"][s["key"]]["seconds"]))
            except Exception as exc:  # noqa: BLE001
                payload["errors"].append({"series": s["key"], "error": repr(exc)[:300]})
                print("  [FAIL] %s %r" % (s["key"], exc))
        payload["ok"] = bool(payload["series"])
        if not payload["ok"]:
            payload["error"] = "no series produced"
    except Exception as exc:  # noqa: BLE001
        payload["error"] = repr(exc)[:300]
        payload["trace"] = traceback.format_exc()[-1200:]
        print("Kronos run failed:", exc)
    write_json("kronos.json", carry_forward("kronos.json", payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
