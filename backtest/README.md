# V13.1.1 historical backtest

This folder provides a chronological, no-lookahead **Mode A** evaluation of the six-pair V13.1.1 strategy using genuine 1-minute FX OHLC data.

Supported historical providers:

- `TWELVE_DATA` — default fallback/alternative provider.
- `TIINGO` — primary live-reference provider when its historical quota is available.
- `AUTO` — tries Tiingo first and, if it is unavailable, restarts the entire historical download with Twelve Data. A single backtest never mixes the two feeds.

The test deliberately does **not** fabricate data that historical 1-minute OHLC cannot reproduce: production 30-second bars, live tick impulse, exact entry spread, Telegram latency, or Pocket Option settlement quotes. Its output is therefore a diagnostic of the reproducible historical core, not a claim of full live-strategy accuracy.

## GitHub Actions

Run **Actions → V13.1.1 Historical Backtest → Run workflow**.

For the current Tiingo quota issue, select:

- Provider: `TWELVE_DATA`
- Months: `6`
- End date: leave blank

The Twelve Data downloader uses 3-calendar-day windows so each 1-minute request remains below the provider's 5,000-point maximum. Requests are throttled to stay below the Basic-plan per-minute credit ceiling. A six-month, six-pair run can take roughly 45–60 minutes.

Required repository secrets:

- `TWELVE_DATA_API_KEY` for Twelve Data.
- `TIINGO_API_TOKEN` for Tiingo.

Outputs are written to `backtest/results/` and `backtest/BACKTEST_REPORT.md`.

The replay enforces the READY-before-signal sequence: a PREPARE event is recorded first, and a historical-core entry cannot occur until a later chronological scan.
