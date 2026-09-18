---
name: nifty-terminal-project
description: "What the trading/ repo is — a keyless static NIFTY terminal on GitHub Pages, cloned 18 Sep 2026"
metadata: 
  node_type: memory
  type: project
  originSessionId: c0c22991-d32e-41fb-9923-81f616c9ecdd
  modified: 2026-09-18T05:54:23.545Z
---

`~/Desktop/trading` is a clone of `github.com/voltairtechindia/Sharemarket`,
cloned 18 Sep 2026. It is "NIFTY Terminal": a static, keyless, India-first
market dashboard for NIFTY 50 and SENSEX, live at
https://voltairtechindia.github.io/Sharemarket/

Constraints that shape every decision in it:

- **No backend, no broker API, no paid feed.** Everything is free-tier. The
  browser reads what CORS allows; GitHub Actions fetches the rest.
- **The repo and the Pages site are public**, so no key is ever committed. The
  OpenRouter key lives in `assets/local-config.js` (gitignored) or the user's
  localStorage.
- **Holdings and the trade journal never leave the browser.** localStorage only,
  never uploaded, never sent to a model. A public repo is no place for a
  position book.
- Stated principle throughout: **a made-up number is worse than no number.** FNO
  fields are absent rather than simulated; the forecast panel publishes its own
  calibration score even when it looks bad.

Operational detail lives in the repo's own `CLAUDE.md` (written 18 Sep 2026) —
dead endpoints, how to verify, the workflow-throttle problem. Read that, not
this, when working in the repo.

Related: [[nifty-terminal-verification-method]], [[voltairtech-repos]]
