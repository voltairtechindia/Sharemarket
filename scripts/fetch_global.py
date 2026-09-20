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
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            if price is None:
                # Fall back to the last non-null close in the series.
                closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
                if not closes:
                    last_err = "no price"
                    continue
                price = closes[-1]
                prev = closes[-2] if len(closes) > 1 else price
            if prev in (None, 0):
                prev = price
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
