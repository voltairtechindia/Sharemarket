#!/usr/bin/env python3
"""Append today's scored headlines to a compact daily archive.

Why this exists
---------------
The news lane carries the heaviest weight in the forecast (0.24) and has never
been scored, not once. calibrate() can replay momentum, levels, structure and
seasonal because those are functions of the price series, which is kept. It
cannot replay news, because nothing kept the news. Every accuracy number this
project has ever printed is therefore silent about 47% of the model's weight.

There is no way to fix that retroactively - the feed is a rolling window and a
headline that has aged out is gone. The only fix is to start keeping it, which
costs three lines in the workflow and pays off in about three months. So this
runs every cycle from now on.

What is kept, and what is not
-----------------------------
Only the fields the lane actually reads: timestamp, sentiment, impact, region.
Plus a truncated headline and source so a post-mortem can name what landed,
and the dedupe key so the same story arriving in ten consecutive sweeps is
stored once.

Dropped: url, summary, tags, terms, industry, priority, impact_tag, lane. Those
are 85% of the bytes and none of them are inputs to newsLane(). The headline is
kept only for items loud enough that a post-mortem might name them.

Measured on a real 600-item sweep: 427 KB whole, 114 KB with every headline,
and the figure printed by this script with the headline rule applied. Over the
90-day window that is the difference between an archive that fits in the
live-data tree and one that does not - the branch is a single rewritten tree,
so whatever is in it sits there on every fetch.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
SOURCE = os.path.join(DATA, "news.json")
ARCHIVE_DIR = os.path.join(DATA, "news_archive")

# Ninety days is the point where the news lane becomes backtestable on a daily
# horizon with enough non-overlapping windows for a Kupiec test to say anything.
# Beyond that the marginal day buys little and the tree keeps growing.
KEEP_DAYS = 90

# The lane reads these and nothing else. See newsLane() in assets/js/forecast.js.
FIELDS = ("ts", "sentiment", "impact", "region")


def load(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def main():
    payload = load(SOURCE, None)
    if not payload:
        print("no news.json to archive")
        return 0

    items = payload.get("news_items") or []
    if not items:
        print("news.json holds no items; nothing to archive")
        return 0

    day = datetime.now(IST).strftime("%Y-%m-%d")
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    target = os.path.join(ARCHIVE_DIR, day + ".json")

    existing = load(target, {"day": day, "items": []})
    by_key = {}
    for row in existing.get("items", []):
        if row.get("k"):
            by_key[row["k"]] = row

    added = 0
    for item in items:
        key = item.get("key")
        ts = item.get("ts")
        if not key or not ts:
            continue
        if key in by_key:
            continue
        sentiment = item.get("sentiment", 0) or 0
        impact = item.get("impact", "low")
        row = {
            # Eight hex characters, not the full sixteen. This only has to
            # deduplicate within one day - a few thousand items against 4.3
            # billion slots - and the key is 30% of the bytes at full length.
            "k": key[:8],
            "ts": ts,
            "s": round(float(sentiment), 2),
            "i": impact,
            "r": (item.get("region") or "")[:2],
        }
        # The headline is by far the largest field and the lane never reads it.
        # It is kept only for items a post-mortem could actually name, which is
        # what arrivalsIn() ranks by: impact weight times absolute sentiment.
        # Storing every neutral wire story's headline cost 30-50 MB over the
        # retention window and bought nothing.
        if impact == "high" or abs(float(sentiment)) >= 0.5:
            row["h"] = (item.get("headline") or "")[:120]
            row["src"] = (item.get("source") or "")[:40]
        by_key[key] = row
        added += 1

    rows = sorted(by_key.values(), key=lambda r: r["ts"])
    with open(target, "w", encoding="utf-8") as fh:
        json.dump({"day": day, "count": len(rows), "items": rows}, fh, separators=(",", ":"))

    prune()
    size = os.path.getsize(target)
    print("archived %d new (%d total) for %s, %.1f KB" % (added, len(rows), day, size / 1024))
    return 0


def prune():
    """Drop day files older than KEEP_DAYS, and rewrite the index.

    The index is what a backtest reads to know what exists without listing a
    directory it cannot list - the page fetches over HTTP and there is no
    directory listing on raw.githubusercontent.com.
    """
    cutoff = (datetime.now(IST) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    days = []
    for name in sorted(os.listdir(ARCHIVE_DIR)):
        if not name.endswith(".json") or name == "index.json":
            continue
        day = name[:-5]
        path = os.path.join(ARCHIVE_DIR, name)
        if day < cutoff:
            try:
                os.remove(path)
                print("pruned", name)
            except OSError:
                pass
            continue
        meta = load(path, {})
        days.append({"day": day, "count": meta.get("count", 0),
                     "bytes": os.path.getsize(path)})

    with open(os.path.join(ARCHIVE_DIR, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "generated_at": int(datetime.now(timezone.utc).timestamp()),
            "keep_days": KEEP_DAYS,
            "days": days,
            "total_bytes": sum(d["bytes"] for d in days),
            "note": "Compact per-day archive of scored headlines. Only the fields "
                    "newsLane() reads are kept. Exists so the news lane can "
                    "eventually be backtested; it cannot be today.",
        }, fh, separators=(",", ":"))


if __name__ == "__main__":
    sys.exit(main())
