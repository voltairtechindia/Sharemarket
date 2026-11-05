# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-05T18:45:36.981Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

10 calls frozen, 8 judged, 11 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 4 |
| Right / wrong / no lean or flat | 2 / 1 / 1 |
| "Always up" would have been right | 4 of 4 |
| Close off the line, average | 349 points (1.49%) |
| Net miss (market minus line) | +1.49%, the market closed above the line |
| Close inside its likely range (68%) | 2 of 4 |
| Close inside its wide range (95%) | 2 of 4 |
| Open off the call, average | 218 points |

The last 4 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-05 | no lean (advance) | 52% | 23,919 | 24,537 (+2.61%) | +618 | no-call | Most of the miss was there at the open: it opened at 24,378.05, the call said 23,979.43 (+399 pts). |
| 2026-11-04 | up (advance) | 65% | 23,868 | 23,961 (+0.63%) | +92 | right |  |
| 2026-11-03 | up (advance) | 81% | 23,632 | 23,811 (+1.58%) | +178 | right |  |
| 2026-11-02 | down (advance) | 24% | 22,932 | 23,441 (+1.68%) | +509 | wrong | After the call was frozen, Brent crude fell 4.7%, Nasdaq futures rose 0.9%. |

By the situation the call was made in (two or more sessions):

| Situation | Sessions | Right |
| --- | --- | --- |
| an uptrend | 3 | 2 (67%) |
| FII buying | 3 | 2 (67%) |
| VIX normal | 3 | 2 (67%) |
| RSI overbought | 3 | 2 (67%) |
| mixed news | 2 | 1 (50%) |

## SENSEX

| | |
| --- | --- |
| Judged sessions | 4 |
| Right / wrong / no lean or flat | 3 / 1 / 0 |
| "Always up" would have been right | 4 of 4 |
| Close off the line, average | 1035 points (1.37%) |
| Net miss (market minus line) | +1.30%, the market closed above the line |
| Close inside its likely range (68%) | 1 of 4 |
| Close inside its wide range (95%) | 3 of 4 |
| Open off the call, average | 776 points |

The last 4 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-05 | up (advance) | 82% | 78,040 | 79,310 (+2.60%) | +1270 | right |  |
| 2026-11-04 | up (advance) | 80% | 77,410 | 77,301 (+0.50%) | -109 | right |  |
| 2026-11-03 | up (advance) | 55% | 75,794 | 76,918 (+1.62%) | +1124 | right |  |
| 2026-11-02 | down (advance) | 27% | 74,054 | 75,693 (+1.66%) | +1639 | wrong | Most of the miss was there at the open: it opened at 75,152.54, the call said 73,868.28 (+1,284 pts). |

By the situation the call was made in (two or more sessions):

| Situation | Sessions | Right |
| --- | --- | --- |
| mixed news | 4 | 3 (75%) |
| FII buying | 4 | 3 (75%) |
| VIX normal | 4 | 3 (75%) |
| an uptrend | 3 | 3 (100%) |
| RSI mid-range | 3 | 2 (67%) |
| a gap-up open | 2 | 2 (100%) |

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
| flow | 5 | 2 | 71% |
| global | 4 | 3 | 57% |
| levels | 5 | 2 | 71% |
| momentum | 6 | 1 | 86% |
| seasonal | 6 | 0 | 100% |
| options | 4 | 1 | 80% |
| kronos | 0 | 4 | 0% |
| news | 2 | 0 | 100% |
| structure | 0 | 2 | 0% |

## The five biggest gaps between line and close

- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- SENSEX 2026-11-05 (advance): +1270 points. Right: said up (+0.96%), closed +2.60%. Widest at 14:15 (+1331). id `SENSEX:2026-11-05:1S:advance:wf`
- SENSEX 2026-11-03 (advance): +1124 points. Right: said up (+0.13%), closed +1.62%. Widest at 15:30 (+1124). id `SENSEX:2026-11-03:1S:advance:wf`
- NIFTY 2026-11-05 (advance): +618 points. No lean called: said flat (+0.03%), closed +2.61%. Most of it was at the open. Widest at 14:15 (+625). id `NIFTY:2026-11-05:1S:advance:wf`
- NIFTY 2026-11-02 (advance): +509 points. Wrong: said down (-0.53%), closed +1.68%. Cues moved after the freeze. Widest at 15:30 (+509). id `NIFTY:2026-11-02:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 4
- opening gap gain: 1 from 4 opens
- session move size: 1, lean 0.00% from 4 sessions
- lane weights: the starting set (nothing has cleared its evidence bar yet)

