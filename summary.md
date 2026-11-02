# Training log: where the calls went right and wrong

Rewritten by `scripts/training_log.js` after every run of the history workflow (last: 2026-11-02T20:46:55.699Z). Not served by the site. Every number here is recomputed from `log/*.jsonl`; README.md has the schema.

4 calls frozen, 2 judged, 5 runs logged.

## NIFTY

| | |
| --- | --- |
| Judged sessions | 1 |
| Right / wrong / no lean or flat | 0 / 1 / 0 |
| "Always up" would have been right | 1 of 1 |
| Close off the line, average | 509 points (2.21%) |
| Net miss (market minus line) | +2.21%, the market closed above the line |
| Close inside its likely range (68%) | 0 of 1 |
| Close inside its wide range (95%) | 0 of 1 |
| Open off the call, average | 369 points |

The last session, newest first (the call each session is judged on):

| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-02 | down (advance) | 24% | 22,932 | 23,441 (+1.68%) | +509 | wrong | After the call was frozen, Brent crude fell 4.7%, Nasdaq futures rose 0.9%. |

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
| momentum | 2 | 0 | 100% |
| options | 2 | 0 | 100% |
| seasonal | 2 | 0 | 100% |
| levels | 2 | 0 | 100% |
| global | 0 | 2 | 0% |
| flow | 0 | 2 | 0% |
| kronos | 0 | 1 | 0% |

## The five biggest gaps between line and close

- SENSEX 2026-11-02 (advance): +1639 points. Wrong: said down (-0.55%), closed +1.66%. Most of it was at the open. Widest at 15:30 (+1639). id `SENSEX:2026-11-02:1S:advance:wf`
- NIFTY 2026-11-02 (advance): +509 points. Wrong: said down (-0.53%), closed +1.68%. Cues moved after the freeze. Widest at 15:30 (+509). id `NIFTY:2026-11-02:1S:advance:wf`

## What the record had learned at the last run

- judged sessions behind the fit: 1
- opening gap gain: 1 from 1 opens
- session move size: 1, lean 0.00% from 1 sessions
- lane weights: the starting set (nothing has cleared its evidence bar yet)
- notes from that run: NIFTY: 2026-11-03 already has its advance call

