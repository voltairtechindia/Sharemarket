"""Shared helpers. Every fetcher writes one JSON file into data/ and never crashes."""
import json
import os
import pathlib
import time
from datetime import datetime, timezone, timedelta

import requests
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CONFIG = ROOT / "config"

IST = timezone(timedelta(hours=5, minutes=30))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

ON_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def now_ist():
    return datetime.now(IST).isoformat(timespec="seconds")


def load_cfg(name):
    with open(CONFIG / name, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def get(url, headers=None, timeout=20, retries=2, session=None, params=None):
    """GET with retries. Raises on final failure so callers can record the error."""
    s = session or requests
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-IN,en;q=0.9"}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retries + 1):
        try:
            r = s.get(url, headers=h, timeout=timeout, params=params)
            if r.status_code == 200:
                return r
            last = RuntimeError(f"HTTP {r.status_code}")
        except Exception as exc:  # noqa: BLE001
            last = exc
        if attempt < retries:
            time.sleep(1.5 * (attempt + 1))
    raise last


def write_json(filename, payload):
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / filename
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    tmp.replace(path)
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


class Lanes:
    """Tracks per-source success so the dashboard can show which feeds are alive."""

    def __init__(self):
        self.items = []

    def record(self, name, ok, count=0, error=""):
        self.items.append(
            {"name": name, "ok": bool(ok), "count": int(count), "error": str(error)[:200]}
        )
        flag = "ok " if ok else "FAIL"
        print(f"  [{flag}] {name} {count} {error[:120]}")

    def run(self, name, fn):
        """Run a lane, swallow its failure, return [] on error."""
        try:
            out = fn() or []
            self.record(name, True, len(out))
            return out
        except Exception as exc:  # noqa: BLE001
            self.record(name, False, 0, repr(exc))
            return []

    def as_list(self):
        return self.items
