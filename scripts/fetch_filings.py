"""Corporate filings and social chatter - the lanes a browser cannot reach.

Filings are the highest-signal source in this project: an order win, a results
date, a pledge or an open offer is published here before the news wires pick it
up, and it is the thing that actually moves a single stock and, in size, the
index. Scored for materiality so the chart can mark the ones that matter.

Writes:
  data/filings.json   BSE + NSE announcements, scored
  data/social.json    Reddit and StockTwits chatter (kept, schema extended)

Nothing raises. Every lane records whether it answered so the UI can show it.
"""
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import DATA, IST, UA, now_iso, write_json  # noqa: E402

MAX_FILINGS = 400
LOOKBACK_DAYS = 3

# What a filing actually means, and how hard it usually hits.
MATERIAL = [
    ("order_win",   3, ["order", "contract", "letter of intent", "loi", "work order",
                        "bags", "awarded", "tender", "purchase order"]),
    ("results",     3, ["financial results", "quarterly results", "audited results",
                        "unaudited results", "earnings", "board meeting intimation"]),
    ("fundraise",   3, ["qip", "qualified institutional", "preferential allotment",
                        "fund raising", "rights issue", "ncd", "debenture", "esop"]),
    ("stake",       3, ["acquisition", "open offer", "sast", "substantial acquisition",
                        "stake sale", "divestment", "merger", "amalgamation", "scheme of arrangement"]),
    ("distress",    4, ["default", "insolvency", "nclt", "ibc", "resolution professional",
                        "show cause", "penalty", "search and seizure", "fraud", "qualified opinion"]),
    ("pledge",      2, ["pledge", "encumbrance", "invocation", "invoked", "lock-in"]),
    ("payout",      2, ["dividend", "bonus issue", "stock split", "buyback", "record date"]),
    ("governance",  1, ["resignation", "appointment", "cessation", "auditor", "kmp",
                        "director", "secretarial"]),
    ("routine",     0, ["newspaper publication", "trading window", "closure of trading window",
                        "compliance certificate", "shareholding pattern", "investor presentation",
                        "analyst meet", "corporate governance report", "reconciliation"]),
]

NEGATIVE = ["invoked", "default", "insolvency", "nclt", "penalty", "show cause", "fraud", "resignation",
            "downgrade", "qualified opinion", "invocation", "search and seizure", "lapse"]
POSITIVE = ["order", "contract", "awarded", "bags", "dividend", "bonus", "buyback",
            "acquisition", "expansion", "commission", "approval", "upgrade", "record"]


def classify(text):
    low = (text or "").lower()
    # Pick the heaviest category that matches, not the first. "Order from NCLT
    # admitting insolvency" contains "order" but it is distress, not a win.
    kind, weight = "other", 1
    for name, w, terms in MATERIAL:
        if any(t in low for t in terms) and w > weight:
            kind, weight = name, w
    if kind == "other":
        for name, w, terms in MATERIAL:
            if any(t in low for t in terms):
                kind, weight = name, w
                break
    if weight >= 3:
        impact = "high"
    elif weight == 2:
        impact = "medium"
    else:
        impact = "low"
    neg = sum(1 for t in NEGATIVE if t in low)
    pos = sum(1 for t in POSITIVE if t in low)
    sentiment = max(-4.0, min(4.0, (pos - neg) * 1.5))
    return kind, impact, round(sentiment, 2)


def clean(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(text or ""))).strip()


def fetch_bse(lanes):
    """BSE's announcement API is open; it only wants a browser-shaped request."""
    to = datetime.now(IST)
    frm = to - timedelta(days=LOOKBACK_DAYS)
    url = ("https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w"
           f"?strCat=-1&strPrevDate={frm:%Y%m%d}&strScrip=&strSearch=P"
           f"&strToDate={to:%Y%m%d}&strType=C&pageno=1")
    r = requests.get(url, timeout=25, headers={
        "User-Agent": UA,
        "Referer": "https://www.bseindia.com/corporates/ann.html",
        "Origin": "https://www.bseindia.com",
        "Accept": "application/json, text/plain, */*",
    })
    r.raise_for_status()
    rows = r.json().get("Table", []) or []
    out = []
    for row in rows:
        head = clean(row.get("HEADLINE") or row.get("NEWSSUB"))
        name = clean(row.get("SLONGNAME") or row.get("SCRIP_CD"))
        if not head or len(head) < 12:
            continue
        when = row.get("NEWS_DT") or row.get("DT_TM") or ""
        try:
            ts = int(datetime.fromisoformat(when.replace("Z", "")).replace(tzinfo=IST).timestamp())
        except Exception:  # noqa: BLE001
            ts = int(time.time())
        kind, impact, sentiment = classify(head + " " + name)
        out.append({
            "source": "BSE filings", "exchange": "BSE", "company": name,
            "headline": (name + ": " + head) if name else head,
            "kind": kind, "impact": impact, "sentiment": sentiment, "ts": ts,
            "url": "https://www.bseindia.com/corporates/ann.html",
        })
    lanes.record("BSE filings", True, len(out))
    return out


def fetch_nse(lanes):
    """NSE hands out a session cookie on the homepage before it answers its API."""
    s = requests.Session()
    heads = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-IN,en;q=0.9"}
    s.get("https://www.nseindia.com/", headers=heads, timeout=20)
    time.sleep(1)
    r = s.get("https://www.nseindia.com/api/corporate-announcements?index=equities",
              headers=dict(heads, Referer="https://www.nseindia.com/companies-listing/corporate-filings-announcements"),
              timeout=25)
    r.raise_for_status()
    rows = r.json()
    if isinstance(rows, dict):
        rows = rows.get("data", []) or []
    out = []
    for row in rows:
        head = clean(row.get("desc") or row.get("subject"))
        name = clean(row.get("sm_name") or row.get("symbol"))
        if not head or len(head) < 12:
            continue
        when = row.get("an_dt") or row.get("sort_date") or ""
        try:
            ts = int(datetime.strptime(when[:19], "%d-%b-%Y %H:%M:%S").replace(tzinfo=IST).timestamp())
        except Exception:  # noqa: BLE001
            try:
                ts = int(datetime.fromisoformat(when[:19]).replace(tzinfo=IST).timestamp())
            except Exception:  # noqa: BLE001
                ts = int(time.time())
        kind, impact, sentiment = classify(head + " " + name)
        out.append({
            "source": "NSE filings", "exchange": "NSE", "company": name,
            "headline": (name + ": " + head) if name else head,
            "kind": kind, "impact": impact, "sentiment": sentiment, "ts": ts,
            "url": "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
        })
    lanes.record("NSE filings", True, len(out))
    return out


def fetch_stocktwits(lanes):
    """Public trending stream. Retail sentiment - weak on fact, useful on mood."""
    r = requests.get("https://api.stocktwits.com/api/2/streams/trending.json",
                     timeout=20, headers={"User-Agent": UA})
    r.raise_for_status()
    out = []
    for m in (r.json().get("messages") or [])[:40]:
        body = clean(m.get("body"))
        if len(body) < 15:
            continue
        basic = ((m.get("entities") or {}).get("sentiment") or {}).get("basic")
        try:
            ts = int(datetime.fromisoformat(m["created_at"].replace("Z", "+00:00")).timestamp())
        except Exception:  # noqa: BLE001
            ts = int(time.time())
        out.append({
            "source": "StockTwits", "headline": body[:220],
            "sentiment": 2.0 if basic == "Bullish" else (-2.0 if basic == "Bearish" else 0.0),
            "impact": "low", "kind": "chatter", "ts": ts,
            "symbols": [s.get("symbol") for s in (m.get("symbols") or [])][:6],
            "url": "https://stocktwits.com/",
        })
    lanes.record("StockTwits", True, len(out))
    return out


def main():
    from common import Lanes
    lanes = Lanes()

    filings = []
    filings += lanes.run("BSE filings", lambda: fetch_bse(Lanes()))
    filings += lanes.run("NSE filings", lambda: fetch_nse(Lanes()))

    seen, deduped = set(), []
    for f in sorted(filings, key=lambda x: -x["ts"]):
        k = re.sub(r"[^a-z0-9]", "", f["headline"].lower())[:90]
        if k in seen:
            continue
        seen.add(k)
        deduped.append(f)
    deduped = deduped[:MAX_FILINGS]

    write_json("filings.json", {
        "updated_iso": now_iso(),
        "count": len(deduped),
        "high": sum(1 for f in deduped if f["impact"] == "high"),
        "lanes": lanes.as_list(),
        "filings": deduped,
    })

    chatter = lanes.run("StockTwits", lambda: fetch_stocktwits(Lanes()))
    write_json("social.json", {
        "updated_iso": now_iso(),
        "count": len(chatter),
        "lanes": lanes.as_list(),
        "items": chatter,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
