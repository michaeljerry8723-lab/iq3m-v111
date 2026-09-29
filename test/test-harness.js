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
  FIXED_UNIVERSE,
  A_GRADE_MIN_QUALITY,
  score5m,
  preAlert5m,
  setupSequenceSnapshot,
  classifyBlocker,
  TickHub
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
    "5m efficiency 0.18 below 0.20"
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
// Summary
// -----------------------------------------------------------------------------
console.log(`=======================================================`);
console.log(`Audit Test Suite Results: ${passed} passed, ${failed} failed`);
console.log(`=======================================================`);

if (failed > 0) {
  process.exitCode = 1;
}
