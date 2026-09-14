"""Fill data/ with obviously fake numbers so you can preview the UI offline.

    python scripts/demo_data.py && python -m http.server 8000

Run any real fetcher afterwards to overwrite it. Never commit demo data.
"""
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
now = datetime.now(timezone.utc)
iso = lambda m=0: (now - timedelta(minutes=m)).isoformat(timespec="seconds")  # noqa: E731
ri = lambda a, b: random.randint(int(a), int(b))  # noqa: E731


def q(sym, label, price, pct):
    prev = price / (1 + pct / 100)
    return {
        "symbol": sym, "label": label, "price": round(price, 2),
        "prev_close": round(prev, 2), "change": round(price - prev, 2),
        "change_pct": pct, "day_high": round(price * 1.004, 2),
        "day_low": round(price * 0.996, 2), "currency": "INR",
        "exchange_state": "DEMO",
        "spark": [round(prev + (price - prev) * i / 59
                        + random.uniform(-price * 8e-4, price * 8e-4), 2) for i in range(60)],
    }


strikes = [{
    "strike": k, "ce_ltp": round(max(2, 25000 - k + 120) * 0.9, 2), "ce_oi": ri(2e5, 3e6),
    "ce_oi_chg": ri(-4e5, 6e5), "ce_iv": round(random.uniform(11, 19), 1),
    "pe_ltp": round(max(2, k - 24800 + 110) * 0.9, 2), "pe_oi": ri(2e5, 3e6),
    "pe_oi_chg": ri(-4e5, 6e5), "pe_iv": round(random.uniform(11, 19), 1),
} for k in range(24600, 25101, 50)]

market = {
    "generated_at": iso(3), "generated_at_ist": iso(3),
    "headline": [q("^NSEI", "Nifty 50", 24812.4, 0.43), q("^NSEBANK", "Bank Nifty", 54219.8, -0.31),
                 q("^BSESN", "Sensex", 81044.1, 0.38), q("^INDIAVIX", "India VIX", 12.84, -2.10)],
    "india": [q("^CNXIT", "Nifty IT", 38210.5, -1.12), q("^CNXAUTO", "Nifty Auto", 25110.2, 0.88),
              q("^CNXPHARMA", "Nifty Pharma", 21880.0, 0.21), q("^CNXMETAL", "Nifty Metal", 9440.7, 1.64)],
    "global": [q("^GSPC", "S&P 500", 5810.2, 0.22), q("^IXIC", "Nasdaq", 18422.6, 0.51),
               q("^VIX", "CBOE VIX", 14.9, -3.2), q("^N225", "Nikkei 225", 39120.0, -0.44)],
    "macro": [q("USDINR=X", "USD / INR", 88.42, 0.12), q("CL=F", "Crude (WTI)", 71.30, -1.44),
              q("GC=F", "Gold", 3420.5, 0.62), q("BTC-USD", "Bitcoin", 92100.0, 2.31)],
    "gainers": [q("TATASTEEL.NS", "Tata Steel", 168.4, 3.1), q("HINDALCO.NS", "Hindalco", 702.2, 2.4),
                q("SBIN.NS", "SBI", 842.0, 1.6)],
    "losers": [q("INFY.NS", "Infosys", 1544.0, -2.2), q("TCS.NS", "TCS", 3102.5, -1.8),
               q("HDFCBANK.NS", "HDFC Bank", 1712.0, -0.9)],
    "options": {"NIFTY": {"spot": 24812.4, "expiry": "demo", "pcr": 1.14,
                          "total_ce_oi": 41200000, "total_pe_oi": 46900000,
                          "max_pain": 24800, "strikes": strikes, "source": "demo"}},
    "lanes": [{"name": "yahoo:headline", "ok": True, "count": 4, "error": ""},
              {"name": "options:nse", "ok": False, "count": 0, "error": "blocked on runner"},
              {"name": "options:dhan", "ok": True, "count": 1, "error": ""}],
}

news = {
    "generated_at": iso(8), "generated_at_ist": iso(8),
    "sector_activity": {"banking": 4, "metals": 3, "it": 2},
    "items": [
        {"id": "d1", "title": "RBI holds repo rate, flags sticky food inflation",
         "summary": "Demo item. The MPC kept the repo rate unchanged and retained a neutral stance.",
         "link": "#", "source": "Moneycontrol markets", "published": iso(12),
         "sectors": ["banking"], "stocks": ["HDFCBANK", "ICICIBANK", "SBIN"],
         "triggers": ["repo rate", "inflation"], "impact": "high", "direction": "flat"},
        {"id": "d2", "title": "Tata Steel gains as China stimulus lifts iron ore prices",
         "summary": "Demo item. Metal prices surge on fresh stimulus.",
         "link": "#", "source": "ET markets", "published": iso(26), "sectors": ["metals"],
         "stocks": ["TATASTEEL", "JSWSTEEL", "HINDALCO"], "triggers": ["stimulus"],
         "impact": "high", "direction": "up"},
        {"id": "d3", "title": "Nifty IT slides on fresh US visa fee proposal",
         "summary": "Demo item. Selloff across IT stocks.", "link": "#",
         "source": "Tariffs / Trump", "published": iso(41), "sectors": ["it"],
         "stocks": ["TCS", "INFY", "WIPRO"], "triggers": ["tariff"],
         "impact": "high", "direction": "down"},
        {"id": "d4", "title": "Rupee ends flat against the dollar", "summary": "",
         "link": "#", "source": "Livemint markets", "published": iso(63), "sectors": [],
         "stocks": [], "triggers": [], "impact": "low", "direction": "flat"},
    ],
    "top": [],
    "lanes": [{"name": "Moneycontrol markets", "ok": True, "count": 30, "error": ""},
              {"name": "Financial Express", "ok": False, "count": 0, "error": "HTTP 403"}],
}

social = {
    "generated_at": iso(9), "generated_at_ist": iso(9), "x_available": False,
    "items": [
        {"id": "e1", "platform": "reddit", "source": "r/IndianStreetBets",
         "author": "r/IndianStreetBets", "text": "Demo post. Bank Nifty 54200 CE printing, anyone holding into expiry?",
         "link": "#", "published": iso(14), "relevant": True},
        {"id": "e2", "platform": "telegram", "source": "tg/nsebseupdates",
         "author": "tg/nsebseupdates", "text": "Demo post. FII net sell 2,140 cr in cash, DII net buy 1,980 cr",
         "link": "#", "published": iso(22), "relevant": True},
        {"id": "e3", "platform": "reddit", "source": "r/IndiaInvestments",
         "author": "r/IndiaInvestments", "text": "Demo post. Which ELSS fund do you all use?",
         "link": "#", "published": iso(35), "relevant": False},
    ],
    "relevant": [],
    "lanes": [{"name": "r/IndianStreetBets", "ok": True, "count": 25, "error": ""},
              {"name": "x:@realDonaldTrump", "ok": False, "count": 0, "error": "all mirrors failed"}],
}

out = ROOT / "data"
out.mkdir(exist_ok=True)
for name, payload in (("market", market), ("news", news), ("social", social)):
    (out / f"{name}.json").write_text(json.dumps(payload, separators=(",", ":")))
print("demo data written to data/. Run a real fetcher to replace it.")
