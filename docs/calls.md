# The call, the verdict and what it learns

How the terminal says where the next session goes, checks itself once the
session is over, and uses each miss for the next call. Written 30 Oct 2026.

## One page

There is one page, `index.html`, laid out as before. The parts added in
October 2026 sit inside it, in the right-hand column:

| Card | File | What it shows |
| --- | --- | --- |
| Next session | `assets/js/panels.js` `renderCall` | the frozen call: lean and odds, where it opens, the likely closing range, what makes it right, support and resistance, and the other readers (AI desk, 20-year model, price models) |
| Said vs did | `panels.js` `renderJudge` | the last judged session in full (what it did not know, what it filed for next time) and one row per session |
| AI desk | `panels.js` `renderDesk`, `assets/js/desk.js` | four analysts (five with the crowd's mood when it answers), a debate and a final call; needs an OpenRouter key |
| What it has learned | `panels.js` `renderLearned` | lessons, which inputs pointed the right way, the twenty-year record, the learned weights |

`classic.html` redirects to `index.html`. The search box above the market
watch finds any NSE stock (`panels.js`, `assets/js/stocks.js`).

The chart puts NOW in the middle (`C.ui.centreNow`, `chart.js frameView`):
the past and the earlier forecast on the left, the forecast on the right.

## The session call

One frozen call per session, always the session view's (one-minute path to
15:30), whichever view is on screen (`app.js sessionCall`). Two stages, each
written once and never rewritten (`assets/js/ledger.js lock`):

- `advance`: the day before, after the close
- `open`: before the open, once the overnight session is in

The call is the odds of closing above the last close (`forecast.closeOdds`,
which adds the uncertainty of the open). 55% or more is an up call, 45% or
less a down call, anything between is no lean. That one rule
(`ledger.callDirOf`) is used by the card, the record and the verdict.

A forecast for a session that has already traded (a stale feed) is never
frozen (`stageNow`).

## The record (data/calls.json)

The browser's own record lives in one browser. So the workflow keeps the
real one: `scripts/daily_call.js`, run by `.github/workflows/history.yml`
twice a weekday.

- 16:40 IST: judges the session that just closed and freezes the call for
  the next one
- 08:25 IST: freezes the pre-open call (its window opens at 08:00 for the
  workflow, 09:00 for a browser)

It runs the page's own modules in Node (`scripts/ktvm.js`), so the call it
freezes is the same arithmetic the page runs. Before it runs, the workflow
refreshes the tape with the same fetchers `live-data.yml` uses, and the
script refuses to freeze or judge from a tape that stops before a close
(`tapeGap`).

Every browser loads the record (`app.js loadCalls`, at boot and every ten
minutes) and `ledger.setShared` makes the record's call the call for its
sessions: a browser freezes its own only for a stock or a session the record
does not cover. Ids of workflow calls end in `:wf`. A browser that has the
closing bars before the evening run settles a copy of the record's call
itself, so the verdict shows at 15:30; the record's version replaces the
copy once it exists.

Kept per symbol: the last 80 sessions, both calls for the last 20, every
projected minute for the last 3 (packed as start, step and values). The run
merges main's copy as well (`--also`), so a push from another workflow can
never lose a judged session.

## The verdict (assets/js/postmortem.js)

After the close each call is judged: right, wrong, no lean, or the market
went nowhere. When it missed, the card lists what it did not know, as facts
with times on them, never a claimed cause:

- the open: most of the miss was already there at 09:15
- the cues: what the overnight markets did after the freeze
- the news: strong headlines after the freeze, pointing the way price went
- the flows: FII cash of ₹1,000 crore or more that day, the way price went
- the size: a close outside the call's own ranges
- the turn: the minute the two lines parted
- its own inputs: which pointed the wrong way
- the calendar: events and expiry

## What it learns from each miss

Three things, all bounded, all visible on the page:

1. **Lessons** (`assets/js/lessons.js`). Each judged session files one
   lesson under the situation the call was made in (trend, news tone, FII,
   VIX, RSI, the gap). The AI desk reads the closest ones before its next
   call. One lesson a session: the pre-open call's, when there is one.
2. **Lane weights** (`assets/js/learn.js`). An input whose record of
   pointing the right way clears a coin with 95% confidence over at least 20
   judged sessions gains weight, at most 8% a step, one step per new judged
   session; one whose record sits below a coin loses it; none goes below
   the floor. Fitted on NIFTY's record by the workflow, used by every
   browser and by the workflow's own next call (`learn.adoptShared`).
3. **The size of the gap.** If the opens it calls are too big or too small
   on average, one gain scales every overnight cue, from at least 10 judged
   opens, shrunk toward 1 while the sample is thin.

Until those samples exist the page says so rather than moving anything. A
browser's own learner (the fallback where the record has no fit) follows the
same rule: one step per batch of new settled calls, never one an hour on the
same evidence.

## Twenty years (data/history_model.json, data/study.json)

- `scripts/fetch_history.py`: daily bars since 2005 for NIFTY, SENSEX, BANK
  NIFTY, India VIX, the US (S&P, Nasdaq, Dow, futures, VIX, chips, credit,
  emerging markets), Asia (Nikkei, Hang Seng, KOSPI, Taiwan, ASX, Shanghai,
  Singapore), Europe, crude, gold, copper, the rupee, the dollar, US yields,
  and India's sector indices and midcaps. Kept in the Actions cache.
- `scripts/history_model.py`: a gradient-boosted model on price factors and
  those markets, aligned by what was known at the hour of the call (evening,
  or pre-open with the US close and Asia's opening move). Trained
  walk-forward: every year scored by a model that never saw it. Its record
  sits beside two baselines (always up; tomorrow repeats today), and its vote
  is cut until it beats them. A planted lead-lag check (`--selfcheck`) runs
  first and fails the workflow if the alignment ever leaks.
- `scripts/history_study.js`: the page's own pattern detectors over the
  whole record, with how each resolved and the base rates.

## Price models (data/kronos.json, data/chronos.json)

Kronos (candles) and Chronos-Bolt (any series) each write the next session
on five-minute bars and the next ten sessions on daily bars, from
`.github/workflows/kronos.yml`. The forecast
averages the two into one lane and says so when they point opposite ways.

## Checks

- `node scripts/selftest.js`: the page as a whole
- `node scripts/selftest_calls.js`: the call, the verdict, the record and
  the learning, including a replayed evening, morning and evening of the
  workflow script on a scratch copy of the data
- `python scripts/history_model.py --selfcheck`: the leak check

## Not yet proven live

Until their workflows have run on GitHub: the record itself, the twenty-year
model's real numbers, and both price models. Their first runs are the check.
