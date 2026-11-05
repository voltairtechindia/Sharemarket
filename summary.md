# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-05T09:59:51.968Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

8 calls frozen, 6 judged, 10 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 3 |
| Right / wrong / no lean or flat | 2 / 1 / 0 |
| "Always up" would have been right | 3 of 3 |
| Close off the line, average | 260 points (1.12%) |
| Net miss (market minus line) | +1.12%, the market closed above the line |
| Close inside its likely range (68%) | 2 of 3 |
| Close inside its wide range (95%) | 2 of 3 |
| Open off the call, average | 158 points |

The last 3 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
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
| Judged sessions | 3 |
| Right / wrong / no lean or flat | 2 / 1 / 0 |
| "Always up" would have been right | 3 of 3 |
| Close off the line, average | 957 points (1.28%) |
| Net miss (market minus line) | +1.18%, the market closed above the line |
| Close inside its likely range (68%) | 1 of 3 |
| Close inside its wide range (95%) | 2 of 3 |
| Open off the call, average | 724 points |

The last 3 sessions, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-04 | up (advance) | 80% | 77,410 | 77,301 (+0.50%) | -109 | right |  |
| 2026-11-03 | up (advance) | 55% | 75,794 | 76,918 (+1.62%) | +1124 | right |  |
| 2026-11-02 | down (advance) | 27% | 74,054 | 75,693 (+1.66%) | +1639 | wrong | Most of the miss was there at the open: it opened at 75,152.54, the call said 73,868.28 (+1,284 pts). |

By the situation the call was made in (two or more sessions):

| Situation | Sessions | Right |
| --- | --- | --- |
| mixed news | 3 | 2 (67%) |
| FII buying | 3 | 2 (67%) |
| VIX normal | 3 | 2 (67%) |
| an uptrend | 2 | 2 (100%) |
| RSI mid-range | 2 | 1 (50%) |

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
| momentum | 6 | 0 | 100% |
| flow | 3 | 2 | 60% |
| levels | 4 | 1 | 80% |
| global | 2 | 3 | 40% |
| seasonal | 4 | 0 | 100% |
| options | 4 | 0 | 100% |
| kronos | 0 | 3 | 0% |
| structure | 0 | 2 | 0% |
| news | 1 | 0 | 100% |

## The five biggest gaps between line and close

- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- SENSEX 2026-11-03 (advance): +1124 points. Right: said up (+0.13%), closed +1.62%. Widest at 15:30 (+1124). id `SENSEX:2026-11-03:1S:advance:wf`
- NIFTY 2026-11-02 (advance): +509 points. Wrong: said down (-0.53%), closed +1.68%. Cues moved after the freeze. Widest at 15:30 (+509). id `NIFTY:2026-11-02:1S:advance:wf`
- NIFTY 2026-11-03 (advance): +178 points. Right: said up (+0.82%), closed +1.58%. Widest at 15:30 (+178). id `NIFTY:2026-11-03:1S:advance:wf`
- SENSEX 2026-11-04 (advance): -109 points. Right: said up (+0.64%), closed +0.50%. Widest at 12:15 (-726). id `SENSEX:2026-11-04:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 3
- opening gap gain: 1 from 3 opens
- session move size: 1, lean 0.00% from 3 sessions
- lane weights: the starting set (nothing has cleared its evidence bar yet)
- notes from that run: NIFTY: 2026-11-05 already has its advance call | SENSEX: 2026-11-05 already has its advance call

