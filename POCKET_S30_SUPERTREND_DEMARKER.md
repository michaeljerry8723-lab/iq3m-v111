# UTC S30 SuperTrend + DeMarker Shadow Strategy

Strategy ID: `pocket-s30-supertrend-demarker7-exp120-shadow-v1`

This is a new, isolated shadow-only strategy that applies the SuperTrend + DeMarker idea from the Pocket Option video to the existing **Tiingo UTC FX** market-data setup. It is a regular UTC FX observation model, not Pocket Option OTC data and not Pocket Option settlement results. Its Durable Object state, outcomes, and statistics are separate from Cruz.

## Rules implemented

- Build 30-second OHLC candles from live Tiingo FX WebSocket quotes using the provider event timestamp.
- Evaluate only a fully completed S30 candle. The first quote in the next S30 bucket is the confirmation/entry quote and must be no more than 15 seconds after that candle closes.
- CALL: SuperTrend is bullish, its line is below the completed candle close, and DeMarker(7) is rising.
- PUT: SuperTrend is bearish, its line is above the completed candle close, and DeMarker(7) is falling.
- No DeMarker threshold, RSI, EMA, or other discretionary signal filter is applied.
- Entry is the fresh Tiingo UTC FX mid-quote timestamp and price after confirmation. Expiry is exactly 120,000 ms after that entry timestamp.
- Settlement uses the first valid Tiingo UTC FX mid-quote from the same live feed at or after expiry. A quote must arrive within 15 seconds after expiry. If the quote stream session changes or the quote gap crosses expiry, the record is VOID because the first valid quote cannot be established.

## Unverified indicator setting

The supplied strategy description did not specify the SuperTrend ATR period or multiplier numerically. ATR(10) and multiplier 2 are provisional defaults only; `atrSettingsVerified` remains false in records and diagnostics. They can be changed with Worker variables `POCKET_S30_SUPERTREND_ATR_PERIOD` and `POCKET_S30_SUPERTREND_MULTIPLIER`. DeMarker period 7 and 120-second expiry are fixed.

## Market-data source and integrity

- Source identity: `tiingo-utc-fx`; candle source: `tiingo-utc-fx-s30`.
- The strategy subscribes the existing shared TickHub to the same 12 UTC FX pairs used by the existing UTC shadow setup: EUR/USD, USD/JPY, GBP/USD, USD/CAD, AUD/USD, USD/CHF, NZD/USD, EUR/JPY, GBP/JPY, EUR/GBP, AUD/JPY, CAD/JPY.
- Both entry and settlement use Tiingo WebSocket mid-quotes. The strategy does not call REST for settlement and does not substitute OTC quotes.
- Tiingo's UTC FX quotes are not equivalent to Pocket Option OTC prices. These observations assess this strategy only against the UTC/Tiingo stream.
- Candles are built from quote events, not broker-supplied S30 bars. To avoid inventing complete candles, an initial partial bucket after startup/restart is skipped, and bars lacking adequate edge coverage, multiple observations, or continuous timely quotes are rejected as data-quality failures. A gap resets contiguous indicator warm-up.

## Endpoints

All paths are on the Worker origin:

- `POST /pocket-s30-demarker/start` — starts shadow collection; requires `X-IQ3M-Cron-Secret` equal to the configured `TELEGRAM_WEBHOOK_SECRET`. It enables quote forwarding from TickHub's existing Tiingo UTC FX WebSocket.
- `GET /pocket-s30-demarker/diagnostics` — feed state, config, per-symbol S30 warm-up, latest quote age, current score/rejection reason, and collection status.
- `GET /pocket-s30-demarker/stats` — total/pending/settled entries, outcomes and W/L win rate excluding draws, by symbol/direction, entry observation dates, and rejection counts.

A code commit does not itself start collection. Collection begins after this branch is deployed to the intended non-production Worker with the `POCKET_S30_SHADOW` binding, `TICK_HUB` binding, and existing `TIINGO_API_TOKEN` configured, then the authenticated start endpoint is called. No production deployment is part of this change.
