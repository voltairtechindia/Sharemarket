"""Twenty years of daily prices, for the study that learns from them.

The browser never reads this file. It is the input to two learners that run in
.github/workflows/history.yml:

  scripts/history_model.py   a factor model (Qlib's Alpha158 idea, trained
                             walk-forward with LightGBM, Qlib's own baseline)
                             that publishes tomorrow's odds, its out-of-sample
                             record year by year, and which inputs carry weight
  scripts/history_study.js   the terminal's own pattern detectors run over the
                             whole daily record, so every candlestick and chart
                             pattern is reported with twenty years of outcomes
                             rather than the few months the page has loaded

What it fetches: NIFTY, SENSEX and BANK NIFTY with full OHLC; India VIX; and
the overnight world the gap is made in: US indices and their futures, Asia,
Europe, Brent and WTI, gold, copper, the rupee, the dollar index, the US 10y
yield and the US VIX. Daily bars, from Yahoo, the same source fetch_market.py
already uses. NIFTY's own daily history on Yahoo starts in September 2007, so
"twenty years" is nineteen for the index itself and longer for the rest.

Each series keeps its own calendar. Dates are the exchange's local date, so a
US session dated 28 Oct is the one that closes at 01:30 IST on 29 Oct, and the
model aligns them by what was known before NSE opened, not by the label.

Writes data/history_daily.json. A series that fails keeps its last good copy
(carry_forward), so one bad night at Yahoo does not shorten the record.
"""
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import UA, now_iso, previous, write_json  # noqa: E402

# key, yahoo symbol, label, fields kept
SERIES = [
    ("NIFTY", "^NSEI", "NIFTY 50", "ohlc"),
    ("SENSEX", "^BSESN", "SENSEX", "ohlc"),
    ("BANKNIFTY", "^NSEBANK", "BANK NIFTY", "ohlc"),
    ("INDIAVIX", "^INDIAVIX", "India VIX", "c"),
    ("SPX", "^GSPC", "S&P 500", "oc"),
    ("NASDAQ", "^IXIC", "Nasdaq Composite", "c"),
    ("DOW", "^DJI", "Dow Jones", "c"),
    ("ES", "ES=F", "S&P 500 futures", "c"),
    ("NQ", "NQ=F", "Nasdaq futures", "c"),
    ("NIKKEI", "^N225", "Nikkei 225", "oc"),
    ("HANGSENG", "^HSI", "Hang Seng", "oc"),
    # The rest of Asia's morning, all open well before 09:15 IST, so their
    # opening move is known at the pre-open run (30 Oct 2026).
    ("KOSPI", "^KS11", "KOSPI", "oc"),
    ("TAIWAN", "^TWII", "Taiwan Weighted", "oc"),
    ("ASX", "^AXJO", "ASX 200", "oc"),
    ("SHANGHAI", "000001.SS", "Shanghai Composite", "oc"),
    ("STI", "^STI", "Straits Times", "oc"),
    # India's own breadth: the sectors and the midcaps, which turn before the
    # index does more often than after it.
    ("CNXIT", "^CNXIT", "NIFTY IT", "c"),
    ("CNXAUTO", "^CNXAUTO", "NIFTY Auto", "c"),
    ("CNXPHARMA", "^CNXPHARMA", "NIFTY Pharma", "c"),
    ("CNXMETAL", "^CNXMETAL", "NIFTY Metal", "c"),
    ("CNXFMCG", "^CNXFMCG", "NIFTY FMCG", "c"),
    ("MIDCAP", "^NSEMDCP50", "NIFTY Midcap 50", "c"),
    # Risk appetite abroad: chips, credit and emerging markets.
    ("SOX", "^SOX", "Philadelphia semiconductors", "c"),
    ("HYG", "HYG", "US high-yield bonds", "c"),
    ("EEM", "EEM", "Emerging markets", "c"),
    ("FTSE", "^FTSE", "FTSE 100", "c"),
    ("DAX", "^GDAXI", "DAX", "c"),
    ("BRENT", "BZ=F", "Brent crude", "c"),
    ("WTI", "CL=F", "WTI crude", "c"),
    ("GOLD", "GC=F", "Gold", "c"),
    ("COPPER", "HG=F", "Copper", "c"),
    ("USDINR", "INR=X", "USD/INR", "c"),
    ("DXY", "DX-Y.NYB", "Dollar index", "c"),
    ("US10Y", "^TNX", "US 10y yield", "c"),
    ("VIXUS", "^VIX", "US VIX", "c"),
]

START = int(datetime(2005, 1, 1, tzinfo=timezone.utc).timestamp())
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&period1={p1}&period2={p2}"


def fetch_json(url, timeout=30):
    """Yahoo direct, then the same URL through r.jina.ai and allorigins, the
    order fetch_market.py uses when a runner is rate-limited."""
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
            last = "HTTP %s" % r.status_code
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)[:160]
        time.sleep(1.0)
    raise RuntimeError(last or "no response")


def daily(sym, fields):
    url = CHART.format(sym=quote(sym, safe=""), p1=START, p2=int(time.time()) + 86400)
    res = fetch_json(url)["chart"]["result"][0]
    off = int(res.get("meta", {}).get("gmtoffset") or 0)
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    out = {"d": [], "o": [], "h": [], "l": [], "c": []}
    seen = set()
    for i, t in enumerate(ts):
        c = (q.get("close") or [None] * len(ts))[i]
        if c is None or c <= 0:
            continue
        # The exchange's own date: a bar stamped at its local open.
        day = datetime.fromtimestamp(int(t) + off, timezone.utc).strftime("%Y-%m-%d")
        if day in seen:          # Yahoo occasionally repeats the live bar
            out["c"][-1] = round(float(c), 4)
            continue
        seen.add(day)
        out["d"].append(day)
        out["c"].append(round(float(c), 4))
        for k, name in (("o", "open"), ("h", "high"), ("l", "low")):
            v = (q.get(name) or [None] * len(ts))[i]
            out[k].append(round(float(v), 4) if v is not None else None)
    keep = {"d": out["d"], "c": out["c"]}
    if "o" in fields:
        keep["o"] = out["o"]
    if "h" in fields:
        keep["h"] = out["h"]
        keep["l"] = out["l"]
    return keep


def main():
    old = previous("history_daily.json") or {}
    old_series = old.get("series") or {}
    payload = {"generated_at": now_iso(), "source": "Yahoo daily bars", "series": {}, "errors": []}
    for key, sym, label, fields in SERIES:
        try:
            s = daily(sym, fields)
            if len(s["d"]) < 250:
                raise RuntimeError("only %d bars" % len(s["d"]))
            s.update({"yahoo": sym, "label": label, "first": s["d"][0], "last": s["d"][-1], "n": len(s["d"])})
            payload["series"][key] = s
            print("  [ok ] %-10s %5d bars  %s .. %s" % (key, s["n"], s["first"], s["last"]))
        except Exception as exc:  # noqa: BLE001
            payload["errors"].append({"series": key, "error": repr(exc)[:200]})
            if key in old_series:
                payload["series"][key] = old_series[key]
                payload["series"][key]["stale"] = True
            print("  [FAIL] %s %r" % (key, exc))
        time.sleep(0.4)
    payload["ok"] = "NIFTY" in payload["series"]
    write_json("history_daily.json", payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
