# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-03T10:13:00.996Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

5 calls frozen, 3 judged, 6 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 2 |
| Right / wrong / no lean or flat | 1 / 1 / 0 |
| "Always up" would have been right | 2 of 2 |
| Close off the line, average | 344 points (1.48%) |
| Net miss (market minus line) | +1.48%, the market closed above the line |
| Close inside its likely range (68%) | 1 of 2 |
| Close inside its wide range (95%) | 1 of 2 |
| Open off the call, average | 188 points |

The last 2 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-03 | up (advance) | 81% | 23,632 | 23,811 (+1.58%) | +178 | right |  |
| 2026-11-02 | down (advance) | 24% | 22,932 | 23,441 (+1.68%) | +509 | wrong | After the call was frozen, Brent crude fell 4.7%, Nasdaq futures rose 0.9%. |

By the situation the call was made in (two or more sessions):

| Situation | Sessions | Right |
| --- | --- | --- |
| an uptrend | 2 | 1 (50%) |
| mixed news | 2 | 1 (50%) |
| FII buying | 2 | 1 (50%) |
| VIX normal | 2 | 1 (50%) |
| RSI overbought | 2 | 1 (50%) |

## SENSEX

| | |
| --- | --- |
| Judged sessions | 1 |
| Right / wrong / no lean or flat | 0 / 1 / 0 |
| "Always up" would have been right | 1 of 1 |
| Close off the line, average | 1639 points (2.20%) |
| Net miss (market minus line) | +2.20%, the market closed above the line |
| Close inside its likely range (68%) | 0 of 1 |
| Close inside its wide range (95%) | 0 of 1 |
| Open off the call, average | 1284 points |

The last session, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-02 | down (advance) | 27% | 74,054 | 75,693 (+1.66%) | +1639 | wrong | Most of the miss was there at the open: it opened at 75,152.54, the call said 73,868.28 (+1,284 pts). |

## Why the wrong calls missed

- most of the miss was already there at the open: 2
- a bigger move than its own range: 2
- its own inputs pointed the wrong way: 2
- the overnight cues moved after the freeze: 1
- strong news after the freeze: 1
- FII flows that day: 1

## Inputs: pointed the way the session went

| Input | Right way | Wrong way | Rate |
| --- | --- | --- | --- |
| momentum | 3 | 0 | 100% |
| global | 1 | 2 | 33% |
| flow | 1 | 2 | 33% |
| options | 3 | 0 | 100% |
| kronos | 0 | 2 | 0% |
| seasonal | 2 | 0 | 100% |
| levels | 2 | 0 | 100% |
| structure | 0 | 1 | 0% |

## The five biggest gaps between line and close

- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- NIFTY 2026-11-02 (advance): +509 points. Wrong: said down (-0.53%), closed +1.68%. Cues moved after the freeze. Widest at 15:30 (+509). id `NIFTY:2026-11-02:1S:advance:wf`
- NIFTY 2026-11-03 (advance): +178 points. Right: said up (+0.82%), closed +1.58%. Widest at 15:30 (+178). id `NIFTY:2026-11-03:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 2
- opening gap gain: 1 from 2 opens
- session move size: 1, lean 0.00% from 2 sessions
- lane weights: the starting set (nothing has cleared its evidence bar yet)
- notes from that run: SENSEX: nothing frozen, the bars for 2026-11-03 stop at 15:23, before the close

