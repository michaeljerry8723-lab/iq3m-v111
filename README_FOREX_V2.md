# Forex Signal V2

Branch: `forex-signal-v2`

This is a separate Cloudflare Worker for normal FX, XAU/USD and BTC/USD. The existing Pocket Option/OTC bot on `main` remains untouched.

## Markets

- EUR/USD
- GBP/USD
- USD/JPY
- AUD/USD
- USD/CAD
- USD/CHF
- XAU/USD
- BTC/USD

## Signal modes

### SCALP
- Entry timeframe: M5
- Structure/context: M15
- Higher-timeframe bias: H1
- Uses EMA alignment, structure/BOS, liquidity sweep, pullback/value area, displacement, RSI, ADX/DMI, volatility, session and spread filters.

### SWING
- Entry timeframe: H1
- Structure/context: H4
- Higher-timeframe bias: D1
- Uses the same confluence categories adapted to slower bars.

## Risk/targets

Every qualified signal contains:
- Entry
- Stop Loss
- TP1 = 1R
- TP2 = 2R
- TP3 = 3R
- Pip distance for FX and XAU/USD
- Point distance for BTC/USD

Gold convention in this bot: 1 XAU/USD pip = 0.01. Therefore a move from 3742.00 to 3751.00 is 900 pips.

The tracking engine settles TP2 vs SL and records timeouts. Signals do not place broker orders automatically.

## Forward-shadow rule

The previous V13.4 rule is carried into this bot as a shadow test only:

`DMI gap >= 20.93 AND ADX <= 76.23`

It does not block live forex signals at this stage. `/forwardstats` compares shadow-eligible and non-eligible outcomes so the rule can be validated on forex/gold/BTC data before being promoted to a production filter.

## Telegram commands

- `/start`
- `/version`
- `/checkall`
- `/signal` — scan SCALP + SWING across all 8 markets
- `/scalp` — scan only M5/M15/H1 setups
- `/swing` — scan only H1/H4/D1 setups
- `/stats` — tracked TP2-vs-SL results
- `/forwardstats` — V13.4 shadow comparison
- `/reconnect`

## Required Cloudflare secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TIINGO_API_TOKEN`

Use a separate Telegram bot token if the existing OTC Telegram bot must remain online. Telegram permits one webhook URL per bot token, so pointing the existing token at this Worker would replace the old webhook.

## Worker

Cloudflare Worker name:

`forex-signal-v2`

Deploy:

```bash
npx wrangler deploy --config ./wrangler.toml
```

After deployment:

1. Open `/health`.
2. Set the new Telegram bot webhook to `https://<worker-url>/telegram` with the webhook secret.
3. Send `/version`.
4. Send `/checkall`.
5. Test `/scalp`, `/swing`, then `/signal`.
6. Allow signals to reach TP2, SL or timeout and verify `/stats` and `/forwardstats`.

## Important

The score is a confluence score, not a probability of winning. V2 is designed for forward testing first. The OTC frozen DMI/ADX threshold is intentionally kept as shadow evidence rather than assumed to transfer directly to normal forex, gold or Bitcoin.
