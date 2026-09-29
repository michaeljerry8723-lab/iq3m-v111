# Antigravity Task — Pocket Option FX Signal Bot Audit

## Objective
Audit and fix the Cloudflare Workers + Telegram Pocket Option FX signal bot so it produces actionable 5-minute CALL/PUT signals when valid setups exist, without preparation-only Telegram spam or random overtrading.

The live market-data provider is Tiingo. The current six-pair universe is EUR/USD, USD/JPY, GBP/USD, USD/CAD, AUD/USD, and USD/CHF.

## Current production concerns
Recent versions have shown many internal/READY setups but too few final signals. Repeated blockers have included:
- ATR extension caps after a valid pullback
- SMA(5/13) continuation structure failures
- momentum confluence requirements
- room-to-move rejections
- stale setup states
- earlier READY-before-signal gating
- Tiingo historical REST quota exhaustion
- timing windows that vanish before the next one-minute scan

The goal is to fix architecture/state/timing first, not blindly lower every threshold.

## Required behavior
1. Telegram should receive final actionable CALL/PUT signals only.
2. SEEK, ARMED, PULLBACK, PREPARE, and READY may exist internally but must not unnecessarily block a valid final signal.
3. Primary expiry remains 5 minutes.
4. Scanning must continue autonomously while the user is offline.
5. Tiingo WebSocket ticks provide fresh live confirmation.
6. Tiingo REST is used sparingly for historical context.
7. Settlement must continue updating /stats and /forwardstats from Tiingo prices.
8. Do not fabricate or force trades just to increase frequency.

## Audit
Trace and test the full path:
SEEK -> ARMED -> PULLBACK -> PREPARE -> final validation -> SIGNALLED -> settlement.

Check every final rejection and classify it as:
- core structure/safety gate
- useful supporting confirmation
- transient timing condition
- redundant/over-restrictive gate

Pay special attention to:
- 5m trend regime
- 15m opposing-trend veto
- SMA 5/13 stack and slopes
- fractal structure
- ATR/volatility
- spread
- room-to-move
- ADX/DMI
- MACD
- RSI
- Aroon
- candle pressure
- completed 1m continuation
- live tick burst / 30s timing
- quality threshold
- final entry drift
- cooldowns
- correlated USD exposure

## Blocker instrumentation
Add persistent automatic-scan blocker counts and a Telegram command:

/blockerstats

It should summarize recent failures by category so tuning is evidence-based.

## Replay/test harness
Build deterministic tests that exercise the same production scoring/state functions:
- clean CALL trend + pullback + continuation -> signal
- clean PUT trend + pullback + continuation -> signal
- structural reversal -> reject
- temporary momentum fade -> preserve setup
- controlled extension after pullback -> can still signal
- final conditions already satisfied in PREPARE -> signal in same scan
- Tiingo context survives Durable Object sleep/restart

## Tiingo / Cloudflare validation
Verify:
- WebSocket subscriptions stay healthy
- sampled live ticks extend persisted minute context correctly
- historical REST does not get consumed every scan
- scheduler/alarm runs autonomously
- quote receive/provider timestamps are handled correctly
- settlement uses a fresh quote/tick around expiry

## Telegram UX
Prioritize:
/version
/cronstatus
/diagnose
/blockerstats
/stats
/forwardstats
/final CALL/PUT signals
/settlement results

No preparation chatter in normal operation.

## Final signal format
⬆️ EUR/USD
AUTO 5-MINUTE SNIPER
EXPIRY: 5 minutes
GRADE: A
SETUP SCORE: 91/100
TRACKING: ON

Do not claim guaranteed accuracy or profits.

## Delivery rules
Work only on branch: antigravity-signal-audit

Before any production merge:
1. Create tests/replay harness.
2. Run syntax validation.
3. Run replay cases.
4. Document every gate changed and why.
5. Keep rollback capability.
6. Do not expose secrets.
7. Do not merge to main automatically.

Deliver corrected code, tests, blocker instrumentation, change summary, and Cloudflare deployment validation steps.
