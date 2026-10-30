# CLAUDE.md: NIFTY Terminal

Static, keyless, India-first market terminal. GitHub Pages serves the repo
root; GitHub Actions fetches what a browser cannot reach. No backend, no broker
API, no paid feed. Live: https://voltairtechindia.github.io/Sharemarket/

This file is the short operational layer. Long-form history and every
measured gotcha: `docs/engineering-notes.md`. The call, its verdict, the
record and the learning: `docs/calls.md`. The AI desk, lessons and stock
search: `docs/v2.md`. Product and forecast rationale: `README.md`.

## Pages

| Page | What | Script entry |
|---|---|---|
| `index.html` | the terminal: NOW-centred chart, every panel, and in the right column the session call, said vs did, the AI desk and what it has learned | `app.js` + `panels.js` |
| `classic.html` | forwards to `index.html`, for old links | none |
| `ipo.html` | IPO terminal | `ipo-app.js` |
| `profile.html`, `data.html` | orders and P&L; every dataset and its status | `profile-app.js`, `hub-app.js` |

## The one rule

**A lane that nothing reads is the recurring bug here.** Before calling
anything done, confirm the round trip (`grep -rn "file.json" assets/ *.html scripts/`).
If nothing reads it, wire it or do not write it.

## Verify like this

1. `node scripts/selftest.js`: loads the real modules into a vm whose global
   is `window`; 498 checks (30 Oct 2026), each a real bug once, including
   `scripts/selftest_calls.js` (the call, the verdict, the record, and the
   workflow's `daily_call.js` replayed over an evening, a morning and an
   evening on a scratch copy of the data). It also checks that every id
   `app.js`, `chart.js` and `panels.js` write to exists on the page. Two timing
   checks fail on slow 2-vCPU boxes; do not loosen them.
   `python scripts/history_model.py --selfcheck` is the twenty-year model's
   leak check.
2. The page itself, in Playwright or a real browser, light and dark, desktop
   and phone: zero page errors, zero HTTP >= 400, Data Lanes reading `live`.
   Localhost: `serve-local.bat` (127.0.0.1:8080). Then the live origin, where
   CORS differs; changed files can be tried there before a push (notes, "V2,
   and the first check on the live origin"). "Done" means read back from the
   running page.
3. When a test is added, mutate the code and watch it go red.

`data/*.json` in a clone is a snapshot. The page reads the `live-data` branch
from raw.githubusercontent first.

## Load order is a dependency order

`config` → `local-config` → `core` → `indicators` → `levels` → `candles` →
`patterns` → `structures` → `journal` → `orders` → `portfolio` → `data` →
`analogs` → `vol` → `forecast` → `postmortem` → `ledger` → `learn` → `trail` →
`evidence` → `engine` → `chart` → `streetcalls` → `stocks` → `lessons` →
`desk` → `app` → `panels`. Reordering breaks the page silently. The workflow
scripts load the same files in Node through `scripts/ktvm.js`.

## Invariants (details in the notes)

- `build()` and `calibrate()` draw the band through `bandPath()`/`volContext()`.
- Outcomes are read by time (`closeAtTime()`), never by index.
- Intervals use `nEff`, never `n`. Holidays live in `core.js`.
- A failed fetcher run never clobbers the last good file (`common.carry_forward`).
- Nothing slow or undeclared in boot's `Promise.all`.
- The option chain is summarised in JS and Python; selftest proves they agree.
- A stale quote or stale candles are never forecast under a new symbol
  (`setSymbol` and `setTimeframe` clear `S.candles`; `refreshCandles` drops a
  late answer for an old view).

## AI rules (OpenRouter, free tier)

- Key: `assets/local-config.js` (gitignored) or Settings (browser storage).
  **Never commit a key.** The repo and the site are public.
- Send `reasoning: { enabled: false }`; reject completions under the minimum
  length; filter guard/safety/moderation ids. `openrouter/free` stays default.
- Budget: 50 requests a day on the free tier (`data.aiBudget()`). The desk
  spends 6 a run, 7 with the sentiment analyst (14 at most, with retries); with
  it on (`C.ui.desk`) the single-call vote and narrative do not run.
- The AI never sees the engine's verdict, only votes, and is settled and
  scored like every lane. It never writes a price.
- Public copy never names the vendor or the model ("the AI"), and never says
  buy or sell (SEBI). Tips only from published calls (`streetcalls.js`).

## Endpoints

Dead ones and their replacements: `docs/engineering-notes.md`, "Endpoints".
Alive from the Pages origin (29-30 Oct 2026): TradingView screener POST
(`text/plain`, no preflight) for any NSE stock plus `beta_1_year`,
`earnings_release_next_date`, `industry`, `open`; OpenRouter models list;
through `r.jina.ai`, Yahoo chart (`SYM.NS`, 1m, 5d), NSE, Tickertape's mood
index and StockTwits (`NIFTY50.NSE`, `SYMBOL.NSE`; none for SENSEX). Yahoo
direct is CORS-blocked. Reddit answers 403 to every proxy; `fetch_social.py`
tries it keyless from Actions and drops it when refused.

## Workflows

- `live-data.yml`: asks for every 5 minutes, gets about one run per 2.5 hours;
  force-pushes `data/` to the orphan `live-data` branch. A wide news sweep
  (`fetch_news.py --wide`), the crowd's `data/social.json` (`fetch_social.py`).
  `config/feeds.yml` is read whole (`feeds_build.py yaml_lanes`; `reddit:` by
  `fetch_social.py`).
- `snapshot.yml`: copies `live-data` to `main` four times a day.
- `kronos.yml`: the price models (Kronos, Chronos-Bolt) to
  `data/kronos.json` and `data/chronos.json`.
- `history.yml`: twice a weekday: the tape, the twenty-year model
  (`data/history_model.json`, `data/study.json`), `daily_call.js` (judges the
  closed session, freezes the next: `data/calls.json`), then `training_log.sh`
  appends every call and judgement to the `training-log` branch. Where the
  calls go wrong: `git fetch origin training-log`, read its `summary.md`.
- Both share `live-data`'s concurrency group and publish through
  `publish_live.sh`. Added 30 Oct 2026; their first runs are the check.

## Style

ES5 browser JS (`var`, `function`, no modules, no build). Python is stdlib plus
`requests`/`feedparser`/`PyYAML`; the models' own deps (pandas, numpy,
lightgbm, torch) are installed only inside their workflows.
Comments say why, with the measurement that forced the decision. A made-up
number is worse than no number: if a source fails, the UI says so. No em
dashes in product copy.

## Git

`main` only (`live-data` and `training-log` are written by the workflows,
never by hand). The owner commits and pushes from Windows. Working tree may be
CRLF, index LF: commit with `git -c core.autocrlf=input`. Never commit
`assets/local-config.js` or `.venv/`. Another agent may edit this repo at the
same time: check `git status` and mtimes before reverting anything.
