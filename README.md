# training-log

Every session call the terminal froze and how it went, appended by the history
workflow (`scripts/training_log.js`, run from `.github/workflows/history.yml`
right after `scripts/daily_call.js`). This branch is never force-pushed and the
site never reads it. It exists so the record can be studied and learned from:
by a person, by a training script, or by Claude.

## Read this first

`summary.md`: the record in plain words, the last twenty sessions, why the
wrong calls missed, which inputs pointed the right way, the biggest gaps and
what the model had learned at the last run. Rewritten every run.

## The log

`log/YYYY-MM.jsonl`, one JSON object a line, filed by the month of the session.
Three kinds, joined by `id` (the call's id, e.g. `NIFTY:2026-11-02:1S:open:wf`):

- `frozen`: the call as it was frozen. `call` (direction `dir` 1/0/-1 from the
  odds, `pUpClose` the odds of closing above the last close, the open it
  expected, the line's end `target`, the 68% and 95% ranges), `lanes` (every
  input that reported: its push on the line `c` and its note), `openParts`
  (what drove the opening call), `context` (cue prices, FII and DII cash, the
  raw situation `fp`), `situation` (the same in words), `headline` (the
  strongest headline at the freeze), `learned` (the move size `g` and lean `b`
  it was drawn with), `line` (the line every fifteen minutes, IST).
- `judged`: the same call after the close. `verdict` (right, wrong, flat,
  no-call), `said` and `did` (open, close, high, low, move), `errPts` and
  `errPct` (close minus the line's end), `inside68`/`inside95`, `reasons` (what
  it did not know, as facts with times: the open, cues after the freeze, news,
  flows, size, the turn, its own inputs, the calendar), `lanesRight` and
  `lanesWrong`, `turn` (when the two lines parted for good), `lesson` (what it
  filed for next time), `session_line` (mean absolute error of the whole line
  and its skill against "price stays put", below 1 is better), `gap` (every
  fifteen minutes: time, line, market, market minus line) and `worstGap`.
- `run`: one a workflow run. What it froze, settled and judged, its notes, and
  what the record had learned (lane weights, opening gap gain, move size and
  lean with their samples) plus the per-symbol stats.

Each session has up to two calls: `advance` (frozen the evening before) and
`open` (frozen before the open). The page judges a session on the `open` call
when there is one.

## How the calls are made

The forecast is arithmetic over weighted inputs (`assets/js/forecast.js`), the
judgement is `assets/js/postmortem.js`, and the learning is
`assets/js/learn.js`. `docs/calls.md` on `main` explains all three.

`state.json` counts what the log holds. A rerun never writes an event twice:
the writer reads the log itself before appending.
