# OpenRouter Forecast Integration — FNO Dashboard

When user asks for AI forecast powered by an external brain (OpenRouter) instead of local simulated predictions:

## Setup (embedded in index.html — never in repo source)

- Input field `id="orKey"` (`type="password"`), placeholder generic (never contain `sk-or-v1-` or real pattern).
- Save via `localStorage` only; never commit value to `repo-test`/GitHub.
- Fetch endpoint: `https://openrouter.ai/api/v1/chat/completions`; header `Authorization: Bearer ${key}`.
- Default model: free-tier available on OpenRouter (e.g., `openai/gpt-4o-mini` or `deepseek/deepseek-r1`); user enters only key.
- Prompt sends: current spot (Nifty / BankNifty / Sensex), recent news headlines from `news.json`, last `predictions.json` call, international factors (DXY / crude / FII / Fed sign). Request structured JSON response: `{direction, reason, confidence, range_low, range_high}`.

## Security rules (standing)

- Key stored in `localStorage`; `clearKey()` wipes it on user request.
- No `value=` attribute with placeholder pattern; no `Bearer` string in source.
- Privacy notice visible near input: "Key never touches GitHub. Only sent to openrouter.ai when Forecast clicked."
- If user asks "is my key safe?" confirm: not in file, not in server (Flask only serves static files), only in their browser until erased.

## Forecast display (same chart — no extra canvas)

- Past range/close shown as existing dataset.
- OpenRouter forecast overlaid as dashed gold / purple line or points labeled "Forecast (OpenRouter brain)".
- Explanation box below chart: direction + reasoning (citing specific news source / seasonal factor) + confidence % + predicted range.
- If key missing or fetch fails: show "Configure OpenRouter key in Settings above" with gray placeholder line; never error-out.

## Pitfall — key leakage

- If `grep -o 'sk-or-v1-' index.html` returns >0, stop and patch placeholder. Never assume placeholder is safe.
- If user shares screen or inspects page source, they must see empty `value=""`; the real key only appears in `localStorage` after user paste.
