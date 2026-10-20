# Pocket Option OTC S30 SuperTrend + DeMarker shadow strategy

Strategy ID: `pocket-s30-supertrend-demarker7-exp120-shadow-v1`

This is a separate shadow-only strategy and storage namespace. It does not call Cruz/UTC scoring, send trade alerts, or execute orders. The strategy is disabled until the authenticated `/pocket-s30-demarker/start` endpoint is called.

## Rules implemented

- Build 30-second OHLC candles from OTCharts Pocket Option OTC stream ticks, using the provider's unshifted event timestamp.
- Evaluate only a fully completed S30 candle. The first quote in the next S30 bucket is the confirmation/entry quote and must be no more than 15 seconds after that candle closes.
- CALL: SuperTrend is bullish, its line is below the completed candle close, and DeMarker(7) is rising.
- PUT: SuperTrend is bearish, its line is above the completed candle close, and DeMarker(7) is falling.
- No DeMarker threshold, RSI, EMA, or other discretionary signal filter is applied.
- Entry is the fresh OTCharts quote timestamp/price after confirmation. Expiry is exactly 120,000 ms after that entry timestamp.
- Settlement uses the first valid quote from the same OTCharts Pocket Option OTC stream at or after expiry. A quote must arrive within 15 seconds after expiry. If the stream session changes or the quote gap crosses expiry, the record is VOID because the first valid quote cannot be established.

## Unverified indicator setting

The supplied strategy description did not specify the SuperTrend ATR period or multiplier numerically. ATR(10) and multiplier 2 are provisional defaults only; `atrSettingsVerified` is explicitly false in records and diagnostics. They can be changed with Worker variables `POCKET_S30_SUPERTREND_ATR_PERIOD` and `POCKET_S30_SUPERTREND_MULTIPLIER`. DeMarker period 7 and 120-second expiry are fixed.

## Source and integrity limits

The data source is OTCharts' stream requested with `venue=otc` and the five supported OTC symbols. It is a third-party OTC market-data stream, not Pocket Option's own settlement feed or a broker execution API. OTCharts currently documents that its free tier has no live streaming; an eligible plan and a configured `OTCHARTS_API_KEY` are required for forward collection. The entry and settlement prices are both taken from this exact stream identity (`otcharts-pocket-option-otc`). Tiingo regular FX prices are rejected. If OTCharts is unavailable, keyless, stale, or does not provide a timely quote, collection will show diagnostics/rejections or VOID records; it must not substitute regular FX prices.

Candles are built from quote events, not broker-supplied S30 bars. To avoid inventing complete candles, an initial partial bucket after startup/restart is skipped, and bars lacking adequate edge coverage, multiple observations, or continuous timely quotes are rejected as data-quality failures. A gap also resets the contiguous indicator warm-up.

## Endpoints

All paths are on the Worker origin:

- `POST /pocket-s30-demarker/start` — starts shadow collection; requires `X-IQ3M-Cron-Secret` equal to the configured `TELEGRAM_WEBHOOK_SECRET`. It starts/reuses TickHub's shared OTCharts stream and forwards a separate, unshifted OTC quote record to the strategy Durable Object.
- `GET /pocket-s30-demarker/diagnostics` — stream state, config, per-symbol S30 warm-up, latest quote age, current score/rejection reason, and collection status.
- `GET /pocket-s30-demarker/stats` — total/pending/settled entries, outcomes and W/L win rate excluding draws, by symbol/direction, entry observation dates, and rejection counts.

A successful code commit does not start a feed. Collection begins only after this branch is deployed to a nonproduction Worker with the `POCKET_S30_SHADOW` binding and `OTCHARTS_API_KEY` configured, then the authenticated start endpoint is called. No production deployment is part of this change.
