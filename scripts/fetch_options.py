#!/usr/bin/env python3
"""NIFTY option chain: PCR, max pain, open-interest walls and the IV surface.

Why this lane exists
--------------------
Every input the forecast had was backward-looking. Momentum, levels, structure
and seasonality are all functions of prices that have already printed; the news
lane reads what has already been published. The option chain is the only free
source in this repo that says what money is positioned for *next*, and it moves
intraday.

Three signals come out of it, in descending order of how much they are worth:

  PCR on change in open interest
      Who is writing today. Puts being written into a rising tape is support
      being sold; calls being written into a stalling one is a ceiling being
      built. This is the fastest-moving of the three and the one a 6.5-hour
      forecast can actually use.

  Open-interest walls
      The strikes carrying the most call and put OI behave like levels, but
      derived from positioning rather than from where price happened to turn.
      levelsLane() already measures room to the nearest price wall; this
      measures room to the nearest *positioning* wall, and they often disagree.

  Max pain
      The strike at which option writers pay out least. Its pull is real but
      weak and almost entirely concentrated in the last day or two before
      expiry, so it is weighted by how close expiry is rather than applied flat.

Endpoint notes, measured 18 Sep 2026
------------------------------------
`/api/option-chain-indices?symbol=NIFTY` is **dead** - HTTP 404, same as the
other endpoints listed in CLAUDE.md. NSE moved it. The live path is
`/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=<DD-MMM-YYYY>`, and it
requires the expiry, which comes from `/api/option-chain-contract-info`. Found
by reading the /api/ paths out of NSE's own `option-chain-v3.js` bundle rather
than by guessing.

The response carries `Access-Control-Allow-Origin: beta.nseindia.com`, so a
browser on our origin cannot read it. This is a workflow lane, which means it is
as old as the last run - about two and a half hours, per CLAUDE.md. That is
tolerable for max pain and the OI walls, which move slowly, and is a real
limitation for the change-in-OI number. The age goes in the payload and the lane
drops itself when stale rather than voting on yesterday's positioning.
"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone

from common import DATA, IST, Lanes, UA, get, now_ist, now_iso, write_json

import requests

NSE_HOME = "https://www.nseindia.com/"
CHAIN_PAGE = "https://www.nseindia.com/option-chain"
INFO = "https://www.nseindia.com/api/option-chain-contract-info?symbol={sym}"
CHAIN = "https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol={sym}&expiry={exp}"

# Strikes far from spot carry OI that is mostly hedging residue and never trades.
# Everything below is computed on a window around spot instead of the whole
# chain, which is what stops one enormous far-out-of-the-money position from
# defining the "wall".
WINDOW_PCT = 6.0


def session():
    """NSE hands out a cookie on the homepage and rejects API calls without it.

    Same shape as fetch_flows.session(). Kept local rather than imported because
    the Referer has to be the option-chain page for these endpoints; sending the
    homepage Referer here returns 401 on some IPs.
    """
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-IN,en;q=0.9",
        "Referer": CHAIN_PAGE,
        "X-Requested-With": "XMLHttpRequest",
    })
    s.get(NSE_HOME, timeout=20)
    time.sleep(1)
    return s


def days_to_expiry(expiry):
    try:
        d = datetime.strptime(expiry, "%d-%b-%Y").replace(tzinfo=IST)
        return max(0, (d - datetime.now(IST)).days)
    except ValueError:
        return None


def chain_for(s, symbol, expiry):
    r = get(CHAIN.format(sym=symbol, exp=requests.utils.quote(expiry)), session=s, retries=2)
    payload = r.json() or {}
    rec = payload.get("records") or {}
    return rec.get("data") or [], rec.get("underlyingValue"), rec.get("timestamp")


def summarise(rows, spot):
    """Everything the lane reads, from one pass over the strikes near spot."""
    if not rows or not spot:
        return None

    lo, hi = spot * (1 - WINDOW_PCT / 100), spot * (1 + WINDOW_PCT / 100)
    near = [r for r in rows if r.get("strikePrice") and lo <= r["strikePrice"] <= hi]
    if len(near) < 8:
        near = rows

    def leg(r, side):
        return r.get(side) or {}

    ce_oi = sum(leg(r, "CE").get("openInterest", 0) or 0 for r in near)
    pe_oi = sum(leg(r, "PE").get("openInterest", 0) or 0 for r in near)
    ce_chg = sum(leg(r, "CE").get("changeinOpenInterest", 0) or 0 for r in near)
    pe_chg = sum(leg(r, "PE").get("changeinOpenInterest", 0) or 0 for r in near)

    # Max pain over the near window: the strike where writers pay out least.
    best_strike, best_pain = None, None
    for a in near:
        k = a["strikePrice"]
        pain = 0.0
        for b in near:
            kb = b["strikePrice"]
            pain += (leg(b, "CE").get("openInterest", 0) or 0) * max(0.0, k - kb)
            pain += (leg(b, "PE").get("openInterest", 0) or 0) * max(0.0, kb - k)
        if best_pain is None or pain < best_pain:
            best_strike, best_pain = k, pain

    def walls(side, above):
        pool = [r for r in near
                if (r["strikePrice"] > spot if above else r["strikePrice"] < spot)]
        pool.sort(key=lambda r: -(leg(r, side).get("openInterest", 0) or 0))
        return [{
            "strike": r["strikePrice"],
            "oi": leg(r, side).get("openInterest", 0) or 0,
            "chgOi": leg(r, side).get("changeinOpenInterest", 0) or 0,
            "distPct": round((r["strikePrice"] - spot) / spot * 100, 2),
        } for r in pool[:3]]

    # ATM implied vol, and the skew that says which tail is being paid for.
    atm = min(near, key=lambda r: abs(r["strikePrice"] - spot))
    atm_ce = leg(atm, "CE").get("impliedVolatility") or 0
    atm_pe = leg(atm, "PE").get("impliedVolatility") or 0
    otm_put = [r for r in near if r["strikePrice"] < spot * 0.98]
    otm_call = [r for r in near if r["strikePrice"] > spot * 1.02]

    def mean_iv(pool, side):
        vals = [leg(r, side).get("impliedVolatility") for r in pool]
        vals = [v for v in vals if v and v > 0]
        return round(sum(vals) / len(vals), 2) if vals else None

    put_iv, call_iv = mean_iv(otm_put, "PE"), mean_iv(otm_call, "CE")

    return {
        "strikes": len(near),
        "windowPct": WINDOW_PCT,
        "totalCeOi": ce_oi,
        "totalPeOi": pe_oi,
        "pcrOi": round(pe_oi / ce_oi, 3) if ce_oi else None,
        "ceChgOi": ce_chg,
        "peChgOi": pe_chg,
        # Change-in-OI PCR is unstable when either side is small or negative, so
        # it is only reported when both sides actually built today.
        "pcrChgOi": round(pe_chg / ce_chg, 3) if ce_chg > 0 and pe_chg > 0 else None,
        "maxPain": best_strike,
        "maxPainPct": round((best_strike - spot) / spot * 100, 3) if best_strike else None,
        "resistance": walls("CE", True),
        "support": walls("PE", False),
        "atmStrike": atm["strikePrice"],
        "atmIv": round((atm_ce + atm_pe) / 2, 2) if (atm_ce or atm_pe) else None,
        "otmPutIv": put_iv,
        "otmCallIv": call_iv,
        # Positive skew: downside protection costs more than upside, which is
        # the normal state for an index and informative when it inverts.
        "ivSkew": round(put_iv - call_iv, 2) if (put_iv and call_iv) else None,
    }


def main():
    lanes = Lanes()
    out = {
        "generated_at": now_iso(),
        "generated_ist": now_ist(),
        "symbol": "NIFTY",
        "ok": False,
        "error": None,
        "source": "nseindia.com/api/option-chain-v3",
        "note": ("Server-side only: NSE answers with Access-Control-Allow-Origin "
                 "beta.nseindia.com, so a browser on our origin cannot read it. "
                 "This is therefore as old as the last workflow run."),
    }

    try:
        s = session()
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"session: {exc!r}"[:200]
        lanes.record("nse session", False, 0, repr(exc))
        write_json("options.json", out)
        return 0

    try:
        info = get(INFO.format(sym="NIFTY"), session=s, retries=2).json() or {}
        expiries = info.get("expiryDates") or []
        if not expiries:
            raise RuntimeError("no expiry dates returned")
        expiry = expiries[0]
        out["expiry"] = expiry
        out["expiryDays"] = days_to_expiry(expiry)
        out["expiriesAhead"] = expiries[:4]
        lanes.record("contract-info", True, len(expiries))
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"contract-info: {exc!r}"[:200]
        lanes.record("contract-info", False, 0, repr(exc))
        write_json("options.json", out)
        return 0

    try:
        rows, spot, stamp = chain_for(s, "NIFTY", expiry)
        if not rows:
            raise RuntimeError("chain returned no strikes")
        out["spot"] = spot
        out["chainTimestamp"] = stamp
        summary = summarise(rows, spot)
        if not summary:
            raise RuntimeError("could not summarise the chain")
        out.update(summary)
        out["ok"] = True
        lanes.record("option-chain-v3", True, len(rows))
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"option-chain: {exc!r}"[:200]
        lanes.record("option-chain-v3", False, 0, repr(exc))

    out["lanes"] = lanes.as_list()
    write_json("options.json", out)
    archive(out)

    if out["ok"]:
        print(f"  PCR(OI)={out.get('pcrOi')} PCR(dOI)={out.get('pcrChgOi')} "
              f"maxPain={out.get('maxPain')} ({out.get('maxPainPct')}%) "
              f"spot={out.get('spot')} expiry={out.get('expiry')} "
              f"in {out.get('expiryDays')}d")
    return 0


def archive(out):
    """Append one compact row per run to a per-day file.

    Same reasoning as archive_news.py: this lane votes on the forecast and
    cannot be replayed, because nothing keeps a record of what the chain looked
    like at any past bar. calibrate() will therefore stay silent about it
    forever unless the record starts now. A row is about 200 bytes and there
    are roughly ten runs a day, so ninety days costs under 200 KB - small
    enough that there is no argument for not doing it.
    """
    if not out.get("ok"):
        return
    day = datetime.now(IST).strftime("%Y-%m-%d")
    adir = DATA / "options_archive"
    adir.mkdir(parents=True, exist_ok=True)
    target = adir / (day + ".json")

    try:
        with open(target, "r", encoding="utf-8") as fh:
            existing = json.load(fh)
    except (OSError, ValueError):
        existing = {"day": day, "rows": []}

    row = {
        "t": out.get("generated_at"),
        "spot": out.get("spot"),
        "pcrOi": out.get("pcrOi"),
        "pcrChgOi": out.get("pcrChgOi"),
        "maxPain": out.get("maxPain"),
        "expiry": out.get("expiry"),
        "expiryDays": out.get("expiryDays"),
        "atmIv": out.get("atmIv"),
        "ivSkew": out.get("ivSkew"),
        "res": (out.get("resistance") or [{}])[0].get("strike"),
        "sup": (out.get("support") or [{}])[0].get("strike"),
    }
    rows = existing.get("rows", [])
    # The chain timestamp is the honest dedupe key: two workflow runs inside one
    # NSE update window carry identical data and should be one row, not two.
    if rows and rows[-1].get("chainTs") == out.get("chainTimestamp"):
        return
    row["chainTs"] = out.get("chainTimestamp")
    rows.append(row)

    with open(target, "w", encoding="utf-8") as fh:
        json.dump({"day": day, "count": len(rows), "rows": rows}, fh,
                  separators=(",", ":"))
    prune(adir)
    print(f"  archived option-chain row ({len(rows)} today, {target.stat().st_size}B)")


def prune(adir, keep_days=90):
    cutoff = (datetime.now(IST) - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    days = []
    for p in sorted(adir.glob("*.json")):
        if p.name == "index.json":
            continue
        if p.stem < cutoff:
            try:
                p.unlink()
            except OSError:
                pass
            continue
        days.append({"day": p.stem, "bytes": p.stat().st_size})
    with open(adir / "index.json", "w", encoding="utf-8") as fh:
        json.dump({"generated_at": now_iso(), "keep_days": keep_days, "days": days,
                   "note": "Per-run option-chain summaries. Exists so optionsLane "
                           "can eventually be backtested; it cannot be today."},
                  fh, separators=(",", ":"))


if __name__ == "__main__":
    sys.exit(main())
