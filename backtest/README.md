# V13.1.1 historical backtest

This folder provides a chronological, no-lookahead **Mode A** evaluation of the six-pair V13.1.1 strategy using genuine Tiingo 1-minute OHLC bars.

It deliberately does **not** fabricate data the live worker uses but historical 1-minute OHLC cannot reproduce: 30-second bars, live tick impulse, exact bid/ask spread, Telegram latency, or Pocket Option settlement quotes. Its output is therefore a diagnostic of the historical core, not a claim of full live-strategy accuracy.

## Run

1. Export `TIINGO_API_TOKEN` in your shell.
2. Optionally set `BACKTEST_MONTHS` (default: 6) and `BACKTEST_END=YYYY-MM-DD`.
3. Run `npm run backtest:fetch`.
4. Run `npm run backtest`.

Outputs are written to `backtest/results/` and `backtest/BACKTEST_REPORT.md`.

The replay enforces the READY-before-signal sequence: a PREPARE event is recorded first, and a historical-core entry cannot occur until a later chronological scan.
