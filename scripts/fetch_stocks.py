"""Quotes for individual NSE names, written to data/stocks.json.

The portfolio panel needs a price per holding. Fetching one URL per symbol for
a whole universe would be two thousand requests a run, so the sources are tried
cheapest first:

  1. NSE's own index constituent endpoint. One request returns every name in
     NIFTY 500 with last price, previous close and the day's range. When it
     works it is by far the best option. NSE blocks datacentre address ranges
     in waves, so it is wrapped and allowed to fail.
  2. Yahoo's batch quote endpoint, fifty symbols per call.
  3. Yahoo's per-symbol chart endpoint, capped, for whatever is still missing.

Whatever is collected is written; the page fills any remaining gap on demand
from the browser. A holding with no price is shown at cost and labelled, which
is better than showing a stale price as though it were live.
"""
import json
import pathlib
import sys
import time
from urllib.parse import quote

import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import DATA, UA, now_iso, write_json  # noqa: E402

NSE_INDEX = "https://www.nseindia.com/api/equity-stockIndices?index={idx}"
NSE_HOME = "https://www.nseindia.com/market-data/live-equity-market"
YF_BATCH = "https://query1.finance.yahoo.com/v7/finance/quote?symbols={syms}"
YF_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d"

INDEXES = ["NIFTY%20500", "NIFTY%20MIDCAP%20100", "NIFTY%20SMALLCAP%20100"]
MAX_INDIVIDUAL = 60          # hard ceiling on one-by-one fetches per run


def from_nse():
    """One request per index. Needs a primed cookie jar or NSE returns 401."""
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-IN,en;q=0.9",
        "Referer": NSE_HOME,
    })
    s.get(NSE_HOME, timeout=20)
    time.sleep(1)
    out = {}
    for idx in INDEXES:
        try:
            r = s.get(NSE_INDEX.format(idx=idx), timeout=25)
            if r.status_code != 200:
                print(f"  NSE {idx}: HTTP {r.status_code}")
                continue
            for row in (r.json().get("data") or []):
                sym = (row.get("symbol") or "").strip().upper()
                if not sym or sym.startswith("NIFTY"):
                    continue
                price = row.get("lastPrice")
                prev = row.get("previousClose")
                if price in (None, 0):
                    continue
                out[sym] = {
                    "price": price,
                    "prevClose": prev,
                    "changePct": row.get("pChange"),
                    "dayHigh": row.get("dayHigh"),
                    "dayLow": row.get("dayLow"),
                    "week52High": (row.get("yearHigh") if "yearHigh" in row else None),
                    "week52Low": (row.get("yearLow") if "yearLow" in row else None),
                    "via": "nse",
                }
            print(f"  NSE {idx}: {len(out)} cumulative")
        except Exception as exc:  # noqa: BLE001
            print(f"  NSE {idx} failed: {exc!r}")
        time.sleep(1)
    return out


def _yahoo_routes(url):
    heads = {"User-Agent": UA, "Accept": "application/json,text/plain,*/*"}
    return [
        (url, heads),
        ("https://r.jina.ai/" + url, dict(heads, **{"x-return-format": "text"})),
        ("https://api.allorigins.win/raw?url=" + quote(url, safe=""), heads),
    ]


def from_yahoo_batch(symbols):
    out = {}
    for i in range(0, len(symbols), 50):
        chunk = symbols[i:i + 50]
        url = YF_BATCH.format(syms=quote(",".join(s + ".NS" for s in chunk), safe=","))
        for target, headers in _yahoo_routes(url):
            try:
                r = requests.get(target, headers=headers, timeout=25)
                if r.status_code != 200 or not r.text.lstrip().startswith("{"):
                    continue
                rows = (r.json().get("quoteResponse") or {}).get("result") or []
                for row in rows:
                    sym = (row.get("symbol") or "").replace(".NS", "").upper()
                    price = row.get("regularMarketPrice")
                    if price is None:
                        continue
                    out[sym] = {
                        "price": price,
                        "prevClose": row.get("regularMarketPreviousClose"),
                        "changePct": row.get("regularMarketChangePercent"),
                        "dayHigh": row.get("regularMarketDayHigh"),
                        "dayLow": row.get("regularMarketDayLow"),
                        "week52High": row.get("fiftyTwoWeekHigh"),
                        "week52Low": row.get("fiftyTwoWeekLow"),
                        "via": "yahoo-batch",
                    }
                break
            except Exception:  # noqa: BLE001
                continue
        time.sleep(0.6)
    return out


def from_yahoo_one(symbols):
    out = {}
    for sym in symbols[:MAX_INDIVIDUAL]:
        url = YF_CHART.format(sym=quote(sym + ".NS", safe=""))
        for target, headers in _yahoo_routes(url):
            try:
                r = requests.get(target, headers=headers, timeout=20)
                if r.status_code != 200 or not r.text.lstrip().startswith("{"):
                    continue
                meta = r.json()["chart"]["result"][0]["meta"]
                price = meta.get("regularMarketPrice")
                if price is None:
                    continue
                prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
                out[sym] = {
                    "price": price, "prevClose": prev,
                    "changePct": round((price - prev) / prev * 100, 4) if prev else None,
                    "dayHigh": meta.get("regularMarketDayHigh"),
                    "dayLow": meta.get("regularMarketDayLow"),
                    "week52High": meta.get("fiftyTwoWeekHigh"),
                    "week52Low": meta.get("fiftyTwoWeekLow"),
                    "via": "yahoo-chart",
                }
                break
            except Exception:  # noqa: BLE001
                continue
        time.sleep(0.4)
    return out


def _constituents():
    """Index members, in index order, from constituents.json.

    These go to the front of the queue. Until 20 Sep 2026 the wanted list was
    universe.json in file order, which is alphabetical, and the Yahoo batch
    lane takes the first 400 - so a run covered 20MICRONS through roughly the
    letter C and reached almost none of the NIFTY 50. The page could therefore
    never show which index members moved, which is the first thing anybody
    looks at in the morning.
    """
    path = DATA / "constituents.json"
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            members = json.load(f).get("members") or []
        # nifty50 first, then the rest of whatever tiers the file carries.
        first = [m["symbol"] for m in members
                 if m.get("symbol") and "nifty50" in (m.get("tiers") or [])]
        rest = [m["symbol"] for m in members
                if m.get("symbol") and "nifty50" not in (m.get("tiers") or [])]
        return first + rest
    except Exception:  # noqa: BLE001
        return []


def universe_symbols():
    path = DATA / "universe.json"
    wide = []
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                wide = [r["symbol"] for r in json.load(f).get("symbols", []) if r.get("symbol")]
        except Exception:  # noqa: BLE001
            wide = []

    # Index members first, then everything else, de-duplicated with order kept.
    seen, out = set(), []
    for sym in _constituents() + wide:
        if sym in seen:
            continue
        seen.add(sym)
        out.append(sym)
    return out


def previous():
    path = DATA / "stocks.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f).get("quotes") or {}
    except Exception:  # noqa: BLE001
        return {}


def main():
    wanted = universe_symbols()
    quotes = {}
    try:
        quotes.update(from_nse())
    except Exception as exc:  # noqa: BLE001
        print(f"NSE lane unavailable: {exc!r}")

    missing = [s for s in wanted if s not in quotes]
    if missing:
        try:
            quotes.update(from_yahoo_batch(missing[:400]))
        except Exception as exc:  # noqa: BLE001
            print(f"Yahoo batch lane failed: {exc!r}")

    missing = [s for s in wanted if s not in quotes]
    if missing:
        try:
            quotes.update(from_yahoo_one(missing))
        except Exception as exc:  # noqa: BLE001
            print(f"Yahoo single lane failed: {exc!r}")

    # Never publish fewer names than last time just because one lane blinked.
    # A price from ten minutes ago beats no price, and each row keeps the
    # source it came from so the page can tell them apart.
    old = previous()
    kept = 0
    for sym, row in old.items():
        if sym not in quotes:
            row = dict(row)
            row["stale"] = True
            quotes[sym] = row
            kept += 1

    write_json(
        "stocks.json",
        {
            "generated_at": now_iso(),
            "count": len(quotes),
            "fresh": len(quotes) - kept,
            "carried_over": kept,
            "quotes": quotes,
        },
    )
    print(f"stocks: {len(quotes)} quotes ({kept} carried over)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
