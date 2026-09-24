# Forex Day Trader V1

Branch: `forex-daytrader-v1`

## Markets

- EUR/USD
- GBP/USD
- USD/JPY
- AUD/USD
- USD/CAD
- USD/CHF
- XAU/USD
- BTC/USD

## Architecture

Telegram -> Cloudflare Worker -> `MarketHub` Durable Object -> Tiingo FX + Crypto streams -> M5/M15/H1 engine -> setup ranking -> Telegram.

The existing OTC bot on `main` is not modified by this branch.

## Required Cloudflare secrets

Keep these as encrypted Worker secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TIINGO_API_TOKEN`

Do not put secret values in GitHub.

## Deployment

This branch uses a separate Worker name:

`forex-daytrader-v1`

Deploy command:

```bash
npx wrangler deploy --config ./wrangler.toml
```

## Telegram commands

- `/start` — show V1 markets
- `/version` — show deployed version
- `/checkall` — check FX/BTC live-feed status
- `/signal` — scan all eight instruments and return only the strongest qualified setup
- `/stats` — show tracked TP2-vs-SL results
- `/reconnect` — reconnect market streams

## Signal model

- H1: directional bias
- M15: structure, BOS and liquidity
- M5: trigger, RSI/ADX and volatility
- Minimum setup score: 82/100
- Minimum directional edge: 15 points
- Stop: ATR/swing based
- TP1: 1R
- TP2: 2R
- TP3: 3R
- Tracked result target: TP2 versus SL
- Maximum tracking window: 6 hours
- BTC/USD: 24/7
- FX and XAU/USD: London/New York day-trading window

## First deployment checks

1. Open `/health` on the Worker URL.
2. Send `/version` in Telegram.
3. Send `/checkall`.
4. Confirm all seven FX-style symbols receive fresh Tiingo FX ticks and BTC/USD receives fresh crypto ticks.
5. Send `/signal`.
6. If no market scores at least 82 with at least 15 points of directional edge, the bot intentionally returns NO TRADE.

## Important

V1 is a signal and forward-testing engine. It does not place broker orders automatically. Setup score is a confluence score, not a guaranteed probability of winning.
