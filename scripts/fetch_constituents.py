#!/usr/bin/env python3
"""Index membership, so the news lane can tell a NIFTY story from noise.

The problem this solves
-----------------------
The news lane averaged sentiment across every headline it had, weighted only by
recency and a keyword-derived impact tag. Measured on one live sweep of 600
items, that pool contained:

    "SEBI Order for Compliance - Completion Order for Recovery Certificate"
    "Reserve Bank of India (Rural Co-operative Banks - Know Your Customer..."
    "SBI Nifty Bank Index Fund(G)-Direct Plan - Univest"

all scored and all voting on where NIFTY goes this afternoon. None of them bear
on it. Meanwhile a headline naming HDFC Bank or Reliance - names that actually
carry the index - counted exactly the same as a microcap board-meeting notice.

Relevance was the missing dimension, and membership is the part of it that can
be sourced rather than guessed.

Where this comes from
---------------------
`niftyindices.com/IndexConstituent/ind_nifty50list.csv` and its siblings. Free,
keyless, no cookie, 3.3 KB. Verified 19 Sep 2026: 50 / 14 / 50 rows with
Company Name, Industry, Symbol, Series and ISIN.

NSE's own `/api/equity-stockIndices?index=NIFTY%2050` is dead - HTTP 404, and
already recorded as dead in CLAUDE.md. Do not reach for it again.

What is deliberately NOT here
-----------------------------
**Weights.** NIFTY 50 is free-float market-cap weighted, and no free endpoint
that answered gives those weights. Financial Services is eleven of the fifty
names but far more than eleven fiftieths of the index, so using the name count
as a weight would be inventing a number - which is the one thing this project
says it will not do. The lane therefore works in membership tiers, which are
facts, rather than weights, which would not be.
"""
import csv
import io
import re
import sys

from common import Lanes, UA, carry_forward, get, now_ist, now_iso, write_json

BASE = "https://niftyindices.com/IndexConstituent/"
HDR = {"Referer": "https://niftyindices.com/", "User-Agent": UA}

# Tiers, most index-relevant first. A headline naming a NIFTY 50 constituent
# bears on the index directly; one naming a Next 50 name bears on it mostly
# through sentiment; anything else is a single stock's business.
LISTS = [
    ("nifty50", "ind_nifty50list.csv"),
    ("bank", "ind_niftybanklist.csv"),
    ("next50", "ind_niftynext50list.csv"),
]

# Suffixes that carry no identifying information and would otherwise make every
# alias match every other company.
NOISE = re.compile(
    r"\b(ltd|limited|ltd\.|corporation|corp|company|co|inc|plc|industries|"
    r"enterprises|india|indian|of|the|and)\b\.?", re.I)


def aliases_for(name, symbol):
    """Short forms a headline is likely to use.

    "Housing Development Finance Corporation Ltd." is never what a wire writes;
    it writes "HDFC". So the alias set keeps the symbol, the full name, and the
    name with corporate furniture stripped - and drops anything under four
    characters, because two-letter fragments match everything.
    """
    out = set()
    sym = (symbol or "").strip().upper()
    if sym:
        out.add(sym)
    full = (name or "").strip()
    if full:
        out.add(full)
        stripped = NOISE.sub(" ", full)
        stripped = re.sub(r"[^A-Za-z0-9& ]", " ", stripped)
        stripped = re.sub(r"\s+", " ", stripped).strip()
        if stripped:
            out.add(stripped)
            # First two words are usually how a company is referred to in prose
            # ("Tata Consultancy", "Bajaj Finance").
            parts = stripped.split(" ")
            if len(parts) >= 2:
                out.add(" ".join(parts[:2]))
    return sorted({a for a in out if len(a) >= 4})


def fetch_list(filename, lanes, label):
    try:
        r = get(BASE + filename, headers=HDR, retries=2, timeout=20)
        rows = list(csv.DictReader(io.StringIO(r.text)))
        rows = [x for x in rows if (x.get("Symbol") or "").strip()]
        lanes.record(label, True, len(rows))
        return rows
    except Exception as exc:  # noqa: BLE001
        lanes.record(label, False, 0, repr(exc))
        return []


def main():
    lanes = Lanes()
    members = {}
    order = []

    for tier, filename in LISTS:
        for row in fetch_list(filename, lanes, tier):
            sym = row["Symbol"].strip().upper()
            name = (row.get("Company Name") or "").strip()
            industry = (row.get("Industry") or "").strip()
            if sym not in members:
                members[sym] = {
                    "symbol": sym,
                    "name": name,
                    "industry": industry,
                    "tiers": [],
                    "aliases": aliases_for(name, sym),
                }
                order.append(sym)
            if tier not in members[sym]["tiers"]:
                members[sym]["tiers"].append(tier)

    industries = sorted({m["industry"] for m in members.values() if m["industry"]})

    payload = {
        "generated_at": now_iso(),
        "generated_ist": now_ist(),
        "source": "niftyindices.com/IndexConstituent/*.csv",
        "ok": bool(members),
        "count": len(members),
        "tiers": {t: sum(1 for m in members.values() if t in m["tiers"])
                  for t, _ in LISTS},
        "industries": industries,
        "members": [members[s] for s in order],
        "note": ("Index membership only. NIFTY 50 is free-float market-cap "
                 "weighted and no free endpoint gives those weights, so the "
                 "news lane works in membership tiers - which are facts - "
                 "rather than weights, which would have to be invented."),
        "lanes": lanes.as_list(),
    }
    # Index membership changes a few times a year. A failed fetch must not
    # blank it, or the news lane silently stops telling a NIFTY name from a
    # microcap and nothing on the page says why.
    payload = carry_forward("constituents.json", payload, keep_stamp=False)
    write_json("constituents.json", payload)
    print(f"  {len(members)} symbols across {payload['tiers']}, "
          f"{len(industries)} industries")
    if members:
        sample = members[order[0]]
        print(f"  sample: {sample['symbol']} -> aliases {sample['aliases']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
