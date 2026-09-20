"""Indian IPOs, written to data/ipo.json.

Four questions this file has to answer, and where each one comes from:

  what is open now        /api/ipo-current-issue carries the live book. It is
                          the only lane here that changes during a session.
  what is coming          /api/all-upcoming-issues?category=ipo. Status is
                          "Active" while bidding and "Forthcoming" before it.
  what it is worth        /api/ipo-detail?symbol=&series= is the whole issue:
                          the category-wise book, the lot size, the lead
                          managers, the registrar, the RED HERRING PROSPECTUS
                          link, the "Ratios / Basis of Issue Price" link - which
                          is NSE's own peer comparison, published by the issuer
                          and not by an aggregator - and the demand curve,
                          bid quantity at every rupee in the band.
  did it work last time   /api/public-past-issues gives issue price and listing
                          date. It does NOT give the listing price, so the
                          listing gain is computed from Yahoo's daily series
                          for the listed symbol. That is the difference between
                          a number this page measured and a number it copied.

Everything is keyless. NSE blocks datacentre addresses in waves, so every lane
is optional, the file carries what arrived, and a failed run keeps the previous
good copy rather than publishing an empty pipeline.

One deliberate omission: grey market premium. Every GMP figure in circulation
is scraped from unregulated grey-market sites, none of them publish a method,
and the numbers disagree with each other by 30% on the same morning. It is not
in this file. The page has a slot for it that stays empty until a source exists
whose track record can be scored the way `listing_gain` is scored here.
"""
import json
import pathlib
import re
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import quote

import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import DATA, UA, Lanes, carry_forward, now_iso, write_json  # noqa: E402

NSE_HOME = "https://www.nseindia.com/market-data/all-upcoming-issues-ipo"
API = "https://www.nseindia.com/api"
UPCOMING = f"{API}/all-upcoming-issues?category=ipo"
CURRENT = f"{API}/ipo-current-issue"
PAST = f"{API}/public-past-issues"
DETAIL = API + "/ipo-detail?symbol={sym}&series={series}"

YAHOO = ("https://query1.finance.yahoo.com/v8/finance/chart/"
         "{sym}?interval=1d&range={rng}")

# How many past issues to price for listing gains. Each one is a Yahoo request,
# and the statistic stops improving long before the list runs out - fifty
# listings is already enough to separate a good year from a bad one, and the
# page says how many went into the number either way.
MAX_PRICED = 60


def session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-IN,en;q=0.9",
        "Referer": NSE_HOME,
    })
    # NSE hands out a cookie on the homepage and refuses the API without it.
    s.get(NSE_HOME, timeout=20)
    time.sleep(1)
    return s


def get_json(s, url, timeout=25):
    r = s.get(url, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} for {url.split('?')[0]}")
    return r.json()


# --------------------------------------------------------------- parsing ---
def num(v):
    """A number out of whatever NSE sent.

    The same field arrives as "8.8642911E7", as "5,35,44,600" and as 88642911
    depending on the endpoint and the day, so every read goes through here.
    Indian digit grouping means commas cannot be assumed to be thousands.
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    t = str(v).strip().replace(",", "")
    if not t or t in {"-", "NA", "N/A"}:
        return None
    try:
        return float(t)
    except ValueError:
        return None


PRICE_RX = re.compile(r"(\d[\d,]*\.?\d*)")


def band(text):
    """Low and high out of "Rs.1700 to Rs.1785" or "Rs. 140 to Rs. 148"."""
    if not text:
        return (None, None)
    found = [num(x) for x in PRICE_RX.findall(str(text))]
    found = [f for f in found if f]
    if not found:
        return (None, None)
    if len(found) == 1:
        return (found[0], found[0])
    return (min(found), max(found))


def ist_date(text):
    """NSE sends dates as 17-Sep-2026 and sometimes as 17-SEP-2026."""
    if not text or str(text).strip() in {"-", ""}:
        return None
    t = str(text).strip()
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(t.title(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def detail_map(payload):
    """issueInfo.dataList is a list of {title, value} with nulls for wrapped
    lines - a lead manager list arrives as twenty rows whose title is null and
    whose value is one bank each. Fold those onto the last real title rather
    than dropping them, because the list of who is running the book is one of
    the few qualitative facts worth carrying."""
    out, last = {}, None
    for row in (payload or {}).get("dataList") or []:
        title = (row.get("title") or "").strip()
        value = (row.get("value") or "").strip().strip('"')
        if title:
            last = title
            out[title] = value
        elif last and value:
            out[last] = (out.get(last, "") + "\n" + value).strip()
    return out


DOC_KEYS = {
    "Red Herring Prospectus": "rhp",
    "Ratios / Basis of Issue Price": "ratios",
    "Anchor Allocation Report": "anchor",
    "Sample Application Forms": "forms",
    "Bidding Centers": "centres",
}


def documents(info):
    """The official documents, by what they are rather than by their filename.

    The RHP is the answer to "show me the report" and the ratios file is NSE's
    own peer comparison - the issuer's stated basis for the price, filed with
    the exchange. Both are links to nsearchives.nseindia.com, so the page sends
    a reader to the exchange rather than reprinting a figure it cannot verify.
    """
    out = {}
    for title, key in DOC_KEYS.items():
        v = info.get(title) or ""
        if v.startswith("http"):
            out[key] = v
    return out


def bid_rows(rows):
    """Category subscription, only the rows that are categories.

    The list mixes totals, categories and sub-categories, and the
    sub-categories have no shares offered - they are a breakdown of who bid
    inside a category, not a category with its own quota. Anything without an
    offered quantity is a breakdown line and is dropped: dividing a bid by a
    blank quota is how a sub-category ends up looking like a 50x subscription.
    """
    out = []
    for r in rows or []:
        offered = num(r.get("noOfSharesOffered") or r.get("noOfShareOffered"))
        if not offered:
            continue
        bid = num(r.get("noOfsharesBid") or r.get("noOfSharesBid"))
        times = num(r.get("noOfTime") or r.get("noOfTotalMeant"))
        cat = (r.get("category") or "").strip()
        if not cat or cat.lower() == "category":
            continue
        out.append({
            "category": cat,
            "offered": offered,
            "bid": bid,
            "times": round(times, 3) if times is not None else (
                round(bid / offered, 3) if bid and offered else None),
        })
    return out


def demand_curve(graph):
    """Cumulative bid quantity at each price in the band.

    This is the most informative object NSE publishes about a live issue and
    nobody draws it. It says where in the band the book actually is: a curve
    that is flat from floor to cap means the book is at cut-off and the issue
    prices at the top; one that falls away above the middle means the demand is
    not there at the upper end.
    """
    plot = (graph or {}).get("plotData") or {}
    pts = []
    for price, qty in plot.items():
        p = num(price)
        q = num(qty)
        if p is None or q is None:
            continue
        pts.append({"price": p, "qty": q})
    pts.sort(key=lambda x: x["price"])
    if not pts:
        return None
    return {
        "points": pts,
        "cutOffQty": num((graph or {}).get("totalBidAtCutOff")),
        "totalBids": num((graph or {}).get("totalBidRecieved") or (graph or {}).get("TOTAL_BIDS")),
        "issueSize": num((graph or {}).get("totalIssueSize")),
        "subscribed": num((graph or {}).get("noOfTimesIssueSubscribed")),
        "asOf": (graph or {}).get("timestamp") or (graph or {}).get("updateTime"),
    }


# ----------------------------------------------------------------- lanes ---
def fetch_pipeline(s):
    rows = get_json(s, UPCOMING) or []
    out = []
    for r in rows:
        lo, hi = band(r.get("issuePrice") or r.get("priceBand"))
        out.append({
            "symbol": (r.get("symbol") or "").strip(),
            "company": (r.get("companyName") or "").strip(),
            "series": (r.get("series") or "").strip(),
            "status": (r.get("status") or "").strip(),
            "opens": ist_date(r.get("issueStartDate")),
            "closes": ist_date(r.get("issueEndDate")),
            "bandLow": lo, "bandHigh": hi,
            "sharesOffered": num(r.get("issueSize")),
            "lotSize": num(r.get("lotSize")),
        })
    return [r for r in out if r["symbol"]]


def fetch_live(s):
    rows = get_json(s, CURRENT) or []
    out = []
    for r in rows:
        offered = num(r.get("noOfSharesOffered"))
        bid = num(r.get("noOfsharesBid"))
        out.append({
            "symbol": (r.get("symbol") or "").strip(),
            "series": (r.get("series") or "").strip(),
            "onBse": str(r.get("isBse") or "") == "1",
            "offered": offered,
            "bid": bid,
            "times": num(r.get("noOfTime")),
        })
    return [r for r in out if r["symbol"]]


def fetch_past(s):
    rows = get_json(s, PAST) or []
    out = []
    for r in rows:
        lo, hi = band(r.get("priceRange"))
        out.append({
            "symbol": (r.get("symbol") or "").strip(),
            "company": (r.get("company") or "").strip(),
            "series": (r.get("securityType") or "").strip(),
            "opens": ist_date(r.get("ipoStartDate")),
            "closes": ist_date(r.get("ipoEndDate")),
            "listed": ist_date(r.get("listingDate")),
            "issuePrice": num(r.get("issuePrice")),
            "bandLow": lo, "bandHigh": hi,
        })
    return [r for r in out if r["symbol"]]


def fetch_detail(s, symbol, series):
    j = get_json(s, DETAIL.format(sym=quote(symbol), series=quote(series or "EQ")))
    info = detail_map(j.get("issueInfo"))
    # bidDetails is the live book; activeCat is the settled one after close.
    book = bid_rows(j.get("bidDetails")) or bid_rows((j.get("activeCat") or {}).get("dataList"))
    curve = demand_curve(j.get("demandGraphALL")) or demand_curve(j.get("demandGraph"))
    return {
        "symbol": symbol,
        "book": book,
        "demand": curve,
        "docs": documents(info),
        "issueType": info.get("Issue Type"),
        "faceValue": num(info.get("Face Value")),
        "lotText": info.get("Bid Lot"),
        "issueSizeText": info.get("Issue Size"),
        "discount": info.get("Discount"),
        "registrar": info.get("Name of the Registrar"),
        "leadManagers": [x for x in (info.get("Book Running Lead Managers") or "").split("\n") if x],
        "updatedAt": ((j.get("activeCat") or {}).get("updateTime")
                      or (j.get("demandGraph") or {}).get("timestamp")),
    }


def listing_gain(s, symbol, listed_iso, issue_price):
    """Measured, not copied.

    NSE's past-issues list gives the issue price and the listing date and stops
    there. The listing gain everybody quotes is issue price against listing-day
    close, so that is what this computes, from the listed symbol's own daily
    series. A symbol Yahoo does not carry, or a listing whose bar is missing,
    returns None and is left out of the statistics rather than guessed.
    """
    if not (listed_iso and issue_price):
        return None
    try:
        listed = datetime.fromisoformat(listed_iso).date()
    except ValueError:
        return None
    age = (datetime.utcnow().date() - listed).days
    if age < 0:
        return None
    rng = "1mo" if age <= 25 else "3mo" if age <= 80 else "1y" if age <= 350 else "2y"
    r = s.get(YAHOO.format(sym=quote(symbol + ".NS"), rng=rng), timeout=20,
              headers={"User-Agent": UA})
    if r.status_code != 200:
        return None
    res = ((r.json().get("chart") or {}).get("result") or [None])[0]
    if not res:
        return None
    stamps = res.get("timestamp") or []
    quote_ = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    closes, opens = quote_.get("close") or [], quote_.get("open") or []
    target = listed.isoformat()
    for i, ts in enumerate(stamps):
        day = datetime.utcfromtimestamp(ts).date().isoformat()
        if day < target:
            continue
        c = closes[i] if i < len(closes) else None
        o = opens[i] if i < len(opens) else None
        if c is None:
            return None
        last = None
        for j2 in range(len(closes) - 1, -1, -1):
            if closes[j2] is not None:
                last = closes[j2]
                break
        return {
            "listOpen": round(o, 2) if o else None,
            "listClose": round(c, 2),
            "listGainPct": round((c - issue_price) / issue_price * 100, 2),
            "openGainPct": round((o - issue_price) / issue_price * 100, 2) if o else None,
            "sinceListingPct": round((last - issue_price) / issue_price * 100, 2) if last else None,
            "pricedFrom": "yahoo",
        }
    return None


def main():
    lanes = Lanes()
    s = None
    try:
        s = session()
    except Exception as exc:  # noqa: BLE001
        lanes.record("nse session", False, 0, repr(exc))

    pipeline, live, past = [], [], []
    if s is not None:
        pipeline = lanes.run("upcoming issues", lambda: fetch_pipeline(s))
        live = lanes.run("live subscription", lambda: fetch_live(s))
        past = lanes.run("past issues", lambda: fetch_past(s))

    # Merge the live book onto the pipeline rows so one object describes one
    # issue. Two lists keyed by symbol is two lists to get out of step.
    by_symbol = {}
    for r in pipeline:
        by_symbol[r["symbol"]] = dict(r)
    for r in live:
        row = by_symbol.setdefault(r["symbol"], {"symbol": r["symbol"], "series": r["series"]})
        row["subscription"] = r["times"]
        row["offered"] = r["offered"]
        row["bid"] = r["bid"]
        row["onBse"] = r.get("onBse")
        row.setdefault("status", "Active")

    # Detail only for issues that are open or about to open. Fetching it for
    # everything would be a request per row for pages nobody opens.
    details = {}
    if s is not None:
        wanted = [r for r in by_symbol.values()
                  if (r.get("status") or "").lower() in {"active", "forthcoming"}]
        for r in wanted[:12]:
            sym = r["symbol"]
            try:
                details[sym] = fetch_detail(s, sym, r.get("series") or "EQ")
                lanes.record(f"detail {sym}", True, len(details[sym].get("book") or []))
            except Exception as exc:  # noqa: BLE001
                lanes.record(f"detail {sym}", False, 0, repr(exc))
            time.sleep(0.6)

    # Listing gains for the recent past, newest first.
    priced = 0
    if s is not None:
        past.sort(key=lambda r: r.get("listed") or "", reverse=True)
        for r in past:
            if priced >= MAX_PRICED:
                break
            if not (r.get("listed") and r.get("issuePrice")):
                continue
            try:
                g = listing_gain(s, r["symbol"], r["listed"], r["issuePrice"])
            except Exception:  # noqa: BLE001
                g = None
            if g:
                r.update(g)
                priced += 1
            time.sleep(0.25)
        lanes.record("listing gains priced", priced > 0, priced)

    ok = bool(by_symbol or past)
    payload = {
        "generated_at": now_iso(),
        "ok": ok,
        "source": "nseindia.com/api (upcoming, current, detail, past) + Yahoo for listing prices",
        "counts": {
            "pipeline": len(by_symbol),
            "detailed": len(details),
            "past": len(past),
            "priced": priced,
        },
        "issues": sorted(by_symbol.values(), key=lambda r: (r.get("opens") or "9999")),
        "details": details,
        "past": past,
        "lanes": lanes.items,
        # No GMP. See the module docstring: every figure in circulation is
        # scraped from unregulated sites that publish no method and disagree
        # with each other. The page leaves the slot empty rather than printing
        # a number it cannot score.
        "gmp": None,
    }
    if not ok:
        payload["error"] = "no IPO lane returned usable data"
    write_json("ipo.json", carry_forward("ipo.json", payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
