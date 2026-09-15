"""Build data/universe.json: the symbol -> company name map holdings match on.

Why this exists. A holding is typed as a ticker - RELIANCE, INFY, SBIN - but
headlines say "Reliance Industries", "Infosys" and "State Bank of India". Without
a name map, a portfolio alert on a ticker would only fire when a wire happened
to print the ticker, which is rarely.

Source is the NSE equity master CSV, which is public and needs no key. If that
is unreachable from the runner - NSE blocks datacentre IPs in waves - the file
already in the repo is kept rather than overwritten with something worse, and a
built-in list of the large caps is used to seed a first run.

Aliases are generated, not hand-written: the legal suffixes are stripped, and
the leading word is kept when it is distinctive enough to be worth matching on
its own. Anything under four characters is dropped, because three-letter
fragments match ordinary prose constantly and one false alert a day is all it
takes for someone to stop reading the alert feed.
"""
import csv
import io
import json
import pathlib
import re
import sys

import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import DATA, UA, now_iso, write_json  # noqa: E402

NSE_CSV = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"

SUFFIXES = re.compile(
    r"\b(limited|ltd|private|pvt|plc|inc|corporation|corp|company|co|"
    r"industries|enterprises|holdings|group|india|\(india\))\b\.?",
    re.I,
)
PUNCT = re.compile(r"[^\w& ]+")

# Enough to make the feature work on the very first run, before the NSE fetch
# has ever succeeded. Not a curated index, just the names most likely to be held.
SEED = [
    ("RELIANCE", "Reliance Industries"), ("TCS", "Tata Consultancy Services"),
    ("HDFCBANK", "HDFC Bank"), ("ICICIBANK", "ICICI Bank"), ("INFY", "Infosys"),
    ("BHARTIARTL", "Bharti Airtel"), ("SBIN", "State Bank of India"),
    ("LICI", "Life Insurance Corporation of India"), ("ITC", "ITC"),
    ("HINDUNILVR", "Hindustan Unilever"), ("LT", "Larsen & Toubro"),
    ("BAJFINANCE", "Bajaj Finance"), ("HCLTECH", "HCL Technologies"),
    ("MARUTI", "Maruti Suzuki India"), ("SUNPHARMA", "Sun Pharmaceutical Industries"),
    ("KOTAKBANK", "Kotak Mahindra Bank"), ("AXISBANK", "Axis Bank"),
    ("TITAN", "Titan Company"), ("ULTRACEMCO", "UltraTech Cement"),
    ("ASIANPAINT", "Asian Paints"), ("ONGC", "Oil & Natural Gas Corporation"),
    ("NTPC", "NTPC"), ("POWERGRID", "Power Grid Corporation of India"),
    ("TATAMOTORS", "Tata Motors"), ("TATASTEEL", "Tata Steel"),
    ("WIPRO", "Wipro"), ("ADANIENT", "Adani Enterprises"),
    ("ADANIPORTS", "Adani Ports and Special Economic Zone"),
    ("JSWSTEEL", "JSW Steel"), ("COALINDIA", "Coal India"),
    ("BAJAJFINSV", "Bajaj Finserv"), ("NESTLEIND", "Nestle India"),
    ("GRASIM", "Grasim Industries"), ("TECHM", "Tech Mahindra"),
    ("HINDALCO", "Hindalco Industries"), ("CIPLA", "Cipla"),
    ("DRREDDY", "Dr Reddys Laboratories"), ("EICHERMOT", "Eicher Motors"),
    ("BRITANNIA", "Britannia Industries"), ("DIVISLAB", "Divis Laboratories"),
    ("HEROMOTOCO", "Hero MotoCorp"), ("BAJAJ-AUTO", "Bajaj Auto"),
    ("INDUSINDBK", "IndusInd Bank"), ("APOLLOHOSP", "Apollo Hospitals Enterprise"),
    ("TATACONSUM", "Tata Consumer Products"), ("SBILIFE", "SBI Life Insurance"),
    ("HDFCLIFE", "HDFC Life Insurance"), ("SHRIRAMFIN", "Shriram Finance"),
    ("BPCL", "Bharat Petroleum Corporation"), ("IOC", "Indian Oil Corporation"),
    ("ZOMATO", "Eternal"), ("PAYTM", "One 97 Communications"),
    ("DMART", "Avenue Supermarts"), ("IRCTC", "Indian Railway Catering and Tourism Corporation"),
    ("VEDL", "Vedanta"), ("PNB", "Punjab National Bank"),
    ("BANKBARODA", "Bank of Baroda"), ("CANBK", "Canara Bank"),
    ("YESBANK", "Yes Bank"), ("IDEA", "Vodafone Idea"),
    ("SUZLON", "Suzlon Energy"), ("IRFC", "Indian Railway Finance Corporation"),
    ("TATAPOWER", "Tata Power Company"), ("GAIL", "GAIL India"),
    ("DLF", "DLF"), ("SIEMENS", "Siemens"), ("PIDILITIND", "Pidilite Industries"),
    ("HAVELLS", "Havells India"), ("GODREJCP", "Godrej Consumer Products"),
    ("AMBUJACEM", "Ambuja Cements"), ("SHREECEM", "Shree Cement"),
    ("BEL", "Bharat Electronics"), ("HAL", "Hindustan Aeronautics"),
    ("MAZDOCK", "Mazagon Dock Shipbuilders"), ("BHEL", "Bharat Heavy Electricals"),
    ("NHPC", "NHPC"), ("SAIL", "Steel Authority of India"),
    ("JIOFIN", "Jio Financial Services"), ("LTIM", "LTIMindtree"),
    ("TRENT", "Trent"), ("NAUKRI", "Info Edge India"),
    ("POLICYBZR", "PB Fintech"), ("NYKAA", "FSN E-Commerce Ventures"),
]


def aliases_for(symbol, name):
    """Distinctive short forms worth matching a headline on."""
    out = set()
    clean = PUNCT.sub(" ", SUFFIXES.sub(" ", name))
    clean = re.sub(r"\s+", " ", clean).strip()
    if clean and clean.lower() != name.lower() and len(clean) >= 4:
        out.add(clean)
    words = clean.split()
    if words:
        head = words[0]
        # A single leading word is only useful when it is long enough to be a
        # name rather than a fragment, and not a word the business pages use
        # about everyone.
        if len(head) >= 5 and head.lower() not in GENERIC_HEADS:
            out.add(head)
        if len(words) >= 2 and len(" ".join(words[:2])) >= 8:
            out.add(" ".join(words[:2]))
    out.discard(symbol)
    return sorted({a for a in out if len(a) >= 4})


GENERIC_HEADS = {
    "india", "indian", "national", "state", "central", "united", "general",
    "global", "first", "new", "great", "super", "prime", "metro", "modern",
    "bharat", "hindustan", "oriental", "eastern", "western", "northern",
    "southern", "future", "power", "steel", "motor", "motors", "bank",
    "finance", "capital", "digital", "energy", "green", "smart",
}


def from_nse():
    r = requests.get(
        NSE_CSV,
        headers={"User-Agent": UA, "Accept": "text/csv,*/*", "Referer": "https://www.nseindia.com/"},
        timeout=30,
    )
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    out = []
    for row in rows:
        sym = (row.get("SYMBOL") or "").strip().upper()
        name = (row.get("NAME OF COMPANY") or "").strip()
        series = (row.get(" SERIES") or row.get("SERIES") or "").strip()
        if not sym or not name:
            continue
        if series and series not in ("EQ", "BE"):
            continue
        out.append({"symbol": sym, "name": name, "aliases": aliases_for(sym, name)})
    if len(out) < 200:
        raise RuntimeError(f"only {len(out)} rows, looks truncated")
    return out


def existing():
    path = DATA / "universe.json"
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload.get("symbols") or None
    except Exception:  # noqa: BLE001
        return None


def main():
    source = "nse"
    try:
        symbols = from_nse()
    except Exception as exc:  # noqa: BLE001
        print(f"NSE master unreachable ({exc!r})")
        symbols = existing()
        source = "kept existing"
        if not symbols:
            symbols = [{"symbol": s, "name": n, "aliases": aliases_for(s, n)} for s, n in SEED]
            source = "seed list"

    write_json(
        "universe.json",
        {
            "generated_at": now_iso(),
            "source": source,
            "count": len(symbols),
            "symbols": symbols,
            "note": "symbol, company name and generated aliases, used to match "
                    "headlines to holdings. Holdings themselves are never stored here.",
        },
    )
    print(f"universe: {len(symbols)} symbols from {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
