"""Build data/feeds_index.json - the real, de-duplicated feed universe.

Replaces the old data/rss_config.json, whose 1050 entries were placeholders
(816 pointed at example.com, the rest at domains that do not resolve:
feeds.moneycontrol.com, feeds.etmarkets.com, feeds.reutersindia.com ...).

Every feed here is free, keyless and real. Two lanes:

  direct  - a publisher's own RSS URL
  gnews   - a Google News RSS search, which is a real feed per query and is
            the honest way to get broad, always-alive coverage

Feeds carry a priority that the news worker uses to decide how often to poll:
  1  every cycle          (index, policy, top wires)
  2  every 3rd cycle      (sectors, heavyweight companies)
  3  every 10th cycle     (long tail companies, secondary international)

Run:  python scripts/feeds_build.py
"""
import re

from common import ROOT, now_iso, write_json

GN = "https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en"
GN_US = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"


def gn(query, edition="in"):
    from urllib.parse import quote_plus

    base = GN if edition == "in" else GN_US
    return base.format(q=quote_plus(query))


# --------------------------------------------------------------- direct feeds
# Publisher RSS that exists today. Dead ones are pruned automatically by the
# news worker after repeated failures - it writes the verdict to feed_health.
DIRECT = [
    # --- Indian business press -------------------------------------------
    ("Moneycontrol top",        "https://www.moneycontrol.com/rss/MCtopnews.xml",                          "india", ["wire"], 1),
    ("Moneycontrol markets",    "https://www.moneycontrol.com/rss/marketreports.xml",                      "india", ["markets"], 1),
    ("Moneycontrol business",   "https://www.moneycontrol.com/rss/business.xml",                           "india", ["business"], 1),
    ("Moneycontrol results",    "https://www.moneycontrol.com/rss/results.xml",                            "india", ["earnings"], 2),
    ("Moneycontrol economy",    "https://www.moneycontrol.com/rss/economy.xml",                            "india", ["macro"], 1),
    ("Moneycontrol IPO",        "https://www.moneycontrol.com/rss/iponews.xml",                            "india", ["ipo"], 3),
    ("Moneycontrol MF",         "https://www.moneycontrol.com/rss/mutualfunds.xml",                        "india", ["flows"], 3),
    ("Moneycontrol currency",   "https://www.moneycontrol.com/rss/currencynews.xml",                       "india", ["currency"], 2),
    ("Moneycontrol commodity",  "https://www.moneycontrol.com/rss/commoditynews.xml",                      "india", ["commodity"], 2),
    ("CNBC TV18 market",        "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml",              "india", ["markets"], 1),
    ("CNBC TV18 economy",       "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml",             "india", ["macro"], 1),
    ("CNBC TV18 business",      "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml",            "india", ["business"], 2),
    ("ET markets",              "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",    "india", ["markets"], 1),
    ("ET economy",              "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms","india", ["macro"], 1),
    ("ET stocks",               "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms","india", ["markets"], 1),
    ("ET industry",             "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms",     "india", ["sector"], 2),
    ("Livemint markets",        "https://www.livemint.com/rss/markets",                                    "india", ["markets"], 1),
    ("Livemint economy",        "https://www.livemint.com/rss/economy",                                    "india", ["macro"], 1),
    ("Livemint companies",      "https://www.livemint.com/rss/companies",                                  "india", ["business"], 2),
    ("Business Standard mkts",  "https://www.business-standard.com/rss/markets-106.rss",                   "india", ["markets"], 1),
    ("Business Standard econ",  "https://www.business-standard.com/rss/economy-102.rss",                   "india", ["macro"], 1),
    ("Business Standard cos",   "https://www.business-standard.com/rss/companies-101.rss",                 "india", ["business"], 2),
    ("Financial Express mkt",   "https://www.financialexpress.com/market/feed/",                           "india", ["markets"], 1),
    ("Financial Express econ",  "https://www.financialexpress.com/economy/feed/",                          "india", ["macro"], 2),
    ("Hindu BusinessLine mkt",  "https://www.thehindubusinessline.com/markets/feeder/default.rss",         "india", ["markets"], 2),
    ("Hindu BusinessLine econ", "https://www.thehindubusinessline.com/economy/feeder/default.rss",         "india", ["macro"], 2),
    ("Business Today markets",  "https://www.businesstoday.in/rssfeeds/?id=225",                           "india", ["markets"], 2),
    ("Zee Business markets",    "https://www.zeebiz.com/rss/markets.xml",                                  "india", ["markets"], 2),
    ("Zee Business economy",    "https://www.zeebiz.com/rss/india-economy.xml",                            "india", ["macro"], 3),
    ("NDTV Profit",             "https://feeds.feedburner.com/ndtvprofit-latest",                          "india", ["markets"], 2),
    ("Firstpost business",      "https://www.firstpost.com/commonfeeds/v1/mfp/rss/business.xml",           "india", ["business"], 3),
    ("Deccan Herald business",  "https://www.deccanherald.com/rss/business.rss",                           "india", ["business"], 3),
    ("New Indian Exp business", "https://www.newindianexpress.com/Business/rssfeed/?id=182&getXmlFeed=true","india", ["business"], 3),
    ("The Hindu business",      "https://www.thehindu.com/business/feeder/default.rss",                    "india", ["business"], 3),
    ("Indian Express business", "https://indianexpress.com/section/business/feed/",                        "india", ["business"], 3),
    ("Times of India business", "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",                "india", ["business"], 3),
    # --- Indian regulators and official ----------------------------------
    ("RBI press releases",      "https://www.rbi.org.in/pressreleases_rss.xml",                            "india", ["policy", "rbi"], 1),
    ("RBI notifications",       "https://www.rbi.org.in/notifications_rss.xml",                            "india", ["policy", "rbi"], 2),
    ("RBI speeches",            "https://www.rbi.org.in/Speeches_rss.xml",                                 "india", ["policy", "rbi"], 3),
    ("PIB all releases",        "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3",                  "india", ["policy"], 2),
    ("PIB finance ministry",    "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3",                  "india", ["policy"], 3),
    # --- International wires ---------------------------------------------
    ("Yahoo Finance",           "https://finance.yahoo.com/news/rssindex",                                 "world", ["wire"], 1),
    ("MarketWatch top",         "https://feeds.content.dowjones.io/public/rss/mw_topstories",              "world", ["wire"], 1),
    ("MarketWatch markets",     "https://feeds.content.dowjones.io/public/rss/mw_marketpulse",             "world", ["markets"], 2),
    ("CNBC world markets",      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135", "world", ["markets"], 1),
    ("CNBC economy",            "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", "world", ["macro"], 1),
    ("CNBC finance",            "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", "world", ["business"], 2),
    ("Investing.com news",      "https://www.investing.com/rss/news_25.rss",                               "world", ["markets"], 2),
    ("Investing.com economy",   "https://www.investing.com/rss/news_14.rss",                               "world", ["macro"], 2),
    ("Federal Reserve press",   "https://www.federalreserve.gov/feeds/press_all.xml",                      "world", ["policy", "fed"], 1),
    ("Federal Reserve speeches","https://www.federalreserve.gov/feeds/speeches.xml",                       "world", ["policy", "fed"], 3),
    ("ECB press",               "https://www.ecb.europa.eu/rss/press.html",                                "world", ["policy"], 3),
    ("IMF news",                "https://www.imf.org/en/News/RSS?language=eng",                            "world", ["policy"], 3),
    ("World Bank news",         "https://www.worldbank.org/en/news/all?format=rss",                        "world", ["policy"], 3),
    ("BBC business",            "https://feeds.bbci.co.uk/news/business/rss.xml",                          "world", ["business"], 2),
    ("Guardian business",       "https://www.theguardian.com/uk/business/rss",                             "world", ["business"], 3),
    ("NYT business",            "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",               "world", ["business"], 3),
    ("NPR economy",             "https://feeds.npr.org/1017/rss.xml",                                      "world", ["macro"], 3),
    ("Nikkei Asia",             "https://asia.nikkei.com/rss/feed/nar",                                    "world", ["asia"], 3),
    ("SCMP business",           "https://www.scmp.com/rss/92/feed",                                        "world", ["asia"], 3),
    ("OilPrice.com",            "https://oilprice.com/rss/main",                                           "world", ["commodity", "crude"], 2),
    ("Mining.com",              "https://www.mining.com/feed/",                                            "world", ["commodity"], 3),
    ("Kitco gold",              "https://www.kitco.com/rss/news.xml",                                      "world", ["commodity", "gold"], 3),
]

# --------------------------------------------------- Google News search lanes
INDEX_QUERIES = [
    ("Nifty 50 index",              ["index"], 1),
    ("Sensex BSE index",            ["index"], 1),
    ("Bank Nifty",                  ["index"], 1),
    ("Nifty prediction today",      ["index"], 1),
    ("Indian stock market today",   ["markets"], 1),
    ("Dalal Street market close",   ["markets"], 1),
    ("NSE India trading",           ["markets"], 1),
    ("India VIX volatility",        ["index", "volatility"], 2),
    ("Nifty futures options open interest", ["derivatives"], 1),
    ("Nifty option chain PCR",      ["derivatives"], 2),
    ("F&O expiry Nifty",            ["derivatives"], 2),
    ("Nifty support resistance level", ["technical"], 2),
    ("Nifty midcap smallcap index", ["index"], 2),
]

POLICY_QUERIES = [
    ("RBI repo rate decision", ["policy", "rbi"], 1),
    ("RBI monetary policy committee", ["policy", "rbi"], 1),
    ("RBI governor statement", ["policy", "rbi"], 1),
    ("RBI liquidity CRR", ["policy", "rbi"], 2),
    ("India inflation CPI data", ["macro", "inflation"], 1),
    ("India WPI wholesale inflation", ["macro", "inflation"], 2),
    ("India GDP growth rate", ["macro", "growth"], 1),
    ("India IIP industrial production", ["macro", "growth"], 2),
    ("India PMI manufacturing services", ["macro", "growth"], 2),
    ("India fiscal deficit budget", ["macro", "fiscal"], 1),
    ("Union Budget India tax", ["macro", "fiscal"], 2),
    ("GST collection India", ["macro", "fiscal"], 2),
    ("India trade deficit exports imports", ["macro", "trade"], 2),
    ("India current account deficit", ["macro", "trade"], 3),
    ("India forex reserves", ["macro", "currency"], 2),
    ("SEBI regulation markets", ["policy", "sebi"], 1),
    ("SEBI circular F&O", ["policy", "sebi"], 2),
    ("FII DII flows Indian equities", ["flows"], 1),
    ("foreign portfolio investors India", ["flows"], 1),
    ("mutual fund SIP inflows India", ["flows"], 2),
    ("India IPO listing subscription", ["ipo"], 2),
    ("India bond yield 10 year", ["rates"], 1),
    ("rupee dollar exchange rate", ["currency"], 1),
    ("India government borrowing auction", ["rates"], 3),
    ("India corporate earnings results quarter", ["earnings"], 1),
    ("Nifty companies quarterly results", ["earnings"], 1),
    ("India monsoon rainfall agriculture", ["macro", "seasonal"], 2),
    ("India festive season demand sales", ["macro", "seasonal"], 2),
    ("India credit growth bank deposits", ["sector", "banking"], 2),
    ("India NPA asset quality banks", ["sector", "banking"], 3),
    ("India capex infrastructure spending", ["macro", "growth"], 2),
    ("India electricity power demand", ["sector", "power"], 3),
    ("India auto sales monthly numbers", ["sector", "auto"], 2),
    ("India real estate housing sales", ["sector", "realty"], 3),
    ("India telecom tariff ARPU", ["sector", "telecom"], 3),
    ("India IT services deal wins", ["sector", "it"], 2),
    ("India pharma USFDA approval", ["sector", "pharma"], 2),
    ("India steel cement prices", ["sector", "metal"], 2),
    ("India FMCG rural demand", ["sector", "fmcg"], 3),
    ("India defence order contract", ["sector", "defence"], 3),
    ("India railway order tender", ["sector", "infra"], 3),
    ("India renewable energy solar", ["sector", "energy"], 3),
    ("India semiconductor electronics PLI", ["sector", "manufacturing"], 3),
    ("India startup funding unicorn", ["business"], 3),
    ("India bank merger acquisition", ["sector", "banking"], 3),
    ("India insurance sector IRDAI", ["sector", "insurance"], 3),
    ("India NBFC lending growth", ["sector", "banking"], 3),
    ("India coal mining production", ["sector", "metal"], 3),
    ("India aviation airline traffic", ["sector", "aviation"], 3),
    ("India chemical specialty prices", ["sector", "chemical"], 3),
]

GLOBAL_QUERIES = [
    ("Federal Reserve interest rate decision", ["policy", "fed"], 1),
    ("FOMC meeting minutes", ["policy", "fed"], 1),
    ("US CPI inflation report", ["macro", "inflation"], 1),
    ("US nonfarm payrolls jobs report", ["macro", "growth"], 1),
    ("US GDP growth quarterly", ["macro", "growth"], 2),
    ("US 10 year treasury yield", ["rates"], 1),
    ("dollar index DXY", ["currency"], 1),
    ("S&P 500 Nasdaq Dow close", ["markets"], 1),
    ("Wall Street stock futures", ["markets"], 1),
    ("crude oil price Brent WTI", ["commodity", "crude"], 1),
    ("OPEC production cut decision", ["commodity", "crude"], 2),
    ("gold price forecast", ["commodity", "gold"], 2),
    ("copper aluminium prices LME", ["commodity", "metal"], 3),
    ("European Central Bank rate", ["policy"], 2),
    ("Bank of Japan yen policy", ["policy"], 2),
    ("China GDP stimulus economy", ["asia", "macro"], 1),
    ("China manufacturing PMI", ["asia", "macro"], 2),
    ("Nikkei Hang Seng Asian markets", ["asia", "markets"], 2),
    ("emerging market fund flows", ["flows"], 2),
    ("MSCI index rebalancing India", ["flows"], 2),
    ("global recession risk outlook", ["macro"], 2),
    ("US India trade deal tariff", ["trade"], 1),
    ("Trump tariff announcement", ["trade"], 1),
    ("US China trade tension", ["trade"], 2),
    ("semiconductor chip export controls", ["trade", "tech"], 3),
    ("Middle East conflict oil supply", ["geopolitics", "crude"], 1),
    ("Russia Ukraine war sanctions", ["geopolitics"], 2),
    ("Red Sea shipping freight rates", ["geopolitics", "trade"], 3),
    ("India China border relations", ["geopolitics"], 3),
    ("global supply chain disruption", ["trade"], 3),
    ("US government shutdown debt ceiling", ["policy"], 3),
    ("bitcoin cryptocurrency price", ["crypto"], 3),
    ("AI capex technology spending", ["tech"], 2),
    ("global central bank gold buying", ["commodity", "gold"], 3),
    ("VIX fear index Wall Street", ["volatility"], 2),
]

# Nifty 50 heavyweights - these are what actually move the index.
NIFTY50 = [
    "Reliance Industries", "HDFC Bank", "ICICI Bank", "Infosys", "TCS",
    "Bharti Airtel", "ITC", "Larsen & Toubro", "State Bank of India", "Axis Bank",
    "Kotak Mahindra Bank", "Hindustan Unilever", "Bajaj Finance", "Maruti Suzuki",
    "Sun Pharmaceutical", "Mahindra & Mahindra", "NTPC", "HCL Technologies",
    "Tata Motors", "Titan Company", "Power Grid Corporation", "UltraTech Cement",
    "Asian Paints", "Tata Steel", "Oil and Natural Gas Corporation", "Coal India",
    "Bajaj Finserv", "Nestle India", "JSW Steel", "Wipro", "Adani Enterprises",
    "Adani Ports", "Grasim Industries", "Hindalco Industries", "Tech Mahindra",
    "Dr Reddys Laboratories", "Cipla", "Tata Consumer Products", "IndusInd Bank",
    "Britannia Industries", "Apollo Hospitals", "Bajaj Auto", "Eicher Motors",
    "Hero MotoCorp", "Divis Laboratories", "SBI Life Insurance", "HDFC Life Insurance",
    "Shriram Finance", "BPCL", "LTIMindtree",
]

# Next tier - liquid large and midcaps that show up in index breadth.
NEXT_TIER = [
    "Zomato Eternal", "Jio Financial Services", "DMart Avenue Supermarts", "Pidilite Industries",
    "Godrej Consumer Products", "Dabur India", "Marico", "Colgate Palmolive India",
    "Havells India", "Siemens India", "ABB India", "Bosch India", "Cummins India",
    "Bharat Electronics", "Hindustan Aeronautics", "Bharat Dynamics", "Mazagon Dock",
    "Cochin Shipyard", "Garden Reach Shipbuilders", "Indian Railway Finance Corporation",
    "RVNL Rail Vikas Nigam", "IRCTC", "Container Corporation of India", "Indian Oil Corporation",
    "Hindustan Petroleum", "GAIL India", "Petronet LNG", "Oil India", "Vedanta",
    "Nalco National Aluminium", "Steel Authority of India", "Jindal Steel and Power",
    "APL Apollo Tubes", "Shree Cement", "Ambuja Cements", "ACC Cement", "Dalmia Bharat",
    "JK Cement", "DLF", "Godrej Properties", "Oberoi Realty", "Prestige Estates",
    "Phoenix Mills", "Lodha Macrotech", "Bank of Baroda", "Punjab National Bank",
    "Canara Bank", "Union Bank of India", "Indian Bank", "Bank of India",
    "IDFC First Bank", "Federal Bank", "Bandhan Bank", "AU Small Finance Bank",
    "Yes Bank", "RBL Bank", "Cholamandalam Investment", "Muthoot Finance",
    "Bajaj Holdings", "SBI Cards", "HDFC AMC", "Nippon India AMC", "ICICI Prudential Life",
    "Max Financial Services", "General Insurance Corporation", "New India Assurance",
    "Lupin", "Aurobindo Pharma", "Zydus Lifesciences", "Torrent Pharmaceuticals",
    "Alkem Laboratories", "Mankind Pharma", "Glenmark Pharmaceuticals", "Biocon",
    "Laurus Labs", "Syngene International", "Fortis Healthcare", "Max Healthcare",
    "Persistent Systems", "Coforge", "Mphasis", "L&T Technology Services", "KPIT Technologies",
    "Tata Elxsi", "Oracle Financial Services", "Info Edge Naukri", "PB Fintech Policybazaar",
    "Paytm One97", "Nykaa FSN Ecommerce", "IndiGo InterGlobe Aviation", "SpiceJet",
    "Indian Hotels Company", "EIH Oberoi Hotels", "Jubilant FoodWorks", "Devyani International",
    "Trent Westside", "Aditya Birla Fashion", "Page Industries", "Bata India",
    "TVS Motor Company", "Ashok Leyland", "Escorts Kubota", "Balkrishna Industries",
    "MRF Tyres", "Apollo Tyres", "Motherson Sumi Samvardhana", "Bharat Forge",
    "Exide Industries", "Amara Raja Batteries", "Tata Power", "Adani Green Energy",
    "Adani Power", "Adani Total Gas", "JSW Energy", "Torrent Power", "NHPC",
    "SJVN", "Power Finance Corporation", "REC Limited", "IREDA", "Suzlon Energy",
    "Waaree Energies", "Premier Energies", "UPL Limited", "PI Industries",
    "SRF Limited", "Deepak Nitrite", "Aarti Industries", "Tata Chemicals",
    "Coromandel International", "Chambal Fertilisers", "Berger Paints", "Kansai Nerolac",
    "Astral Pipes", "Supreme Industries", "Polycab India", "KEI Industries",
    "Dixon Technologies", "Amber Enterprises", "Blue Star", "Voltas", "Whirlpool India",
    "Crompton Greaves Consumer", "V-Guard Industries", "Thermax", "Kirloskar Oil Engines",
    "AIA Engineering", "Carborundum Universal", "Grindwell Norton", "Timken India",
    "Schaeffler India", "SKF India", "Godrej Industries", "United Spirits",
    "United Breweries", "Radico Khaitan", "Varun Beverages", "Emami", "Bajaj Consumer",
    "Honasa Mamaearth", "Vinati Organics", "Navin Fluorine", "Gujarat Fluorochemicals",
    "Linde India", "Solar Industries", "Ideaforge Technology", "Data Patterns",
    "Paras Defence", "Zen Technologies", "Apar Industries", "Transformers and Rectifiers",
    "CG Power and Industrial", "Hitachi Energy India", "Inox Wind", "Sterling and Wilson",
    "Kalpataru Projects", "KEC International", "NCC Limited", "Afcons Infrastructure",
    "GR Infraprojects", "PNC Infratech", "IRB Infrastructure", "Adani Wilmar",
    "Patanjali Foods", "Hatsun Agro", "Balrampur Chini", "Shree Renuka Sugars",
    "Triveni Engineering", "Godrej Agrovet", "Kaveri Seeds", "Rallis India",
    "Sumitomo Chemical India", "Bayer CropScience India", "Jubilant Ingrevia",
    "Clean Science Technology", "Fine Organic Industries", "Camlin Fine Sciences",
]

SECTOR_QUERIES = [
    "Nifty Bank index stocks", "Nifty IT index stocks", "Nifty Auto index stocks",
    "Nifty Pharma index stocks", "Nifty Metal index stocks", "Nifty FMCG index stocks",
    "Nifty Realty index stocks", "Nifty Energy index stocks", "Nifty PSU Bank index",
    "Nifty Financial Services index", "Nifty Media index", "Nifty Infrastructure index",
    "Nifty Consumer Durables index", "Nifty Oil and Gas index", "Nifty Healthcare index",
    "Nifty Private Bank index", "Nifty Commodities index", "Nifty Defence index",
    "Nifty Capital Markets index", "Nifty Railway PSU index",
]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48]


def build():
    feeds = []
    seen = set()

    def add(fid, name, url, lane, region, tags, priority):
        if url in seen:
            return
        seen.add(url)
        feeds.append(
            {
                "id": fid,
                "name": name,
                "url": url,
                "lane": lane,
                "region": region,
                "tags": tags,
                "priority": priority,
            }
        )

    for name, url, region, tags, pri in DIRECT:
        add("d_" + slug(name), name, url, "direct", region, tags, pri)

    for q, tags, pri in INDEX_QUERIES:
        add("gi_" + slug(q), q, gn(q), "gnews", "india", tags, pri)
    for q, tags, pri in POLICY_QUERIES:
        add("gp_" + slug(q), q, gn(q), "gnews", "india", tags, pri)
    for q, tags, pri in GLOBAL_QUERIES:
        add("gw_" + slug(q), q, gn(q, "us"), "gnews", "world", tags, pri)
    for q in SECTOR_QUERIES:
        add("gs_" + slug(q), q, gn(q), "gnews", "india", ["sector"], 2)

    for co in NIFTY50:
        q = f"{co} share price news"
        add("gc_" + slug(co), co, gn(q), "gnews", "india", ["company", "nifty50"], 2)
    for co in NEXT_TIER:
        q = f"{co} share price news"
        add("gn_" + slug(co), co, gn(q), "gnews", "india", ["company"], 3)

    by_priority = {}
    for f in feeds:
        by_priority[f["priority"]] = by_priority.get(f["priority"], 0) + 1

    payload = {
        "generated_at": now_iso(),
        "count": len(feeds),
        "by_lane": {
            "direct": sum(1 for f in feeds if f["lane"] == "direct"),
            "gnews": sum(1 for f in feeds if f["lane"] == "gnews"),
        },
        "by_region": {
            "india": sum(1 for f in feeds if f["region"] == "india"),
            "world": sum(1 for f in feeds if f["region"] == "world"),
        },
        "by_priority": by_priority,
        "note": "Every URL here is a real, free, keyless feed. Priority controls poll cadence: 1=every cycle, 2=every 3rd, 3=every 10th.",
        "feeds": feeds,
    }
    write_json("feeds_index.json", payload)
    print(f"  {len(feeds)} feeds  {payload['by_lane']}  {payload['by_region']}  priority={by_priority}")
    return payload


if __name__ == "__main__":
    build()
