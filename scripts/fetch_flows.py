"""Market breadth and institutional flows, written to data/flows.json.

Two numbers that move an index and are not in the price series:

  breadth  how many stocks are advancing against declining. A 200 point Nifty
           day carried by four heavyweights is a different market from one with
           350 stocks up, and the index alone cannot tell you which you are in.
  FII/DII  net foreign and domestic institutional flow in crore. Published
           daily by NSE after the close.

Both are free. Both are also behind endpoints that block datacentre addresses
in waves, so every lane is optional and the file is written with whatever
arrived. A missing lane drops out of the forecast's weighting rather than
counting as zero, which would be a bearish reading dressed up as no data.
"""
import json
import pathlib
import re
import sys
import time

import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import DATA, UA, Lanes, now_iso, write_json  # noqa: E402

NSE_HOME = "https://www.nseindia.com/market-data/live-equity-market"
# equity-stockIndices, which used to serve the constituent rows, now answers 404
# for every index. allIndices still answers, and each row already carries the
# advance/decline count NSE computed itself, so the counting is no longer ours
# to do. Preference order is widest first: a 500-name read is a market, a
# 50-name read is the same heavyweights that already moved the index.
NSE_INDICES = "https://www.nseindia.com/api/allIndices"
BREADTH_PREF = ("NIFTY 500", "NIFTY TOTAL MARKET", "NIFTY 200", "NIFTY 100", "NIFTY 50")
NSE_FII = "https://www.nseindia.com/api/fiidiiTradeReact"
MC_FII = "https://www.moneycontrol.com/stocks/marketstats/fii_dii_activity/index.php"


def session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-IN,en;q=0.9",
        "Referer": NSE_HOME,
    })
    s.get(NSE_HOME, timeout=20)
    time.sleep(1)
    return s


def breadth(s):
    """Advance/decline from NSE's own index rows, widest index that answered."""
    r = s.get(NSE_INDICES, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"allIndices HTTP {r.status_code}")
    rows = {(row.get("indexSymbol") or ""): row for row in (r.json().get("data") or [])}
    for name in BREADTH_PREF:
        row = rows.get(name)
        if not row:
            continue
        adv, dec = row.get("advances"), row.get("declines")
        # NSE sends these as strings before the open and as ints once the
        # session starts; both arrive as null on a holiday.
        try:
            adv, dec, unc = int(adv), int(dec), int(row.get("unchanged") or 0)
        except (TypeError, ValueError):
            continue
        if adv + dec + unc:
            return {"advances": adv, "declines": dec, "unchanged": unc, "basis": name}
    raise RuntimeError("no breadth rows")


def fii_dii_nse(s):
    r = s.get(NSE_FII, timeout=25)
    r.raise_for_status()
    rows = r.json()
    out = {}
    for row in rows:
        cat = (row.get("category") or "").upper()
        net = row.get("netValue")
        if net is None:
            continue
        key = "fii" if "FII" in cat or "FPI" in cat else "dii" if "DII" in cat else None
        if key:
            out[key] = {"netCr": float(net), "date": row.get("date"), "via": "nse"}
    if not out:
        raise RuntimeError("no FII/DII rows")
    return out


def fii_dii_moneycontrol():
    """Moneycontrol publishes the same table as HTML. Scraped as a fallback
       only, and only the two net numbers - nothing else is stored."""
    r = requests.get(MC_FII, headers={"User-Agent": UA}, timeout=25)
    r.raise_for_status()
    text = re.sub(r"<[^>]+>", " ", r.text)
    text = re.sub(r"\s+", " ", text)
    m = re.search(r"FII/FPI.*?(-?[\d,]+\.\d\d).*?DII.*?(-?[\d,]+\.\d\d)", text)
    if not m:
        raise RuntimeError("table shape changed")
    def n(x):
        return float(x.replace(",", ""))
    return {"fii": {"netCr": n(m.group(1)), "via": "moneycontrol"},
            "dii": {"netCr": n(m.group(2)), "via": "moneycontrol"}}


def previous():
    path = DATA / "flows.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def main():
    lanes = Lanes()
    payload = {"generated_at": now_iso()}
    prev = previous()

    s = None
    try:
        s = session()
        lanes.record("NSE session", True, 1)
    except Exception as exc:  # noqa: BLE001
        lanes.record("NSE session", False, 0, repr(exc))

    if s:
        try:
            payload["breadth"] = breadth(s)
            lanes.record("breadth", True, 1)
        except Exception as exc:  # noqa: BLE001
            lanes.record("breadth", False, 0, repr(exc))
        try:
            payload.update(fii_dii_nse(s))
            lanes.record("FII/DII (NSE)", True, 1)
        except Exception as exc:  # noqa: BLE001
            lanes.record("FII/DII (NSE)", False, 0, repr(exc))

    if "fii" not in payload:
        try:
            payload.update(fii_dii_moneycontrol())
            lanes.record("FII/DII (Moneycontrol)", True, 1)
        except Exception as exc:  # noqa: BLE001
            lanes.record("FII/DII (Moneycontrol)", False, 0, repr(exc))

    # Flows are a daily number; keeping yesterday's while today's endpoint is
    # down is right. Breadth is intraday, so a stale one is marked rather than
    # silently reused as if it were current.
    for key in ("fii", "dii"):
        if key not in payload and key in prev:
            payload[key] = dict(prev[key], carried_over=True)
    if "breadth" not in payload and "breadth" in prev:
        payload["breadth"] = dict(prev["breadth"], stale=True)

    payload["lanes"] = lanes.as_list()
    write_json("flows.json", payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
