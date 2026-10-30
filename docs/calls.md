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
| AI desk | `panels.js` `renderDesk`, `assets/js/desk.js` | four analysts (five with the crowd's mood when it answers), a debate and a final call made knowing its own recent record; needs an OpenRouter key |
| What it has learned | `panels.js` `renderLearned` | lessons, which inputs pointed the right way, the twenty-year record, the learned weights |

`classic.html` redirects to `index.html`. The search box above the market
watch finds any NSE stock (`panels.js`, `assets/js/stocks.js`).

The chart puts NOW in the middle (`C.ui.centreNow`, `chart.js frameView`):
the past and the earlier forecast on the left, the forecast on the right.

Every frozen line stays on the chart (`app.js pastCalls`, `chart.js
drawLocked`, 30 Oct 2026). Each finished session's call is drawn over its own
candles with what price did beside it, and ends in a dot that reads "said
22,655, closed 22,937": green when the call was right, red when it was wrong.
The record keeps a five-minute sketch of each line for its last 20 sessions,
so the lines are there in every browser, not only in the one that froze them.

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

Four things, all bounded, all visible on the page:

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

4. **The size of the session's move, and a lean** (`learn.closeFitFrom`,
   30 Oct 2026), from the gap between each frozen line and the market. For
   every judged session: how far the line said the session would go from its
   open to its close, against how far it went. The least-squares gain of one
   on the other, from at least 10 sessions, shrunk toward 1 and held between
   0.4 and 1.6, resizes the line's drift: a line that keeps calling twice the
   move gets about half. What is left, the average distance the close lands
   above or below the line, becomes a lean only after 20 sessions and only
   when it is two standard errors clear of zero, capped at 0.25% a session.
   Each call carries the gain and lean it was drawn with (`learned`) and the
   fit divides them back out, so a correction never learns from itself.
   A browser's own daily-view calls (5-minute bars, the same session) count
   too, so a browser that has been open for weeks learns from day one: one
   owner's 15 judged sessions, each scored with itself left out, took the
   average close miss from 0.96% to 0.92% (`learn.closeFitCheck`, shown
   under said vs did).

The AI desk's final call also reads its last eight judged sessions, what the
line said against what the market did and why it missed, before it answers
(`desk.recordText`).

Until those samples exist the page says so rather than moving anything. A
browser's own learner (the fallback where the record has no fit) follows the
same rule: one step per batch of new settled calls, never one an hour on the
same evidence.

## The crowd (data/social.json)

`scripts/fetch_social.py`, run by `live-data.yml` and `history.yml`:
Tickertape's Market Mood Index, the StockTwits streams for NIFTY and BANK
NIFTY, and the subreddits listed in `config/feeds.yml`, tried without a key
and left out when Reddit refuses (it does, from most cloud addresses). The
forecast reads it as the crowd lane (`forecast.crowdLane`, weight 0.04): the
other way at the extremes (mood index above 70 or below 30, a stream three to
one either way) and not at all in the middle. A browser also reads the mood
index and the symbol's stream itself every fifteen minutes and uses whichever
reading is newer. The learner moves its weight off the record like every
other input.

## The training log (the training-log branch)

Every frozen call and every judgement, appended by `scripts/training_log.sh`
right after `daily_call.js`, to the `training-log` branch, which keeps its
history and is never served by the site:

- `log/YYYY-MM.jsonl`: events `frozen`, `judged` and `run`, joined by id.
  The line and the gap between line and market every fifteen minutes, every
  input's push and note, the cue prices, the situation, the verdict, the
  reasons it missed, the lesson, and what the record had learned at each run.
- `summary.md`: the record in plain words and tables, rewritten every run.
- `README.md`: the schema.

To study where it goes wrong: `git fetch origin training-log`, then read
`summary.md` on that branch.

## Why it is moving (assets/js/drivers.js)

The card splits the index's move into what is pushing it down and what is
holding it up. Every market abroad (36 live through the screener, refreshed
every minute) is its move times its link to NIFTY measured over twenty years
(`history_model.py world_links`: the market's last move before the open
against the next gap and close, and for the markets that close before NSE,
the same day's move), in points. Within a group (the US, Asia, Europe,
commodities, currencies and rates) only the strongest link counts, because
the S&P, the Nasdaq and their futures are one move. India's own heavyweights
are weight times move (full market cap weights, approximate). Flows,
breadth, India VIX, options, news and the crowd are listed without points.
Until the workflow's first run publishes the links, markets are shown by the
way they usually push India and claim no points.

The world markets are kept every five minutes while the page is open
(`app.js recordWorld`), so a reason point on the chart names the market that
moved in the same window ("Abroad in the same window: Hang Seng -0.9%"),
not only the headline.

## The setup check (drivers.setup)

Two views of the same inputs, worded as conditions and never as advice:

- Direction: the odds the close is higher, how many inputs agree with the
  lean, the strongest with it and against it, the room to the next
  resistance and support, and the call's own record.
- Range, for selling options: one day's expected move from India VIX, the
  line's likely range, and the signs for and against a quiet day (the CPR's
  width against twenty years of widths, VIX level and change, the gap, high
  impact events, expiry, the distance to the call and put walls, and a hard
  day abroad).

## Studies and the playbook (assets/js/studies.js)

The Studies menu on the chart draws what Indian traders draw before the
open: the CPR, floor pivots, Camarilla, yesterday's high, low and close, the
first 15 minutes' range, Fibonacci of the last swing, the option walls and
max pain, round numbers, Ichimoku and an RSI panel. Each comes with its rule
of thumb and where price sits against it now. Every rule that can be checked
on daily bars (21 of them: CPR width and position, breaks of yesterday's
range, R1 and S1, Camarilla, gap fills and fades, RSI, the EMA stack, NR7,
three red days, VIX) is measured with the rate it has to beat: over twenty
years by `history_study.js` (data/study.json `playbook`), and until then
over two years of daily bars in the browser. "In play now" lists the rules
that apply to the session on screen.

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
  the learning (lane weights, the gap gains, the crowd lane, the desk's own
  record), including a replayed evening, morning and evening of the workflow
  script on a scratch copy of the data and the training log written from it,
  twice, with nothing written twice
- `python scripts/history_model.py --selfcheck`: the leak check

## Not yet proven live

Until their workflows have run on GitHub: the record itself, the twenty-year
model's real numbers, and both price models. Their first runs are the check.
Added later on 30 Oct 2026 and also waiting on a run: `data/social.json`
(whether Tickertape, StockTwits and Reddit answer GitHub's addresses), the
Telegram, X-mirror, GDELT, Bing and Yahoo feeds, and the first push to
`training-log`. The gap gains need 10 judged sessions before they move.
Also waiting on the workflow: the twenty-year world links (the drivers card
shows directions without points until then) and the twenty-year playbook
(the Studies menu shows two years of this browser's bars until then).
