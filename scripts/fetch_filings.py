"""Corporate filings - the lane a browser cannot reach.

Filings are the highest-signal source in this project: an order win, a results
date, a pledge or an open offer is published here before the news wires pick it
up, and it is the thing that actually moves a single stock and, in size, the
index. Scored for materiality so the chart can mark the ones that matter.

Writes:
  data/filings.json   BSE + NSE announcements, scored

This used to also write data/social.json from the StockTwits trending stream.
Nothing ever read it - the path was declared in config.js and never fetched -
so the lane was paying a request and 12 KB of branch churn per run to produce
a file no screen displayed. Removed rather than wired: retail chatter is not a
forecast input any of the seven lanes asks for.

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


def fetch_bse():
    """BSE's announcement API is open; it only wants a browser-shaped request.

    It answers 200 with the bare JSON string "No Record Found!" rather than an
    empty table when it does not want to serve you - which is also what it
    returns to a datacentre address, so an empty result here is a block as often
    as it is a quiet day. Calling .get() on that string raised AttributeError
    and the lane reported a Python error instead of "BSE said no".
    """
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
    payload = r.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"BSE returned {payload!r}")
    rows = payload.get("Table") or []
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
    return out


def fetch_nse():
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
    return out


def main():
    from common import Lanes
    lanes = Lanes()

    filings = []
    # Lanes.run already records the result. The fetchers used to also record
    # into a throwaway Lanes() passed in here, which printed every lane twice
    # into the workflow log for no gain.
    filings += lanes.run("BSE filings", fetch_bse)
    filings += lanes.run("NSE filings", fetch_nse)

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

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
