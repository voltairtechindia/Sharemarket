"""Score past forecasts against what the market actually did, then move the weights.

This is the part the original build faked. Nothing is marked correct unless a real
close is fetched and compared to the spot recorded when the forecast was made.

Run before the next open, or right before predict.py:  python scripts/validate.py
"""
import json
from datetime import datetime, timezone

import requests

from common import DATA, get, now_iso, write_json
from predict import DEFAULT_WEIGHTS, FLAT_BAND, PRED_FILE, load_store

LEARN_UP, LEARN_DOWN = 1.05, 0.95
W_MIN, W_MAX = 0.30, 3.00
YF = "https://query1.finance.yahoo.com/v8/finance/chart/"


def daily_closes(session, symbol, days=10):
    """Returns [(date, close)] oldest first, from Yahoo daily candles."""
    r = get(YF + symbol, session=session, retries=1,
            params={"range": f"{days}d", "interval": "1d"})
    res = r.json()["chart"]["result"][0]
    stamps = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0]["close"]
    out = []
    for t, c in zip(stamps, closes):
        if c is None:
            continue
        out.append((datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat(), round(c, 2)))
    return out


def next_close_after(series, made_date):
    """The first close strictly after the day the forecast was made."""
    for date, close in series:
        if date > made_date:
            return date, close
    return None, None


def actual_direction(before, after):
    pct = (after - before) / before * 100
    if pct > FLAT_BAND:
        return "up", round(pct, 2)
    if pct < -FLAT_BAND:
        return "down", round(pct, 2)
    return "flat", round(pct, 2)


def main():
    if not PRED_FILE.exists():
        raise SystemExit("no predictions.json yet, run predict.py first")

    store = load_store()
    pending = [p for p in store["predictions"] if not p.get("validated")]
    if not pending:
        print("nothing pending validation")
        return

    session = requests.Session()
    try:
        nifty_series = daily_closes(session, "^NSEI")
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"could not fetch Nifty closes, leaving everything pending: {exc!r}")

    weights = {**DEFAULT_WEIGHTS, **store.get("weights", {})}
    settled = 0

    for p in pending:
        made_date = p["made_at"][:10]
        date, close = next_close_after(nifty_series, made_date)
        if close is None:
            print(f"{p['id']}: next session has not closed yet, still pending")
            continue

        before = p["nifty"]["spot_at_prediction"]
        actual, pct = actual_direction(before, close)
        called = p["nifty"]["direction"]
        correct = called == actual

        p["validated"] = True
        p["outcome"] = {
            "validated_at": now_iso(),
            "close_date": date,
            "close": close,
            "move_pct": pct,
            "actual_direction": actual,
            "called": called,
            "correct": correct,
            "in_range": bool(p["nifty"]["range_low"] <= close <= p["nifty"]["range_high"]),
        }

        # Reward signals that pointed the right way, penalise the ones that did not.
        # Signals that did not fire, or that said flat, are left alone.
        for s in p["signals"]:
            if not s.get("fired") or s["bias"] == "flat" or actual == "flat":
                continue
            factor = LEARN_UP if s["bias"] == actual else LEARN_DOWN
            w = weights.get(s["name"], 1.0) * factor
            weights[s["name"]] = round(max(W_MIN, min(W_MAX, w)), 3)

        settled += 1
        mark = "hit " if correct else "miss"
        print(f"{p['id']}: called {called}, actual {actual} ({pct:+.2f}% to {close}) -> {mark}")

    done = [p for p in store["predictions"] if p.get("validated")]
    hits = sum(1 for p in done if p["outcome"]["correct"])
    in_range = sum(1 for p in done if p["outcome"]["in_range"])

    note = ""
    if len(done) < 30:
        note = (f"Only {len(done)} settled forecasts. Nothing here is a track record yet, "
                f"coin flips run hot over small samples. Treat the number as noise until "
                f"there are at least 30.")

    store["weights"] = weights
    store["accuracy"] = {
        "validated": len(done),
        "correct": hits,
        "percent": round(hits / len(done) * 100, 1) if done else None,
        "range_hits": in_range,
        "range_percent": round(in_range / len(done) * 100, 1) if done else None,
        "sample_warning": note,
    }
    store["generated_at"] = now_iso()
    write_json("predictions.json", store)

    print(f"\nsettled {settled} this run. Overall {hits}/{len(done)} direction calls.")
    if note:
        print(note)
    print("weights now: " + ", ".join(f"{k}={v}" for k, v in sorted(weights.items())))


if __name__ == "__main__":
    main()
