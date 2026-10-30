# GitHub repos worth using

What this terminal already takes from open source, and what is worth wiring
in next, in order. Checked 30 Oct 2026; read each licence again before
adding anything.

## In use

| Repo | What it does here |
| --- | --- |
| [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) | Candle foundation model: half of the price-model lane (`scripts/kronos_forecast.py`, `kronos.yml`) |
| [amazon-science/chronos-forecasting](https://github.com/amazon-science/chronos-forecasting) | Chronos-Bolt: the other half of that lane (`scripts/chronos_forecast.py`) |
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | The AI desk's design: analysts, a bull and bear debate, a final call with a risk check, and memory of past calls (`assets/js/desk.js`, `lessons.js`) |
| tradermonty's Claude trading skills | Market-regime and breadth checklists (`trading-skills/`) |
| [microsoft/qlib](https://github.com/microsoft/qlib) | The Alpha158 factor set the twenty-year model's own-price factors follow (`scripts/history_model.py`) |

## Next, in order

1. **Chronos-2** ([amazon/chronos-2](https://huggingface.co/amazon/chronos-2),
   Apache-2.0, about 120M parameters, runs on CPU). Unlike Chronos-Bolt it
   takes covariates, past-only and known-future, and forecasts several series
   together, with up to 8,192 steps of context. Swapped into
   `scripts/chronos_forecast.py` with the world markets the "Why it is moving"
   card shows (US futures, Asia, crude, the rupee) as past covariates, the
   price-model lane would read the same factors as the drivers panel.
   `pip install "chronos-forecasting>=2.0"`, then
   `Chronos2Pipeline.from_pretrained("amazon/chronos-2")`.
2. **TimesFM 2.5** ([google-research/timesfm](https://github.com/google-research/timesfm)):
   Apache-2.0, one series at a time, as a third voice in the price-model
   lane. TimesFM 3 (August 2026) adds covariates, but its weights are for
   non-commercial, non-production use only, so it stays out.
3. **Sector rotation**: [AdroitAnandAI/RRG-Sector-Rotation-India](https://github.com/AdroitAnandAI/RRG-Sector-Rotation-India)
   draws relative rotation graphs for NSE sectors (leading, weakening,
   lagging, improving). The page already has the sector board; the RRG would
   add which sectors are rotating in.
4. **Broker data, if you connect an account**: [OpenAlgo](https://docs.openalgo.in)
   (marketcalls) puts one API over the Indian brokers, for exchange-grade ticks
   and your real orders. It needs your broker keys and runs on your own
   machine, so it can never sit in this public repo.
5. **Option chain history**: TechfaneTechnologies/QtsApp and similar option
   chain libraries compute IV, OI and Greeks; this repo's own chain archive is
   the cheaper route to a backtestable options lane.

## How to judge a new one

A model or source joins as a lane with a small weight and earns more only off
the judged record (`assets/js/learn.js`), the way Kronos, the crowd and the
twenty-year model did. Published benchmarks for time-series models are mostly
on non-financial data, and some overlap their own training data; the only
test that counts here is the said-against-did record.
