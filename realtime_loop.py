
"""Real-time FNO AI update loop — updates predictions + industry impact."""
import json, time, datetime, os, random

BASE = os.path.dirname(os.path.abspath(__file__))
PRED_FILE = os.path.join(BASE, "data", "predictions.json")
LIVE_FILE = os.path.join(BASE, "data", "live_impact.json")

INDUSTRY_MAP = {
    "Banking": {"nifty_impact": "positive", "banknifty_impact": "high_positive", "sectors": ["HDFC", "ICICI", "SBI"]},
    "IT / Pharma": {"nifty_impact": "positive", "banknifty_impact": "low_positive", "sectors": ["INFY", "TCS", "SUNPHARMA"]},
    "Oil / Refineries": {"nifty_impact": "negative", "banknifty_impact": "neutral", "sectors": ["RELIANCE", "IOC", "BPCL"]},
    "Auto / Capital Goods": {"nifty_impact": "positive", "banknifty_impact": "low_positive", "sectors": ["TATA", "ASHOKLEY", "ENGINERSIN"]},
    "Power / Energy": {"nifty_impact": "neutral", "banknifty_impact": "low_positive", "sectors": ["NTPC", "POWERGRID"]},
}

# Simulated live market snapshot (replace with real NSE feed when available)
MARKET_SNAPSHOT = {
    "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "nifty_spot": 23398.10,
    "banknifty_spot": 56606.55,
    "nifty_change_pct": -0.34,
    "banknifty_change_pct": +0.24,
    "vix": 14.20,
    "us_futures": "mixed",
    "dxy": 104.50,
    "crude_brent": 78.30,
}

# Simulated news feeds mapped to industries
NEWS_FEEDS = [
    {"headline":"SBI aims DPDP compliance by Dec; banking regulations loosening","industry":"Banking","sentiment":"positive","impact":"medium","nifty_indicator":"+0.15%","bank_indicator":"+0.40%"},
    {"headline":"IT sector sees new AI contracts from US clients","industry":"IT / Pharma","sentiment":"positive","impact":"low","nifty_indicator":"+0.08%","bank_indicator":"+0.02%"},
    {"headline":"Oil prices surge on Middle East supply concerns","industry":"Oil / Refineries","sentiment":"negative","impact":"high","nifty_indicator":"-0.22%","bank_indicator":"0.00%"},
    {"headline":"Auto sales up 12% in Aug; capital goods orders rise","industry":"Auto / Capital Goods","sentiment":"positive","impact":"medium","nifty_indicator":"+0.18%","bank_indicator":"+0.05%"},
    {"headline":"Power generation hits record; grid stability improves","industry":"Power / Energy","sentiment":"positive","impact":"low","nifty_indicator":"+0.05%","bank_indicator":"+0.10%"},
]

def load_predictions():
    try:
        with open(PRED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"predictions": [], "accuracy_summary": {}}

def save_predictions(data):
    with open(PRED_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def update_live_impact():
    predictions = load_predictions()
    # Add latest prediction + validation if not already done
    latest = predictions.get("predictions", [])[-1] if predictions.get("predictions") else None
    # Build live impact mapping
    impact_items = []
    for item in NEWS_FEEDS:
        mapping = INDUSTRY_MAP.get(item["industry"], {"nifty_impact":"neutral","banknifty_impact":"neutral"})
        impact_items.append({
            "news": item["headline"],
            "industry": item["industry"],
            "sentiment": item["sentiment"],
            "impact_level": item["impact"],
            "nifty_impact": mapping["nifty_impact"],
            "banknifty_impact": mapping["banknifty_impact"],
            "predicted_move_nifty": item.get("nifty_indicator", "0.00%"),
            "predicted_move_bank": item.get("bank_indicator", "0.00%"),
            "validated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "validated": False  # Set to True after market close comparison
        })

    live_data = {
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "market": MARKET_SNAPSHOT,
        "industry_news_impact": impact_items,
        "self_learning_accuracy": predictions.get("accuracy_summary", {}),
        "next_validation": (datetime.datetime.now() + datetime.timedelta(hours=16)).strftime("%Y-%m-%d %H:%M:%S") if datetime.datetime.now().hour < 16 else (datetime.datetime.now() + datetime.timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(LIVE_FILE, "w", encoding="utf-8") as f:
        json.dump(live_data, f, indent=2, ensure_ascii=False)
    print(f"[{live_data['updated_at']}] Updated live_impact.json — {len(impact_items)} industry news mapped.")

if __name__ == "__main__":
    # Run continuously, updating every 15 minutes
    print("Real-time loop started. Updates every 15 minutes. Press Ctrl+C to stop.")
    while True:
        try:
            update_live_impact()
        except Exception as e:
            print("Error in loop:", e)
        time.sleep(900)  # 15 minutes
