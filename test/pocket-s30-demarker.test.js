import assert from "node:assert/strict";
import {
  POCKET_S30_STRATEGY_ID, POCKET_S30_SOURCE_FEED, POCKET_S30_SYMBOLS, POCKET_S30_DEFAULT_CONFIG,
  pocketS30ConfigFromEnv, computeDeMarker, computeSuperTrend, scorePocketS30,
  validatePocketS30Quote, createPocketS30State, restorePocketS30State,
  capturePocketS30Entry, ingestPocketS30Quote, expirePocketS30Pending,
  summarizePocketS30, countPocketS30Rejection, PocketS30DemarkerShadow
} from "../pocket-s30-demarker.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("PASS " + name); }
const base = 1800000000000;
function trendBars(sign = 1) {
  const bars = []; let price = 1;
  for (let i = 0; i < 60; i++) {
    let delta = sign * 0.0001;
    if (i === 52) delta = -sign * 0.00025;
    const open = price; price += delta;
    bars.push({ t: base + i * 30000, o: open, h: Math.max(open, price) + 0.00004,
      l: Math.min(open, price) - 0.00004, c: price, n: 8 });
  }
  return bars;
}
function quote(symbol, providerAt, price, session = "session-a", sourceFeed = POCKET_S30_SOURCE_FEED) {
  return { sourceFeed, symbol, providerAt, receivedAt: providerAt + 100, price, streamSession: session };
}
function makeEntry(direction = "CALL") {
  const bars = trendBars(direction === "CALL" ? 1 : -1);
  const score = scorePocketS30(bars, { confirmationAt: bars.at(-1).t + 30000,
    atrPeriod: 10, atrMultiplier: 2, deMarkerPeriod: 7 });
  assert.equal(score.direction, direction);
  const state = createPocketS30State(base, POCKET_S30_DEFAULT_CONFIG);
  const entryAt = bars.at(-1).t + 35000;
  const record = capturePocketS30Entry(state, { symbol: "EUR/USD", direction,
    signalBarAt: bars.at(-1).t, score, quote: quote("EUR/USD", entryAt, 1.25),
    config: state.config }, entryAt + 100);
  return { state, record, entryAt, score, bars };
}

test("config uses DeMarker 7 and provisional configurable ATR(10)x2", () => {
  assert.equal(POCKET_S30_DEFAULT_CONFIG.deMarkerPeriod, 7);
  assert.equal(POCKET_S30_DEFAULT_CONFIG.atrPeriod, 10);
  assert.equal(POCKET_S30_DEFAULT_CONFIG.atrMultiplier, 2);
  assert.equal(POCKET_S30_DEFAULT_CONFIG.atrSettingsVerified, false);
  assert.equal(pocketS30ConfigFromEnv({ POCKET_S30_SUPERTREND_ATR_PERIOD: "14",
    POCKET_S30_SUPERTREND_MULTIPLIER: "3" }).atrPeriod, 14);
});

test("DeMarker rising and falling values follow high/low movement", () => {
  const rising = trendBars(1);
  const put = computeDeMarker(trendBars(-1), 7);
  const call = computeDeMarker(rising, 7);
  assert.equal(call.ready, true);
  assert.equal(call.direction, "rising");
  assert.equal(put.ready, true);
  assert.equal(put.direction, "falling");
});

test("DeMarker reports insufficient and invalid data without a signal", () => {
  assert.equal(computeDeMarker(trendBars().slice(0, 8), 7).ready, false);
  assert.equal(computeDeMarker([{ h: NaN, l: 1 }], 7).ready, false);
  assert.equal(computeDeMarker(Array.from({ length: 10 }, (_, i) =>
    ({ h: 10, l: 10, t: i })), 7).ready, false);
});

test("SuperTrend calculates a bullish line below rising price", () => {
  const bars = trendBars(1);
  const st = computeSuperTrend(bars, { atrPeriod: 10, atrMultiplier: 2 });
  assert.equal(st.ready, true);
  assert.equal(st.trend, "bullish");
  assert.ok(st.line < bars.at(-1).c);
});

test("SuperTrend calculates a bearish line above falling price", () => {
  const bars = trendBars(-1);
  const st = computeSuperTrend(bars, { atrPeriod: 10, atrMultiplier: 2 });
  assert.equal(st.ready, true);
  assert.equal(st.trend, "bearish");
  assert.ok(st.line > bars.at(-1).c);
});

test("SuperTrend rejects insufficient or invalid configuration/history", () => {
  assert.equal(computeSuperTrend(trendBars().slice(0, 11), { atrPeriod: 10, atrMultiplier: 2 }).ready, false);
  assert.equal(computeSuperTrend(trendBars(), { atrPeriod: 1, atrMultiplier: 2 }).reason,
    "invalid_supertrend_configuration");
});

test("CALL requires bullish trend, line below price, and rising DeMarker", () => {
  const bars = trendBars(1);
  const score = scorePocketS30(bars, { confirmationAt: bars.at(-1).t + 30000,
    atrPeriod: 10, atrMultiplier: 2, deMarkerPeriod: 7 });
  assert.equal(score.direction, "CALL");
  assert.ok(score.superTrend.line < score.price);
  assert.equal(score.deMarker.direction, "rising");
});

test("PUT requires bearish trend, line above price, and falling DeMarker", () => {
  const bars = trendBars(-1);
  const score = scorePocketS30(bars, { confirmationAt: bars.at(-1).t + 30000,
    atrPeriod: 10, atrMultiplier: 2, deMarkerPeriod: 7 });
  assert.equal(score.direction, "PUT");
  assert.ok(score.superTrend.line > score.price);
  assert.equal(score.deMarker.direction, "falling");
});

test("strategy waits until the signal S30 candle has completed", () => {
  const bars = trendBars(1);
  assert.equal(scorePocketS30(bars, { confirmationAt: bars.at(-1).t + 29999,
    atrPeriod: 10, atrMultiplier: 2, deMarkerPeriod: 7 }).reason,
  "latest_s30_candle_not_completed_at_confirmation");
});

test("invalid and gapped candle data are rejected or require a fresh contiguous warm-up", () => {
  const bars = trendBars(1);
  const invalid = bars.map(x => ({ ...x })); invalid[20].h = invalid[20].l - 1;
  assert.equal(scorePocketS30(invalid, { confirmationAt: bars.at(-1).t + 30000 }).reason,
    "invalid_or_out_of_order_s30_candle");
  const gapped = bars.map(x => ({ ...x })); for (let i = 30; i < gapped.length; i++) gapped[i].t += 30000;
  const afterGap = scorePocketS30(gapped, { confirmationAt: gapped.at(-1).t + 30000 });
  assert.equal(afterGap.bars, 30);
  assert.equal(afterGap.ok, true);
});

test("fresh UTC FX quotes require exact source, supported pair, and valid timing/price", () => {
  const now = base + 1000, q = quote("EUR/USD", base, 1.1);
  assert.equal(validatePocketS30Quote(q, now).ok, true);
  assert.equal(validatePocketS30Quote({ ...q, sourceFeed: "otcharts-pocket-option-otc" }, now).reason, "source_feed_mismatch");
  assert.equal(validatePocketS30Quote({ ...q, symbol: "EUR/USD-OTC" }, now).reason, "unsupported_utc_fx_symbol");
  assert.equal(validatePocketS30Quote({ ...q, price: 0 }, now).reason, "invalid_source_quote");
  assert.equal(validatePocketS30Quote({ ...q, receivedAt: now - 20000 }, now).reason, "stale_source_quote");
});

test("entry record stores source, indicators, config, quote timestamp, and exact 120-second expiry", () => {
  const { state, record, entryAt, score } = makeEntry("CALL");
  assert.equal(record.ok, true);
  const row = record.record;
  assert.equal(row.strategyId, POCKET_S30_STRATEGY_ID);
  assert.equal(row.sourceFeed, POCKET_S30_SOURCE_FEED);
  assert.equal(row.entryAt, entryAt);
  assert.equal(row.expiryAt, entryAt + 120000);
  assert.equal(row.direction, "CALL");
  assert.equal(row.superTrend.atr, score.superTrend.atr);
  assert.equal(row.deMarker.value, score.deMarker.value);
  assert.equal(row.config.atrSettingsVerified, false);
  assert.equal(state.pending.length, 1);
});

test("duplicate signal-bar entries are prevented across retries", () => {
  const { state, record, entryAt, score, bars } = makeEntry();
  const again = capturePocketS30Entry(state, { symbol: "EUR/USD", direction: "CALL",
    signalBarAt: bars.at(-1).t, score, quote: quote("EUR/USD", entryAt, 1.25),
    config: state.config }, entryAt + 200);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(state.pending.length, 1);
});

test("entry is rejected when quote arrives too late after candle confirmation", () => {
  const bars = trendBars(1), state = createPocketS30State(base);
  const score = scorePocketS30(bars, { confirmationAt: bars.at(-1).t + 30000 });
  const q = quote("EUR/USD", bars.at(-1).t + 30000 + 15001, 1.2);
  assert.equal(capturePocketS30Entry(state, { symbol: q.symbol, direction: "CALL",
    signalBarAt: bars.at(-1).t, score, quote: q }, q.receivedAt).reason,
  "entry_quote_not_immediately_after_confirmation");
});

test("entry refuses a mismatched strategy namespace", () => {
  const { state, score, bars, entryAt } = makeEntry();
  state.strategyId = "old-cruz-strategy";
  const out = capturePocketS30Entry(state, { symbol: "EUR/USD", direction: "CALL",
    signalBarAt: bars.at(-1).t, score, quote: quote("EUR/USD", entryAt, 1.2) }, entryAt + 200);
  assert.equal(out.reason, "strategy_state_isolation_mismatch");
});

test("settlement uses first continuous same-feed quote at or after exact expiry", () => {
  const { state, record, entryAt } = makeEntry("CALL");
  assert.equal(record.ok, true);
  const expiryAt = entryAt + 120000;
  for (let at = entryAt + 10000; at < expiryAt; at += 10000) {
    assert.equal(ingestPocketS30Quote(state, quote("EUR/USD", at, 1.25, "session-a"),
      at + 150).accepted, true);
  }
  const result = ingestPocketS30Quote(state, quote("EUR/USD", expiryAt + 1000, 1.26, "session-a"),
    expiryAt + 1150);
  assert.deepEqual(result.settled, [record.id]);
  assert.equal(state.pending.length, 0);
  assert.equal(state.history[0].result, "WIN");
  assert.equal(state.history[0].exitAt, expiryAt + 1000);
  assert.equal(state.history[0].exitSourceFeed, POCKET_S30_SOURCE_FEED);
});

test("equal entry and exit prices settle as DRAW", () => {
  const { state, record, entryAt } = makeEntry("PUT"), expiryAt = entryAt + 120000;
  for (let at = entryAt + 10000; at < expiryAt; at += 10000)
    ingestPocketS30Quote(state, quote("EUR/USD", at, 1.25), at + 150);
  ingestPocketS30Quote(state, quote("EUR/USD", expiryAt, 1.25), expiryAt + 150);
  assert.equal(state.history.find(x => x.id === record.id).result, "DRAW");
});

test("settlement beyond grace or across source discontinuity is VOID", () => {
  const one = makeEntry("CALL"), expiry = one.entryAt + 120000;
  const late = ingestPocketS30Quote(one.state, quote("EUR/USD", expiry + 16000, 1.3), expiry + 16150);
  assert.equal(late.settled.length, 1);
  assert.equal(one.state.history[0].result, "VOID");

  const two = makeEntry("CALL"), exp2 = two.entryAt + 120000;
  const gap = ingestPocketS30Quote(two.state, quote("EUR/USD", exp2 + 1000, 1.3, "session-b"), exp2 + 1150);
  assert.equal(gap.settled.length, 1);
  assert.equal(two.state.history[0].result, "VOID");
});

test("alarm voids an unsettled record exactly after settlement grace", () => {
  const { state, record, entryAt } = makeEntry();
  const result = expirePocketS30Pending(state, entryAt + 120000 + 15000);
  assert.deepEqual(result.expired, [record.id]);
  assert.equal(state.history[0].result, "VOID");
});

test("restart restoration retains only this strategy's pending/history and bars", () => {
  const { state, record } = makeEntry();
  state.completedBars["EUR/USD"] = trendBars(1);
  const recovered = restorePocketS30State(JSON.parse(JSON.stringify(state)), base + 500000);
  assert.equal(recovered.pending.length, 1);
  assert.equal(recovered.pending[0].id, record.id);
  assert.equal(recovered.completedBars["EUR/USD"].length, 60);
  assert.deepEqual(recovered.currentBars, {});
  const wrong = restorePocketS30State({ ...state, strategyId: "cruz-v8" }, base);
  assert.equal(wrong.pending.length, 0);
  assert.equal(wrong.history.length, 0);
});

test("statistics isolate counts, directions, symbols, dates, and rejection reasons", () => {
  const { state, entryAt } = makeEntry();
  countPocketS30Rejection(state, "test_rejection", "EUR/USD", entryAt + 1000);
  const stats = summarizePocketS30(state);
  assert.equal(stats.strategyId, POCKET_S30_STRATEGY_ID);
  assert.equal(stats.totalEntries, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.settled, 0);
  assert.equal(stats.bySymbol["EUR/USD"].pending, 1);
  assert.equal(stats.byDirection.CALL.pending, 1);
  assert.equal(stats.observationDates.first, new Date(entryAt).toISOString().slice(0, 10));
  assert.equal(stats.rejectionReasons.test_rejection.count, 1);
});

test("feed identity accepts Tiingo UTC FX and rejects OTC prices", () => {
  const q = quote("EUR/USD", base, 1.1, "regular", "tiingo-utc-fx");
  assert.equal(validatePocketS30Quote(q, base + 1000).ok, true);
  const otc = quote("EUR/USD", base, 1.1, "otc-session", "otcharts-pocket-option-otc");
  assert.equal(validatePocketS30Quote(otc, base + 1000).reason, "source_feed_mismatch");
  assert.equal(POCKET_S30_SYMBOLS.length, 12);
  assert.equal(POCKET_S30_STRATEGY_ID, "pocket-s30-supertrend-demarker7-exp120-shadow-v1");
});


async function testAsync(name, fn) { await fn(); passed++; console.log("PASS " + name); }
function mockContext(storageMap, alarms = []) {
  return {
    storage: {
      get: async key => storageMap.get(key),
      put: async (key, value) => storageMap.set(key, structuredClone(value)),
      setAlarm: async at => alarms.push(at)
    },
    blockConcurrencyWhile: fn => fn(),
    waitUntil: promise => promise
  };
}

await testAsync("Durable Object starts shadow-only, records S30 signals, persists and restores after restart", async () => {
  const storageMap = new Map(), alarms = [];
  let now = base + 1_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const env = {
      TELEGRAM_WEBHOOK_SECRET: "test-secret",
      POCKET_S30_SUPERTREND_ATR_PERIOD: "10",
      POCKET_S30_SUPERTREND_MULTIPLIER: "2",
      TICK_HUB: {
        idFromName: name => name,
        get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true, status: "connected" })) })
      }
    };
    const ctx = mockContext(storageMap, alarms);
    const object = new PocketS30DemarkerShadow(ctx, env);
    await object.ready;
    const started = await object.fetch(new Request("https://shadow/start", {
      method: "POST", headers: { "X-IQ3M-Cron-Secret": "test-secret" }
    }));
    assert.equal(started.status, 200);
    assert.equal(object.state.enabled, true);
    assert.equal(object.state.history.length, 0);
    assert.equal(object.state.config.expirySeconds, 120);

    const bars = trendBars(1);
    const offsets = [1000, 7000, 15000, 23000];
    for (const bar of bars) {
      const prices = [bar.o, bar.h, bar.l, bar.c];
      for (let i = 0; i < prices.length; i++) {
        const providerAt = bar.t + offsets[i];
        now = providerAt + 100;
        await object.onQuote(quote("EUR/USD", providerAt, prices[i], "session-live"));
      }
    }
    const confirmAt = bars.at(-1).t + 31000;
    now = confirmAt + 100;
    const confirmation = await object.onQuote(quote("EUR/USD", confirmAt, bars.at(-1).c, "session-live"));
    assert.equal(confirmation.entry.direction, "CALL");
    assert.equal(object.state.pending.length, 1);
    assert.equal(object.state.pending[0].expiryAt, confirmAt + 120000);
    assert.equal(storageMap.get("pocketS30SuperTrendDeMarkerShadowV1").pending.length, 1);

    const restarted = new PocketS30DemarkerShadow(mockContext(storageMap, alarms), env);
    await restarted.ready;
    assert.equal(restarted.state.pending.length, 1);
    assert.equal(restarted.state.pending[0].sourceFeed, POCKET_S30_SOURCE_FEED);
    assert.deepEqual(restarted.state.currentBars, {});
    const stats = await (await restarted.fetch(new Request("https://shadow/stats"))).json();
    assert.equal(stats.totalEntries, 1);
    assert.equal(stats.pending, 1);
    assert.equal(stats.strategyId, POCKET_S30_STRATEGY_ID);
  } finally {
    Date.now = originalNow;
  }
});

console.log("Pocket S30 DeMarker tests: " + passed + " passed, 0 failed");
