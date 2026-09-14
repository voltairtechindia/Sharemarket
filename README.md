FNO AI Dashboard — Internal Build
==================================
Location: C:\hrv\Voltairtech\project\RJ\share market
Access:  http://192.168.0.6:8080 (Flask server) OR open index.html directly
GitHub Pages: Push index.html + data/ to a private/internal GitHub repo

Contents
--------
- index.html        Single-page dashboard (Nifty, Bank Nifty, FNO metrics, news, international, predictions)
- app.py            Flask server (self-learning loop, predictions.json read/write)
- data/predictions.json   Self-learning memory (validated predictions with accuracy)
- start_server.bat  Double-click to run server on 192.168.0.6:8080

What it does
-------------
1. Shows Nifty 50 + Bank Nifty with FNO metrics (Spot, Futures, Basis, PCR, OI Change, Max Pain, IV)
2. Curated news + sentiment tags (positive/negative/neutral) with impact levels
3. International signals (US futures, DXY, Crude, China PMI) with Indian market impact notes
4. AI Prediction box: direction + range + confidence, based on signal fusion (FNO + news + international)
5. Self-learning log: past predictions validated against market moves; accuracy updates weights

Self-Taught Mechanism
----------------------
- predictions.json stores every prediction, validation result, and correct/incorrect status
- When Hermes runs the pipeline, it reads accuracy_summary and adjusts signal weights
- Correct predictions reinforce their signals; incorrect predictions reduce conflicting signal weights
- This is the "assumed data which is predicted and then show that it went and learn by himself" loop

Hermes Connection
-----------------
Hermes opens this URL in browser (local or cloud) and interacts with the page. For coding updates, Hermes edits app.py and index.html in this folder. The predictions file is the durable memory across sessions.

Notes
-----
- X (Twitter) not connected directly. News is aggregated from web sources and tags applied by Hermes.
- FNO OI / PCR data in this prototype is simulated/assumed for demonstration; connect to NSE/BSE APIs for live data.
- Internal use only. Do not expose server to public networks without authentication.
