# Forecast upgrade — implementation plan

Written 18 Sep 2026. Scope locked with the user: full GARCH port, ledger stored
in both localStorage and the `live-data` branch, site stays static (no Next.js,
no Supabase — see "Rejected" at the end).

Two goals, in priority order:

1. Make the band's stated probability true, and prove it with a significance
   test rather than an eyeballed threshold.
2. Record every forecast and score it when its clock runs out, then explain on
   the page which lane was right, which was wrong, and what arrived that nothing
   called.

The second is the user's actual ask ("why it did and didn't happen"). The first
is a prerequisite: there is no point explaining a forecast whose range is the
wrong width.

---

## Defects this plan closes

Found by reading `forecast.js` (814 lines), `config.js` and the accuracy panel in
`app.js`.

| # | Defect | Where | Closed by |
|---|---|---|---|
| 1 | `calibrate()` scores a model the user never sees — flat `sigmaBar*sqrt(bars)`, no vol profile, no VIX blend, no `dayShape`, no `persistence`, no `temper`, no analog | `forecast.js:769` | Phase 2 |
| 2 | Coverage reported with no significance test; 67.9% of 53 replays has a 95% CI of roughly ±12.6pp, and the panel paints it green at `abs(c68-68) <= 8` | `forecast.js:786`, `app.js:1245` | Phase 1 (Kupiec), Phase 4 |
| 3 | Lane liveness decided by regex on the lane's own English note, so rewording a note silently changes `bias` | `forecast.js:380` | Phase 0 |
| 4 | Volatility is close-to-close only, discarding the OHLC the candles already carry | `forecast.js:399` | Phase 1 (Parkinson / Yang-Zhang) |
| 5 | `pUp` is Gaussian `ncdf(z)` on fat-tailed index returns | `forecast.js:44`, `forecast.js:583` | Phase 1 (empirical z) |
| 6 | Seven lane weights hand-set, never fitted, no evidence | `config.js:178` | Phase 3 makes fitting possible; fitting itself is out of scope for this pass |
| 7 | Header comment claims "Eight lanes"; the `lanes` array holds seven | `forecast.js:10` | Phase 0 |

---

## Sources being copied from

| Repo | License | Taken |
|---|---|---|
| `tripolskypetr/garch` | MIT | GARCH(1,1) and GJR-GARCH variance recursion, Nelder-Mead fitting, QLIKE model selection, empirically calibrated `zScore`, Kupiec POF test, Parkinson RV |
| `salesforce/online_conformal` | BSD-3 | Adaptive Conformal Inference update rule (Gibbs & Candès 2021) |
| `properscoring`, `nci/scores` | Apache-2.0 | CRPS and Brier score formulas |
| `Souravpriyadarsi/NSE-visor` | **unlicensed** | Pattern only, no source: forecasts saved per-date to a branch, never overwritten, joined to the actual close on settlement |

MIT and Apache-2.0 both permit use with attribution. Each ported function gets a
comment naming the repo and the licence it came from. Nothing is copied from
NSE-visor, which carries no licence — only the ledger-on-a-branch idea, which is
not copyrightable and which this repo already implements for `live-data`.

---

## Phase 0 — honesty fixes

Small, independent of everything else, and they prevent the later phases from
inheriting a silent bug.

**Lane liveness.** Each lane function (`newsLane`, `seasonalLane`,
`momentumLane`, `globalLane`, `levelsLane`, `flowLane`, and
`structures.impliedBias`) returns an explicit `hasData` boolean. `build()`
filters on that field instead of the regex at `forecast.js:380`.

Care: `hasData` must mean "this lane received input", not "this lane has a
non-zero opinion". A lane that saw forty headlines and concluded neutral is
live and belongs in the denominator; a lane whose feed is down is not.

**Stale comment.** `forecast.js:10` header updated to seven voting lanes, with
intraday named as what it is — a drift term via `dayShape`, not a vote.

**Verification.** In the browser console on the running page, confirm `bias` is
unchanged for a case where every lane reports, and that killing one feed moves
weight to the rest rather than dragging bias toward zero.

---

## Phase 1 — `assets/js/vol.js`

New file. ES5, `var`, `function`, no modules, no build step — matching the rest
of `assets/js/`. Loaded after `core` and before `forecast`, since `forecast`
will depend on it.

Estimated 400–450 lines. Exports `KT.vol`.

### 1a. Range-based realised variance

```
parkinson(candle)   = ln(high/low)^2 / (4 * ln 2)
garmanKlass(candle) = 0.5*ln(H/L)^2 - (2*ln2 - 1)*ln(C/O)^2
yangZhang(candles, n)   overnight + open-to-close + Rogers-Satchell
```

Parkinson is the default: it needs only high and low, which every candle in this
repo has, and it is far less noisy per bar than close-to-close. Yang-Zhang is
kept for the daily and longer timeframes, where the overnight gap is a real part
of the variance and ignoring it understates the band.

Guard the degenerate cases the repo will actually hit: `high === low` on a thin
bar, and any candle missing `open`. Fall back to the squared close-to-close
return for that bar rather than dropping it, so the series stays aligned.

### 1b. GARCH(1,1) and GJR-GARCH

```
GARCH:  sigma_t^2 = omega + alpha * RV_{t-1} + beta * sigma_{t-1}^2
GJR:    sigma_t^2 = omega + (alpha + gamma * I(r_{t-1} < 0)) * RV_{t-1} + beta * sigma_{t-1}^2

multi-step, GARCH:  sigma_{t+h}^2 = omega + (alpha + beta) * sigma_{t+h-1}^2
multi-step, GJR:    sigma_{t+h}^2 = omega + (alpha + gamma/2 + beta) * sigma_{t+h-1}^2
```

GJR matters for an equity index specifically: down moves raise volatility more
than up moves of the same size, and a symmetric GARCH underestimates the band
after a fall — which is when a forecast panel is read hardest.

Fitted by Student-t log-likelihood, since index returns are fat-tailed and
Gaussian MLE will misfit the tail this whole exercise is about.

Stationarity constraints enforced as barriers in the objective, not as clamps on
the output: `omega > 0`, `alpha, beta, gamma >= 0`, `alpha + gamma/2 + beta < 1`.

### 1c. Nelder-Mead

Derivative-free simplex, multi-start. Four parameters for GARCH
(omega, alpha, beta, df), five for GJR (plus gamma). Deterministic start points
via golden-ratio perturbation — **no `Math.random()`**, so the same candles
always produce the same forecast. A panel whose numbers move on refresh with no
new data is not defensible.

Budget: 1000 iterations per run, tolerance 1e-8, 3 restarts for GARCH and 4 for
GJR. Must be measured, not assumed — see the budget check below.

### 1d. QLIKE model selection

```
QLIKE = mean( RV_t / sigma_t^2 - ln(RV_t / sigma_t^2) - 1 )
```

Picks between GARCH, GJR and a plain EWMA fallback on forecast error rather
than on in-sample fit. EWMA is the floor: when there is too little history to
fit anything, or when the optimiser fails to converge, the model degrades to
EWMA and **says so in the panel** rather than silently returning a fitted-looking
number. That is the project's stated position — a made-up number is worse than
no number.

### 1e. Empirically calibrated z

Replaces `C.forecast.coneVolMultiplier: 1.15`, which is a hand-tuned constant
standing where a measurement belongs.

Rescale the fitted variance series so standardised residuals have unit variance,
then blend the empirical `|z|` quantile of those residuals with the fitted
Student-t(df) quantile — empirical dominating where the sample supports that part
of the tail, t taking over in the far tail where it does not. Return the
multiplier actually used so the panel can show it.

### 1f. Adaptive Conformal Inference

```
alpha_t = clamp(alpha_{t-1} + gamma * (alpha - miss), 0.005, 0.5)
```
where `miss` is 1 if the last settled actual fell outside the band that was
shown, else 0. `gamma` around 0.02 to start, to be tuned against the ledger once
it has rows.

This is the piece that makes the band self-correct **live** rather than only in
backtest, and it is the reason the ledger and the band belong in the same pass:
ACI's input is the settled miss record from Phase 3. Until the ledger has rows,
`alpha_t` sits at its nominal value and the panel says the adaptive term is not
yet active.

### 1g. Kupiec POF test

```
LR = -2 * ln( (1-p)^(n-x) * p^x ) + 2 * ln( (1-x/n)^(n-x) * (x/n)^x )
```
chi-squared, 1 df. Returns `{hitRate, expected, n, pValue, verdict}` where
verdict is `well-calibrated`, `too-narrow`, `too-wide` or `insufficient-data`.

`insufficient-data` is a real verdict and must be shown as one. On 53 replays
the honest reading of 67.9% is "cannot distinguish from target, or from 55%, or
from 81%" — not a pass.

### Verification for Phase 1

This phase is pure numerics with no UI, so it gets tested directly rather than
by looking at the page. A small harness page under `references/` (not linked
from the site) that asserts:

- **Known-answer**: a series simulated from known `omega, alpha, beta` recovers
  those parameters within tolerance.
- **Stationarity**: no fitted parameter set violates `alpha + gamma/2 + beta < 1`.
- **Determinism**: same input, same output, across ten runs.
- **Degenerate input**: flat candles, `high === low`, single candle, all-identical
  closes — returns the EWMA fallback and does not throw or return `NaN`.
- **Budget**: fit time measured on the real NIFTY 1D series (about 300 bars).
  If it exceeds ~150ms, the fit is moved behind the same throttle
  `calibrateEveryMs` already uses for calibration and cached per
  `symbol:timeframe`. Not assumed — measured and written into a comment, per
  this repo's habit of putting the number in the comment.

---

## Phase 2 — wire into `forecast.js`

**`build()`**: `sigmaBlend` is replaced. Today it is
`sigmaBar * 0.6 + vixBar * 0.4` where `sigmaBar` is `stdev(rets)`. It becomes
the GARCH/GJR term structure from Phase 1, still blended with the India VIX
conversion — VIX is a genuinely forward-looking input and worth keeping — but
the blend weight is chosen by QLIKE against the realised series rather than
hard-coded at 0.6/0.4.

The per-bar loop already accumulates `cumVar` bucket by bucket with
`vp.mult(t)`. That structure is right and stays; what changes is that each bar's
variance comes from the GARCH multi-step recursion rather than from one flat
number. `volProfile` continues to shape it across the clock.

`coneVolMultiplier` gives way to the empirical z from 1e, scaled by the ACI
`alpha_t` from 1f.

**`calibrate()`**: rewritten so that it replays **the band that is actually
shown**. This is defect 1 and it is the most important change in Phase 2. The
replay must use `volProfile`, the GARCH sigma, `persistence`, `temper`, the
shaped drift and `dayShape` — everything `build()` uses — with only the lanes
that genuinely cannot be reconstructed historically left out.

The current honest disclaimer stays and gets more precise: it should name the
news, global and flow lanes as unreplayable, and it should no longer be
describing a band the page does not draw.

Output gains `kupiec68`, `kupiec95` and `crps`.

Care: `calibrate()` walks `at = warm; at + bars < candles.length; at += step`.
Fitting a GARCH at every step is far more expensive than the current
`stdev(rets)`. Either refit every `k`-th step and carry parameters between, or
raise `step`. Whichever is chosen, the replay count `n` must stay high enough for
Kupiec to say anything — and if it does not, the verdict is
`insufficient-data` and the panel says so.

**Verification.** Run the page. The 68% coverage number should move, because it
is now scoring a different and correct band. It is expected and fine for the
number to get *worse* — README already commits to reporting numbers whether or
not they flatter the model. What must be true: the band on the chart and the
band being scored are the same band. Assert that by logging both at one replay
point and comparing.

---

## Phase 3 — `assets/js/ledger.js`

New file, exports `KT.ledger`. Uses `core.store`, which already wraps
localStorage with a TTL and a key prefix.

### Record

On each `build()`, write one entry keyed by `symbol:timeframe:generatedAt`:

```
{ id, symbol, timeframe, generatedAt, lastClose, direction, bias, confidence,
  target, targetPct, rangeLow, rangeHigh,
  lanes: [{ id, score, weight, contribution, note, hasData }],
  checkpoints: [{ time, label, value, low, high, low95, high95, pUp }],
  newsEnd, patternEnd, agree, gapPct,
  vix, sigmaPerBar, volModel, zUsed, alphaT,
  topHeadline: { headline, source, ts, impact, sentiment } }
```

Deduplicated: one entry per `symbol:timeframe` per `reasonBucket`, so a page left
open does not write a row a second. Capped by count and age, oldest evicted —
localStorage is small and silently throws when full.

### Settle

On load and on each candle refresh, any entry whose final checkpoint time has
passed gets joined to the actual closes. Per checkpoint:

```
{ actual, errorPct, inside68, inside95, directionRight }
```

Settlement reads the loaded candle series. An entry whose window is not covered
by the loaded range stays `pending` rather than being scored against missing
data.

### Explain — the part the user asked for

For a settled entry, realised move `R = (actual - lastClose) / lastClose * 100`.

1. **Per-lane verdict.** Each lane asked for a move of
   `contribution * scale * 100` percent. Right if its sign matches `R`'s, wrong
   if opposed, and reported as "called nothing" when its contribution rounds to
   zero. This is a directional verdict per lane, not a claim that the lane
   caused the move.
2. **Residual.** `R` minus the sum of lane-implied moves — the part no lane
   called. A large residual is the honest signal that the model was not merely
   wrong, but blind.
3. **Failure mode.** The most useful single line on the panel, and the one thing
   here that is fully checkable:
   - `inside68 && !directionRight` → the lean was wrong but the range held; the
     model was not badly calibrated, just not informative
   - `!inside95` → price left the band; a volatility surprise, not a direction
     surprise
   These are different failures and today the panel cannot tell them apart.
4. **What arrived.** When the residual is large, scan news items with `ts`
   between `generatedAt` and the checkpoint time, rank by
   `impact_weight * |sentiment|`, and name the top one or two. Wording must stay
   descriptive — "the largest headline inside the window was X" — and must not
   assert that the headline caused the move. The repo's position is that a
   made-up number is worse than no number; an invented causal claim is the same
   sin in prose.

### Aggregate

Across settled entries: per-lane hit rate and sample size, overall coverage at
68 and 95 with a Kupiec verdict, direction rate, CRPS, and mean absolute error
against the no-change baseline. This is what eventually justifies refitting the
seven weights in `config.js` — that refit is explicitly **not** in this pass,
because with zero settled rows there is nothing to fit.

**Verification.** Cannot wait days for real settlement. Seed the ledger from
history: take candles from N bars ago, run `build()` against that truncated
series, record, then settle against the bars that really followed. That exercises
record → settle → explain → aggregate end to end in one page load, and it is the
same trick `calibrate()` already uses.

---

## Phase 4 — the "How it went" panel

New section in `index.html` beside the existing accuracy section, rendered by a
new `renderLedger()` in `app.js` following the shape of `renderAccuracy()`.

Shows, for the most recent settled forecast on the current symbol and timeframe:

- what was forecast, what happened, side by side
- the failure mode line from Phase 3 point 3
- per-lane verdict table: lane, what it asked for, right or wrong
- residual, and the headline that landed inside the window when there is one
- below that, the aggregate: per-lane hit rates with sample sizes

Empty state is not a blank panel. With no settled forecasts it says so and names
when the first one settles. A panel that renders nothing is indistinguishable
from a panel that is broken, which is this repo's recurring failure.

The accuracy panel gains the Kupiec verdict and p-value, and the green/red class
keys off the verdict rather than `abs(c68 - 68) <= 8`.

**Verification.** Playwright, per CLAUDE.md: zero `pageerror`, zero HTTP >= 400,
all five Data Lanes read `live`, and the new section renders with real content
after the history-seeded settlement — not just an empty shell. Check both
localhost and the deployed origin, since CORS differs.

---

## Phase 5 — workflow

**News archive.** `live-data.yml` writes `data/news_archive/YYYY-MM-DD.json`
alongside `news.json` on each run. Three lines. This is the unlock for defect 6:
the news lane is *permanently* unscoreable today because nothing keeps a record
of what the headlines were. Start archiving now and it becomes backtestable in
about three months. Nothing else in this plan depends on it, which is why it is
last — but it should ship in this pass precisely because its value is a function
of how early it starts.

Size check before committing to it: measure one `news.json` and multiply by runs
per day. At the measured ~2.5 hour cadence that is roughly 10 files a day.

**Ledger mirror.** The workflow writes its own forecast rows to
`data/ledger/YYYY-MM-DD.json` on the `live-data` branch, never overwritten,
matching the NSE-visor pattern on infrastructure this repo already runs.

The panel reads both stores and labels each row's origin — "this browser" versus
"recorded" — because they are not the same evidence and merging them silently
would overstate the sample.

Honest constraint to write into the panel, not hide: CLAUDE.md measured the
workflow at about one run per 2.5 hours, not the `*/5` it requests. Hourly
checkpoints will settle coarsely on the branch store. The localStorage store
does not have this problem, which is the main reason both exist.

---

## Order and what gates what

```
Phase 0  ──→ Phase 2
Phase 1  ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
                            └──────→ Phase 5
```

Phase 1 is the long pole. Phases 0 and 5 are independent and can land any time.
ACI (1f) cannot be tuned until Phase 3 has settled rows, so it ships at its
nominal value with the adaptive term disabled and clearly labelled as such.

---

## Rejected, with reasons

**Next.js + Supabase.** Hosting is not what is wrong with the forecast — every
computation here runs on candles the browser already holds, and a migration adds
zero accuracy. Supabase's free tier pauses a project after 7 days with no
database activity, and `pg_cron` stops when it pauses, so the settlement job
would die with the database meant to trigger it; the usual keep-alive is a
GitHub Actions ping, subject to the same throttle CLAUDE.md already measured at
~2.5 hours. A silently-stopped settlement job is exactly the "built, committed,
read by nothing" failure this repo keeps having. It also breaks the README's
stated position: static, keyless, no backend. Revisit when the ledger passes
~10k rows and needs querying, or when it becomes multi-user.

**Fitting the seven lane weights in this pass.** There is nothing to fit until
the ledger has settled rows. Phase 3 makes it possible; doing it now would mean
fitting to the backtest, which only scores two of the seven lanes.

**Copying NSE-visor source.** No licence file, `license: null` on the API. The
ledger-on-a-branch idea is used; no code is.
