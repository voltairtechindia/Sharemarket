# Market desk

A live Indian market dashboard that runs on GitHub Pages for free. No paid API,
no server, no API key required to get started.

GitHub Actions does the fetching on a schedule and commits plain JSON files into
`data/`. The page reads those files from its own domain, so there is no CORS
problem and no secret sitting in browser JavaScript.

## What it shows

- Nifty 50, Bank Nifty, Sensex and India VIX with intraday sparklines
- Sector indices, biggest movers, global indices, USDINR, crude, gold, bitcoin
- A merged news feed from 11 Indian RSS sources plus 9 Google News keyword watchers,
  deduped, and tagged with the sectors and stocks likely to react
- Social chatter from Reddit, public Telegram channels and X mirrors
- An F&O option chain with OI, IV, PCR and max pain, once you add a broker token
- A next-session forecast whose accuracy is measured against real closes

## Forecast engine

`scripts/predict.py` logs one call per session. It fuses ten signals: India VIX,
US index cues, USDINR, crude, Nifty's own momentum, heavyweight breadth, PCR, OI skew,
max pain distance, and aggregate news direction.

Three things make the number mean something.

Every signal declares whether it actually fired. When the option chain is missing, PCR,
OI and max pain report "no data" rather than quietly defaulting to neutral, and the panel
shows that greyed out.

Conviction is divided by every signal that produced a reading, not just the opinionated
ones. Three inputs agreeing while seven shrug reads as 30% agreement, not 100%.

`scripts/validate.py` fetches the real close from Yahoo, compares it to the spot recorded
when the call was made, and marks hit or miss. Signals that pointed the right way get
their weight multiplied by 1.05, ones that pointed wrong by 0.95, clamped to 0.3 to 3.0.
Signals that said flat, or never fired, are left alone. Weights persist in
`data/predictions.json` and feed the next call.

The `forecast` workflow runs both at 16:05 IST on weekdays. The panel refuses to present
an accuracy figure as meaningful below 30 settled calls, because a coin flip clears 66%
over three tries often enough to fool anyone.

## Migrated from the original prototype

The forecast panel replaces the self-learning box in the earlier build. The three rows
from that build's `predictions.json` are preserved under `legacy_demo` and excluded from
every accuracy number, because the old `validate()` route set `correct = True`
unconditionally, so the 66.7% was never checked against a market close.

Futures price and basis are not shown. Yahoo does not carry NSE index futures, so those
two fields say "broker feed only" instead of displaying a plausible looking number.

## Setup

1. Create a new repo, drop these files in, push.
2. Settings, Pages, set Source to "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Settings, Actions, General, scroll to Workflow permissions and pick "Read and write".
   Without this the bot cannot commit the data files.
4. Actions tab, run **market data** and **news and social** once by hand.
5. Open `https://<username>.github.io/<repo>/`.

Cron takes over after that. Market data refreshes every 5 minutes during Indian
market hours, news and social every 15 minutes.

To see the layout before any of that, `python scripts/demo_data.py` fills `data/`
with obviously fake numbers. Open `index.html` through a local server, not as a
`file://` path, or the browser will block the JSON reads:

```
python scripts/demo_data.py
python -m http.server 8000
```

## The honest limits

**Refresh rate.** GitHub's cron minimum is 5 minutes and runs often drift by another
5 to 15 minutes when the platform is busy. That is fine for news and for watching
index levels. It is not fast enough to trade off.

**NSE blocks datacenter IPs.** The unofficial `nseindia.com` endpoints will not answer
a GitHub runner, so the option chain stays empty on Pages until you do one of the two
things below. Everything else on the page still works.

**The X lane will break sometimes.** X Corp sent takedown letters to Nitter instances
in August 2026, so public mirrors come and go. That lane is isolated: when it fails,
Reddit, Telegram and the news feed keep running and the page says so in the Social tab.
In practice the Google News keyword watchers catch a market-moving post within a minute
or two anyway, because the wires pick it up.

**Repo history grows.** Roughly 80 commits a day. Squash the history every few months
if it bothers you, or point Pages at a separate data branch.

## Getting a real option chain

Two routes, both free.

**Run it on your own machine.** NSE answers a home broadband IP:

```
pip install -r requirements.txt
python scripts/serve.py
```

That refreshes every 60 seconds and serves the dashboard on your LAN IP, so any
phone or laptop on the same network can open it. Flags: `--port`, `--market-every`,
`--news-every`.

**Or add a Dhan token.** Dhan gives free data API access with a demat account, and the
token lasts about 30 days, which means it survives inside GitHub Actions without a
daily login dance. Generate one in the Dhan web app under DhanHQ Trading APIs, then add
`DHAN_ACCESS_TOKEN` and `DHAN_CLIENT_ID` under Settings, Secrets and variables, Actions.
The option chain panel fills in on the next run.

Angel One SmartAPI and Upstox also work and are also free, but both want a fresh login
each day and Angel One binds some apps to a static IP, which GitHub runners do not have.
Dhan is the least painful fit for this setup.

## Changing what it tracks

| File | What it controls |
|---|---|
| `config/watchlist.yml` | Which symbols appear. Any Yahoo Finance ticker works. |
| `config/feeds.yml` | RSS sources, Google News search terms, subreddits, X handles, Telegram channels. |
| `config/keywords.yml` | Which words map to which sector and stock list, and what counts as high impact. |

The Google News block in `feeds.yml` is the most useful thing to edit. Each entry is a
plain search query, so adding a watcher for a person, a company or a policy is one line.

## Data sources

Everything below is free and needs no signup.

| Source | Used for |
|---|---|
| Yahoo Finance chart endpoint | All quotes, indices, FX, commodities |
| Google News RSS search | Keyword and event watchers |
| Moneycontrol, ET, Livemint, Business Standard, Financial Express, BusinessLine | Market news |
| RBI press release RSS | Policy |
| Reddit `.rss` | Retail chatter |
| `t.me/s/<channel>` | Public Telegram channels |
| Nitter forks | X, best effort |

Optional, free with an account: Dhan (option chain), NSE direct (local only).

## Layout

```
.github/workflows/   two cron workflows
scripts/             fetchers, commit helper, local server
config/              watchlist, feeds, keyword map
data/                JSON written by the bot, read by the page
index.html           the dashboard
assets/              styles and logic
```
