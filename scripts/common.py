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


def previous(filename):
    """Whatever is already in data/<filename>, or {}.

    The workflow seeds data/ from the live branch before any fetcher runs,
    precisely so a lane that fails this cycle keeps its last good value instead
    of publishing an empty file. A fetcher that unconditionally writes its
    failure payload defeats that: one network blip replaces good data with
    `ok: false` and everybody downstream loses it until the next success.

    See fetch_flows.py, which has carried FII/DII forward this way from the
    start - this is that pattern, shared.
    """
    path = DATA / filename
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def carry_forward(filename, payload, keep_stamp=True):
    """Return the previous good payload when this run produced nothing usable.

    `keep_stamp` decides whether the carried copy keeps its ORIGINAL
    generated_at. It must, for anything whose consumer judges staleness from
    that field - the option chain lane drops itself past four hours, and
    restamping a carried copy to now would silence that guard and let the model
    vote on positioning from another session. Refreshing the stamp would be a
    lie about when the data was true.
    """
    if payload.get("ok"):
        return payload
    prev = previous(filename)
    if not prev.get("ok"):
        return payload                      # nothing better to fall back to
    out = dict(prev)
    out["carried_over"] = True
    out["carried_at"] = now_iso()
    out["carry_reason"] = payload.get("error") or "this run produced nothing usable"
    if not keep_stamp:
        out["generated_at"] = now_iso()
    return out


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
