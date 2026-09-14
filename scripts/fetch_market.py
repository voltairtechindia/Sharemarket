"""Pull index, stock and macro quotes from Yahoo Finance. No API key required.

Optionally pulls an F&O option chain from NSE (local runs) or Dhan (needs a free
account token in repo secrets). Both are best effort and never fail the run.
"""
import os
import time

import requests

from common import Lanes, ON_ACTIONS, get, load_cfg, now_ist, now_iso, write_json

YF_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]


def yahoo_quote(session, symbol, label):
    last_err = None
    for host in YF_HOSTS:
        url = f"{host}/v8/finance/chart/{symbol}"
        try:
            r = get(
                url,
                session=session,
                retries=1,
                params={"range": "1d", "interval": "5m", "includePrePost": "false"},
            )
            j = r.json()["chart"]["result"][0]
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue

        meta = j.get("meta", {})
        closes = []
        try:
            closes = [c for c in j["indicators"]["quote"][0]["close"] if c is not None]
        except Exception:  # noqa: BLE001
            pass

        price = meta.get("regularMarketPrice")
        if price is None and closes:
            price = closes[-1]
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        if price is None or prev is None:
            last_err = RuntimeError("no price in response")
            continue

        change = price - prev
        spark = closes[-78:]
        if len(spark) > 60:  # thin it out so the JSON stays small
            step = len(spark) / 60
            spark = [spark[int(i * step)] for i in range(60)]

        return {
            "symbol": symbol,
            "label": label,
            "price": round(float(price), 2),
            "prev_close": round(float(prev), 2),
            "change": round(float(change), 2),
            "change_pct": round(float(change) / float(prev) * 100, 2) if prev else 0.0,
            "day_high": meta.get("regularMarketDayHigh"),
            "day_low": meta.get("regularMarketDayLow"),
            "currency": meta.get("currency", ""),
            "exchange_state": meta.get("marketState", ""),
            "spark": [round(float(x), 2) for x in spark],
        }
    raise last_err or RuntimeError("yahoo failed")


def fetch_group(session, entries):
    out = []
    for e in entries:
        try:
            out.append(yahoo_quote(session, e["symbol"], e["label"]))
        except Exception as exc:  # noqa: BLE001
            print(f"  skip {e['symbol']}: {exc!r}")
        time.sleep(0.25)  # stay polite, Yahoo throttles bursts
    if not out:
        raise RuntimeError("every symbol in group failed")
    return out


# ---------------------------------------------------------------- option chain

def nse_option_chain(symbols, width):
    """Unofficial NSE endpoint. Needs a cookie handshake and a real browser UA.
    NSE firewalls cloud IPs, so this is skipped on GitHub runners by default."""
    if ON_ACTIONS and os.environ.get("FORCE_NSE") != "1":
        raise RuntimeError("skipped on GitHub runner, NSE blocks datacenter IPs")

    s = requests.Session()
    get("https://www.nseindia.com/option-chain", session=s, timeout=15,
        headers={"Accept": "text/html,application/xhtml+xml"})
    time.sleep(1)

    out = {}
    for sym in symbols:
        r = get(
            "https://www.nseindia.com/api/option-chain-indices",
            session=s,
            timeout=15,
            params={"symbol": sym},
            headers={"Accept": "application/json", "Referer": "https://www.nseindia.com/option-chain"},
        )
        out[sym] = shape_nse_chain(r.json(), width)
        time.sleep(1.2)  # NSE rate limit is roughly 3 req/sec, stay well under
    return out


def shape_nse_chain(raw, width):
    records = raw.get("records", {})
    spot = records.get("underlyingValue")
    expiry = (records.get("expiryDates") or [None])[0]
    rows = [r for r in records.get("data", []) if r.get("expiryDate") == expiry]
    if spot and rows:
        atm = min(rows, key=lambda r: abs(r["strikePrice"] - spot))["strikePrice"]
        rows.sort(key=lambda r: abs(r["strikePrice"] - atm))
        rows = sorted(rows[: width * 2 + 1], key=lambda r: r["strikePrice"])

    strikes, ce_oi, pe_oi = [], 0, 0
    for r in rows:
        ce, pe = r.get("CE", {}), r.get("PE", {})
        ce_oi += ce.get("openInterest", 0)
        pe_oi += pe.get("openInterest", 0)
        strikes.append({
            "strike": r["strikePrice"],
            "ce_ltp": ce.get("lastPrice"), "ce_oi": ce.get("openInterest"),
            "ce_oi_chg": ce.get("changeinOpenInterest"), "ce_iv": ce.get("impliedVolatility"),
            "pe_ltp": pe.get("lastPrice"), "pe_oi": pe.get("openInterest"),
            "pe_oi_chg": pe.get("changeinOpenInterest"), "pe_iv": pe.get("impliedVolatility"),
        })

    max_pain = None
    if strikes:
        def pain(k):
            return sum(
                max(0, k - s["strike"]) * (s["ce_oi"] or 0)
                + max(0, s["strike"] - k) * (s["pe_oi"] or 0)
                for s in strikes
            )
        max_pain = min((s["strike"] for s in strikes), key=pain)

    return {
        "spot": spot,
        "expiry": expiry,
        "pcr": round(pe_oi / ce_oi, 2) if ce_oi else None,
        "total_ce_oi": ce_oi,
        "total_pe_oi": pe_oi,
        "max_pain": max_pain,
        "strikes": strikes,
        "source": "nse",
    }


def dhan_option_chain(symbols, width):
    """Free with a Dhan account. Token lives ~30 days so it survives in Actions."""
    token = os.environ.get("DHAN_ACCESS_TOKEN")
    client = os.environ.get("DHAN_CLIENT_ID")
    if not token or not client:
        raise RuntimeError("DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID not set")

    scrip = {"NIFTY": 13, "BANKNIFTY": 25, "FINNIFTY": 27}
    headers = {"access-token": token, "client-id": client, "Content-Type": "application/json"}
    out = {}
    for sym in symbols:
        sid = scrip.get(sym)
        if sid is None:
            continue
        body = {"UnderlyingScrip": sid, "UnderlyingSeg": "IDX_I"}
        r = requests.post("https://api.dhan.co/v2/optionchain/expirylist",
                          json=body, headers=headers, timeout=20)
        r.raise_for_status()
        expiry = r.json()["data"][0]
        body["Expiry"] = expiry
        r = requests.post("https://api.dhan.co/v2/optionchain",
                          json=body, headers=headers, timeout=20)
        r.raise_for_status()
        out[sym] = shape_dhan_chain(r.json().get("data", {}), expiry, width)
        time.sleep(3.2)  # Dhan option chain is rate limited to 1 call per 3 sec
    return out


def shape_dhan_chain(data, expiry, width):
    spot = data.get("last_price")
    oc = data.get("oc", {}) or {}
    rows = []
    for k, v in oc.items():
        ce, pe = v.get("ce", {}) or {}, v.get("pe", {}) or {}
        rows.append({
            "strike": float(k),
            "ce_ltp": ce.get("last_price"), "ce_oi": ce.get("oi"),
            "ce_oi_chg": (ce.get("oi") or 0) - (ce.get("previous_oi") or 0),
            "ce_iv": ce.get("implied_volatility"),
            "pe_ltp": pe.get("last_price"), "pe_oi": pe.get("oi"),
            "pe_oi_chg": (pe.get("oi") or 0) - (pe.get("previous_oi") or 0),
            "pe_iv": pe.get("implied_volatility"),
        })
    rows = [r for r in rows if (r["ce_oi"] or r["pe_oi"])]
    if spot and rows:
        atm = min(rows, key=lambda r: abs(r["strike"] - spot))["strike"]
        rows.sort(key=lambda r: abs(r["strike"] - atm))
        rows = sorted(rows[: width * 2 + 1], key=lambda r: r["strike"])

    ce_oi = sum(r["ce_oi"] or 0 for r in rows)
    pe_oi = sum(r["pe_oi"] or 0 for r in rows)
    max_pain = None
    if rows:
        def pain(k):
            return sum(
                max(0, k - r["strike"]) * (r["ce_oi"] or 0)
                + max(0, r["strike"] - k) * (r["pe_oi"] or 0)
                for r in rows
            )
        max_pain = min((r["strike"] for r in rows), key=pain)

    return {
        "spot": spot, "expiry": expiry,
        "pcr": round(pe_oi / ce_oi, 2) if ce_oi else None,
        "total_ce_oi": ce_oi, "total_pe_oi": pe_oi,
        "max_pain": max_pain, "strikes": rows, "source": "dhan",
    }


def main():
    cfg = load_cfg("watchlist.yml")
    lanes = Lanes()
    session = requests.Session()

    groups = {}
    for group in ("headline", "india", "global", "macro", "movers"):
        entries = cfg.get(group) or []
        groups[group] = lanes.run(f"yahoo:{group}", lambda e=entries: fetch_group(session, e))

    opt_cfg = cfg.get("options", {}) or {}
    symbols = opt_cfg.get("symbols", [])
    width = int(opt_cfg.get("strikes_around_atm", 10))
    chains = {}

    if opt_cfg.get("dhan"):
        try:
            chains = dhan_option_chain(symbols, width)
            lanes.record("options:dhan", True, len(chains))
        except Exception as exc:  # noqa: BLE001
            lanes.record("options:dhan", False, 0, repr(exc))

    if not chains and opt_cfg.get("nse_direct"):
        try:
            chains = nse_option_chain(symbols, width)
            lanes.record("options:nse", True, len(chains))
        except Exception as exc:  # noqa: BLE001
            lanes.record("options:nse", False, 0, repr(exc))

    movers = sorted(groups.get("movers", []), key=lambda q: q["change_pct"], reverse=True)

    write_json("market.json", {
        "generated_at": now_iso(),
        "generated_at_ist": now_ist(),
        "headline": groups.get("headline", []),
        "india": groups.get("india", []),
        "global": groups.get("global", []),
        "macro": groups.get("macro", []),
        "gainers": movers[:6],
        "losers": list(reversed(movers[-6:])),
        "options": chains,
        "lanes": lanes.as_list(),
    })


if __name__ == "__main__":
    main()
