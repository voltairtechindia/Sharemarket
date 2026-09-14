"""Social chatter without any platform API.

Three independent lanes. Reddit and Telegram are stable. The X lane reads public
Nitter-fork mirrors and is expected to fail sometimes, which is fine: it is
isolated so the rest of the dashboard is unaffected.
"""
import hashlib
import html
import re
import time
from datetime import datetime, timezone

import feedparser

from common import Lanes, get, load_cfg, now_ist, now_iso, write_json

MAX_ITEMS = 120
TAG_RE = re.compile(r"<[^>]+>")

# Only keep posts that look market related, otherwise the feed is pure noise.
RELEVANT = re.compile(
    r"nifty|sensex|banknifty|bank nifty|fno|f&o|option|call|put|expiry|strike|"
    r"rbi|sebi|fii|dii|rally|crash|circuit|breakout|resistance|support|"
    r"tariff|fed|rate cut|rate hike|crude|rupee|ipo|results|earnings",
    re.I,
)


def clean(text, limit=320):
    return html.unescape(TAG_RE.sub(" ", text or "")).replace("&nbsp;", " ").strip()[:limit]


def mk(source, platform, text, link, published, author=""):
    return {
        "id": hashlib.sha1((text[:120] + source).encode()).hexdigest()[:12],
        "platform": platform,
        "source": source,
        "author": author or source,
        "text": text,
        "link": link,
        "published": published,
        "relevant": bool(RELEVANT.search(text)),
    }


def to_iso(entry):
    for field in ("published_parsed", "updated_parsed"):
        t = entry.get(field)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc).isoformat(timespec="seconds")
    return now_iso()


def reddit_lane(name, url):
    r = get(url, retries=1, timeout=25, headers={"Accept": "application/atom+xml"})
    parsed = feedparser.parse(r.content)
    out = []
    for e in parsed.entries[:25]:
        title = clean(e.get("title", ""), 220)
        body = clean(e.get("summary", ""), 240)
        if not title:
            continue
        out.append(mk(name, "reddit", title, e.get("link", ""), to_iso(e),
                      author=(e.get("author") or name)))
        if body and body != title:
            out[-1]["text"] = f"{title} :: {body}"
    if not out:
        raise RuntimeError("no entries")
    return out


def x_lane(handle, mirrors):
    last = None
    for host in mirrors:
        url = f"{host.rstrip('/')}/{handle}/rss"
        try:
            r = get(url, retries=0, timeout=20)
            parsed = feedparser.parse(r.content)
            out = []
            for e in parsed.entries[:15]:
                text = clean(e.get("title", ""), 300)
                if not text:
                    continue
                out.append(mk(f"@{handle}", "x", text, e.get("link", ""), to_iso(e),
                              author=f"@{handle}"))
            if out:
                return out
            last = RuntimeError("mirror returned empty feed")
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise last or RuntimeError("all mirrors failed")


TG_MSG = re.compile(
    r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.S)
TG_TIME = re.compile(r'<time datetime="([^"]+)"')


def telegram_lane(channel):
    r = get(f"https://t.me/s/{channel}", retries=1, timeout=25,
            headers={"Accept": "text/html"})
    body = r.text
    texts = TG_MSG.findall(body)[-20:]
    times = TG_TIME.findall(body)[-20:]
    out = []
    for i, raw in enumerate(texts):
        text = clean(raw.replace("<br/>", " ").replace("<br>", " "), 300)
        if not text:
            continue
        ts = times[i] if i < len(times) else now_iso()
        out.append(mk(f"tg/{channel}", "telegram", text,
                      f"https://t.me/s/{channel}", ts))
    if not out:
        raise RuntimeError("no messages parsed, page layout may have changed")
    return out


def main():
    feeds = load_cfg("feeds.yml")
    lanes = Lanes()
    items = []

    for f in feeds.get("reddit", []):
        items += lanes.run(f["name"], lambda f=f: reddit_lane(f["name"], f["url"]))
        time.sleep(0.6)

    mirrors = feeds.get("x_mirrors", [])
    for handle in feeds.get("x_handles", []):
        items += lanes.run(f"x:@{handle}", lambda h=handle: x_lane(h, mirrors))
        time.sleep(0.8)

    for ch in feeds.get("telegram", []):
        items += lanes.run(f"tg:{ch}", lambda c=ch: telegram_lane(c))
        time.sleep(0.6)

    items.sort(key=lambda x: x["published"], reverse=True)
    items = items[:MAX_ITEMS]

    x_lanes = [l for l in lanes.as_list() if l["name"].startswith("x:")]
    write_json("social.json", {
        "generated_at": now_iso(),
        "generated_at_ist": now_ist(),
        "items": items,
        "relevant": [i for i in items if i["relevant"]][:40],
        "x_available": any(l["ok"] for l in x_lanes),
        "lanes": lanes.as_list(),
    })


if __name__ == "__main__":
    main()
