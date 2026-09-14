"""Fetch the whole feed universe server side, filter the noise out, score what is left.

Runs on GitHub Actions (or locally) where there is no CORS wall, so it can reach
the ~85% of Indian and international feeds a browser cannot fetch directly.

Writes:
  data/news.json         headlines, filtered and scored (schema kept backward compatible)
  data/news_rollup.json  hourly sentiment buckets - what the chart hangs its reasons on
  data/feed_health.json  which feeds are alive, so the UI can show a true count

Nothing here ever raises: a dead feed is recorded and skipped.
"""
import hashlib
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import feedparser
import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import DATA, IST, ROOT, UA, now_ist, now_iso, write_json  # noqa: E402

MAX_ITEMS = 600          # hard cap on stored headlines
TTL_HOURS = 72           # anything older is dropped
MAX_SUMMARY = 220        # characters kept per item, no article bodies
WORKERS = 24
FEED_TIMEOUT = 12

LEX = json.loads((ROOT / "config" / "lexicon.json").read_text(encoding="utf-8"))
BULL, BEAR = LEX["bullish"], LEX["bearish"]
IMPACT_HI = [k.lower() for k in LEX["impact_high"]]
IMPACT_MD = [k.lower() for k in LEX["impact_medium"]]
RELEVANCE = [k.lower() for k in LEX["relevance"]]
NOISE = [k.lower() for k in LEX["noise"]]
SECTORS = {k: [t.lower() for t in v] for k, v in LEX["sector_map"].items()}

# Terms are matched longest-first on word boundaries, and each match is blanked
# out of the working copy. That stops "ban" scoring inside "banking" and stops
# "surge" double counting after "surges" has already matched.
def _compile(table):
    out = []
    for term, weight in table.items():
        out.append((len(term), term, weight, re.compile(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])")))
    out.sort(key=lambda x: -x[0])
    return out


BULL_RX = _compile(BULL)
BEAR_RX = _compile(BEAR)


def norm(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def key_of(title):
    """Dedupe key: lowercase alphanumerics only, so re-syndicated copies collapse."""
    return hashlib.sha1(re.sub(r"[^a-z0-9]", "", (title or "").lower()).encode()).hexdigest()[:16]


def score_text(text):
    """Return (sentiment -4..4, impact 'high'|'medium'|'low', matched terms)."""
    low = " " + text.lower() + " "
    work = low
    hits, total = [], 0.0
    for _, term, w, rx in BULL_RX + BEAR_RX:
        m = rx.search(work)
        if m:
            total += w
            hits.append(term)
            work = work[: m.start()] + (" " * (m.end() - m.start())) + work[m.end():]
    # Compress so a headline stuffed with words cannot dominate.
    sentiment = max(-4.0, min(4.0, total / 2.0))

    impact = "low"
    if any(k in low for k in IMPACT_HI):
        impact = "high"
    elif any(k in low for k in IMPACT_MD):
        impact = "medium"
    return round(sentiment, 2), impact, hits[:6]


def sector_of(text):
    low = text.lower()
    best, best_n = "general", 0
    for name, terms in SECTORS.items():
        n = sum(1 for t in terms if t in low)
        if n > best_n:
            best, best_n = name, n
    return best


def is_noise(text):
    low = text.lower()
    if any(n in low for n in NOISE):
        return True
    # Must say something market related, otherwise it is not our business.
    return not any(r in low for r in RELEVANCE)


def parse_time(entry):
    for attr in ("published_parsed", "updated_parsed"):
        tm = getattr(entry, attr, None)
        if tm:
            try:
                return datetime(*tm[:6], tzinfo=timezone.utc)
            except Exception:  # noqa: BLE001
                pass
    return datetime.now(timezone.utc)


def pick_feeds(feeds, cycle):
    """Priority 1 every cycle, 2 every 3rd, 3 every 10th."""
    out = []
    for f in feeds:
        p = f.get("priority", 3)
        if p <= 1 or (p == 2 and cycle % 3 == 0) or (p == 3 and cycle % 10 == 0):
            out.append(f)
    return out


def fetch_one(feed, session):
    url = feed["url"]
    try:
        r = session.get(
            url,
            headers={"User-Agent": UA, "Accept": "application/rss+xml,application/xml,text/xml,*/*"},
            timeout=FEED_TIMEOUT,
        )
        if r.status_code != 200:
            return feed, [], f"HTTP {r.status_code}"
        parsed = feedparser.parse(r.content)
        if not parsed.entries:
            return feed, [], "no entries"
        return feed, parsed.entries[:25], ""
    except Exception as exc:  # noqa: BLE001
        return feed, [], type(exc).__name__


def load_existing():
    path = DATA / "news.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("news_items", [])
    except Exception:  # noqa: BLE001
        return []


def main():
    index_path = DATA / "feeds_index.json"
    if not index_path.exists():
        print("feeds_index.json missing - run scripts/feeds_build.py first")
        return 1
    feeds = json.loads(index_path.read_text(encoding="utf-8"))["feeds"]

    cycle = int(time.time() // 300)  # one cycle per 5 minutes
    due = pick_feeds(feeds, cycle)
    print(f"cycle {cycle}: polling {len(due)} of {len(feeds)} feeds")

    session = requests.Session()
    results, health = [], []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_one, f, session) for f in due]
        for fut in as_completed(futures):
            feed, entries, err = fut.result()
            health.append(
                {"id": feed["id"], "name": feed["name"], "lane": feed["lane"],
                 "ok": not err, "n": len(entries), "err": err}
            )
            for e in entries:
                results.append((feed, e))

    alive = sum(1 for h in health if h["ok"])
    print(f"  {alive}/{len(due)} feeds alive, {len(results)} raw entries")

    # ---------------------------------------------------------------- filter
    existing = load_existing()
    seen = {i.get("key") or key_of(i.get("headline", "")) for i in existing}
    fresh, dropped_noise, dropped_dupe = [], 0, 0

    for feed, e in results:
        title = norm(getattr(e, "title", ""))
        if len(title) < 18:
            continue
        summary = norm(re.sub(r"<[^>]+>", " ", getattr(e, "summary", "")))[:MAX_SUMMARY]
        blob = f"{title}. {summary}"
        if is_noise(blob):
            dropped_noise += 1
            continue
        k = key_of(title)
        if k in seen:
            dropped_dupe += 1
            continue
        seen.add(k)

        sentiment, impact, hits = score_text(blob)
        ts = parse_time(e)
        sector = sector_of(blob)
        tag = "Positive" if sentiment > 0.6 else ("Negative" if sentiment < -0.6 else "Neutral")

        fresh.append(
            {
                # --- original schema, unchanged so existing readers keep working
                "headline": title,
                "industry": sector,
                "impact_tag": tag,
                "source": feed["name"],
                "tags": feed.get("tags", []),
                "timestamp": ts.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S"),
                "priority": {1: "high", 2: "medium", 3: "low"}.get(feed.get("priority", 3), "low"),
                "region": "indian" if feed["region"] == "india" else "international",
                # --- added fields
                "key": k,
                "url": getattr(e, "link", "")[:400],
                "ts": int(ts.timestamp()),
                "sentiment": sentiment,
                "impact": impact,
                "terms": hits,
                "lane": feed["lane"],
                "summary": summary,
            }
        )

    print(f"  kept {len(fresh)} | noise {dropped_noise} | dupes {dropped_dupe}")

    # ------------------------------------------------------------ merge, cap
    merged = fresh + existing
    cutoff = int((datetime.now(timezone.utc) - timedelta(hours=TTL_HOURS)).timestamp())
    merged = [m for m in merged if m.get("ts", cutoff + 1) >= cutoff]
    merged.sort(key=lambda m: (m.get("ts", 0)), reverse=True)
    merged = merged[:MAX_ITEMS]

    write_json(
        "news.json",
        {
            "updated_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            "updated_iso": now_iso(),
            "cycle": cycle,
            "feeds_polled": len(due),
            "feeds_alive": alive,
            "feeds_total": len(feeds),
            "kept": len(fresh),
            "dropped_noise": dropped_noise,
            "dropped_duplicate": dropped_dupe,
            "news_items": merged,
        },
    )

    # --------------------------------------------------------- hourly rollup
    buckets = {}
    for m in merged:
        hour = (m["ts"] // 3600) * 3600
        b = buckets.setdefault(hour, {"t": hour, "n": 0, "sum": 0.0, "hi": 0, "top": None, "topAbs": 0.0})
        b["n"] += 1
        b["sum"] += m["sentiment"]
        if m["impact"] == "high":
            b["hi"] += 1
        weight = abs(m["sentiment"]) * (3 if m["impact"] == "high" else 2 if m["impact"] == "medium" else 1)
        if weight > b["topAbs"]:
            b["topAbs"] = weight
            b["top"] = {"h": m["headline"][:180], "s": m["sentiment"], "i": m["impact"],
                        "src": m["source"], "sec": m["industry"], "u": m["url"]}
    rollup = []
    for hour in sorted(buckets):
        b = buckets[hour]
        rollup.append({"t": b["t"], "n": b["n"], "avg": round(b["sum"] / max(1, b["n"]), 3),
                       "high": b["hi"], "top": b["top"]})

    recent = [m for m in merged if m["ts"] >= int(time.time()) - 86400]
    net = round(sum(m["sentiment"] for m in recent) / max(1, len(recent)), 3)
    write_json(
        "news_rollup.json",
        {
            "updated_iso": now_iso(),
            "net_sentiment_24h": net,
            "items_24h": len(recent),
            "high_impact_24h": sum(1 for m in recent if m["impact"] == "high"),
            "by_sector": {
                s: round(
                    sum(m["sentiment"] for m in recent if m["industry"] == s)
                    / max(1, sum(1 for m in recent if m["industry"] == s)), 3)
                for s in {m["industry"] for m in recent}
            },
            "hourly": rollup[-192:],
        },
    )

    health.sort(key=lambda h: (h["ok"], h["n"]), reverse=True)
    write_json(
        "feed_health.json",
        {"updated_iso": now_iso(), "polled": len(due), "alive": alive,
         "total_configured": len(feeds), "feeds": health},
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
