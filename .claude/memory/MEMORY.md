# Memory

Findings that cost real measurement to establish and that a fresh session would
otherwise have to rediscover. One fact per file.

These are checked in so they travel with the repo. Claude Code's own memory
directory is keyed to a local filesystem path, so a clone on another machine
does not inherit it — these files are the portable copy. Read them as notes,
not as live state: each records what was true on the date it names, so verify a
named endpoint or flag still exists before relying on it.

- [NIFTY Terminal project](nifty-terminal-project.md) — what this repo is and the constraints it ships under
- [Verify by driving the page](nifty-terminal-verification-method.md) — Playwright and the Data Lanes panel, not source reading
- [GitHub Actions cron throttle](github-actions-cron-throttle.md) — `*/5` really fires about every 2.5 hours on a quiet repo
- [OpenRouter free-tier traps](openrouter-free-tier-traps.md) — reasoning eats `max_tokens`; the free pool contains classifiers
- [Indian market free endpoints](indian-market-free-endpoints.md) — which NSE, BSE, Moneycontrol and Yahoo URLs still answer

Operational guidance lives in [`CLAUDE.md`](../../CLAUDE.md) at the repo root.
