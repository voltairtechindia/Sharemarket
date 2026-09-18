---
name: indian-market-free-endpoints
description: "Which free NSE/BSE/Moneycontrol/Yahoo endpoints still answer, measured 18 Sep 2026"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c0c22991-d32e-41fb-9923-81f616c9ecdd
  modified: 2026-09-18T05:55:23.184Z
---

Measured 18 Sep 2026 from a residential IP and from a headless browser on
`voltairtechindia.github.io`.

**Working**
- `nseindia.com/api/allIndices` — every index row carries `advances`,
  `declines`, `unchanged`, `last`, `percentChange`, `previousClose`, `pe`, `pb`.
  This is the surviving free breadth source.
- `nseindia.com/api/fiidiiTradeReact` — FII/DII net in crore.
- `nseindia.com/api/marketStatus`, `/api/equity-master`,
  `/api/live-analysis-variations?index=gainers|loosers`, `/api/market-turnover`.
- `nseindia.com/api/corporate-announcements?index=equities` — filings.
- `priceapi.moneycontrol.com/pricefeed/...` — live index price, sends CORS
  headers, readable straight from a browser. Also carries `adv`/`decl`/`unchg`.
- `www.moneycontrol.com/rss/*.xml` — **server side only**.
- Yahoo `query1.finance.yahoo.com/v8/finance/chart/<sym>` — OHLC.

All NSE calls need the homepage cookie first (`GET
nseindia.com/market-data/live-equity-market`), a browser `User-Agent` and a
`Referer`. Expect waves of IP-based blocking.

**Dead or blocked**
- `nseindia.com/api/equity-stockIndices?index=…` — **404 for every index**,
  including `NIFTY 50` and `SECURITIES IN F&O`. Was the standard constituent
  endpoint; use `allIndices` instead.
- `www.moneycontrol.com/rss/*.xml` **from a browser** — 403, all paths.
- `api.bseindia.com/BseIndiaAPI/api/AnnGetData/w` — returns 200 with the bare
  JSON string `"No Record Found!"` (so `.get()` on it raises AttributeError).
  `bseindia.com` serves "Access Denied" to headless/datacentre addresses.
- Yahoo `meta.chartPreviousClose` is the close before the **requested range**,
  not the previous session. With `range=5d` it is five sessions stale. Derive
  prev close from the daily candle series instead.

**CORS-clean RSS a browser can read directly** (verified from the live origin):
CNBC TV18 (`market`, `economy`, `business`, `personal-finance`, `startup`,
`world`), CNBC US (`search.cnbc.com/rs/search/combinedcms/view.xml?...`),
MarketWatch (`feeds.content.dowjones.io/public/rss/mw_topstories`,
`mw_realtimeheadlines`, `mw_marketpulse`), Yahoo Finance
(`finance.yahoo.com/news/rssindex`).
**Not** CORS-clean: Economic Times, Livemint, Business Standard, NDTV Profit,
Zee Business, Financial Express, Hindu BusinessLine, Investing.com, Google News.

Related: [[nifty-terminal-project]]
