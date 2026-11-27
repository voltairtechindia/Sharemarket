# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-27T11:32:42.678Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

38 calls frozen, 36 judged, 42 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 18 |
| Right / wrong / no lean or flat | 11 / 5 / 2 |
| "Always up" would have been right | 14 of 18 |
| Close off the line, average | 250 points (1.01%) |
| Net miss (market minus line) | +0.48%, the market closed above the line |
| Close inside its likely range (68%) | 10 of 18 |
| Close inside its wide range (95%) | 15 of 18 |
| Open off the call, average | 186 points |

The last 18 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-27 | up (advance) | 72% | 26,003 | 25,607 (-1.07%) | -396 | wrong | 24 strong headlines after the call pointed down. The loudest, at 12:34: "Why is Indian stock market falling to |
| 2026-11-26 | down (advance) | 36% | 25,719 | 25,885 (+0.25%) | +165 | wrong | Most of the miss was there at the open: it opened at 25,873.20, the call said 25,609.56 (+264 pts). |
| 2026-11-25 | up (advance) | 72% | 25,511 | 25,819 (+1.85%) | +308 | right |  |
| 2026-11-23 | down (advance) | 42% | 25,749 | 25,350 (-1.75%) | -399 | right |  |
| 2026-11-20 | up (advance) | 86% | 25,737 | 25,801 (+1.12%) | +63 | right |  |
| 2026-11-19 | up (advance) | 65% | 25,303 | 25,514 (+1.14%) | +211 | right |  |
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
| FII buying | 15 | 10 (67%) |
| mixed news | 14 | 9 (64%) |
| an uptrend | 12 | 9 (75%) |
| RSI overbought | 11 | 8 (73%) |
| VIX normal | 10 | 6 (60%) |
| a gap-up open | 7 | 6 (86%) |
| VIX elevated | 6 | 5 (83%) |
| a gap-down open | 6 | 2 (33%) |
| RSI oversold | 3 | 2 (67%) |
| a flat open | 3 | 3 (100%) |
| a range-bound tape | 2 | 1 (50%) |
| RSI mid-range | 2 | 1 (50%) |
| a downtrend | 2 | 1 (50%) |
| positive news | 2 | 2 (100%) |

## SENSEX

| | |
| --- | --- |
| Judged sessions | 18 |
| Right / wrong / no lean or flat | 7 / 4 / 7 |
| "Always up" would have been right | 14 of 18 |
| Close off the line, average | 843 points (1.05%) |
| Net miss (market minus line) | +0.50%, the market closed above the line |
| Close inside its likely range (68%) | 13 of 18 |
| Close inside its wide range (95%) | 17 of 18 |
| Open off the call, average | 681 points |

The last 18 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-27 | no lean (advance) | 53% | 84,693 | 83,339 (-1.17%) | -1354 | no-call | 24 strong headlines after the call pointed down. The loudest, at 12:34: "Why is Indian stock market falling to |
| 2026-11-26 | down (advance) | 38% | 83,569 | 84,329 (+0.47%) | +759 | wrong | Most of the miss was there at the open: it opened at 84,283.97, the call said 83,256.59 (+1,027 pts). |
| 2026-11-25 | up (advance) | 75% | 83,065 | 83,938 (+1.82%) | +873 | right |  |
| 2026-11-23 | no lean (advance) | 48% | 83,625 | 82,436 (-1.77%) | -1189 | no-call | 27 strong headlines after the call pointed down. The loudest, at 13:12: "Dalal Street under pressure: Sensex d |
| 2026-11-20 | no lean (advance) | 54% | 84,082 | 83,920 (+1.08%) | -162 | no-call | Most of the miss was there at the open: it opened at 82,479.52, the call said 83,653.60 (-1,174 pts). |
| 2026-11-19 | up (advance) | 63% | 82,287 | 83,022 (+1.21%) | +735 | right |  |
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
| mixed news | 11 | 7 (64%) |
| FII buying | 10 | 6 (60%) |
| RSI mid-range | 9 | 6 (67%) |
| an uptrend | 7 | 5 (71%) |
| VIX normal | 7 | 4 (57%) |
| a gap-up open | 6 | 6 (100%) |
| VIX elevated | 4 | 3 (75%) |
| a gap-down open | 4 | 0 (0%) |
| a downtrend | 3 | 2 (67%) |
| RSI overbought | 2 | 1 (50%) |

## Why the wrong calls missed

- most of the miss was already there at the open: 9
- its own inputs pointed the wrong way: 9
- the overnight cues moved after the freeze: 8
- strong news after the freeze: 7
- a bigger move than its own range: 6
- an event on the calendar: 3
- FII flows that day: 2

## Inputs: pointed the way the session went

| Input | Right way | Wrong way | Rate |
| --- | --- | --- | --- |
| global | 22 | 13 | 63% |
| momentum | 25 | 9 | 74% |
| seasonal | 25 | 8 | 76% |
| levels | 18 | 13 | 58% |
| flow | 12 | 14 | 46% |
| options | 10 | 14 | 42% |
| kronos | 5 | 9 | 36% |
| structure | 2 | 11 | 15% |
| news | 4 | 6 | 40% |
| crowd | 3 | 7 | 30% |

## The five biggest gaps between line and close

- SENSEX 2026-11-06 (advance): +2689 points. Wrong: said down (-1.22%), closed +2.17%. Cues moved after the freeze. Widest at 15:30 (+2689). id `SENSEX:2026-11-06:1S:advance:wf`
- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- SENSEX 2026-11-27 (advance): -1354 points. No lean called: said flat (+0.43%), closed -1.17%. News after the freeze. Widest at 15:15 (-1388). id `SENSEX:2026-11-27:1S:advance:wf`
- SENSEX 2026-11-05 (advance): +1270 points. Right: said up (+0.96%), closed +2.60%. Widest at 14:15 (+1331). id `SENSEX:2026-11-05:1S:advance:wf`
- SENSEX 2026-11-23 (advance): -1189 points. No lean called: said flat (-0.35%), closed -1.77%. News after the freeze. Widest at 15:30 (-1189). id `SENSEX:2026-11-23:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 18
- opening gap gain: 0.899 from 18 opens
- session move size: 0.715, lean 0.00% from 18 sessions (raw slope 0.557, lean t 1.23)
- lane weights: the starting set (nothing has cleared its evidence bar yet)

