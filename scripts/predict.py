"""Log a next-session forecast built only from data that was actually fetched.

Every signal declares whether it fired or was unavailable. Nothing is invented.
Weights live in data/predictions.json and are adjusted by validate.py against real
closes, so accuracy here means accuracy, not a placeholder.

Run after the close:  python scripts/predict.py
"""
import json
from datetime import datetime

from common import DATA, now_ist, now_iso, write_json

FLAT_BAND = 0.15   # a move smaller than this percent counts as flat, not a call
DEFAULT_WEIGHTS = {"vix": 1.0, "global_cue": 1.0, "usdinr": 1.0, "crude": 1.0,
                   "momentum": 1.0, "breadth": 1.0, "pcr": 1.0, "oi": 1.0,
                   "max_pain": 1.0, "news": 1.0}

PRED_FILE = DATA / "predictions.json"


def load_store():
    if PRED_FILE.exists():
        try:
            return json.loads(PRED_FILE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return {"schema": 2, "weights": dict(DEFAULT_WEIGHTS), "predictions": [],
            "accuracy": {}, "legacy_demo": []}


def read(name):
    path = DATA / f"{name}.json"
    if not path.exists():
        raise SystemExit(f"{name}.json missing. Run the fetchers first.")
    return json.loads(path.read_text(encoding="utf-8"))


def find(quotes, symbol):
    for q in quotes:
        if q["symbol"] == symbol:
            return q
    return None


def signal(name, bias, because, fired=True):
    """bias: 'up', 'down' or 'flat'. fired=False means the input was unavailable."""
    return {"name": name, "bias": bias, "because": because, "fired": fired}


def build_signals(market, news):
    quotes = (market.get("headline", []) + market.get("global", [])
              + market.get("macro", []) + market.get("india", []))
    out = []

    vix = find(quotes, "^INDIAVIX")
    if vix:
        b = "down" if vix["change_pct"] > 4 else "up" if vix["change_pct"] < -4 else "flat"
        out.append(signal("vix", b, f"India VIX {vix['change_pct']:+.2f}%"))
    else:
        out.append(signal("vix", "flat", "India VIX not in the last fetch", fired=False))

    cues = [q for q in (find(quotes, "^GSPC"), find(quotes, "^IXIC")) if q]
    if cues:
        avg = sum(q["change_pct"] for q in cues) / len(cues)
        b = "up" if avg > 0.25 else "down" if avg < -0.25 else "flat"
        out.append(signal("global_cue", b, f"US indices {avg:+.2f}% avg"))
    else:
        out.append(signal("global_cue", "flat", "no US index data", fired=False))

    fx = find(quotes, "USDINR=X")
    if fx:
        b = "down" if fx["change_pct"] > 0.3 else "up" if fx["change_pct"] < -0.3 else "flat"
        out.append(signal("usdinr", b, f"USDINR {fx['change_pct']:+.2f}%"))
    else:
        out.append(signal("usdinr", "flat", "no USDINR data", fired=False))

    oil = find(quotes, "BZ=F") or find(quotes, "CL=F")
    if oil:
        b = "down" if oil["change_pct"] > 2 else "up" if oil["change_pct"] < -2 else "flat"
        out.append(signal("crude", b, f"crude {oil['change_pct']:+.2f}%"))
    else:
        out.append(signal("crude", "flat", "no crude data", fired=False))

    nifty = find(quotes, "^NSEI")
    if nifty:
        b = "up" if nifty["change_pct"] > 0.4 else "down" if nifty["change_pct"] < -0.4 else "flat"
        out.append(signal("momentum", b, f"Nifty session {nifty['change_pct']:+.2f}%"))
    else:
        out.append(signal("momentum", "flat", "no Nifty data", fired=False))

    movers = market.get("gainers", []) + market.get("losers", [])
    if movers:
        up = sum(1 for m in movers if m["change_pct"] > 0)
        ratio = up / len(movers)
        b = "up" if ratio > 0.6 else "down" if ratio < 0.4 else "flat"
        out.append(signal("breadth", b, f"{up} of {len(movers)} heavyweights green"))
    else:
        out.append(signal("breadth", "flat", "no heavyweight data", fired=False))

    chain = (market.get("options") or {}).get("NIFTY")
    if chain and chain.get("pcr"):
        pcr = chain["pcr"]
        b = "up" if pcr > 1.2 else "down" if pcr < 0.8 else "flat"
        out.append(signal("pcr", b, f"PCR {pcr}"))
        mp, spot = chain.get("max_pain"), chain.get("spot")
        if mp and spot:
            gap = (mp - spot) / spot * 100
            b = "up" if gap > 0.3 else "down" if gap < -0.3 else "flat"
            out.append(signal("max_pain", b, f"max pain {gap:+.2f}% from spot"))
        ce, pe = chain.get("total_ce_oi") or 0, chain.get("total_pe_oi") or 0
        if ce and pe:
            b = "up" if pe > ce * 1.1 else "down" if ce > pe * 1.1 else "flat"
            out.append(signal("oi", b, f"PE OI {pe:,} vs CE OI {ce:,}"))
    else:
        for n in ("pcr", "max_pain", "oi"):
            out.append(signal(n, "flat", "no option chain in this run", fired=False))

    items = news.get("items", [])
    scored = [i for i in items if i.get("impact") in ("high", "medium")
              and i.get("direction") in ("up", "down")]
    if scored:
        up = sum(1 for i in scored if i["direction"] == "up")
        down = len(scored) - up
        b = "up" if up > down * 1.3 else "down" if down > up * 1.3 else "flat"
        out.append(signal("news", b, f"{up} bullish vs {down} bearish headlines"))
    else:
        out.append(signal("news", "flat", "no directional headlines", fired=False))

    return out


def fuse(signals, weights):
    score = sum(weights.get(s["name"], 1.0) * (1 if s["bias"] == "up" else -1 if s["bias"] == "down" else 0)
                for s in signals if s["fired"])
    # Divide by every signal that produced a reading, not just the opinionated ones.
    # Three signals agreeing while seven shrug is weak conviction, not 100% agreement.
    mass = sum(weights.get(s["name"], 1.0) for s in signals if s["fired"])
    agreement = abs(score) / mass if mass else 0.0
    direction = "up" if score > 0.5 else "down" if score < -0.5 else "flat"
    return direction, round(score, 2), round(agreement, 2)


def main():
    market, news = read("market"), read("news")
    store = load_store()
    weights = {**DEFAULT_WEIGHTS, **store.get("weights", {})}

    signals = build_signals(market, news)
    direction, score, agreement = fuse(signals, weights)

    quotes = market.get("headline", [])
    nifty, bank = find(quotes, "^NSEI"), find(quotes, "^NSEBANK")
    if not nifty:
        raise SystemExit("no Nifty quote in market.json, nothing to anchor a forecast to")

    chain = (market.get("options") or {}).get("NIFTY") or {}
    band = 0.6 if agreement < 0.4 else 0.4
    anchor = chain.get("max_pain") or nifty["price"]

    entry = {
        "id": f"{datetime.now().strftime('%Y-%m-%d')}-{len(store['predictions']) + 1}",
        "made_at": now_iso(),
        "made_at_ist": now_ist(),
        "horizon": "next session close",
        "nifty": {
            "spot_at_prediction": nifty["price"],
            "direction": direction,
            "range_low": round(anchor * (1 - band / 100), 1),
            "range_high": round(anchor * (1 + band / 100), 1),
        },
        "banknifty": {
            "spot_at_prediction": bank["price"] if bank else None,
            "direction": direction,
        },
        "signals": [dict(s, weight=round(weights.get(s["name"], 1.0), 3)) for s in signals],
        "fired": sum(1 for s in signals if s["fired"]),
        "score": score,
        "agreement": agreement,
        "option_chain_used": bool(chain),
        "validated": False,
        "outcome": None,
    }

    store["predictions"].append(entry)
    store["weights"] = weights
    store["generated_at"] = now_iso()
    write_json("predictions.json", store)

    print(f"\n{direction.upper()} on Nifty, agreement {agreement:.0%}, "
          f"{entry['fired']}/{len(signals)} signals fired, "
          f"chain {'used' if chain else 'unavailable'}")
    for s in signals:
        mark = "on" if s["fired"] else "--"
        print(f"  {mark} {s['name']:<12} {s['bias']:<5} w={weights.get(s['name'], 1.0):.2f}  {s['because']}")


if __name__ == "__main__":
    main()
