"""Price paths from Chronos-Bolt, the second price model, for NIFTY and SENSEX.

Chronos-Bolt (github.com/amazon-science/chronos-forecasting, Apache 2.0) is a
forecasting model pretrained on close to a hundred billion points of time
series from every domain, not only markets. Where Kronos reads candles and
samples paths, Chronos-Bolt reads one series of closes and writes its
quantiles directly, so the two disagree for different reasons. The page
averages them into the one price-model lane (forecast.js kronosLane), and a
model that is down leaves the other one voting alone.

Same series, same horizons, same calendar and the same file shape as
scripts/kronos_forecast.py (whose helpers it uses), written to
data/chronos.json:
  series["NIFTY:5m"]   the next session, 75 five-minute bars, from the last close
  series["NIFTY:1d"]   the next ten sessions
  series["SENSEX:1d"]  the same for SENSEX
with, per step, the 10/25/50/75/90th percentile close.

Runs in .github/workflows/kronos.yml beside Kronos. Never raises: a failure
is written into the file as ok: false and the last good run is kept.

Local check without the model (no torch needed):
  python scripts/chronos_forecast.py --stub --local
"""
import argparse
import sys
import time
import traceback

from common import now_iso, write_json, carry_forward
from kronos_forecast import SERIES, holiday_set, future_times, bars_from_yahoo, bars_from_local, complete_bars

LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9]


class StubPipeline:
    """A random walk shaped like the pipeline's predict_quantiles, for
    checking this script without torch. Labelled a stub; the page refuses it."""
    def __init__(self, seed=11):
        import numpy as np
        self.np = np
        self.rng = np.random.default_rng(seed)

    def predict_quantiles(self, inputs, prediction_length, quantile_levels):
        np = self.np
        c = np.asarray(inputs[0], dtype=float)
        sd = float(np.std(np.diff(np.log(c))[-120:])) or 0.002
        paths = c[-1] * np.exp(np.cumsum(self.rng.normal(0, sd, (200, prediction_length)), axis=1))
        q = np.percentile(paths, [x * 100 for x in quantile_levels], axis=0).T     # (H, Q)
        return q[None, :, :], np.median(paths, axis=0)[None, :]


def load_chronos(model_id):
    import torch
    from chronos import BaseChronosPipeline
    return BaseChronosPipeline.from_pretrained(model_id, device_map="cpu", torch_dtype=torch.float32)


def forecast_series(pipe, s, rows, hol, stub):
    import numpy as np
    rows = complete_bars(rows, s["interval"])[-s["lookback"]:]
    if len(rows) < 120:
        raise ValueError("only %d bars, need 120" % len(rows))
    closes = [float(r[4]) for r in rows]
    fut = future_times(rows[-1][0], s["interval"], s["pred_len"], hol)
    t0 = time.time()
    if stub:
        q, _ = pipe.predict_quantiles([closes], prediction_length=len(fut), quantile_levels=LEVELS)
    else:
        import torch
        q, _ = pipe.predict_quantiles(torch.tensor(closes, dtype=torch.float32), prediction_length=len(fut),
                                      quantile_levels=LEVELS)
        q = q.detach().cpu().numpy()
    secs = round(time.time() - t0, 1)
    q = np.asarray(q, dtype=float)[0]                    # (horizon, levels)
    if q.shape != (len(fut), len(LEVELS)) or not np.isfinite(q).all():
        raise ValueError("the model returned %s, expected %s" % (q.shape, (len(fut), len(LEVELS))))
    q = np.sort(q, axis=1)                               # quantiles never cross
    last_close = closes[-1]

    def r2(v):
        return round(float(v), 2)

    steps = [{"t": int(f.timestamp()), "p10": r2(q[i][0]), "p25": r2(q[i][1]), "p50": r2(q[i][2]),
              "p75": r2(q[i][3]), "p90": r2(q[i][4])} for i, f in enumerate(fut)]
    end = steps[-1]
    return {
        "symbol": s["symbol"], "interval": s["interval"],
        "base_time": int(rows[-1][0]), "base_close": r2(last_close),
        "bars_read": len(rows), "seconds": secs,
        "end": {"t": end["t"], "p50": end["p50"], "p10": end["p10"], "p90": end["p90"],
                "change_pct": round((end["p50"] - last_close) / last_close * 100, 3)},
        "steps": steps,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="amazon/chronos-bolt-small")
    ap.add_argument("--stub", action="store_true", help="random-walk stand-in for the model (no torch)")
    ap.add_argument("--local", action="store_true", help="read candles from data/ instead of Yahoo")
    args = ap.parse_args()

    payload = {"generated_at": now_iso(), "ok": False, "model": "stub" if args.stub else args.model,
               "source": "github.com/amazon-science/chronos-forecasting (Apache 2.0)", "stub": bool(args.stub),
               "series": {}, "errors": []}
    try:
        hol = holiday_set()
        pipe = StubPipeline() if args.stub else load_chronos(args.model)
        for s in SERIES:
            try:
                rows = bars_from_local(s) if args.local else bars_from_yahoo(s)
                payload["series"][s["key"]] = forecast_series(pipe, s, rows, hol, args.stub)
                e = payload["series"][s["key"]]["end"]
                print("  [ok ] %-10s %3d steps, end p50 %s (%+.2f%%), %ss" % (
                    s["key"], len(payload["series"][s["key"]]["steps"]), e["p50"], e["change_pct"],
                    payload["series"][s["key"]]["seconds"]))
            except Exception as exc:  # noqa: BLE001
                payload["errors"].append({"series": s["key"], "error": repr(exc)[:300]})
                print("  [FAIL] %s %r" % (s["key"], exc))
        payload["ok"] = bool(payload["series"])
        if not payload["ok"]:
            payload["error"] = "no series produced"
    except Exception as exc:  # noqa: BLE001
        payload["error"] = repr(exc)[:300]
        payload["trace"] = traceback.format_exc()[-1200:]
        print("Chronos run failed:", exc)
    write_json("chronos.json", carry_forward("chronos.json", payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
