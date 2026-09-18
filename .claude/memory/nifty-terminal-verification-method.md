---
name: nifty-terminal-verification-method
description: "Verify this repo by driving the page in Playwright and asserting the Data Lanes panel, not by reading source"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c0c22991-d32e-41fb-9923-81f616c9ecdd
  modified: 2026-09-18T05:54:33.949Z
---

For `~/Desktop/trading`, the only verification that counts is driving the real
page in a headless browser and reading what it renders.

**Why:** every defect found in the 18 Sep 2026 audit was invisible in the source
and obvious in the running page. A 404'd NSE endpoint, a model lane returning
`content: null`, eight feeds 403-ing, a prev-close two sessions stale — the code
looked correct in all four cases. The repo's whole failure pattern is a lane
that is built, committed, and exercised by nothing.

**How to apply:**

1. Serve the repo (`.venv/bin/python -m http.server 8080`), open it in
   Playwright, wait ~45s for the polling loops to complete a cycle.
2. Assert the **Data Lanes panel reads `live` on all five rows** — Live price,
   Candles, Fast news, Deep news, Model. `idle` or `unavailable` is a real
   failure.
3. Assert zero `pageerror` and zero HTTP >= 400 on the response listener.
4. Check the live origin too, not just localhost — CORS differs.
5. For a fetcher, read its JSON output directly. The page prefers the remote
   `live-data` branch over local `data/`, so a local script run does not change
   what the page displays.

Related: [[nifty-terminal-project]]
