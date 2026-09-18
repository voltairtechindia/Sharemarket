---
name: github-actions-cron-throttle
description: GitHub drops scheduled-workflow firings on low-activity repos — a */5 cron really runs every ~2.5 hours
metadata: 
  node_type: memory
  type: reference
  originSessionId: c0c22991-d32e-41fb-9923-81f616c9ecdd
  modified: 2026-09-18T05:54:48.903Z
---

A `*/5 * * * *` schedule in GitHub Actions does **not** give twelve runs an hour
on a low-activity repo. Measured on `voltairtechindia/Sharemarket` over
17–18 Sep 2026, run starts were 07:53, 12:53, 17:23, 20:26, 22:59 and 01:12 UTC
— roughly one run every 2.5 hours.

GitHub deprioritises scheduled workflows on repos with little push activity and
**drops** the skipped firings rather than queueing them, so there is no catch-up
burst. Lowering the cron interval does not help; the same throttle applies.

Practical consequence for any free-tier project that treats Actions as a data
refresher: anything the workflow produces is as old as the last run, which can
be four-plus hours during a trading session. Design for it — put the lanes that
must be current in the browser, and display the timestamp of each lane rather
than the cron expression.

Related: [[nifty-terminal-project]]
