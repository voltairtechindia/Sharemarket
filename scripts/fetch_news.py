"""Aggregate free market news RSS, dedupe it, and tag each item with the sectors
and stocks that are likely to react. No API keys anywhere in this file."""
import hashlib
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote_plus

import feedparser

from common import Lanes, get, load_cfg, now_ist, now_iso, write_json

MAX_ITEMS = 150
TAG_RE = re.compile(r"<[^>]+>")


def clean(text, limit=400):
    return TAG_RE.sub("", (text or "")).replace("&nbsp;", " ").strip()[:limit]


def norm_title(title):
    return re.sub(r"[^a-z0-9 ]", "", (title or "").lower()).strip()


def to_iso(entry):
    for field in ("published_parsed", "updated_parsed"):
        t = entry.get(field)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc).isoformat(timespec="seconds")
    return now_iso()


def parse_feed(url, source):
    r = get(url, retries=1, timeout=25)
    parsed = feedparser.parse(r.content)
    out = []
    for e in parsed.entries[:40]:
        title = clean(e.get("title", ""), 300)
        if not title:
            continue
        out.append({
            "id": hashlib.sha1((title + source).encode()).hexdigest()[:12],
            "title": title,
            "summary": clean(e.get("summary", ""), 320),
            "link": e.get("link", ""),
            "source": source,
            "published": to_iso(e),
        })
    if not out:
        raise RuntimeError("feed parsed but had no usable entries")
    return out


_word_cache = {}


def has_word(blob, word):
    """Whole-word match so 'ev' does not fire on 'every' and 'sail' not on 'sailing'."""
    rx = _word_cache.get(word)
    if rx is None:
        rx = _word_cache[word] = re.compile(r"(?<!\w)" + re.escape(word) + r"(?!\w)")
    return bool(rx.search(blob))


def tag(item, kw):
    blob = f"{item['title']} {item['summary']}".lower()
    sectors, stocks = [], []
    for sector, spec in (kw.get("sectors") or {}).items():
        if any(has_word(blob, w) for w in spec.get("words", [])):
            sectors.append(sector)
            stocks.extend(spec.get("stocks", []))

    hits = [w for w in kw.get("high_impact", []) if has_word(blob, w)]
    score = 2 * len(hits) + len(sectors)

    bull = sum(1 for w in kw.get("bullish", []) if has_word(blob, w))
    bear = sum(1 for w in kw.get("bearish", []) if has_word(blob, w))
    direction = "up" if bull > bear else "down" if bear > bull else "flat"

    item["sectors"] = sectors[:4]
    item["stocks"] = sorted(set(stocks))[:8]
    item["triggers"] = hits[:4]
    item["impact"] = "high" if score >= 3 else "medium" if score >= 1 else "low"
    item["direction"] = direction
    return item


def dedupe(items):
    seen, out = set(), []
    for it in sorted(items, key=lambda x: x["published"], reverse=True):
        key = norm_title(it["title"])[:70]
        if key and key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def main():
    feeds = load_cfg("feeds.yml")
    kw = load_cfg("keywords.yml")
    lanes = Lanes()
    items = []

    for f in feeds.get("news", []):
        items += lanes.run(f["name"], lambda f=f: parse_feed(f["url"], f["name"]))
        time.sleep(0.3)

    params = feeds.get("google_news_params", "hl=en-IN&gl=IN&ceid=IN:en")
    for g in feeds.get("google_news", []):
        url = f"https://news.google.com/rss/search?q={quote_plus(g['q'])}&{params}"
        items += lanes.run(f"google:{g['name']}", lambda u=url, n=g["name"]: parse_feed(u, n))
        time.sleep(0.3)

    items = [tag(i, kw) for i in dedupe(items)][:MAX_ITEMS]
    rank = {"high": 0, "medium": 1, "low": 2}
    top = sorted(items, key=lambda i: (rank[i["impact"]], i["published"]), reverse=False)[:12]

    sector_counts = {}
    for i in items:
        for s in i["sectors"]:
            sector_counts[s] = sector_counts.get(s, 0) + 1

    write_json("news.json", {
        "generated_at": now_iso(),
        "generated_at_ist": now_ist(),
        "items": items,
        "top": top,
        "sector_activity": dict(sorted(sector_counts.items(), key=lambda x: -x[1])),
        "lanes": lanes.as_list(),
    })


if __name__ == "__main__":
    main()
