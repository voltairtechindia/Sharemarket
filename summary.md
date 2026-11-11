# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-11T18:41:59.781Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

16 calls frozen, 14 judged, 19 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 7 |
| Right / wrong / no lean or flat | 4 / 2 / 1 |
| "Always up" would have been right | 7 of 7 |
| Close off the line, average | 315 points (1.32%) |
| Net miss (market minus line) | +1.28%, the market closed above the line |
| Close inside its likely range (68%) | 4 of 7 |
| Close inside its wide range (95%) | 4 of 7 |
| Open off the call, average | 194 points |

The last 7 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11 | up (advance) | 76% | 25,263 | 25,255 (+0.84%) | -8 | right |  |
| 2026-11-09 | up (advance) | 59% | 25,068 | 25,045 (+0.06%) | -23 | right |  |
| 2026-11-06 | down (advance) | 5% | 24,257 | 25,030 (+2.01%) | +773 | wrong | After the call was frozen, the rupee (USD/INR) strengthened 0.61%, Nasdaq futures rose 1.1%. |
| 2026-11-05 | no lean (advance) | 52% | 23,919 | 24,537 (+2.61%) | +618 | no-call | Most of the miss was there at the open: it opened at 24,378.05, the call said 23,979.43 (+399 pts). |
| 2026-11-04 | up (advance) | 65% | 23,868 | 23,961 (+0.63%) | +92 | right |  |
| 2026-11-03 | up (advance) | 81% | 23,632 | 23,811 (+1.58%) | +178 | right |  |
| 2026-11-02 | down (advance) | 24% | 22,932 | 23,441 (+1.68%) | +509 | wrong | After the call was frozen, Brent crude fell 4.7%, Nasdaq futures rose 0.9%. |

By the situation the call was made in (two or more sessions):

| Situation | Sessions | Right |
| --- | --- | --- |
| an uptrend | 5 | 4 (80%) |
| mixed news | 5 | 3 (60%) |
| RSI overbought | 5 | 4 (80%) |
| FII buying | 5 | 3 (60%) |
| VIX normal | 4 | 2 (50%) |
| VIX elevated | 2 | 2 (100%) |
| a gap-up open | 2 | 2 (100%) |
| a flat open | 2 | 2 (100%) |
| a gap-down open | 2 | 0 (0%) |

## SENSEX

| | |
| --- | --- |
| Judged sessions | 7 |
| Right / wrong / no lean or flat | 4 / 2 / 1 |
| "Always up" would have been right | 7 of 7 |
| Close off the line, average | 1028 points (1.33%) |
| Net miss (market minus line) | +1.29%, the market closed above the line |
| Close inside its likely range (68%) | 3 of 7 |
| Close inside its wide range (95%) | 6 of 7 |
| Open off the call, average | 714 points |

The last 7 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11 | up (advance) | 75% | 81,542 | 81,879 (+0.95%) | +337 | right |  |
| 2026-11-09 | no lean (advance) | 51% | 81,079 | 81,107 (+0.10%) | +27 | no-call | Most of the miss was there at the open: it opened at 81,313.44, the call said 81,163.79 (+150 pts). |
| 2026-11-06 | down (advance) | 23% | 78,339 | 81,028 (+2.17%) | +2689 | wrong | After the call was frozen, the rupee (USD/INR) strengthened 0.60%. |
| 2026-11-05 | up (advance) | 82% | 78,040 | 79,310 (+2.60%) | +1270 | right |  |
| 2026-11-04 | up (advance) | 80% | 77,410 | 77,301 (+0.50%) | -109 | right |  |
| 2026-11-03 | up (advance) | 55% | 75,794 | 76,918 (+1.62%) | +1124 | right |  |
| 2026-11-02 | down (advance) | 27% | 74,054 | 75,693 (+1.66%) | +1639 | wrong | Most of the miss was there at the open: it opened at 75,152.54, the call said 73,868.28 (+1,284 pts). |

By the situation the call was made in (two or more sessions):

| Situation | Sessions | Right |
| --- | --- | --- |
| mixed news | 6 | 4 (67%) |
| RSI mid-range | 5 | 3 (60%) |
| FII buying | 5 | 3 (60%) |
| VIX normal | 5 | 3 (60%) |
| an uptrend | 4 | 4 (100%) |
| a gap-up open | 3 | 3 (100%) |
| a gap-down open | 2 | 0 (0%) |

## Why the wrong calls missed

- a bigger move than its own range: 4
- most of the miss was already there at the open: 4
- its own inputs pointed the wrong way: 4
- the overnight cues moved after the freeze: 3
- strong news after the freeze: 2
- FII flows that day: 2

## Inputs: pointed the way the session went

| Input | Right way | Wrong way | Rate |
| --- | --- | --- | --- |
| global | 8 | 5 | 62% |
| levels | 7 | 6 | 54% |
| momentum | 9 | 3 | 75% |
| seasonal | 12 | 0 | 100% |
| options | 6 | 4 | 60% |
| flow | 7 | 2 | 78% |
| kronos | 0 | 5 | 0% |
| structure | 0 | 5 | 0% |
| crowd | 0 | 4 | 0% |
| news | 2 | 0 | 100% |

## The five biggest gaps between line and close

- SENSEX 2026-11-06 (advance): +2689 points. Wrong: said down (-1.22%), closed +2.17%. Cues moved after the freeze. Widest at 15:30 (+2689). id `SENSEX:2026-11-06:1S:advance:wf`
- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- SENSEX 2026-11-05 (advance): +1270 points. Right: said up (+0.96%), closed +2.60%. Widest at 14:15 (+1331). id `SENSEX:2026-11-05:1S:advance:wf`
- SENSEX 2026-11-03 (advance): +1124 points. Right: said up (+0.13%), closed +1.62%. Widest at 15:30 (+1124). id `SENSEX:2026-11-03:1S:advance:wf`
- NIFTY 2026-11-06 (advance): +773 points. Wrong: said down (-1.14%), closed +2.01%. Cues moved after the freeze. Widest at 15:30 (+773). id `NIFTY:2026-11-06:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 7
- opening gap gain: 1 from 7 opens
- session move size: 1, lean 0.00% from 7 sessions
- lane weights: the starting set (nothing has cleared its evidence bar yet)

