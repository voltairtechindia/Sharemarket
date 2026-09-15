"""Pull real Nifty / Sensex OHLC from Yahoo and compute the seasonal study.

Writes:
  data/candles_<SYM>_<TF>.json   OHLC per timeframe, compact arrays
  data/quote.json                latest snapshot for both indices
  data/seasonality.json          month-of-year, day-of-week and expiry-week stats
  data/market.json               kept for backward compatibility with the old page

Yahoo is fetched directly (this runs server side, no CORS). If Yahoo rate limits
the runner, the same URL is retried through r.jina.ai and allorigins.
"""
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import DATA, IST, UA, now_iso, write_json  # noqa: E402

SYMBOLS = {
    "NIFTY": {"yahoo": "^NSEI", "label": "NIFTY 50", "exchange": "NSE"},
    "SENSEX": {"yahoo": "^BSESN", "label": "SENSEX", "exchange": "BSE"},
}

# (timeframe id, yahoo interval, yahoo range) - matches the UI's timeframe buttons.
TIMEFRAMES = [
    ("1H", "1m", "5d"),     # hourly view: minute candles, reasons every 10 min
    ("1D", "5m", "1mo"),    # daily view: 5m candles, reasons every 1 hour
    ("1M", "1d", "6mo"),    # monthly view: daily candles, reasons every 1 day
    ("1Y", "1d", "2y"),     # yearly view
    ("ALL", "1mo", "max"),  # till date - Yahoo serves monthly bars at this range anyway
]

SEASONAL_SOURCES = [("1mo", "max"), ("1d", "10y")]

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={iv}&range={rg}"


def _try(url, timeout=25):
    heads = {"User-Agent": UA, "Accept": "application/json,text/plain,*/*"}
    attempts = [
        (url, heads),
        ("https://r.jina.ai/" + url, dict(heads, **{"x-return-format": "text"})),
        ("https://api.allorigins.win/raw?url=" + quote(url, safe=""), heads),
    ]
    last = ""
    for target, h in attempts:
        try:
            r = requests.get(target, headers=h, timeout=timeout)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                return r.json()
            last = f"HTTP {r.status_code}"
        except Exception as exc:  # noqa: BLE001
            last = type(exc).__name__
        time.sleep(1)
    raise RuntimeError(f"all fetch routes failed: {last}")


def fetch_chart(yahoo_symbol, interval, rng):
    url = CHART.format(sym=quote(yahoo_symbol, safe=""), iv=interval, rg=rng)
    data = _try(url)
    res = data["chart"]["result"][0]
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        v = (q.get("volume") or [None] * len(ts))[i] or 0
        rows.append([int(t), round(o, 2), round(h, 2), round(l, 2), round(c, 2), int(v)])
    return res["meta"], rows


def pct(a, b):
    return None if not b else round((a - b) / b * 100.0, 4)


def seasonality(monthly, daily):
    """Real seasonal statistics computed from history, not assumed."""
    # --- month of year, from monthly closes
    by_month = {m: [] for m in range(1, 13)}
    for i in range(1, len(monthly)):
        prev_c, cur = monthly[i - 1][4], monthly[i]
        r = pct(cur[4], prev_c)
        if r is None:
            continue
        month = datetime.fromtimestamp(cur[0], IST).month
        by_month[month].append(r)

    months = []
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    for m in range(1, 13):
        vals = by_month[m]
        if not vals:
            months.append({"m": m, "name": names[m - 1], "n": 0, "avg": 0.0, "median": 0.0,
                           "win": 0.0, "best": 0.0, "worst": 0.0})
            continue
        wins = sum(1 for v in vals if v > 0)
        months.append({
            "m": m, "name": names[m - 1], "n": len(vals),
            "avg": round(statistics.fmean(vals), 2),
            "median": round(statistics.median(vals), 2),
            "win": round(wins / len(vals) * 100, 1),
            "best": round(max(vals), 2), "worst": round(min(vals), 2),
        })

    # --- day of week, from daily closes
    dow = {i: [] for i in range(7)}
    for i in range(1, len(daily)):
        r = pct(daily[i][4], daily[i - 1][4])
        if r is None:
            continue
        dow[datetime.fromtimestamp(daily[i][0], IST).weekday()].append(r)
    dnames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    days = []
    for i in range(5):
        vals = dow[i]
        if not vals:
            continue
        days.append({"d": i, "name": dnames[i], "n": len(vals),
                     "avg": round(statistics.fmean(vals), 3),
                     "win": round(sum(1 for v in vals if v > 0) / len(vals) * 100, 1)})

    # --- expiry week (week containing the last Thursday of the month)
    expiry_week, other_week = [], []
    for i in range(1, len(daily)):
        d = datetime.fromtimestamp(daily[i][0], IST)
        r = pct(daily[i][4], daily[i - 1][4])
        if r is None:
            continue
        # last Thursday: a Thursday with fewer than 7 days left in the month
        import calendar
        last_day = calendar.monthrange(d.year, d.month)[1]
        last_thu = max(day for day in range(1, last_day + 1)
                       if datetime(d.year, d.month, day).weekday() == 3)
        (expiry_week if abs(d.day - last_thu) <= 3 else other_week).append(r)

    # --- realised volatility, for the forecast cone
    rets = [pct(daily[i][4], daily[i - 1][4]) for i in range(1, len(daily))]
    rets = [r for r in rets if r is not None]
    vol_20 = round(statistics.pstdev(rets[-20:]), 3) if len(rets) >= 20 else 0.8
    vol_250 = round(statistics.pstdev(rets[-250:]), 3) if len(rets) >= 250 else vol_20

    now = datetime.now(IST)
    cur = next((m for m in months if m["m"] == now.month), None)
    nxt = next((m for m in months if m["m"] == (now.month % 12) + 1), None)

    return {
        "updated_iso": now_iso(),
        "history_months": len(monthly),
        "history_days": len(daily),
        "months": months,
        "days_of_week": days,
        "expiry_week": {
            "n": len(expiry_week),
            "avg": round(statistics.fmean(expiry_week), 3) if expiry_week else 0.0,
            "other_avg": round(statistics.fmean(other_week), 3) if other_week else 0.0,
        },
        "volatility": {"daily_20d": vol_20, "daily_250d": vol_250},
        "current_month": cur,
        "next_month": nxt,
    }


def main():
    out_quote = {}
    generated = now_iso()

    for key, meta_cfg in SYMBOLS.items():
        ysym = meta_cfg["yahoo"]
        meta_latest = None
        for tf, interval, rng in TIMEFRAMES:
            try:
                meta, rows = fetch_chart(ysym, interval, rng)
                meta_latest = meta_latest or meta
                write_json(
                    f"candles_{key}_{tf}.json",
                    {
                        "symbol": key, "yahoo": ysym, "timeframe": tf,
                        "interval": interval, "range": rng,
                        "generated_at": generated, "count": len(rows),
                        "fields": ["t", "o", "h", "l", "c", "v"],
                        "candles": rows,
                    },
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  [FAIL] {key} {tf}: {exc}")

        if meta_latest:
            out_quote[key] = {
                "symbol": key,
                "label": meta_cfg["label"],
                "exchange": meta_cfg["exchange"],
                "price": meta_latest.get("regularMarketPrice"),
                "prev_close": meta_latest.get("chartPreviousClose"),
                "day_high": meta_latest.get("regularMarketDayHigh"),
                "day_low": meta_latest.get("regularMarketDayLow"),
                "week52_high": meta_latest.get("fiftyTwoWeekHigh"),
                "week52_low": meta_latest.get("fiftyTwoWeekLow"),
                "market_time": meta_latest.get("regularMarketTime"),
                "currency": meta_latest.get("currency", "INR"),
            }
            p, pc = out_quote[key]["price"], out_quote[key]["prev_close"]
            if p and pc:
                out_quote[key]["change"] = round(p - pc, 2)
                out_quote[key]["change_pct"] = pct(p, pc)

    write_json("quote.json", {"generated_at": generated, "quotes": out_quote})

    # ------------------------------------------------------------ seasonality
    try:
        _, monthly = fetch_chart("^NSEI", *SEASONAL_SOURCES[0])
        _, daily = fetch_chart("^NSEI", *SEASONAL_SOURCES[1])
        write_json("seasonality.json", seasonality(monthly, daily))
    except Exception as exc:  # noqa: BLE001
        print(f"  [FAIL] seasonality: {exc}")

    # -------------------------------------- keep the old market.json contract
    try:
        old = json.loads((DATA / "market.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        old = {}
    old.update({
        "generated_at": generated,
        "generated_at_ist": datetime.now(IST).isoformat(timespec="seconds"),
        "headline": [
            {"symbol": k, "label": v["label"], "price": v.get("price"),
             "change": v.get("change"), "change_pct": v.get("change_pct")}
            for k, v in out_quote.items()
        ],
    })
    write_json("market.json", old)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
