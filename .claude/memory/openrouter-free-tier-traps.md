---
name: openrouter-free-tier-traps
description: "Two ways OpenRouter's free auto-router silently returns nothing usable, and the fixes"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c0c22991-d32e-41fb-9923-81f616c9ecdd
  modified: 2026-09-18T05:55:07.081Z
---

Both measured against `openrouter/free` on 18 Sep 2026.

**1. `max_tokens` covers reasoning tokens.** Routed to a reasoning-heavy free
model (`liquid/lfm-2.5-2.6b:free`), all 320 tokens went to reasoning:
`reasoning_tokens: 320`, `finish_reason: "length"`, `content: null`. HTTP 200,
nothing returned. Fix: send `reasoning: { enabled: false }` in the request body.
Verified `reasoning_tokens: 0` afterwards. Raising `max_tokens` also works but
costs latency and is not deterministic.

**2. The free pool contains classifiers, not just chat models.** The router
picked `nvidia/nemotron-3.5-content-safety:free`, which answered a market-forecast
prompt with `"User Safety: safe"` — a valid 200 with useless content. Filtering on
`architecture.input_modalities` / `output_modalities` does not catch these; they
are genuinely text-in/text-out. Two guards: reject completions below a sensible
length floor, and exclude ids matching `guard|safety|moderat|embed|rerank|classif`.

**Keep the auto-router anyway.** Free model ids turn over constantly.
`openrouter/free` with reasoning off was usable 6/6 in testing; hardcoded named
models were *less* reliable (`qwen/qwen3.8-27b:free` and `google/gemma-4-31b-it:free`
both returned empty or 429 upstream).

Key identity and quota: `GET https://openrouter.ai/api/v1/key` returns
`free_model_daily_requests` (1000/day limit).

Related: [[nifty-terminal-project]]
