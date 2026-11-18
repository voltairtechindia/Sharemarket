# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-18T10:55:50.646Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

26 calls frozen, 24 judged, 28 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 12 |
| Right / wrong / no lean or flat | 7 / 3 / 2 |
| "Always up" would have been right | 10 of 12 |
| Close off the line, average | 246 points (1.01%) |
| Net miss (market minus line) | +0.73%, the market closed above the line |
| Close inside its likely range (68%) | 8 of 12 |
| Close inside its wide range (95%) | 9 of 12 |
| Open off the call, average | 169 points |

The last 12 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | down (advance) | 38% | 25,337 | 25,228 (-0.63%) | -109 | right |  |
| 2026-11-17 | no lean (advance) | 47% | 25,257 | 25,387 (+0.38%) | +130 | no-call | Most of the miss was there at the open: it opened at 25,323.65, the call said 25,178.66 (+145 pts). |
| 2026-11-16 | down (advance) | 38% | 25,080 | 25,291 (+0.58%) | +211 | wrong | 44 strong headlines after the call pointed up. The loudest, at 11:12: "Saw the rally coming? How India's mutua |
| 2026-11-13 | down (advance) | 36% | 25,246 | 25,144 (-0.61%) | -102 | right |  |
| 2026-11-12 | up (advance) | 82% | 25,494 | 25,299 (+0.17%) | -194 | right |  |
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
| FII buying | 9 | 6 (67%) |
| an uptrend | 8 | 6 (75%) |
| mixed news | 8 | 5 (63%) |
| RSI overbought | 8 | 6 (75%) |
| VIX normal | 7 | 4 (57%) |
| a gap-down open | 4 | 1 (25%) |
| a flat open | 3 | 3 (100%) |
| VIX elevated | 3 | 3 (100%) |
| a gap-up open | 3 | 3 (100%) |
| positive news | 2 | 2 (100%) |
| RSI oversold | 2 | 1 (50%) |

## SENSEX

| | |
| --- | --- |
| Judged sessions | 12 |
| Right / wrong / no lean or flat | 5 / 3 / 4 |
| "Always up" would have been right | 10 of 12 |
| Close off the line, average | 842 points (1.07%) |
| Net miss (market minus line) | +0.78%, the market closed above the line |
| Close inside its likely range (68%) | 8 of 12 |
| Close inside its wide range (95%) | 11 of 12 |
| Open off the call, average | 644 points |

The last 12 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | no lean (advance) | 46% | 82,465 | 82,032 (-0.61%) | -433 | no-call | After the call was frozen, FTSE fell 1.3%, Dow futures fell 1.0%. |
| 2026-11-17 | down (advance) | 41% | 81,923 | 82,532 (+0.52%) | +609 | wrong | 40 strong headlines after the call pointed up. The loudest, at 13:29: "Bank Nifty scales record high as broad  |
| 2026-11-16 | no lean (advance) | 47% | 81,135 | 82,105 (+0.63%) | +970 | no-call | Most of the miss was there at the open: it opened at 81,857.39, the call said 80,890.11 (+967 pts). |
| 2026-11-13 | no lean (advance) | 50% | 81,787 | 81,592 (-0.39%) | -194 | no-call |  |
| 2026-11-12 | up (advance) | 55% | 82,611 | 81,911 (+0.04%) | -700 | right |  |
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
| mixed news | 8 | 5 (63%) |
| FII buying | 7 | 4 (57%) |
| an uptrend | 6 | 5 (83%) |
| VIX normal | 6 | 3 (50%) |
| RSI mid-range | 6 | 4 (67%) |
| a gap-up open | 4 | 4 (100%) |
| a gap-down open | 3 | 0 (0%) |
| RSI overbought | 2 | 1 (50%) |
| VIX elevated | 2 | 2 (100%) |

## Why the wrong calls missed

- most of the miss was already there at the open: 6
- its own inputs pointed the wrong way: 6
- the overnight cues moved after the freeze: 5
- a bigger move than its own range: 5
- strong news after the freeze: 4
- FII flows that day: 2
- an event on the calendar: 1

## Inputs: pointed the way the session went

| Input | Right way | Wrong way | Rate |
| --- | --- | --- | --- |
| global | 14 | 9 | 61% |
| levels | 11 | 11 | 50% |
| momentum | 17 | 5 | 77% |
| seasonal | 18 | 4 | 82% |
| options | 10 | 8 | 56% |
| flow | 9 | 7 | 56% |
| crowd | 3 | 7 | 30% |
| kronos | 2 | 7 | 22% |
| structure | 2 | 7 | 22% |
| news | 2 | 3 | 40% |

## The five biggest gaps between line and close

- SENSEX 2026-11-06 (advance): +2689 points. Wrong: said down (-1.22%), closed +2.17%. Cues moved after the freeze. Widest at 15:30 (+2689). id `SENSEX:2026-11-06:1S:advance:wf`
- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- SENSEX 2026-11-05 (advance): +1270 points. Right: said up (+0.96%), closed +2.60%. Widest at 14:15 (+1331). id `SENSEX:2026-11-05:1S:advance:wf`
- SENSEX 2026-11-03 (advance): +1124 points. Right: said up (+0.13%), closed +1.62%. Widest at 15:30 (+1124). id `SENSEX:2026-11-03:1S:advance:wf`
- SENSEX 2026-11-16 (advance): +970 points. No lean called: said flat (-0.56%), closed +0.63%. Most of it was at the open. Widest at 09:45 (+1117). id `SENSEX:2026-11-16:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 12
- opening gap gain: 0.983 from 12 opens
- session move size: 1.515, lean 0.00% from 12 sessions (raw slope 1.944, lean t 1.61)
- lane weights: the starting set (nothing has cleared its evidence bar yet)

