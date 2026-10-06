"""Overnight and cross-asset cues, written to data/global.json.

Indian equities do not open in a vacuum. By 09:15 IST the S&P futures, crude,
the dollar, the rupee and the US 10 year have already told you most of what the
gap is going to be, and the forecast's global lane reads this file rather than
guessing from international headlines.

Every source here is free and needs no key. Yahoo is the primary; Stooq is the
fallback for the ones it carries, because Yahoo rate limits runners in bursts
and a lane that dies silently is worse than one that degrades.

The output is deliberately small - a label, a price and a percentage change per
instrument. Nothing else is stored, which is the brief: no unwanted noise.
"""
import sys
from datetime import datetime, timezone
from urllib.parse import quote

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import UA, Lanes, now_iso, write_json  # noqa: E402

# key -> (label, yahoo symbol, stooq symbol or None)
INSTRUMENTS = [
    ("us_futures", "S&P 500 futures", "ES=F", "^spx"),
    ("nasdaq_fut", "Nasdaq futures", "NQ=F", None),
    ("dow_fut", "Dow futures", "YM=F", None),
    # ("sgx_nifty", "GIFT Nifty", "^NSEI", None) was here until 20 Sep 2026.
    # ^NSEI is NIFTY spot, not GIFT Nifty, so this row fed the index back
    # into its own global lane and into the opening-gap model. There is no
    # keyless GIFT Nifty quote, so the row is gone rather than relabelled.
    ("crude", "Brent crude", "BZ=F", "cb.f"),
    ("gold", "Gold", "GC=F", "xauusd"),
    ("usdinr", "USD/INR", "INR=X", "usdinr"),
    ("dxy", "Dollar index", "DX-Y.NYB", None),
    ("us10y", "US 10y yield", "^TNX", None),
    ("vix", "India VIX", "^INDIAVIX", None),
    ("cboe_vix", "CBOE VIX", "^VIX", None),
    ("nikkei", "Nikkei 225", "^N225", None),
    ("hangseng", "Hang Seng", "^HSI", None),
    ("ftse", "FTSE 100", "^FTSE", None),
]

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d"
STOOQ = "https://stooq.com/q/l/?s={sym}&f=sd2t2ohlcv&h&e=csv"


def _routes(url):
    heads = {"User-Agent": UA, "Accept": "application/json,text/plain,*/*"}
    return [
        (url, heads),
        ("https://r.jina.ai/" + url, dict(heads, **{"x-return-format": "text"})),
        ("https://api.allorigins.win/raw?url=" + quote(url, safe=""), heads),
    ]


def prev_session_close(res, meta):
    """The close of the session before the latest one, from the daily bars.

    This file used to take meta.chartPreviousClose, which is the close before
    the *requested range* starts - with range=5d, five sessions back. Every
    changePct in global.json was therefore a five-session move: measured
    6 Oct 2026, Nikkei +5.89% here against +1.05% live on TradingView, and the
    opening call it fed read +1.37% where the live cues gave +0.47%.
    fetch_market.py found and fixed the same bug in quote.json on 18 Sep 2026
    (prev_close() there); this is the same rule for the overnight cues.

    Bars are folded to one per exchange-local date (Yahoo sometimes repeats
    the live day), and if the series lags the quote by more than a day and a
    half - the current session has no bar yet - the last bar IS the previous
    session.
    """
    ts = res.get("timestamp") or []
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    off = int(meta.get("gmtoffset") or 0)
    days = {}
    for t, c in zip(ts, closes):
        if c is not None and t is not None:
            days[(int(t) + off) // 86400] = (int(t), float(c))
    if not days:
        return None
    order = sorted(days)
    last_t, last_c = days[order[-1]]
    rmt = meta.get("regularMarketTime")
    if rmt and int(rmt) - last_t > 1.5 * 86400:
        return last_c
    if len(order) < 2:
        return None
    return days[order[-2]][1]


def yahoo_quote(symbol):
    url = CHART.format(sym=quote(symbol, safe=""))
    last_err = "no route"
    for target, headers in _routes(url):
        try:
            r = requests.get(target, headers=headers, timeout=20)
            if r.status_code != 200 or not r.text.lstrip().startswith("{"):
                last_err = f"HTTP {r.status_code}"
                continue
            res = r.json()["chart"]["result"][0]
            meta = res.get("meta") or {}
            price = meta.get("regularMarketPrice")
            prev = prev_session_close(res, meta)
            if price is None:
                # Fall back to the last non-null close in the series.
                closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
                if not closes:
                    last_err = "no price"
                    continue
                price = closes[-1]
                prev = closes[-2] if len(closes) > 1 else price
            if prev in (None, 0):
                # No earlier session in the window: a 0% change is a claim, so
                # the row is dropped rather than reported flat.
                last_err = "no previous session"
                continue
            return {
                "price": round(float(price), 4),
                "prevClose": round(float(prev), 4),
                "changePct": round((float(price) - float(prev)) / float(prev) * 100, 4),
                "currency": meta.get("currency"),
                "via": "yahoo",
            }
        except Exception as exc:  # noqa: BLE001
            last_err = type(exc).__name__
    raise RuntimeError(last_err)


def stooq_quote(symbol):
    r = requests.get(STOOQ.format(sym=symbol), headers={"User-Agent": UA}, timeout=15)
    lines = [ln for ln in r.text.strip().splitlines() if ln]
    if len(lines) < 2:
        raise RuntimeError("empty csv")
    cols = lines[0].lower().split(",")
    vals = lines[1].split(",")
    row = dict(zip(cols, vals))
    close = float(row["close"])
    open_ = float(row["open"]) or close
    return {
        "price": round(close, 4),
        "prevClose": round(open_, 4),
        "changePct": round((close - open_) / open_ * 100, 4),
        "currency": None,
        "via": "stooq",
        # Stooq's quote line carries today's bar only, so this is the move
        # since the open, not since the previous close. Labelled rather than
        # passed off as the same quantity.
        "basis": "open",
    }


def main():
    lanes = Lanes()
    items = {}
    for key, label, yahoo, stooq in INSTRUMENTS:
        row = None
        try:
            row = yahoo_quote(yahoo)
            lanes.record(label, True, 1)
        except Exception as exc:  # noqa: BLE001
            if stooq:
                try:
                    row = stooq_quote(stooq)
                    lanes.record(label + " (stooq)", True, 1)
                except Exception as exc2:  # noqa: BLE001
                    lanes.record(label, False, 0, f"{exc!r} / {exc2!r}")
            else:
                lanes.record(label, False, 0, repr(exc))
        if row:
            row["label"] = label
            items[key] = row

    alive = sum(1 for i in lanes.as_list() if i["ok"])
    write_json(
        "global.json",
        {
            "generated_at": now_iso(),
            "count": len(items),
            "sources_alive": alive,
            "sources_total": len(INSTRUMENTS),
            "items": items,
            "lanes": lanes.as_list(),
            "note": "Free sources only. changePct is against the previous close, "
                    "so before the Indian open it is the overnight move.",
        },
    )
    print(f"global cues: {len(items)}/{len(INSTRUMENTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
