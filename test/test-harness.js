/**
 * Deterministic Test and Replay Harness for V13.6 FX Sniper Audit.
 * Tests production scoring and state machine functions against required scenarios:
 * 1. Clean CALL trend + pullback + continuation -> signal
 * 2. Clean PUT trend + pullback + continuation -> signal
 * 3. Structural reversal -> reject / cancel
 * 4. Temporary momentum fade -> preserve setup
 * 5. Controlled extension after pullback -> can still signal
 * 6. Final conditions already satisfied in PREPARE -> signal in same scan
 * 7. Tiingo context survives Durable Object sleep/restart
 * 8. Blocker instrumentation (/blockerstats)
 */

import { createBars, createTicks } from "./market-generator.js";
import {
  VERSION,
  STRATEGY_ID,
  BLOCKER_CLASSIFIER_VERSION,
  SHORT_SHADOW_ID,
  FIXED_UNIVERSE,
  A_GRADE_MIN_QUALITY,
  score5m,
  preAlert5m,
  scoreShortExpiryShadow,
  setupSequenceSnapshot,
  classifyBlocker,
  SHORT_SHADOW_UNIVERSE,
  scoreCruz1mShadow,
  cruzIchimokuSnapshot,
  cruzDmiSnapshot,
  cruzAroonSnapshot,
  cruzOsmaSnapshot,
  scoreCruz30sAroonOsma,
  cruzS30SettlementPrice,
  TickHub,
  CRUZ_ENTRY_METHOD_REVISION,
  determineCruzResearchEntry
} from "../worker.js";

// Mock Durable Object storage for Node testing
class MockStorage {
  constructor(data = {}) {
    this.map = new Map(Object.entries(data));
    this.alarm = null;
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(time) {
    this.alarm = time;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

class MockCtx {
  constructor(storage) {
    this.storage = storage;
    this.initPromise = Promise.resolve();
  }

  blockConcurrencyWhile(fn) {
    this.initPromise = Promise.resolve().then(fn);
    return this.initPromise;
  }

  async waitForInit() {
    await this.initPromise;
  }
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}


// -----------------------------------------------------------------------------
// Test 32: Cruz entry-method integrity guard
// -----------------------------------------------------------------------------
console.log("Test 32: Cruz entry-method integrity guard");
{
  const entry = determineCruzResearchEntry({});
  assert(
    entry.qualified === false && entry.sourceVerified === false,
    "Cruz research entry remains blocked until the source-verified entry rule exists"
  );
  assert(
    CRUZ_ENTRY_METHOD_REVISION === "source-verified-rule-required-v1",
    "Cruz research entry revision explicitly requires source verification"
  );
}
console.log();

console.log(`=======================================================`);
console.log(`Running V13.6 Pocket Option FX Sniper Audit Test Suite`);
console.log(`=======================================================\n`);

// -----------------------------------------------------------------------------
// Test 1: Clean CALL trend + pullback + continuation -> signal
// -----------------------------------------------------------------------------
console.log(`Test 1: Clean CALL trend + pullback + continuation -> signal`);
{
  const now = Date.now();
  const bars = createBars({
    count: 180,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    extensionAtr: 0.7,
    now
  });

  const lastPrice = Number(bars.at(-1).c);
  const ticks = createTicks({ lastPrice, direction: "CALL", count: 18, now, aligned: true });

  const seq = setupSequenceSnapshot(bars);
  assert(seq.ready && seq.direction === "CALL", `Sequence detects CALL trend (direction: ${seq.direction})`);
  assert(seq.structureOk, "Structure is intact (fractal support held)");

  const pre = preAlert5m(ticks, bars, "EUR/USD", "CALL");
  assert(pre.ok, `preAlert5m qualifies CALL setup (preScore: ${pre.preScore?.toFixed(3)})`);

  const score = score5m(ticks, bars, "EUR/USD");
  console.log("TEST 1 SCORE:", score);
  assert(score.ok && score.direction === "CALL", `score5m produces CALL signal (ok: ${score.ok}, grade: ${score.grade}, quality: ${(score.quality * 100)?.toFixed(1)}%)`);
  assert(score.quality >= A_GRADE_MIN_QUALITY, `Signal quality ${(score.quality * 100)?.toFixed(1)}% meets A-grade floor (${A_GRADE_MIN_QUALITY * 100}%)`);
}
console.log();

// -----------------------------------------------------------------------------
// Test 2: Clean PUT trend + pullback + continuation -> signal
// -----------------------------------------------------------------------------
console.log(`Test 2: Clean PUT trend + pullback + continuation -> signal`);
{
  const now = Date.now();
  const bars = createBars({
    count: 180,
    direction: "PUT",
    withPullback: true,
    withContinuation: true,
    extensionAtr: 0.7,
    now
  });
  const lastPrice = Number(bars.at(-1).c);
  const ticks = createTicks({ lastPrice, direction: "PUT", count: 18, now, aligned: true });

  const seq = setupSequenceSnapshot(bars);
  assert(seq.ready && seq.direction === "PUT", `Sequence detects PUT trend (direction: ${seq.direction})`);
  assert(seq.structureOk, "Structure is intact (fractal resistance held)");

  const pre = preAlert5m(ticks, bars, "EUR/USD", "PUT");
  console.log("TEST 2 PRE:", pre);
  assert(pre.ok, `preAlert5m qualifies PUT setup (preScore: ${pre.preScore?.toFixed(3)})`);

  const score = score5m(ticks, bars, "EUR/USD");
  assert(score.ok && score.direction === "PUT", `score5m produces PUT signal (ok: ${score.ok}, grade: ${score.grade}, quality: ${(score.quality * 100)?.toFixed(1)}%)`);
  assert(score.quality >= A_GRADE_MIN_QUALITY, `Signal quality ${(score.quality * 100)?.toFixed(1)}% meets A-grade floor`);
}
console.log();

// -----------------------------------------------------------------------------
// Test 3: Structural reversal -> reject / cancel
// -----------------------------------------------------------------------------
console.log(`Test 3: Structural reversal -> reject / cancel`);
{
  const now = Date.now();
  // 3a. Fractal support broken
  const brokenFractalBars = createBars({
    count: 120,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    breakFractal: true,
    now
  });
  const lastPrice1 = Number(brokenFractalBars.at(-1).c);
  const ticks1 = createTicks({ lastPrice: lastPrice1, direction: "CALL", count: 18, now, aligned: true });

  const seqBroken = setupSequenceSnapshot(brokenFractalBars);
  assert(!seqBroken.structureOk, "Fractal break detected in setup sequence (structureOk is false)");

  const scoreBroken = score5m(ticks1, brokenFractalBars, "EUR/USD");
  assert(
    !scoreBroken.ok &&
    classifyBlocker(scoreBroken.reason) === "core_structure",
    `score5m rejects structurally invalid setup (reason: "${scoreBroken.reason}")`
  );

  // 3b. 5m trend reversed
  const reversedBars = createBars({
    count: 120,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    reverseTrend: true,
    now
  });
  const lastPrice2 = Number(reversedBars.at(-1).c);
  const ticks2 = createTicks({ lastPrice: lastPrice2, direction: "CALL", count: 18, now, aligned: true });

  const scoreReversed = score5m(ticks2, reversedBars, "EUR/USD");
  assert(!scoreReversed.ok, `score5m rejects when 5m trend reverses (reason: "${scoreReversed.reason}")`);
}
console.log();

// -----------------------------------------------------------------------------
// Test 4: Temporary momentum fade -> preserve setup
// -----------------------------------------------------------------------------
console.log(`Test 4: Temporary momentum fade -> preserve setup`);
{
  const now = Date.now();
  const bars = createBars({
    count: 180,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    now
  });
  const lastPrice = Number(bars.at(-1).c);
  // Unaligned ticks (temporary momentum hesitation)
  const flatTicks = createTicks({
    lastPrice,
    direction: "CALL",
    count: 18,
    now,
    aligned: false
  });

  const score = score5m(flatTicks, bars, "EUR/USD");
  assert(!score.ok, `score5m pauses entry during tick hesitation (reason: "${score.reason}")`);

  // Classification must identify this as transient timing, NOT hard invalidation
  const category = classifyBlocker(score.reason);
  assert(category === "transient_timing" || category === "supporting_confirmation", `Blocker classified as transient/supporting: "${category}"`);
}
console.log();

// -----------------------------------------------------------------------------
// Test 5: Controlled extension after pullback -> can still signal
// -----------------------------------------------------------------------------
console.log(`Test 5: Controlled extension after pullback -> can still signal`);
{
  const now = Date.now();
  // Post-pullback expansion at 1.85 ATR (well above 1.60 old limit, but within 2.50 limit)
  const bars = createBars({
    count: 180,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    extensionAtr: 1.45,
    now
  });
  const lastPrice = Number(bars.at(-1).c);
  const ticks = createTicks({ lastPrice, direction: "CALL", count: 18, now, aligned: true });

  const pre = preAlert5m(ticks, bars, "EUR/USD", "CALL");
  assert(pre.ok, `preAlert5m allows post-pullback expansion up to 2.50 ATR (preScore: ${pre.preScore?.toFixed(3)}, distanceFast: ${pre.distanceFastAtr?.toFixed(2)} ATR)`);

  const score = score5m(ticks, bars, "EUR/USD");
  console.log("TEST 2 SCORE:", score);
  assert(score.ok, `score5m permits controlled post-pullback entry (distanceFastAtr: ${score.distanceFastAtr?.toFixed(2)} ATR, quality: ${(score.quality * 100)?.toFixed(1)}%)`);
}
console.log();

// -----------------------------------------------------------------------------
// Test 6: Final conditions already satisfied in PREPARE -> signal in same scan
// -----------------------------------------------------------------------------
console.log(`Test 6: Final conditions already satisfied in PREPARE -> signal in same scan`);
{
  const now = Date.now();
  const bars = createBars({
    count: 180,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    extensionAtr: 0.8,
    now
  });
  const lastPrice = Number(bars.at(-1).c);
  const ticks = createTicks({ lastPrice, direction: "CALL", count: 18, now, aligned: true });

  const storage = new MockStorage();
  const ctx = new MockCtx(storage);
  const hub = new TickHub(ctx, { WS_SYMBOLS: "EUR/USD" });
  await ctx.waitForInit();

  // Deterministic replay: do not contact Tiingo.
  hub.subscribe = async () => true;
  hub.ensureSocket = async () => true;
  hub.refreshIfStale = async () => true;
  hub.fetchOneMinuteBars = async () => bars;
  hub.lastStatus = "test-live";

  // Simulate ticks pushed into TickHub
  for (const t of ticks) {
    hub.pushTick("EUR/USD", t.t, t.p, t.bid, t.ask);
  }
  // Populate oneMinuteCache
  hub.oneMinuteCache.set("EUR/USD", { at: now, bars });
  const lastBarT = Number(bars.at(-1).t);

  hub.setupStates["EUR/USD"] = {
    stage: "PREPARE",
    direction: "CALL",
    lastBarT,
    setupCandleT: lastBarT,
    prepareAt: Date.now(),
    readyKey: `EUR/USD|CALL|${lastBarT}`,
    internalPrepare: true,
    updatedAt: Date.now()
  };

  await ctx.storage.put("setupStates", hub.setupStates);

  // Advance state: starts in SEEK -> ARMED -> PULLBACK -> PREPARE -> immediate evaluation
  const result = await hub.analyze("EUR/USD");
  console.log("TEST 6 ANALYZE FULL RESULT:", result);
  assert(result.ok && result.grade === "A" && result.direction === "CALL", `analyze() signals immediately in same scan (ok: ${result.ok}, grade: ${result.grade}, stage: ${result.setupStage})`);
}
console.log();

// -----------------------------------------------------------------------------
// Test 7: Tiingo context survives Durable Object sleep/restart
// -----------------------------------------------------------------------------
console.log(`Test 7: Tiingo context survives Durable Object sleep/restart`);
{
  const now = Date.now();
  const bars = createBars({ count: 90, direction: "CALL", now });
  const storage = new MockStorage();

  // Instance 1: runs and saves context
  const ctx1 = new MockCtx(storage);
  const hub1 = new TickHub(ctx1, { WS_SYMBOLS: "EUR/USD" });
  hub1.oneMinuteCache.set("EUR/USD", { at: now, bars });
  hub1.oneMinuteCacheDirty = true;
  await hub1.closeFeeds("simulated sleep");

  // Verify storage contains persisted cache
  const persisted = await storage.get("oneMinuteCacheData");
  assert(persisted && persisted["EUR/USD"] && persisted["EUR/USD"].bars.length === 90, "oneMinuteCacheData persisted to storage on sleep");

  // Instance 2: simulated restart from persisted storage
  const ctx2 = new MockCtx(storage);
  const hub2 = new TickHub(ctx2, { WS_SYMBOLS: "EUR/USD" });

  await ctx2.waitForInit();

  const restored = hub2.oneMinuteCache.get("EUR/USD");
  assert(restored && restored.bars.length === 90, `Restored oneMinuteCache contains ${restored?.bars?.length} bars without calling REST`);
  assert(hub2.contextIsUsable(restored.bars), "Restored context is usable immediately for indicators");
}
console.log();

// -----------------------------------------------------------------------------
// Test 8: Blocker instrumentation (/blockerstats)
// -----------------------------------------------------------------------------
console.log(`Test 8: Blocker instrumentation (/blockerstats)`);
{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);
  const hub = new TickHub(ctx, { WS_SYMBOLS: "EUR/USD" });

  // Record diverse blockers
  await hub.recordBlocker("EUR/USD", "Fractal(2) support failed");
  await hub.recordBlocker("USD/JPY", "waiting for a clean completed 5m trend");
  await hub.recordBlocker("GBP/USD", "fresh completed 1m continuation candle is missing");
  await hub.recordBlocker("USD/CAD", "live tick flow is reversing against the setup");
  await hub.recordBlocker("AUD/USD", "entry extension 2.80 ATR exceeds the 2.50 ATR five-minute limit");
  await hub.recordBlocker("USD/CHF", "pair cooldown active");
  await hub.recordBlocker(
    "USD/JPY",
    "5m efficiency 0.185 below 0.200"
  );

  await hub.recordBlocker(
    "EUR/USD",
    "trend armed — waiting for the next pullback into the SMA zone"
  );

  const stats = await hub.getBlockerStats();
  assert(stats.ok, "getBlockerStats returns ok");
  assert(stats.totalEvaluations === 8, `Total evaluations recorded: ${stats.totalEvaluations}`);
  assert(stats.byCategory.core_structure >= 1, `Core structure failures counted: ${stats.byCategory.core_structure}`);
  assert(stats.byCategory.supporting_confirmation >= 1, `Supporting confirmation failures counted: ${stats.byCategory.supporting_confirmation}`);
  assert(stats.byCategory.transient_timing >= 1, `Transient timing failures counted: ${stats.byCategory.transient_timing}`);
  assert(stats.byCategory.redundant_gate >= 1, `Redundant gate failures counted: ${stats.byCategory.redundant_gate}`);
  assert(stats.byCategory.risk_cooldown >= 1, `Risk/cooldown failures counted: ${stats.byCategory.risk_cooldown}`);
  assert(
    stats.efficiencyFineBands.near_180_189 === 1,
    `0.180–0.189 efficiency band counted: ${stats.efficiencyFineBands.near_180_189}`
  );
  assert(
    stats.efficiencyBands.near_qualified === 1,
    `Near-qualified efficiency failures counted: ${stats.efficiencyBands.near_qualified}`
  );
  assert(
    stats.byCategory.setup_progression >= 1,
    `Setup progression counted: ${stats.byCategory.setup_progression}`
  );

  const formatted = hub.formatBlockerStatsMessage(stats);
  assert(formatted.includes("BLOCKER STATS"), "Formatted message includes header");
  assert(formatted.includes("Core Structure"), "Formatted message includes categories");
}
console.log();

// -----------------------------------------------------------------------------
// Test 9: Short-expiry shadow statistics
// -----------------------------------------------------------------------------
console.log(`Test 9: Short-expiry shadow statistics`);
{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);
  const hub = new TickHub(ctx, { WS_SYMBOLS: "EUR/USD" });
  const clusterBase = Date.now() - 10 * 60000;

  hub.shortShadowState = {
    strategyId: SHORT_SHADOW_ID,
    startedAt: Date.now(),
    pending: [
      {
        id: "pending-1",
        symbol: "EUR/USD",
        direction: "CALL"
      }
    ],
    history: [
      {
        symbol: "EUR/USD",
        result60: "WIN",
        result120: "WIN",
        entryAt: clusterBase
      },
      {
        symbol: "GBP/USD",
        result60: "LOSS",
        result120: "WIN",
        entryAt: clusterBase
      },
      {
        symbol: "USD/JPY",
        result60: "DRAW",
        result120: "LOSS",
        entryAt: clusterBase + 60000
      }
    ]
  };

  const stats = await hub.getShortShadowStats();

  assert(stats.ok, "Short-shadow stats return ok");

  assert(
    stats.strategyId === SHORT_SHADOW_ID,
    "Short-shadow strategy ID is isolated"
  );

  assert(
    stats.pending === 1,
    `Short-shadow pending count: ${stats.pending}`
  );

  assert(
    stats.expiry60.settled === 3,
    `60s settled count: ${stats.expiry60.settled}`
  );

  assert(
    stats.expiry60.wins === 1 &&
    stats.expiry60.losses === 1 &&
    stats.expiry60.draws === 1,
    "60s outcomes counted correctly"
  );

  assert(
    Math.abs(stats.expiry60.winRate - 50) < 0.001,
    `60s W/L win rate: ${stats.expiry60.winRate}`
  );

  assert(
    stats.expiry120.settled === 3,
    `120s settled count: ${stats.expiry120.settled}`
  );

  assert(
    stats.expiry120.wins === 2 &&
    stats.expiry120.losses === 1 &&
    stats.expiry120.draws === 0,
    "120s outcomes counted correctly"
  );

  assert(
    Math.abs(stats.expiry120.winRate - (2 / 3) * 100) < 0.001,
    `120s W/L win rate: ${stats.expiry120.winRate}`
  );

  assert(
    stats.clusterAdjusted.expiry60.settledClusters === 2,
    `60s cluster-adjusted settled clusters: ${stats.clusterAdjusted.expiry60.settledClusters}`
  );

  assert(
    Math.abs(
      stats.clusterAdjusted.expiry60.equalClusterWinRate - 50
    ) < 0.001,
    `60s equal-cluster win rate: ${stats.clusterAdjusted.expiry60.equalClusterWinRate}`
  );

  assert(
    stats.clusterAdjusted.expiry120.scoredClusters === 2,
    `120s scored clusters: ${stats.clusterAdjusted.expiry120.scoredClusters}`
  );

  assert(
    Math.abs(
      stats.clusterAdjusted.expiry120.equalClusterWinRate - 50
    ) < 0.001,
    `120s equal-cluster win rate: ${stats.clusterAdjusted.expiry120.equalClusterWinRate}`
  );

  assert(
    stats.evidence.settledClusters === 1,
    `Evidence counter sees 1 fully scored cluster: ${stats.evidence.settledClusters}`
  );

  assert(
    stats.evidence.minimumTarget === 50 &&
    stats.evidence.preferredTarget === 100,
    "Evidence targets are 50 minimum and 100 preferred clusters"
  );

  assert(
    Math.abs(
      stats.evidence.minimumProgressPct - 2
    ) < 0.001,
    `Minimum evidence progress: ${stats.evidence.minimumProgressPct}%`
  );

  assert(
    stats.evidence.status === "collecting",
    `Evidence status is collecting: ${stats.evidence.status}`
  );
}
console.log();

// -----------------------------------------------------------------------------
// Test 10: Short-expiry dual settlement
// -----------------------------------------------------------------------------
console.log(`Test 10: Short-expiry dual settlement`);
{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);
  const hub = new TickHub(ctx, {
    WS_SYMBOLS: "EUR/USD"
  });

  const entryAt = Date.now() - 121000;

  const captured =
    await hub.captureShortShadow({
      symbol: "EUR/USD",
      direction: "CALL",
      entryPrice: 1.10000,
      entryAt,
      sourceKey: "short-test-1",
      features: {
        test: true
      }
    });

  assert(
    captured.ok,
    "Short-shadow setup captured"
  );

  assert(
    captured.expiry60At - entryAt === 60000,
    "60s expiry scheduled correctly"
  );

  assert(
    captured.expiry120At - entryAt === 120000,
    "120s expiry scheduled correctly"
  );

  hub.ticks.set("EUR/USD", [
    {
      t: entryAt + 60100,
      r: entryAt + 60100,
      p: 1.10100
    },
    {
      t: entryAt + 120100,
      r: entryAt + 120100,
      p: 1.09900
    }
  ]);

  const settled =
    await hub.settleShortShadow(
      entryAt + 121000
    );

  assert(
    settled.completed === 1,
    "Both expiries completed"
  );

  const stats =
    await hub.getShortShadowStats();

  assert(
    stats.pending === 0,
    "Completed setup removed from pending"
  );

  assert(
    stats.expiry60.wins === 1,
    "CALL wins at 60 seconds"
  );

  assert(
    stats.expiry120.losses === 1,
    "Same CALL loses at 120 seconds"
  );

  assert(
    stats.recent.length === 1,
    "Completed setup stored in history"
  );
}
console.log();

// -----------------------------------------------------------------------------
// Test 11: Short-expiry alarm scheduling
// -----------------------------------------------------------------------------
console.log(`Test 11: Short-expiry alarm scheduling`);
{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);

  const hub = new TickHub(ctx, {
    WS_SYMBOLS: "EUR/USD"
  });

  await ctx.waitForInit();

  const now = Date.now();

  hub.pendingSignals = [];

  hub.shortShadowState = {
    strategyId: SHORT_SHADOW_ID,
    startedAt: now,
    history: [],
    pending: [
      {
        id: "alarm-short-1",
        symbol: "EUR/USD",
        direction: "CALL",
        entryPrice: 1.10000,
        entryAt: now,
        expiry60At: now + 60000,
        expiry120At: now + 120000,
        result60: null,
        result120: null
      }
    ]
  };

  await hub.scheduleAlarm();

  const firstAlarm =
    await storage.getAlarm();

  assert(
    Number.isFinite(firstAlarm),
    "Short-shadow pending setup creates an alarm"
  );

  assert(
    firstAlarm >= now + 59000 &&
    firstAlarm <= now + 61000,
    "First alarm targets the 60-second expiry"
  );

  hub.shortShadowState.pending[0].result60 =
    "WIN";

  await hub.scheduleAlarm();

  const secondAlarm =
    await storage.getAlarm();

  assert(
    secondAlarm >= now + 119000 &&
    secondAlarm <= now + 121000,
    "After 60s settlement, alarm advances to 120s expiry"
  );

  hub.shortShadowState.pending = [];

  await hub.scheduleAlarm();

  assert(
    (await storage.getAlarm()) === null,
    "Alarm clears when no normal or short-expiry settlements remain"
  );
}
console.log();

// -----------------------------------------------------------------------------
// Test 12: Short-expiry directional detector
// -----------------------------------------------------------------------------
console.log(`Test 12: Short-expiry directional detector`);
{
  const now = Date.now();

  const callBars = createBars({
    count: 90,
    direction: "CALL",
    withPullback: true,
    withContinuation: true,
    now
  });

  const callTicks = createTicks({
    lastPrice: Number(callBars.at(-1).c),
    direction: "CALL",
    count: 24,
    aligned: true,
    now
  });

  const call =
    scoreShortExpiryShadow(
      callTicks,
      callBars,
      "EUR/USD"
    );

  assert(
    call.ok,
    `Short-expiry CALL qualifies: ${call.reason || "qualified"}`
  );

  assert(
    call.direction === "CALL",
    `Short-expiry direction CALL: ${call.direction}`
  );

  assert(
    Array.isArray(call.expiryCandidates) &&
    call.expiryCandidates.includes(60) &&
    call.expiryCandidates.includes(120),
    "Short detector evaluates both 60s and 120s"
  );

  assert(
    call.quality >= 0.86,
    `Short CALL quality: ${call.quality}`
  );

  const putBars = createBars({
    count: 90,
    direction: "PUT",
    withPullback: true,
    withContinuation: true,
    now
  });

  const putTicks = createTicks({
    lastPrice: Number(putBars.at(-1).c),
    direction: "PUT",
    count: 24,
    aligned: true,
    now
  });

  const put =
    scoreShortExpiryShadow(
      putTicks,
      putBars,
      "GBP/USD"
    );

  assert(
    put.ok,
    `Short-expiry PUT qualifies: ${put.reason || "qualified"}`
  );

  assert(
    put.direction === "PUT",
    `Short-expiry direction PUT: ${put.direction}`
  );
}
console.log();

// -----------------------------------------------------------------------------
// Test 13: Cruz Ichimoku + DMI configuration
// -----------------------------------------------------------------------------
console.log("Test 13: Cruz Ichimoku + DMI configuration");

{
  const now = Date.now();

  const makeTrendBars = direction => {
    const bars = [];
    let price = 1.10000;

    const step =
      direction === "CALL"
        ? 0.00010
        : -0.00010;

    for (let i = 0; i < 60; i++) {
      const o = price;
      const c = price + step;

      const h =
        Math.max(o, c) + 0.00004;

      const l =
        Math.min(o, c) - 0.00004;

      bars.push({
        t: now - (60 - i) * 60000,
        o,
        h,
        l,
        c,
        n: 20
      });

      price = c;
    }

    return bars;
  };

  const callBars =
    makeTrendBars("CALL");

  const putBars =
    makeTrendBars("PUT");

  const callIchi =
    cruzIchimokuSnapshot(callBars);

  const putIchi =
    cruzIchimokuSnapshot(putBars);

  const callDmi =
    cruzDmiSnapshot(callBars);

  const putDmi =
    cruzDmiSnapshot(putBars);

  assert(
    callIchi.ready,
    "Cruz Ichimoku CALL context ready"
  );

  assert(
    putIchi.ready,
    "Cruz Ichimoku PUT context ready"
  );

  assert(
    callIchi.tenkan > callIchi.kijun,
    "Bull trend has Tenkan above Kijun"
  );

  assert(
    putIchi.tenkan < putIchi.kijun,
    "Bear trend has Tenkan below Kijun"
  );

  assert(
    callIchi.tenkanPeriod === 5 &&
    callIchi.kijunPeriod === 10 &&
    callIchi.spanBPeriod === 20,
    "Cruz Ichimoku uses 5/10/20"
  );

  assert(
    callDmi.ready &&
    callDmi.plusDI > callDmi.minusDI,
    "Bull trend produces +DI dominance"
  );

  assert(
    putDmi.ready &&
    putDmi.minusDI > putDmi.plusDI,
    "Bear trend produces -DI dominance"
  );

  assert(
    callDmi.diLength === 7 &&
    callDmi.adxSmoothing === 14,
    "Cruz DMI uses DI 7 / ADX smoothing 14"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 14: Cruz 1-minute BUY / SELL trigger
// -----------------------------------------------------------------------------
console.log("Test 14: Cruz 1-minute BUY / SELL trigger");

{
  const now = Date.now();

  const makeCruzTriggerBars = direction => {
    const bars = [];
    let price = 1.10000;

    // Build the market in the opposite direction first.
    // The final candle then creates the fresh DI crossover
    // and Ichimoku breakout visible in the Cruz examples.
    const baseStep =
      direction === "CALL"
        ? -0.00005
        : 0.00005;

    for (let i = 0; i < 59; i++) {
      const o = price;
      const c = price + baseStep;

      bars.push({
        t: now - (60 - i) * 60000,
        o,
        h: Math.max(o, c) + 0.00003,
        l: Math.min(o, c) - 0.00003,
        c,
        n: 20
      });

      price = c;
    }

    // Strong reversal/breakout candle.
    const finalMove =
      direction === "CALL"
        ? 0.00050
        : -0.00050;

    const o = price;
    const c = price + finalMove;

    bars.push({
      t: now - 60000,
      o,
      h: Math.max(o, c) + 0.00003,
      l: Math.min(o, c) - 0.00003,
      c,
      n: 30
    });

    return bars;
  };


  // -------------------------------------------------
  // CALL
  // -------------------------------------------------

  const callBars =
    makeCruzTriggerBars("CALL");

  const callTicks =
    createTicks({
      lastPrice:
        Number(callBars.at(-1).c),

      direction: "CALL",
      count: 24,
      aligned: true,
      now
    });

  const call =
    scoreCruz1mShadow(
      callTicks,
      callBars,
      "EUR/USD"
    );

  console.log(
    "CRUZ CALL RESULT:",
    call
  );

  assert(
    call.ok &&
    call.direction === "CALL",
    `Cruz detector produces CALL (${call.reason || "qualified"})`
  );

  assert(
    call.dmi?.crossUp === true,
    "+DI freshly crosses above -DI for CALL"
  );

  assert(
    call.trigger?.bullishSpanBBreak === true ||
    call.trigger?.bullishCloudBreak === true,
    "CALL candle breaks/reclaims Ichimoku boundary"
  );


  // -------------------------------------------------
  // PUT
  // -------------------------------------------------

  const putBars =
    makeCruzTriggerBars("PUT");

  const putTicks =
    createTicks({
      lastPrice:
        Number(putBars.at(-1).c),

      direction: "PUT",
      count: 24,
      aligned: true,
      now
    });

  const put =
    scoreCruz1mShadow(
      putTicks,
      putBars,
      "GBP/USD"
    );

  console.log(
    "CRUZ PUT RESULT:",
    put
  );

  assert(
    put.ok &&
    put.direction === "PUT",
    `Cruz detector produces PUT (${put.reason || "qualified"})`
  );

  assert(
    put.dmi?.crossDown === true,
    "-DI freshly crosses above +DI for PUT"
  );

  assert(
    put.trigger?.bearishSpanBBreak === true ||
    put.trigger?.bearishCloudBreak === true,
    "PUT candle breaks below Ichimoku boundary"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 15: Cruz detector integrates with short-shadow capture
// -----------------------------------------------------------------------------
console.log("Test 15: Cruz detector integrates with short-shadow capture");

{
  const now = Date.now();

  const bars = [];
  let price = 1.10000;

  // Build bearish pressure first.
  for (let i = 0; i < 59; i++) {
    const o = price;
    const c = price - 0.00005;

    bars.push({
      t: now - (60 - i) * 60000,
      o,
      h: Math.max(o, c) + 0.00003,
      l: Math.min(o, c) - 0.00003,
      c,
      n: 20
    });

    price = c;
  }

  // Strong bullish Cruz reversal / breakout candle.
  {
    const o = price;
    const c = price + 0.00050;

    bars.push({
      t: now - 60000,
      o,
      h: c + 0.00003,
      l: o - 0.00003,
      c,
      n: 30
    });
  }

  const ticks = createTicks({
    lastPrice: Number(bars.at(-1).c),
    direction: "CALL",
    count: 24,
    aligned: true,
    now
  });

  const storage = new MockStorage();
  const ctx = new MockCtx(storage);

  const hub = new TickHub(ctx, {
    WS_SYMBOLS: "EUR/USD"
  });

  await ctx.waitForInit();

  // No external network calls during deterministic test.
  hub.subscribe = async () => true;
  hub.ensureSocket = async () => true;
  hub.refreshIfStale = async () => true;
  hub.fetchOneMinuteBars = async () => bars;

  for (const tick of ticks) {
    hub.pushTick(
      "EUR/USD",
      tick.t,
      tick.p,
      tick.bid,
      tick.ask
    );
  }

  const result =
    await hub.evaluateShortShadow(
      "EUR/USD"
    );

  assert(
    result.ok &&
    result.captured === true &&
    result.direction === "CALL",
    "Cruz CALL is captured by autonomous short-shadow evaluator"
  );

  assert(
    hub.shortShadowState.pending.length === 1,
    "Captured Cruz setup enters pending settlement queue"
  );

  const record =
    hub.shortShadowState.pending[0];

  assert(
    record.strategyId === SHORT_SHADOW_ID,
    "Captured setup uses current Cruz shadow strategy ID"
  );

  assert(
    record.features?.model ===
    "cruz-1m-ichimoku-dmi",
    "Captured setup records Cruz model identity"
  );

  assert(
    record.features?.ichimoku?.tenkanPeriod === 5 &&
    record.features?.ichimoku?.kijunPeriod === 10 &&
    record.features?.ichimoku?.spanBPeriod === 20 &&
    record.features?.dmi?.diLength === 7 &&
    record.features?.dmi?.adxSmoothing === 14,
    "Captured setup preserves Cruz 5/10/20 Ichimoku and 7/14 DMI settings"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 16: Cruz universe remains separate from 5-minute universe
// -----------------------------------------------------------------------------
console.log("Test 16: Cruz universe separation");

{
  assert(
    FIXED_UNIVERSE.length === 6,
    `5-minute universe remains 6 pairs (${FIXED_UNIVERSE.length})`
  );

  assert(
    SHORT_SHADOW_UNIVERSE.length === 12,
    `Cruz short-shadow universe contains 12 pairs (${SHORT_SHADOW_UNIVERSE.length})`
  );

  assert(
    SHORT_SHADOW_UNIVERSE.every(
      symbol =>
        FIXED_UNIVERSE.includes(symbol) ||
        [
          "NZD/USD",
          "EUR/JPY",
          "GBP/JPY",
          "EUR/GBP",
          "AUD/JPY",
          "CAD/JPY"
        ].includes(symbol)
    ),
    "Cruz universe contains only approved FX pairs"
  );

  assert(
    !FIXED_UNIVERSE.includes("GBP/JPY") &&
    SHORT_SHADOW_UNIVERSE.includes("GBP/JPY"),
    "Additional Cruz pairs do not leak into 5-minute universe"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 17: Cruz UTC market-window statistics
// -----------------------------------------------------------------------------
console.log("Test 17: Cruz UTC market-window statistics");

{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);
  const hub = new TickHub(ctx, {
    WS_SYMBOLS: "EUR/USD"
  });

  await ctx.waitForInit();

  const day = {
    asia:
      Date.UTC(2026, 8, 30, 2, 0, 0),

    london:
      Date.UTC(2026, 8, 30, 9, 0, 0),

    overlap:
      Date.UTC(2026, 8, 30, 14, 0, 0),

    newYork:
      Date.UTC(2026, 8, 30, 18, 0, 0),

    late:
      Date.UTC(2026, 8, 30, 22, 0, 0)
  };

  hub.shortShadowState = {
    strategyId: SHORT_SHADOW_ID,
    startedAt:
      Date.UTC(2026, 8, 30, 0, 0, 0),

    pending: [],

    history: [
      {
        symbol: "USD/JPY",
        direction: "CALL",
        entryAt: day.asia,
        result60: "WIN",
        result120: "WIN"
      },

      {
        symbol: "GBP/USD",
        direction: "PUT",
        entryAt: day.london,
        result60: "WIN",
        result120: "LOSS"
      },

      {
        symbol: "EUR/USD",
        direction: "CALL",
        entryAt: day.overlap,
        result60: "LOSS",
        result120: "WIN"
      },

      {
        symbol: "USD/CAD",
        direction: "PUT",
        entryAt: day.newYork,
        result60: "WIN",
        result120: "WIN"
      },

      {
        symbol: "AUD/USD",
        direction: "CALL",
        entryAt: day.late,
        result60: "LOSS",
        result120: "LOSS"
      }
    ]
  };

  const stats =
    await hub.getShortShadowStats();


  assert(
    stats.bySession.ASIA.expiry60.settled === 1,
    "02:00 UTC is classified into ASIA"
  );

  assert(
    stats.bySession.LONDON.expiry60.settled === 1,
    "09:00 UTC is classified into LONDON"
  );

  assert(
    stats.bySession.OVERLAP.expiry60.settled === 1,
    "14:00 UTC is classified into OVERLAP"
  );

  assert(
    stats.bySession.NEW_YORK.expiry60.settled === 1,
    "18:00 UTC is classified into NEW_YORK"
  );

  assert(
    stats.bySession.LATE.expiry60.settled === 1,
    "22:00 UTC is classified into LATE"
  );

  assert(
    stats.clusterAdjustedBySession.ASIA
      .expiry60.settledClusters === 1 &&
    Math.abs(
      stats.clusterAdjustedBySession.ASIA
        .expiry60.equalClusterWinRate - 100
    ) < 0.001,
    "ASIA cluster-adjusted 60s result is isolated correctly"
  );

  assert(
    stats.clusterAdjustedBySession.LONDON
      .expiry120.settledClusters === 1 &&
    Math.abs(
      stats.clusterAdjustedBySession.LONDON
        .expiry120.equalClusterWinRate - 0
    ) < 0.001,
    "LONDON cluster-adjusted 120s result is isolated correctly"
  );

  assert(
    stats.clusterAdjustedBySession.OVERLAP
      .expiry60.settledClusters === 1 &&
    Math.abs(
      stats.clusterAdjustedBySession.OVERLAP
        .expiry60.equalClusterWinRate - 0
    ) < 0.001,
    "OVERLAP cluster-adjusted 60s result is isolated correctly"
  );

  assert(
    stats.clusterAdjustedBySession.NEW_YORK
      .expiry120.settledClusters === 1 &&
    Math.abs(
      stats.clusterAdjustedBySession.NEW_YORK
        .expiry120.equalClusterWinRate - 100
    ) < 0.001,
    "NEW YORK cluster-adjusted 120s result is isolated correctly"
  );

  assert(
    stats.clusterAdjustedBySession.LATE
      .expiry60.settledClusters === 1 &&
    Math.abs(
      stats.clusterAdjustedBySession.LATE
        .expiry60.equalClusterWinRate - 0
    ) < 0.001,
    "LATE cluster-adjusted 60s result is isolated correctly"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 18: Failed settlement snapshot must not strand short-expiry records
// -----------------------------------------------------------------------------
console.log(
  "Test 18: Failed settlement snapshot cannot strand short-expiry records"
);

{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);

  const hub = new TickHub(ctx, {
    WS_SYMBOLS: "EUR/USD"
  });

  await ctx.waitForInit();

  const now = Date.now();

  hub.shortShadowState = {
    strategyId: SHORT_SHADOW_ID,
    startedAt: now - 300000,

    pending: [
      {
        id: "snapshot-failure-test",
        sourceKey: "snapshot-failure-test",
        strategyId: SHORT_SHADOW_ID,

        symbol: "EUR/USD",
        direction: "CALL",

        entryPrice: 1.1000,
        entryAt: now - 180000,

        expiry60At: now - 120000,
        expiry120At: now - 60000,

        result60: null,
        result120: null,

        exit60Price: null,
        exit120Price: null,

        exit60TickAt: null,
        exit120TickAt: null
      }
    ],

    history: []
  };

  await storage.put(
    "shortShadowState",
    hub.shortShadowState
  );


  let snapshotAttempted = false;

  hub.fetchTopSnapshots =
    async () => {
      snapshotAttempted = true;

      throw new Error(
        "synthetic settlement snapshot failure"
      );
    };


  await hub.alarm();


  assert(
    snapshotAttempted,
    "Settlement snapshot failure path was exercised"
  );

  assert(
    hub.shortShadowState.pending.length === 0,
    "Overdue short-expiry record is not left pending after snapshot failure"
  );

  assert(
    hub.shortShadowState.history.length === 1,
    "Completed overdue record moves into short-shadow history"
  );

  assert(
    hub.shortShadowState.history[0].result60 === "VOID" &&
    hub.shortShadowState.history[0].result120 === "VOID",
    "Both overdue expiries settle VOID when no expiry tick is available"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 19: Scheduler settlement endpoint clears overdue short-expiry records
// -----------------------------------------------------------------------------
console.log(
  "Test 19: Scheduler settlement endpoint clears overdue short-expiry records"
);

{
  const storage = new MockStorage();
  const ctx = new MockCtx(storage);

  const hub = new TickHub(ctx, {
    WS_SYMBOLS: "EUR/USD"
  });

  await ctx.waitForInit();

  const now = Date.now();

  hub.shortShadowState = {
    strategyId: SHORT_SHADOW_ID,
    startedAt: now - 300000,

    pending: [
      {
        id: "scheduler-settlement-test",
        sourceKey: "scheduler-settlement-test",
        strategyId: SHORT_SHADOW_ID,

        symbol: "EUR/USD",
        direction: "CALL",

        entryPrice: 1.1000,
        entryAt: now - 180000,

        expiry60At: now - 120000,
        expiry120At: now - 60000,

        result60: null,
        result120: null,

        exit60Price: null,
        exit120Price: null,

        exit60TickAt: null,
        exit120TickAt: null
      }
    ],

    history: []
  };

  await storage.put(
    "shortShadowState",
    hub.shortShadowState
  );

  const response =
    await hub.fetch(
      new Request(
        "https://tickhub/settle-short-shadow"
      )
    );

  const result =
    await response.json();

  assert(
    result.ok === true,
    "Scheduler settlement endpoint returns ok"
  );

  assert(
    result.completed === 1,
    "Scheduler settlement endpoint completes overdue record"
  );

  assert(
    hub.shortShadowState.pending.length === 0,
    "Scheduler settlement endpoint clears overdue pending record"
  );

  assert(
    hub.shortShadowState.history.length === 1 &&
    hub.shortShadowState.history[0].result60 === "VOID" &&
    hub.shortShadowState.history[0].result120 === "VOID",
    "Scheduler settlement endpoint moves overdue record to history as VOID"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 20: Cruz V2 Aroon(10) crossover detection
// -----------------------------------------------------------------------------
console.log(
  "Test 20: Cruz V2 Aroon(10) crossover detection"
);

{
  const makeBar = (
    t,
    high,
    low,
    close = (high + low) / 2
  ) => ({
    t,
    o: close,
    h: high,
    l: low,
    c: close,
    n: 10
  });

  const start =
    Date.UTC(
      2026,
      9,
      1,
      12,
      0,
      0
    );


  // -------------------------------------------------
  // CALL crossover:
  // Previous window:
  // old high dominates + fresh low -> Down > Up
  //
  // Current window:
  // old high drops out + new high arrives
  // -> Up crosses above Down
  // -------------------------------------------------

  const callBars = [];

  callBars.push(
    makeBar(
      start,
      1.1100,
      1.1000
    )
  );

  for (let i = 1; i <= 9; i++) {
    callBars.push(
      makeBar(
        start + i * 30000,
        1.1050 + i * 0.00001,
        1.1010 + i * 0.00001
      )
    );
  }

  callBars.push(
    makeBar(
      start + 10 * 30000,
      1.1055,
      1.0990
    )
  );

  callBars.push(
    makeBar(
      start + 11 * 30000,
      1.1080,
      1.1020
    )
  );


  const callAroon =
    cruzAroonSnapshot(
      callBars,
      10
    );


  assert(
    callAroon.ready === true &&
    callAroon.period === 10,
    "Cruz V2 Aroon(10) becomes ready with sufficient 30s bars"
  );

  assert(
    callAroon.crossUp === true &&
    callAroon.crossDown === false,
    `Aroon-Up fresh bullish crossover detected (${callAroon.up.toFixed(1)} vs ${callAroon.down.toFixed(1)})`
  );


  // -------------------------------------------------
  // PUT crossover:
  // Previous window:
  // fresh high + old low -> Up > Down
  //
  // Current window:
  // old low drops out + new low arrives
  // -> Down crosses above Up
  // -------------------------------------------------

  const putBars = [];

  putBars.push(
    makeBar(
      start,
      1.1050,
      1.0950
    )
  );

  for (let i = 1; i <= 9; i++) {
    putBars.push(
      makeBar(
        start + i * 30000,
        1.1020 + i * 0.00001,
        1.0980 + i * 0.00001
      )
    );
  }

  putBars.push(
    makeBar(
      start + 10 * 30000,
      1.1080,
      1.0985
    )
  );

  putBars.push(
    makeBar(
      start + 11 * 30000,
      1.1030,
      1.0940
    )
  );


  const putAroon =
    cruzAroonSnapshot(
      putBars,
      10
    );


  assert(
    putAroon.crossDown === true &&
    putAroon.crossUp === false,
    `Aroon-Down fresh bearish crossover detected (${putAroon.down.toFixed(1)} vs ${putAroon.up.toFixed(1)})`
  );

  assert(
    callAroon.up > callAroon.down &&
    putAroon.down > putAroon.up,
    "Aroon direction agrees with the intended CALL and PUT crossover states"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 21: Cruz V2 OsMA(10,20,10) zero-line transitions
// -----------------------------------------------------------------------------
console.log(
  "Test 21: Cruz V2 OsMA(10,20,10) zero-line transitions"
);

{
  const start =
    Date.UTC(
      2026,
      9,
      1,
      13,
      0,
      0
    );

  const makeBar = (
    index,
    close
  ) => ({
    t:
      start +
      index * 30000,

    o: close,
    h: close + 0.00005,
    l: close - 0.00005,
    c: close,
    n: 10
  });


  // -------------------------------------------------
  // Bullish zero-line transition
  // Flat market first, then a fresh upward impulse.
  // -------------------------------------------------

  const bullishBars = [];

  for (let i = 0; i < 31; i++) {
    bullishBars.push(
      makeBar(
        i,
        1.10000
      )
    );
  }

  bullishBars.push(
    makeBar(
      31,
      1.10100
    )
  );


  const bullishOsma =
    cruzOsmaSnapshot(
      bullishBars,
      10,
      20,
      10
    );


  assert(
    bullishOsma.ready === true &&
    bullishOsma.fastPeriod === 10 &&
    bullishOsma.slowPeriod === 20 &&
    bullishOsma.signalPeriod === 10,
    "Cruz V2 OsMA(10,20,10) becomes ready with sufficient 30s bars"
  );

  assert(
    bullishOsma.bullishZeroCross === true &&
    bullishOsma.bearishZeroCross === false &&
    bullishOsma.osma > 0,
    `Bullish OsMA zero-line transition detected (${bullishOsma.previousOsma.toFixed(8)} -> ${bullishOsma.osma.toFixed(8)})`
  );


  // -------------------------------------------------
  // Bearish zero-line transition
  // Flat market first, then a fresh downward impulse.
  // -------------------------------------------------

  const bearishBars = [];

  for (let i = 0; i < 31; i++) {
    bearishBars.push(
      makeBar(
        i,
        1.10000
      )
    );
  }

  bearishBars.push(
    makeBar(
      31,
      1.09900
    )
  );


  const bearishOsma =
    cruzOsmaSnapshot(
      bearishBars,
      10,
      20,
      10
    );


  assert(
    bearishOsma.bearishZeroCross === true &&
    bearishOsma.bullishZeroCross === false &&
    bearishOsma.osma < 0,
    `Bearish OsMA zero-line transition detected (${bearishOsma.previousOsma.toFixed(8)} -> ${bearishOsma.osma.toFixed(8)})`
  );

  assert(
    bullishOsma.bullish === true &&
    bearishOsma.bearish === true,
    "OsMA polarity agrees with bullish and bearish confirmation states"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 22: Cruz V2 combined Aroon + OsMA CALL/PUT scorer
// -----------------------------------------------------------------------------
console.log(
  "Test 22: Cruz V2 combined Aroon + OsMA scorer"
);

{
  const start =
    Date.UTC(
      2026,
      9,
      1,
      14,
      0,
      0
    );

  const makeBar = (
    index,
    {
      open = 1.1000,
      high = 1.1005,
      low = 1.0995,
      close = 1.1000
    } = {}
  ) => ({
    t:
      start +
      index * 30000,

    o: open,
    h: high,
    l: low,
    c: close,
    n: 10
  });


  // -------------------------------------------------
  // CALL fixture
  //
  // Bars remain flat enough for OsMA to sit near zero.
  // At index 20 an old high controls Aroon-Up.
  // At index 30 a fresh low makes Aroon-Down dominant.
  // At index 31:
  // - old high drops out
  // - fresh high arrives
  // - close jumps higher
  //
  // Result:
  // Aroon-Up crosses above Aroon-Down
  // + OsMA crosses bullish through zero.
  // -------------------------------------------------

  const callBars = [];

  for (let i = 0; i < 32; i++) {
    callBars.push(
      makeBar(i)
    );
  }


  callBars[20] =
    makeBar(
      20,
      {
        open: 1.1000,
        high: 1.1100,
        low: 1.0995,
        close: 1.1000
      }
    );


  callBars[30] =
    makeBar(
      30,
      {
        open: 1.1000,
        high: 1.1005,
        low: 1.0990,
        close: 1.1000
      }
    );


  callBars[31] =
    makeBar(
      31,
      {
        open: 1.1000,
        high: 1.1120,
        low: 1.1005,
        close: 1.1015
      }
    );


  const callScore =
    scoreCruz30sAroonOsma(
      callBars,
      [],
      "EUR/USD"
    );


  assert(
    callScore.ok === true &&
    callScore.direction === "CALL",
    `Cruz V2 produces CALL from aligned Aroon/OsMA confirmation`
  );

  assert(
    callScore.aroon?.period === 10 &&
    callScore.osma?.fastPeriod === 10 &&
    callScore.osma?.slowPeriod === 20 &&
    callScore.osma?.signalPeriod === 10,
    "Cruz V2 CALL preserves Aroon(10) and OsMA(10,20,10) settings"
  );


  // -------------------------------------------------
  // PUT fixture — exact mirror
  // -------------------------------------------------

  const putBars = [];

  for (let i = 0; i < 32; i++) {
    putBars.push(
      makeBar(i)
    );
  }


  putBars[20] =
    makeBar(
      20,
      {
        open: 1.1000,
        high: 1.1005,
        low: 1.0900,
        close: 1.1000
      }
    );


  putBars[30] =
    makeBar(
      30,
      {
        open: 1.1000,
        high: 1.1010,
        low: 1.0995,
        close: 1.1000
      }
    );


  putBars[31] =
    makeBar(
      31,
      {
        open: 1.1000,
        high: 1.0995,
        low: 1.0880,
        close: 1.0985
      }
    );


  const putScore =
    scoreCruz30sAroonOsma(
      putBars,
      [],
      "EUR/USD"
    );


  assert(
    putScore.ok === true &&
    putScore.direction === "PUT",
    "Cruz V2 produces PUT from aligned Aroon/OsMA confirmation"
  );

  assert(
    callScore.timeframe === "30s" &&
    putScore.timeframe === "30s" &&
    callScore.primaryExpirySeconds === 120 &&
    putScore.primaryExpirySeconds === 120,
    "Cruz V2 uses 30-second chart with 120-second primary expiry"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 23: Cruz V2 OANDA completed S30 candle parser
// -----------------------------------------------------------------------------
console.log(
  "Test 23: Cruz V2 OANDA S30 candle parser"
);

{
  const storage =
    new MockStorage();

  const ctx =
    new MockCtx(storage);

  const hub =
    new TickHub(
      ctx,
      {
        WS_SYMBOLS:
          "EUR/USD",

        OANDA_API_TOKEN:
          "test-oanda-token",

        OANDA_ENV:
          "practice"
      }
    );

  await ctx.waitForInit();


  const start =
    Date.UTC(
      2026,
      9,
      1,
      15,
      0,
      0
    );


  const candles = [];

  // 33 completed S30 candles.
  for (let i = 0; i < 33; i++) {
    const base =
      1.10000 +
      i * 0.00001;

    candles.push({
      complete: true,

      volume:
        20 + i,

      time:
        new Date(
          start +
          i * 30000
        ).toISOString(),

      mid: {
        o:
          base.toFixed(5),

        h:
          (
            base +
            0.00010
          ).toFixed(5),

        l:
          (
            base -
            0.00010
          ).toFixed(5),

        c:
          (
            base +
            0.00002
          ).toFixed(5)
      }
    });
  }


  // Currently forming candle.
  // This MUST NOT enter the indicator calculation.
  candles.push({
    complete: false,

    volume: 99,

    time:
      new Date(
        start +
        33 * 30000
      ).toISOString(),

    mid: {
      o: "1.20000",
      h: "1.30000",
      l: "1.00000",
      c: "1.25000"
    }
  });


  const originalFetch =
    globalThis.fetch;

  let requestedUrl =
    null;

  let requestedOptions =
    null;


  globalThis.fetch =
    async (
      input,
      options = {}
    ) => {
      requestedUrl =
        String(input);

      requestedOptions =
        options;

      return new Response(
        JSON.stringify({
          instrument:
            "EUR_USD",

          granularity:
            "S30",

          candles
        }),
        {
          status: 200,

          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    };


  try {
    const bars =
      await hub
        .fetchCruz30SecondBars(
          "EUR/USD",
          60
        );


    const url =
      new URL(
        requestedUrl
      );


    assert(
      url.pathname ===
      "/v3/instruments/EUR_USD/candles" &&
      url.searchParams.get(
        "granularity"
      ) === "S30" &&
      url.searchParams.get(
        "price"
      ) === "M",
      "Cruz V2 requests EUR_USD midpoint S30 candles"
    );


    assert(
      requestedOptions
        ?.headers
        ?.Authorization ===
      "Bearer test-oanda-token",
      "OANDA candle request uses Bearer authentication"
    );


    assert(
      bars.length === 33,
      `Only completed S30 candles are retained (${bars.length}/33)`
    );


    assert(
      bars.at(-1)?.t ===
      start +
      32 * 30000 &&
      bars.at(-1)?.c !==
      1.25000,
      "Incomplete current 30s candle is excluded"
    );


    assert(
      bars.every(
        (bar, index) =>
          index === 0 ||
          Number(bar.t) -
          Number(
            bars[
              index - 1
            ].t
          ) ===
          30000
      ) &&
      Number.isFinite(
        bars[0]?.o
      ) &&
      Number.isFinite(
        bars[0]?.h
      ) &&
      Number.isFinite(
        bars[0]?.l
      ) &&
      Number.isFinite(
        bars[0]?.c
      ),
      "Completed OANDA candles map to ordered 30-second numeric OHLC bars"
    );
  } finally {
    globalThis.fetch =
      originalFetch;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 24: Cruz V2 30-second autonomous scan claim
// -----------------------------------------------------------------------------
console.log(
  "Test 24: Cruz V2 30-second scan claim"
);

{
  const realDateNow =
    Date.now;

  const fixedNow =
    Date.UTC(
      2026,
      9,
      1,
      16,
      0,
      0
    );

  let now =
    fixedNow;

  Date.now =
    () => now;


  try {
    const storage =
      new MockStorage();

    const ctx =
      new MockCtx(storage);

    const hub =
      new TickHub(
        ctx,
        {
          WS_SYMBOLS:
            "EUR/USD"
        }
      );

    await ctx.waitForInit();


    // First request in this 30-second slot
    // must acquire the claim.
    const firstResponse =
      await hub.fetch(
        new Request(
          "https://local/claim-short-cron",
          {
            method: "POST"
          }
        )
      );

    const first =
      await firstResponse.json();


    assert(
      first.ok === true &&
      first.claimed === true &&
      first.count === 1,
      "First Cruz V2 scan acquires the current 30-second slot"
    );


    // Second request inside exactly the same
    // 30-second slot must be rejected.
    const secondResponse =
      await hub.fetch(
        new Request(
          "https://local/claim-short-cron",
          {
            method: "POST"
          }
        )
      );

    const second =
      await secondResponse.json();


    assert(
      second.ok === true &&
      second.claimed === false &&
      second.slot === first.slot,
      "Duplicate Cruz V2 scan is blocked inside the same 30-second slot"
    );


    // Move into the next 30-second slot.
    now +=
      30000;


    const thirdResponse =
      await hub.fetch(
        new Request(
          "https://local/claim-short-cron",
          {
            method: "POST"
          }
        )
      );

    const third =
      await thirdResponse.json();


    assert(
      third.ok === true &&
      third.claimed === true &&
      third.slot ===
      first.slot + 1 &&
      third.count === 2,
      "Cruz V2 can acquire the immediately following 30-second slot"
    );


    assert(
      Number(
        await storage.get(
          "shortCronScanCount"
        )
      ) === 2 &&
      Number(
        await storage.get(
          "lastShortCronClaimAt"
        )
      ) === now,
      "Cruz V2 30-second scheduler state is persisted correctly"
    );
  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 25: 5-minute engine remains limited to one scan per minute
// -----------------------------------------------------------------------------
console.log(
  "Test 25: 5-minute engine minute claim remains protected"
);

{
  const realDateNow =
    Date.now;

  let now =
    Date.UTC(
      2026,
      9,
      1,
      17,
      0,
      1
    );

  Date.now =
    () => now;


  try {
    const storage =
      new MockStorage();

    const ctx =
      new MockCtx(storage);

    const hub =
      new TickHub(
        ctx,
        {
          WS_SYMBOLS:
            "EUR/USD"
        }
      );

    await ctx.waitForInit();


    // -------------------------------------------------
    // First wake at 17:00:01
    // 5-minute engine should acquire this minute.
    // -------------------------------------------------

    const firstResponse =
      await hub.fetch(
        new Request(
          "https://local/claim-cron",
          {
            method: "POST"
          }
        )
      );

    const first =
      await firstResponse.json();


    assert(
      first.ok === true &&
      first.claimed === true &&
      first.count === 1,
      "5-minute engine acquires the first scan of the minute"
    );


    // -------------------------------------------------
    // Second scheduler wake at 17:00:31.
    // Same minute — 5-minute engine MUST NOT run again.
    // -------------------------------------------------

    now +=
      30000;


    const secondResponse =
      await hub.fetch(
        new Request(
          "https://local/claim-cron",
          {
            method: "POST"
          }
        )
      );

    const second =
      await secondResponse.json();


    assert(
      second.ok === true &&
      second.claimed === false &&
      second.minute === first.minute,
      "Second 30-second wake cannot trigger another 5-minute scan in the same minute"
    );


    // -------------------------------------------------
    // Next minute at 17:01:01.
    // 5-minute engine may scan again.
    // -------------------------------------------------

    now +=
      30000;


    const thirdResponse =
      await hub.fetch(
        new Request(
          "https://local/claim-cron",
          {
            method: "POST"
          }
        )
      );

    const third =
      await thirdResponse.json();


    assert(
      third.ok === true &&
      third.claimed === true &&
      third.minute ===
      first.minute + 1 &&
      third.count === 2,
      "5-minute engine becomes eligible again in the next minute"
    );


    assert(
      Number(
        await storage.get(
          "cronScanCount"
        )
      ) === 2,
      "Two scheduler wakes per minute do not inflate 5-minute scan count"
    );
  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 26: Cruz V2 exact S30 settlement boundaries
// -----------------------------------------------------------------------------
console.log(
  "Test 26: Cruz V2 exact S30 settlement boundaries"
);

{
  const start =
    Date.UTC(
      2026,
      9,
      2,
      8,
      0,
      0
    );


  const bars = [];

  for (let i = 0; i < 8; i++) {
    bars.push({
      t:
        start +
        i * 30000,

      o:
        1.10000 +
        i * 0.00010,

      h:
        1.10010 +
        i * 0.00010,

      l:
        1.09990 +
        i * 0.00010,

      c:
        1.10005 +
        i * 0.00010,

      n: 20
    });
  }


  // Signal candle is index 0.
  // Its close is at start + 30 seconds.
  const entryAt =
    start + 30000;


  // -------------------------------------------------
  // 60-second expiry
  //
  // entryAt + 60s = start + 90s
  // Therefore settlement candle must be:
  // open start + 60s
  // close start + 90s
  // -> bars[2]
  // -------------------------------------------------

  const expiry60At =
    entryAt + 60000;

  const settle60 =
    cruzS30SettlementPrice(
      bars,
      expiry60At
    );


  assert(
    settle60 !== null &&
    settle60.candleOpenAt ===
    start + 60000 &&
    settle60.candleCloseAt ===
    expiry60At,
    "Cruz V2 selects the exact S30 candle ending at the 60s expiry"
  );


  assert(
    settle60.price ===
    Number(bars[2].c),
    "60s settlement uses the exact expiry candle close price"
  );


  // -------------------------------------------------
  // 120-second PRIMARY expiry
  //
  // entryAt + 120s = start + 150s
  // settlement candle:
  // open start + 120s
  // close start + 150s
  // -> bars[4]
  // -------------------------------------------------

  const expiry120At =
    entryAt + 120000;

  const settle120 =
    cruzS30SettlementPrice(
      bars,
      expiry120At
    );


  assert(
    settle120 !== null &&
    settle120.candleOpenAt ===
    start + 120000 &&
    settle120.candleCloseAt ===
    expiry120At &&
    settle120.price ===
    Number(bars[4].c),
    "Cruz V2 uses the exact S30 close at the 120s primary expiry"
  );


  // -------------------------------------------------
  // Never substitute a nearby candle.
  // -------------------------------------------------

  const missing =
    cruzS30SettlementPrice(
      bars,
      start + 123456
    );


  assert(
    missing === null,
    "Cruz V2 refuses an approximate settlement when the exact expiry boundary is missing"
  );
}

console.log();

// -----------------------------------------------------------------------------
// Test 27: Cruz V2 evaluator refuses unverified entry fallback
// -----------------------------------------------------------------------------
console.log(
  "Test 27: Cruz V2 evaluator refuses unverified entry fallback"
);

{
  const realDateNow =
    Date.now;

  const start =
    Date.UTC(
      2026,
      9,
      2,
      9,
      0,
      0
    );


  const makeBar = (
    index,
    {
      open = 1.1000,
      high = 1.1005,
      low = 1.0995,
      close = 1.1000
    } = {}
  ) => ({
    t:
      start +
      index * 30000,

    o: open,
    h: high,
    l: low,
    c: close,
    n: 20
  });


  const bars30 = [];

  for (let i = 0; i < 32; i++) {
    bars30.push(
      makeBar(i)
    );
  }


  // Old Aroon high.
  bars30[20] =
    makeBar(
      20,
      {
        open: 1.1000,
        high: 1.1100,
        low: 1.0995,
        close: 1.1000
      }
    );


  // Fresh low makes Aroon-Down dominant.
  bars30[30] =
    makeBar(
      30,
      {
        open: 1.1000,
        high: 1.1005,
        low: 1.0990,
        close: 1.1000
      }
    );


  // Fresh bullish breakout:
  // Aroon-Up crossover + bullish OsMA transition.
  bars30[31] =
    makeBar(
      31,
      {
        open: 1.1000,
        high: 1.1120,
        low: 1.1005,
        close: 1.1015
      }
    );


  const expectedEntryAt =
    Number(
      bars30.at(-1).t
    ) +
    30000;


  // Evaluator runs one second after
  // the completed S30 candle closes.
  Date.now =
    () =>
      expectedEntryAt +
      1000;


  try {
    const storage =
      new MockStorage();

    const ctx =
      new MockCtx(storage);

    const hub =
      new TickHub(
        ctx,
        {
          WS_SYMBOLS:
            "EUR/USD"
        }
      );

    await ctx.waitForInit();


    // No external OANDA call during test.
    hub.fetchMassive30SecondBars =
      async (
        symbol,
        count
      ) => {
        assert(
          symbol === "EUR/USD" &&
          count === 80,
          "Cruz V2 evaluator requests 80 S30 bars for the selected pair"
        );

        return bars30;
      };


    const result =
      await hub.evaluateShortShadowV2(
        "EUR/USD"
      );


    assert(
      result.ok === true &&
      result.patternDetected === true &&
      result.captured === false &&
      result.direction === "CALL" &&
      result.entryMethodVerified === false,
      "Cruz V2 detects the aligned CALL pattern but refuses an unverified entry"
    );


    assert(
      hub.shortShadowState.pending.length === 0,
      "Unverified Cruz entry is not inserted into the pending settlement queue"
    );


    assert(
      record.features?.model ===
      "cruz-30s-aroon10-osma10-20-10" &&
      record.features?.dataSource ===
      "massive-s30" &&
      record.features?.timeframe ===
      "30s" &&
      record.features?.primaryExpirySeconds ===
      120 &&
      record.features?.aroon?.period ===
      10 &&
      record.features?.osma?.fastPeriod ===
      10 &&
      record.features?.osma?.slowPeriod ===
      20 &&
      record.features?.osma?.signalPeriod ===
      10,
      "Captured V2 record preserves exact 30s Aroon(10) and OsMA(10,20,10) configuration"
    );
  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 28: Cruz V2 evaluator refuses unverified PUT entry fallback
// -----------------------------------------------------------------------------
console.log(
  "Test 28: Cruz V2 evaluator refuses unverified PUT entry fallback"
);

{
  const realDateNow =
    Date.now;

  const start =
    Date.UTC(
      2026,
      9,
      2,
      10,
      0,
      0
    );


  const makeBar = (
    index,
    {
      open = 1.1000,
      high = 1.1005,
      low = 1.0995,
      close = 1.1000
    } = {}
  ) => ({
    t:
      start +
      index * 30000,

    o: open,
    h: high,
    l: low,
    c: close,
    n: 20
  });


  const bars30 = [];

  for (let i = 0; i < 32; i++) {
    bars30.push(
      makeBar(i)
    );
  }


  // Old Aroon low.
  bars30[20] =
    makeBar(
      20,
      {
        open: 1.1000,
        high: 1.1005,
        low: 1.0900,
        close: 1.1000
      }
    );


  // Fresh high makes Aroon-Up dominant.
  bars30[30] =
    makeBar(
      30,
      {
        open: 1.1000,
        high: 1.1010,
        low: 1.0995,
        close: 1.1000
      }
    );


  // Fresh bearish breakdown:
  // Aroon-Down crossover + bearish OsMA transition.
  bars30[31] =
    makeBar(
      31,
      {
        open: 1.1000,
        high: 1.0995,
        low: 1.0880,
        close: 1.0985
      }
    );


  const expectedEntryAt =
    Number(
      bars30.at(-1).t
    ) +
    30000;


  Date.now =
    () =>
      expectedEntryAt +
      1000;


  try {
    const storage =
      new MockStorage();

    const ctx =
      new MockCtx(storage);

    const hub =
      new TickHub(
        ctx,
        {
          WS_SYMBOLS:
            "GBP/USD"
        }
      );

    await ctx.waitForInit();


    hub.fetchMassive30SecondBars =
      async (
        symbol,
        count
      ) => {
        assert(
          symbol === "GBP/USD" &&
          count === 80,
          "Cruz V2 PUT evaluator requests 80 Massive S30 bars for the selected pair"
        );

        return bars30;
      };


    const result =
      await hub.evaluateShortShadowV2(
        "GBP/USD"
      );


    assert(
      result.ok === true &&
      result.patternDetected === true &&
      result.captured === false &&
      result.direction === "PUT" &&
      result.entryMethodVerified === false,
      "Cruz V2 detects the aligned PUT pattern but refuses an unverified entry"
    );


    assert(
      hub.shortShadowState.pending.length === 0,
      "Unverified Cruz PUT entry is not inserted into the pending settlement queue"
    );


    assert(
      record.features?.model ===
      "cruz-30s-aroon10-osma10-20-10" &&
      record.features?.dataSource ===
      "massive-s30" &&
      record.features?.timeframe ===
      "30s" &&
      record.features?.primaryExpirySeconds ===
      120 &&
      record.features?.aroon?.period ===
      10 &&
      record.features?.osma?.fastPeriod ===
      10 &&
      record.features?.osma?.slowPeriod ===
      20 &&
      record.features?.osma?.signalPeriod ===
      10,
      "Captured PUT record preserves exact V2 indicator configuration"
    );
  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 29: Cruz V2 settles exact OANDA S30 expiries
// -----------------------------------------------------------------------------
console.log(
  "Test 29: Cruz V2 Massive S30 settlement"
);

{
  const realDateNow =
    Date.now;

  const start =
    Date.UTC(
      2026,
      9,
      2,
      11,
      0,
      0
    );


  // Entry occurs at the close of bar 0.
  const entryAt =
    start + 30000;

  const expiry60At =
    entryAt + 60000;

  const expiry120At =
    entryAt + 120000;


  const bars30 = [
    {
      t: start,
      o: 1.1000,
      h: 1.1002,
      l: 1.0998,
      c: 1.1000,
      n: 20
    },

    {
      t: start + 30000,
      o: 1.1000,
      h: 1.1005,
      l: 1.0999,
      c: 1.1003,
      n: 20
    },

    // Closes exactly at the 60s expiry.
    {
      t: start + 60000,
      o: 1.1003,
      h: 1.1012,
      l: 1.1002,
      c: 1.1010,
      n: 20
    },

    {
      t: start + 90000,
      o: 1.1010,
      h: 1.1011,
      l: 1.0998,
      c: 1.1001,
      n: 20
    },

    // Closes exactly at the 120s expiry.
    {
      t: start + 120000,
      o: 1.1001,
      h: 1.1002,
      l: 1.0988,
      c: 1.0990,
      n: 20
    }
  ];


  Date.now =
    () =>
      expiry120At +
      1000;


  try {
    const storage =
      new MockStorage();

    const ctx =
      new MockCtx(storage);

    const hub =
      new TickHub(
        ctx,
        {
          WS_SYMBOLS:
            "EUR/USD"
        }
      );

    await ctx.waitForInit();


    hub.shortShadowState = {
      strategyId:
        SHORT_SHADOW_ID,

      startedAt:
        start,

      pending: [
        {
          id:
            "cruz-v2-settlement-test",

          sourceKey:
            "cruz-v2-settlement-test",

          strategyId:
            SHORT_SHADOW_ID,

          symbol:
            "EUR/USD",

          direction:
            "CALL",

          entryPrice:
            1.1000,

          entryAt,

          expiry60At,
          expiry120At,

          result60:
            null,

          result120:
            null,

          exit60Price:
            null,

          exit120Price:
            null,

          exit60TickAt:
            null,

          exit120TickAt:
            null,

          features: {
            model:
              "cruz-30s-aroon10-osma10-20-10",

            dataSource:
              "oanda-s30-mid",

            primaryExpirySeconds:
              120
          }
        }
      ],

      history: []
    };


    await storage.put(
      "shortShadowState",
      hub.shortShadowState
    );


    let fetchCount = 0;


    hub.fetchMassive30SecondBars =
      async (
        symbol,
        count
      ) => {
        fetchCount++;

        assert(
          symbol === "EUR/USD" &&
          count === 80,
          "V2 settlement requests OANDA S30 history for the due pair"
        );

        return bars30;
      };


    const settled =
      await hub.settleShortShadowV2(
        Date.now()
      );


    assert(
      fetchCount === 1 &&
      settled.settlementSource ===
      "massive-s30",
      "Cruz V2 settlement uses OANDA S30 as the single settlement source"
    );


    assert(
      settled.settled60 === 1 &&
      settled.settled120 === 1 &&
      settled.completed === 1,
      "Both 60s diagnostic and 120s primary expiries settle in one pass"
    );


    assert(
      hub.shortShadowState.pending.length === 0 &&
      hub.shortShadowState.history.length === 1,
      "Fully settled V2 record moves from pending into history"
    );


    const record =
      hub.shortShadowState.history[0];


    assert(
      record.result60 === "WIN" &&
      record.exit60Price === 1.1010 &&
      record.exit60TickAt ===
      expiry60At &&
      record.result120 === "LOSS" &&
      record.exit120Price === 1.0990 &&
      record.exit120TickAt ===
      expiry120At,
      "Cruz V2 scores the exact 60s and 120s OANDA candle closes"
    );
  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 30: Production short-shadow routes switch cleanly from V1 to V2
// -----------------------------------------------------------------------------
console.log(
  "Test 30: Cruz V2 production route switch"
);

{
  const realDateNow =
    Date.now;

  const start =
    Date.UTC(
      2026,
      9,
      2,
      12,
      0,
      0
    );


  const makeBar = (
    index,
    {
      open = 1.1000,
      high = 1.1005,
      low = 1.0995,
      close = 1.1000
    } = {}
  ) => ({
    t:
      start +
      index * 30000,

    o: open,
    h: high,
    l: low,
    c: close,
    n: 20
  });


  // -------------------------------------------------
  // Build deterministic V2 CALL signal
  // -------------------------------------------------

  const signalBars = [];

  for (let i = 0; i < 32; i++) {
    signalBars.push(
      makeBar(i)
    );
  }


  signalBars[20] =
    makeBar(
      20,
      {
        high: 1.1100,
        low: 1.0995,
        close: 1.1000
      }
    );


  signalBars[30] =
    makeBar(
      30,
      {
        high: 1.1005,
        low: 1.0990,
        close: 1.1000
      }
    );


  signalBars[31] =
    makeBar(
      31,
      {
        open: 1.1000,
        high: 1.1120,
        low: 1.1005,
        close: 1.1015
      }
    );


  const entryAt =
    Number(
      signalBars.at(-1).t
    ) +
    30000;

  const expiry60At =
    entryAt +
    60000;

  const expiry120At =
    entryAt +
    120000;


  // Simulate Durable Object storage containing
  // the OLD V1 experiment.
  const storage =
    new MockStorage({
      blockerStats: {
        strategyId:
          STRATEGY_ID,

        classifierVersion:
          BLOCKER_CLASSIFIER_VERSION,

        startedAt:
          start,

        total: 0,
        byCategory: {},
        bySymbol: {},
        recent: []
      },

      shortShadowState: {
        strategyId:
          "cruz-1m-ichimoku-dmi-shadow-v1",

        startedAt:
          start - 86400000,

        pending: [
          {
            id:
              "old-v1-pending"
          }
        ],

        history: [
          {
            id:
              "old-v1-history"
          }
        ]
      }
    });


  const ctx =
    new MockCtx(storage);

  const hub =
    new TickHub(
      ctx,
      {
        WS_SYMBOLS:
          "EUR/USD"
      }
    );


  await ctx.waitForInit();


  // -------------------------------------------------
  // V1 state must disappear because strategy ID changed.
  // -------------------------------------------------

  assert(
    hub.shortShadowState.strategyId ===
    SHORT_SHADOW_ID &&
    hub.shortShadowState.pending.length ===
    0 &&
    hub.shortShadowState.history.length ===
    0,
    "Changing to Cruz V2 strategy ID starts a completely fresh short-shadow dataset"
  );


  // One second after signal candle completion.
  Date.now =
    () =>
      entryAt +
      1000;


  try {
    hub.fetchMassive30SecondBars =
      async () =>
        signalBars;


    // -------------------------------------------------
    // Test the actual /short-shadow route.
    // -------------------------------------------------

    const signalResponse =
      await hub.fetch(
        new Request(
          "https://local/short-shadow?symbol=EUR%2FUSD"
        )
      );


    const signal =
      await signalResponse.json();


    assert(
      signal.ok === true &&
      signal.captured === true &&
      signal.direction === "CALL",
      "/short-shadow production route now captures the Cruz V2 CALL"
    );


    assert(
      hub.shortShadowState.pending.length ===
      1 &&
      hub.shortShadowState.pending[0]
        ?.strategyId ===
      SHORT_SHADOW_ID &&
      hub.shortShadowState.pending[0]
        ?.features?.model ===
      "cruz-30s-aroon10-osma10-20-10" &&
      hub.shortShadowState.pending[0]
        ?.features?.dataSource ===
      "massive-s30",
      "Production capture is tagged with the fresh V2 strategy and Massive S30 model"
    );


    // -------------------------------------------------
    // Add exact future OANDA S30 settlement candles.
    // -------------------------------------------------

    const settlementBars = [
      ...signalBars,

      makeBar(
        32,
        {
          open: 1.1015,
          high: 1.1018,
          low: 1.1013,
          close: 1.1016
        }
      ),

      // Closes exactly at expiry60At.
      makeBar(
        33,
        {
          open: 1.1016,
          high: 1.1022,
          low: 1.1015,
          close: 1.1020
        }
      ),

      makeBar(
        34,
        {
          open: 1.1020,
          high: 1.1021,
          low: 1.1008,
          close: 1.1010
        }
      ),

      // Closes exactly at expiry120At.
      makeBar(
        35,
        {
          open: 1.1010,
          high: 1.1011,
          low: 1.1000,
          close: 1.1005
        }
      )
    ];


    hub.fetchMassive30SecondBars =
      async () =>
        settlementBars;


    Date.now =
      () =>
        expiry120At +
        1000;


    // -------------------------------------------------
    // Test the actual /settle-short-shadow route.
    // -------------------------------------------------

    const settleResponse =
      await hub.fetch(
        new Request(
          "https://local/settle-short-shadow"
        )
      );


    const settled =
      await settleResponse.json();


    assert(
      settled.ok === true &&
      settled.settlementSource ===
      "massive-s30" &&
      settled.completed === 1,
      "/settle-short-shadow production route now uses V2 Massive S30 settlement"
    );


    assert(
      hub.shortShadowState.pending.length ===
      0 &&
      hub.shortShadowState.history.length ===
      1,
      "V2 production route moves the fully settled record into fresh history"
    );


    const record =
      hub.shortShadowState.history[0];


    assert(
      record.result60 === "WIN" &&
      record.exit60Price ===
      1.1020 &&
      record.result120 === "LOSS" &&
      record.exit120Price ===
      1.1005,
      "Production V2 route independently scores exact 60s and 120s S30 outcomes"
    );

  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Test 31: Massive completed S30 candle parser
// -----------------------------------------------------------------------------
console.log(
  "Test 31: Massive S30 candle parser"
);

{
  const realDateNow =
    Date.now;

  const start =
    Date.UTC(
      2026,
      9,
      3,
      10,
      0,
      0
    );

  // 33 completed candles + one still forming.
  const now =
    start +
    33 * 30000 +
    10000;

  Date.now =
    () => now;


  try {
    const storage =
      new MockStorage();

    const ctx =
      new MockCtx(storage);

    const hub =
      new TickHub(
        ctx,
        {
          WS_SYMBOLS:
            "EUR/USD",

          MASSIVE_API_KEY:
            "test-massive-key"
        }
      );

    await ctx.waitForInit();


    const results = [];

    for (let i = 0; i < 34; i++) {
      const base =
        1.10000 +
        i * 0.00001;

      results.push({
        t:
          start +
          i * 30000,

        o:
          base,

        h:
          base + 0.00010,

        l:
          base - 0.00010,

        c:
          base + 0.00002,

        n:
          20 + i
      });
    }


    const originalFetch =
      globalThis.fetch;

    let requestedUrl =
      null;

    let requestedOptions =
      null;


    globalThis.fetch =
      async (
        input,
        options = {}
      ) => {
        requestedUrl =
          String(input);

        requestedOptions =
          options;

        return new Response(
          JSON.stringify({
            status:
              "OK",

            ticker:
              "C:EURUSD",

            results
          }),
          {
            status: 200,

            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      };


    try {
      const bars =
        await hub
          .fetchMassive30SecondBars(
            "EUR/USD",
            80
          );


      const url =
        new URL(
          requestedUrl
        );

      const decodedPath =
        decodeURIComponent(
          url.pathname
        );


      assert(
        decodedPath.includes(
          "/v2/aggs/ticker/C:EURUSD/range/30/second/"
        ),
        "Massive request uses C:EURUSD with 30-second aggregate interval"
      );


      assert(
        requestedOptions
          ?.headers
          ?.Authorization ===
        "Bearer test-massive-key",
        "Massive request uses Bearer API-key authentication"
      );


      assert(
        url.searchParams.get(
          "sort"
        ) === "asc" &&
        url.searchParams.get(
          "limit"
        ) === "5000",
        "Massive request asks for ordered aggregate history"
      );


      assert(
        bars.length === 33,
        `Only completed Massive S30 candles are retained (${bars.length}/33)`
      );


      assert(
        bars.at(-1)?.t ===
        start +
        32 * 30000 &&
        bars.every(
          bar =>
            Number.isFinite(
              bar.o
            ) &&
            Number.isFinite(
              bar.h
            ) &&
            Number.isFinite(
              bar.l
            ) &&
            Number.isFinite(
              bar.c
            )
        ),
        "Massive S30 response maps to ordered numeric OHLC bars and excludes forming candle"
      );
    } finally {
      globalThis.fetch =
        originalFetch;
    }
  } finally {
    Date.now =
      realDateNow;
  }
}

console.log();

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log(`=======================================================`);
console.log(`Audit Test Suite Results: ${passed} passed, ${failed} failed`);
console.log(`=======================================================`);

if (failed > 0) {
  process.exitCode = 1;
}
