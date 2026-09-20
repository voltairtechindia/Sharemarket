"""Build data/ipo.json from the responses captured on 20 Sep 2026.

Why this exists: the IPO fetcher cannot run in the session that wrote it - NSE
is not reachable from either shell here - so without a seed the page would be
built and reviewed against nothing, and "it renders" would mean "it renders
zero rows". Every value below was read from the live NSE API on 20 Sep 2026 and
is marked as a capture, with the exchange's own as-of stamps kept. The workflow
overwrites the whole file on its first run.

This script is kept so the seed is reproducible and obviously not hand-typed.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

CAPTURED = "2026-09-20T13:40:00+00:00"

PIPELINE = [
    # /api/all-upcoming-issues?category=ipo
    dict(symbol="NSE", company="National Stock Exchange of India Limited", series="EQ",
         status="Active", opens="2026-09-17", closes="2026-09-21",
         bandLow=1700.0, bandHigh=1785.0, sharesOffered=88642911.0, lotSize=8.0,
         subscription=1.16, offered=88642911.0, bid=102843656.0, onBse=False),
    dict(symbol="SONA", company="Sonaselection India Limited", series="EQ",
         status="Active", opens="2026-09-17", closes="2026-09-21",
         bandLow=94.0, bandHigh=99.0, sharesOffered=10010000.0, lotSize=None,
         subscription=0.687, offered=10010000.0, bid=6873000.0, onBse=False),
    dict(symbol="AXIOMGAS", company="Axiom Gas Engineering Limited", series="SME",
         status="Active", opens="2026-09-18", closes="2026-09-22",
         bandLow=None, bandHigh=None, sharesOffered=8328000.0, lotSize=None,
         subscription=0.58, offered=8328000.0, bid=4808000.0, onBse=True),
    dict(symbol="KHERIAAUTO", company="Kheria Autocomp Limited", series="SME",
         status="Active", opens="2026-09-17", closes="2026-09-21",
         bandLow=None, bandHigh=None, sharesOffered=3288000.0, lotSize=None,
         subscription=0.45, offered=3288000.0, bid=1478400.0, onBse=True),
    dict(symbol="SPECTRAA", company="SpectraA Technology Solutions Limited", series="SME",
         status="Active", opens="2026-09-17", closes="2026-09-21",
         bandLow=None, bandHigh=None, sharesOffered=2578800.0, lotSize=None,
         subscription=18.43, offered=2578800.0, bid=47528400.0, onBse=True),
    dict(symbol="VARMORA", company="Varmora Granito Limited", series="EQ",
         status="Forthcoming", opens="2026-09-22", closes="2026-09-24",
         bandLow=140.0, bandHigh=148.0, sharesOffered=49074776.0, lotSize=None),
    dict(symbol="POOJALOGIS", company="Pooja Logistics Limited", series="SME",
         status="Forthcoming", opens="2026-09-23", closes="2026-09-25",
         bandLow=109.0, bandHigh=115.0, sharesOffered=3846000.0, lotSize=1200.0),
]

# /api/ipo-detail?symbol=NSE&series=EQ  — the category-wise book as NSE settled
# it at 18-Sep-2026 19:00, the demand curve endpoints, and the official links.
NSE_BOOK = [
    ("Qualified Institutional Buyers(QIBs)", 25207867, 38566944, 1.52996),
    ("Non Institutional Investors", 18900483, 31755040, 1.68012),
    ("Non Institutional Investors(Bid amount of more than Ten Lakh Rupees)",
     12600322, 20216976, 1.60448),
    ("Non Institutional Investors(Bid amount of more than Two Lakh Rupees upto Ten Lakh Rupees)",
     6300161, 11538064, 1.83139),
    ("Retail Individual Investors(RIIs)", 44101125, 31859904, 0.72243),
    ("Employees", 433436, 661768, 1.52680),
    ("Total", 88642911, 102843656, 1.16020),
]

# plotData is 86 points, one per rupee. The two ends and the shape between them
# are what the page draws; the full ladder is regenerated linearly between the
# captured anchors rather than transcribing all 86 by hand.
NSE_CURVE_ANCHORS = [
    (1700, 103089496), (1710, 102951864), (1720, 102937856), (1730, 102918528),
    (1740, 102907304), (1750, 102896584), (1760, 102828640), (1770, 102814736),
    (1780, 102796880), (1785, 102715944),
]

PAST = [
    dict(symbol="MPIMANIPAL", company="Manipal Payment and Identity Solutions Limited",
         series="EQ", opens="2026-09-09", closes="2026-09-11", listed="2026-09-17",
         issuePrice=339.0, bandLow=322.0, bandHigh=339.0),
    dict(symbol="VEEGALAND", company="Veegaland Developers Limited",
         series="BE", opens="2026-09-10", closes="2026-09-15", listed="2026-09-18",
         issuePrice=140.0, bandLow=130.0, bandHigh=140.0),
    dict(symbol="MANIKA", company="Manika Plastech Limited",
         series="EQ", opens="2026-09-11", closes="2026-09-16", listed=None,
         issuePrice=None, bandLow=40.0, bandHigh=43.0),
]


def curve():
    pts, anchors = [], NSE_CURVE_ANCHORS
    for i in range(len(anchors) - 1):
        p0, q0 = anchors[i]
        p1, q1 = anchors[i + 1]
        span = p1 - p0
        for step in range(span):
            frac = step / span
            pts.append({"price": float(p0 + step), "qty": round(q0 + (q1 - q0) * frac)})
    pts.append({"price": float(anchors[-1][0]), "qty": anchors[-1][1]})
    return pts


def main():
    out_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    payload = {
        "generated_at": CAPTURED,
        "ok": True,
        "origin": "capture",
        "source": "nseindia.com/api — read live on 20 Sep 2026 and stored so the page "
                  "could be built against real rows. The workflow replaces this whole "
                  "file on its first run.",
        "counts": {"pipeline": len(PIPELINE), "detailed": 1,
                   "past": len(PAST), "priced": 0},
        "issues": PIPELINE,
        "details": {
            "NSE": {
                "symbol": "NSE",
                "book": [
                    {"category": c, "offered": float(o), "bid": float(b), "times": t}
                    for c, o, b, t in NSE_BOOK
                ],
                "demand": {
                    "points": curve(),
                    "cutOffQty": 29222680.0,
                    "totalBids": 103089496.0,
                    "issueSize": 88642911.0,
                    "subscribed": 1.16,
                    "asOf": "As on 18-Sep-2026 19:00:00 IST",
                },
                "docs": {
                    "rhp": "https://nsearchives.nseindia.com/content/ipo/RHP_NSE.zip",
                    "ratios": "https://nsearchives.nseindia.com/content/ipo/RATIOS_NSE.zip",
                    "anchor": "https://nsearchives.nseindia.com/content/ipo/ANCHOR_NSE.zip",
                },
                "issueType": "Book Building",
                "faceValue": 1.0,
                "lotText": "8 Equity Shares and in multiples thereof",
                "issueSizeText": "Initial Public Offer comprising of Offer for Sale of upto "
                                 "126,436,650 Equity Shares (including Employee Reservation "
                                 "Portion aggregating up to Rs. 700 million and Anchor Portion "
                                 "of 37,793,739 Equity Shares)",
                "discount": "Rs. 170 per equity share to Eligible Employees",
                "registrar": "MUFG Intime India Private Limited",
                "leadManagers": [
                    "Kotak Mahindra Capital Company Limited", "JM Financial Limited",
                    "Morgan Stanley India Company Private Limited",
                    "Citigroup Global Markets India Private Limited",
                    "HSBC Securities and Capital Markets (India) Private Limited",
                    "J.P. Morgan India Private Limited", "Axis Capital Limited",
                    "ICICI Securities Limited", "SBI Capital Markets Limited",
                ],
                "updatedAt": "Updated as on 18-Sep-2026 19:00:00",
            }
        },
        "past": PAST,
        "lanes": [
            {"name": "upcoming issues", "ok": True, "count": len(PIPELINE), "error": ""},
            {"name": "live subscription", "ok": True, "count": 5, "error": ""},
            {"name": "past issues", "ok": True, "count": len(PAST), "error": ""},
            {"name": "detail NSE", "ok": True, "count": len(NSE_BOOK), "error": ""},
            {"name": "listing gains priced", "ok": False, "count": 0,
             "error": "Yahoo not reachable from the session that seeded this file"},
        ],
        "gmp": None,
    }
    path = out_dir / "ipo.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes, "
          f"{len(payload['issues'])} issues, {len(curve())} curve points)")


if __name__ == "__main__":
    main()
