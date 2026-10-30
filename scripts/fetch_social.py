"""The crowd's mood: Tickertape's Market Mood Index, the StockTwits streams for
NIFTY and BANK NIFTY and, when it answers without a key, Reddit.

Writes data/social.json, which the forecast's crowd lane reads
(assets/js/forecast.js crowdLane and socialFor), with the call the workflow
freezes (scripts/daily_call.js) and the AI desk's sentiment analyst.

Free and keyless, every source. Nothing here raises: a source that fails keeps
its last good reading, with that reading's own time on it so the lane can tell
how old it is, and is recorded as failed under `sources`.

Reddit (r/IndianStreetBets and three others) answers 403 to anonymous requests
from most cloud addresses, the proxies the page uses among them (measured 6
and 30 Oct 2026). It is tried once a run through the public RSS with an honest
User-Agent and left out when it refuses. No key is ever used.

Run:  python scripts/fetch_social.py
"""
import calendar
import re
import time
from datetime import datetime

import feedparser

from common import UA, get, load_cfg, now_iso, previous, write_json

MMI_URL = "https://api.tickertape.in/mmi/now"
ST_URL = "https://api.stocktwits.com/api/2/streams/symbol/{sym}.json"
# The page's own mapping (data.js stocktwitsSymbol). SENSEX has no stream.
ST_SYMBOLS = {"NIFTY": "NIFTY50.NSE", "BANKNIFTY": "NIFTYBANK.NSE"}
# The subreddits listed in config/feeds.yml (`reddit:`), these when it is unreadable.
REDDIT_DEFAULT = ["IndianStreetBets", "IndiaInvestments", "StockMarketIndia", "DalalStreetTalks"]
REDDIT_URL = "https://www.reddit.com/r/{sub}/new/.rss?limit=50"
# Subreddits about markets everywhere: a post counts only when it names India.
GLOBAL_SUBS = {"options", "investing", "stocks", "wallstreetbets", "stockmarket", "economics"}
INDIA_RX = re.compile(r"\b(india|indian|nifty|sensex|nse|bse|rupee|rbi|sebi|dalal)\b", re.I)
REDDIT_UA = "sharemarket-terminal/1.0 (public market dashboard; github.com/voltairtechindia/Sharemarket)"

# Same filter the page applies (data.js PROMO_RX): tip-selling is not a mood.
PROMO_RX = re.compile(r"telegram|whatsapp|\bjoin (?:my|our|the|now)\b|\bdm me\b|free (?:tips|calls|trial)|"
                      r"\bt\.me\b|link in bio", re.I)
MARKET_RX = re.compile(r"\b(nifty|sensex|bank ?nifty|markets?|stocks?|shares?|fii|dii|rbi|sebi|ipo|f&o|options?|"
                       r"expiry|rally|crash|correction|bull|bear|portfolio|sip)\b", re.I)
MAX_AGE_SEC = 3 * 86400      # StockTwits messages older than this are not today's crowd
REDDIT_AGE_SEC = 2 * 86400
CARRY_SEC = 36 * 3600        # a carried reading older than this is dropped (the lane's own limit)


def zone(v):
    return "extreme fear" if v < 30 else "fear" if v < 50 else "greed" if v < 70 else "extreme greed"


def epoch(text):
    if not text:
        return None
    try:
        return int(datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def clean(text):
    text = re.sub(r"https?://\S+", "", str(text or ""))
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


def mood_index():
    r = get(MMI_URL, headers={"Accept": "application/json"}, timeout=15, retries=1)
    d = (r.json() or {}).get("data") or {}
    v = d.get("indicator")
    if not isinstance(v, (int, float)):
        raise RuntimeError("no indicator in the answer")

    def ind(x):
        return round(x["indicator"], 1) if isinstance(x, dict) and isinstance(x.get("indicator"), (int, float)) else None

    return {"now": round(v, 1), "zone": zone(v), "day": ind(d.get("lastDay")), "week": ind(d.get("lastWeek")),
            "month": ind(d.get("lastMonth")), "at": epoch(d.get("date")) or int(time.time())}


def stocktwits(sym):
    r = get(ST_URL.format(sym=sym), headers={"Accept": "application/json"}, timeout=15, retries=1)
    msgs = (r.json() or {}).get("messages") or []
    now = time.time()
    bull = bear = promo = 0
    items = []
    for m in msgs:
        ts = epoch(m.get("created_at"))
        if not ts or now - ts > MAX_AGE_SEC:
            continue
        body = clean(m.get("body"))
        if not body or PROMO_RX.search(body):
            promo += 1
            continue
        tag = (((m.get("entities") or {}).get("sentiment") or {}).get("basic"))
        if tag == "Bullish":
            bull += 1
        elif tag == "Bearish":
            bear += 1
        items.append({"ts": ts, "text": body[:180], "tag": tag.lower() if tag in ("Bullish", "Bearish") else None})
    if not items:
        raise RuntimeError("no recent messages" if not promo else "only promotions")
    items.sort(key=lambda x: -x["ts"])
    return {"symbol": sym, "n": len(items), "bull": bull, "bear": bear, "promo": promo,
            "from": items[-1]["ts"], "to": items[0]["ts"], "items": items[:10]}


def reddit_subs():
    try:
        rows = (load_cfg("feeds.yml") or {}).get("reddit") or []
    except Exception:  # noqa: BLE001 - a broken file falls back to the default list
        rows = []
    subs = []
    for row in rows:
        m = re.search(r"/r/([A-Za-z0-9_]+)", str((row or {}).get("url") or (row or {}).get("name") or ""))
        if m and m.group(1) not in subs:
            subs.append(m.group(1))
    return subs or REDDIT_DEFAULT


def reddit():
    """Recent posts about the market from the subreddits in config/feeds.yml,
    scored with the news word list. Stops at the first refusal: a 403 or 429
    from one subreddit is the same answer for all of them."""
    try:
        from fetch_news import score_text
    except Exception:  # noqa: BLE001 - the lexicon is optional here
        score_text = None
    now = time.time()
    subs = reddit_subs()
    posts, ok_subs, errors = [], [], []
    for sub in subs:
        try:
            r = get(REDDIT_URL.format(sub=sub), timeout=15, retries=0,
                    headers={"User-Agent": REDDIT_UA, "Accept": "application/atom+xml,application/xml,*/*"})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"r/{sub}: {exc}")
            if re.search(r"40[13]|429", str(exc)):
                break
            continue
        feed = feedparser.parse(r.content)
        if not feed.entries:
            errors.append(f"r/{sub}: no entries")
            continue
        ok_subs.append(sub)
        for e in feed.entries:
            tm = getattr(e, "updated_parsed", None) or getattr(e, "published_parsed", None)
            ts = calendar.timegm(tm) if tm else None
            title = clean(getattr(e, "title", ""))
            if not ts or now - ts > REDDIT_AGE_SEC or len(title) < 12:
                continue
            if PROMO_RX.search(title) or not MARKET_RX.search(title):
                continue
            if sub.lower() in GLOBAL_SUBS and not INDIA_RX.search(title):
                continue
            s = score_text(title)[0] if score_text else 0.0
            posts.append({"ts": ts, "sub": sub, "title": title[:200], "s": round(s, 2),
                          "tag": "bullish" if s > 0.6 else "bearish" if s < -0.6 else None})
        time.sleep(1.0)
    posts.sort(key=lambda p: -p["ts"])
    if not ok_subs:
        return {"ok": False, "why": "; ".join(errors)[:300] or "no answer", "tried": subs}
    return {"ok": True, "subs": ok_subs, "n": len(posts),
            "bull": sum(1 for p in posts if p["tag"] == "bullish"),
            "bear": sum(1 for p in posts if p["tag"] == "bearish"),
            "posts": posts[:25], "why": "; ".join(errors)[:300] or None}


def fresh(reading, stamp_key):
    """A carried reading, if it is still young enough to vote."""
    if not isinstance(reading, dict):
        return None
    t = reading.get(stamp_key)
    return reading if isinstance(t, (int, float)) and time.time() - t <= CARRY_SEC else None


def main():
    prev = previous("social.json")
    sources = []

    try:
        mood = mood_index()
        sources.append({"name": "Tickertape mood index", "ok": True, "n": 1})
    except Exception as exc:  # noqa: BLE001
        mood = fresh(prev.get("mood"), "at")
        if mood:
            mood = dict(mood, carried=True)
        sources.append({"name": "Tickertape mood index", "ok": False, "why": str(exc)[:160]})

    symbols = {}
    for key, sym in ST_SYMBOLS.items():
        try:
            crowd = stocktwits(sym)
            sources.append({"name": "StockTwits " + sym, "ok": True, "n": crowd["n"]})
        except Exception as exc:  # noqa: BLE001
            crowd = fresh(((prev.get("symbols") or {}).get(key) or {}).get("crowd"), "to")
            if crowd:
                crowd = dict(crowd, carried=True)
            sources.append({"name": "StockTwits " + sym, "ok": False, "why": str(exc)[:160]})
        if crowd:
            symbols[key] = {"crowd": crowd}
        time.sleep(0.5)

    rd = reddit()
    sources.append({"name": "Reddit", "ok": bool(rd.get("ok")), "n": rd.get("n", 0),
                    **({} if rd.get("ok") else {"why": rd.get("why")})})

    payload = {
        "generated_at": now_iso(),
        "source": "scripts/fetch_social.py",
        "ok": bool(mood or symbols or rd.get("ok")),
        "mood": mood,
        "symbols": symbols,
        "reddit": rd,
        "sources": sources,
    }
    write_json("social.json", payload)
    for s in sources:
        print(f"  [{'ok ' if s['ok'] else 'FAIL'}] {s['name']}" + (f"  {s.get('n')}" if s["ok"] else f"  {s.get('why')}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
