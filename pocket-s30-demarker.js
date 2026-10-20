/**
 * Pocket Option OTC S30 SuperTrend + DeMarker shadow strategy.
 * ATR(10) and multiplier(2) are provisional defaults; see
 * POCKET_S30_SUPERTREND_DEMARKER.md for the source and assumption note.
 */

import { DurableObject } from "cloudflare:workers";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export const POCKET_S30_STRATEGY_ID = "pocket-s30-supertrend-demarker7-exp120-shadow-v1";
export const POCKET_S30_SOURCE_FEED = "otcharts-pocket-option-otc";
export const POCKET_S30_BAR_SOURCE = "otcharts-pocket-option-otc-s30";
export const POCKET_S30_SYMBOLS = Object.freeze([
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"
]);
export const POCKET_S30_DEFAULT_CONFIG = Object.freeze({
  timeframeSeconds: 30,
  deMarkerPeriod: 7,
  atrPeriod: 10,
  atrMultiplier: 2,
  atrSettingsVerified: false,
  expirySeconds: 120,
  entryMode: "completed-s30-confirmation-next-valid-otc-quote",
  sourceFeed: POCKET_S30_SOURCE_FEED
});
export const POCKET_S30_STATE_KEY = "pocketS30SuperTrendDeMarkerShadowV1";
export const POCKET_S30_MAX_PENDING = 1000;
export const POCKET_S30_MAX_HISTORY = 5000;
export const POCKET_S30_MAX_SOURCE_AGE_MS = 15000;
export const POCKET_S30_MAX_SOURCE_GAP_MS = 15000;
export const POCKET_S30_SETTLEMENT_GRACE_MS = 15000;
export const POCKET_S30_INTERVAL_MS = 30000;

export function pocketS30ConfigFromEnv(env = {}) {
  const rawPeriod = Number(env.POCKET_S30_SUPERTREND_ATR_PERIOD);
  const rawMultiplier = Number(env.POCKET_S30_SUPERTREND_MULTIPLIER);
  const atrPeriod = Number.isInteger(rawPeriod) && rawPeriod >= 2 && rawPeriod <= 100
    ? rawPeriod
    : POCKET_S30_DEFAULT_CONFIG.atrPeriod;
  const atrMultiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 && rawMultiplier <= 20
    ? rawMultiplier
    : POCKET_S30_DEFAULT_CONFIG.atrMultiplier;
  return {
    ...POCKET_S30_DEFAULT_CONFIG,
    atrPeriod,
    atrMultiplier,
    atrSettingsVerified: false
  };
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function validBar(bar) {
  if (!bar || !finite(bar.t) || ![bar.o, bar.h, bar.l, bar.c].every(finite)) return false;
  const t = Number(bar.t), o = Number(bar.o), h = Number(bar.h), l = Number(bar.l), c = Number(bar.c);
  return t > 0 && t % POCKET_S30_INTERVAL_MS === 0 &&
    l > 0 && h >= Math.max(o, c, l) && l <= Math.min(o, c, h);
}

function contiguousTail(inputBars) {
  if (!Array.isArray(inputBars) || !inputBars.length) return [];
  let start = 0;
  for (let i = inputBars.length - 1; i >= 0; i--) {
    if (!validBar(inputBars[i])) return null;
    if (i > 0) {
      const delta = Number(inputBars[i].t) - Number(inputBars[i - 1].t);
      if (delta <= 0) return null;
      if (delta !== POCKET_S30_INTERVAL_MS) { start = i; break; }
    }
  }
  return inputBars.slice(start).map(bar => ({
    t: Number(bar.t), o: Number(bar.o), h: Number(bar.h),
    l: Number(bar.l), c: Number(bar.c), n: Number(bar.n || 0)
  }));
}

export function computeDeMarker(bars, period = 7) {
  const p = Number(period);
  if (!Array.isArray(bars) || !Number.isInteger(p) || p < 1) {
    return { ready: false, reason: "invalid_demarker_input", value: null, previous: null };
  }
  if (bars.length < p + 2) {
    return { ready: false, reason: "insufficient_demarker_history", value: null, previous: null, requiredBars: p + 2 };
  }
  const maxMoves = new Array(bars.length).fill(0);
  const minMoves = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const high = Number(bars[i].h), previousHigh = Number(bars[i - 1].h);
    const low = Number(bars[i].l), previousLow = Number(bars[i - 1].l);
    if (![high, previousHigh, low, previousLow].every(Number.isFinite)) {
      return { ready: false, reason: "invalid_demarker_candle", value: null, previous: null };
    }
    maxMoves[i] = Math.max(high - previousHigh, 0);
    minMoves[i] = Math.max(previousLow - low, 0);
  }
  const at = index => {
    let up = 0, down = 0;
    for (let j = index - p + 1; j <= index; j++) {
      up += maxMoves[j];
      down += minMoves[j];
    }
    const total = up + down;
    return total > 0 ? up / total : null;
  };
  const value = at(bars.length - 1);
  const previous = at(bars.length - 2);
  if (!Number.isFinite(value) || !Number.isFinite(previous)) {
    return { ready: false, reason: "demarker_flat_or_unavailable", value, previous };
  }
  return {
    ready: true,
    period: p,
    value,
    previous,
    rising: value > previous,
    falling: value < previous,
    direction: value > previous ? "rising" : value < previous ? "falling" : "flat"
  };
}

export function computeSuperTrend(bars, options = {}) {
  const atrPeriod = Number(options.atrPeriod);
  const multiplier = Number(options.atrMultiplier);
  if (!Array.isArray(bars) || !Number.isInteger(atrPeriod) || atrPeriod < 2 ||
      !Number.isFinite(multiplier) || multiplier <= 0) {
    return { ready: false, reason: "invalid_supertrend_configuration", value: null };
  }
  const n = bars.length;
  if (n < atrPeriod + 2) {
    return { ready: false, reason: "insufficient_supertrend_history", value: null, requiredBars: atrPeriod + 2 };
  }
  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const high = Number(bars[i]?.h), low = Number(bars[i]?.l), previousClose = Number(bars[i - 1]?.c);
    if (![high, low].every(Number.isFinite) || high < low) {
      return { ready: false, reason: "invalid_supertrend_candle", value: null };
    }
    tr[i] = i === 0
      ? high - low
      : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }
  const atr = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const line = new Array(n).fill(null);
  const trend = new Array(n).fill(null);
  let seed = 0;
  for (let i = 0; i < atrPeriod; i++) seed += tr[i];
  atr[atrPeriod - 1] = seed / atrPeriod;
  const first = atrPeriod - 1;
  for (let i = first; i < n; i++) {
    if (i > first) atr[i] = ((atr[i - 1] * (atrPeriod - 1)) + tr[i]) / atrPeriod;
    const mid = (Number(bars[i].h) + Number(bars[i].l)) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    if (i === first) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      trend[i] = Number(bars[i].c) >= mid ? 1 : -1;
    } else {
      upper[i] = basicUpper < upper[i - 1] || Number(bars[i - 1].c) > upper[i - 1]
        ? basicUpper
        : upper[i - 1];
      lower[i] = basicLower > lower[i - 1] || Number(bars[i - 1].c) < lower[i - 1]
        ? basicLower
        : lower[i - 1];
      if (trend[i - 1] > 0) trend[i] = Number(bars[i].c) < lower[i] ? -1 : 1;
      else trend[i] = Number(bars[i].c) > upper[i] ? 1 : -1;
    }
    line[i] = trend[i] > 0 ? lower[i] : upper[i];
  }
  const index = n - 1;
  return {
    ready: Number.isFinite(line[index]) && Number.isFinite(line[index - 1]),
    reason: Number.isFinite(line[index]) && Number.isFinite(line[index - 1]) ? null : "supertrend_warmup",
    atrPeriod,
    multiplier,
    atr: atr[index],
    previousAtr: atr[index - 1],
    line: line[index],
    previousLine: line[index - 1],
    trend: trend[index] > 0 ? "bullish" : trend[index] < 0 ? "bearish" : null,
    previousTrend: trend[index - 1] > 0 ? "bullish" : trend[index - 1] < 0 ? "bearish" : null,
    upperBand: upper[index],
    lowerBand: lower[index],
    previousUpperBand: upper[index - 1],
    previousLowerBand: lower[index - 1]
  };
}

export function scorePocketS30(bars, options = {}) {
  const config = {
    ...POCKET_S30_DEFAULT_CONFIG,
    ...options
  };
  const atrPeriod = Number(config.atrPeriod);
  const atrMultiplier = Number(config.atrMultiplier);
  const deMarkerPeriod = Number(config.deMarkerPeriod);
  const confirmationAt = Number(config.confirmationAt);
  if (!Number.isInteger(atrPeriod) || atrPeriod < 2 || atrPeriod > 100 ||
      !Number.isFinite(atrMultiplier) || atrMultiplier <= 0 || atrMultiplier > 20 ||
      !Number.isInteger(deMarkerPeriod) || deMarkerPeriod < 1) {
    return { ok: false, reason: "invalid_strategy_configuration", direction: null };
  }
  if (!Array.isArray(bars) || !bars.length) {
    return { ok: false, reason: "insufficient_completed_s30_bars", direction: null, requiredBars: Math.max(atrPeriod + 2, deMarkerPeriod + 2), bars: 0 };
  }
  const tail = contiguousTail(bars);
  if (!tail) return { ok: false, reason: "invalid_or_out_of_order_s30_candle", direction: null };
  const requiredBars = Math.max(atrPeriod + 2, deMarkerPeriod + 2);
  if (tail.length < requiredBars) {
    return { ok: false, reason: "insufficient_contiguous_s30_bars", direction: null, bars: tail.length, requiredBars };
  }
  const latest = tail.at(-1);
  if (!Number.isFinite(confirmationAt) || latest.t + POCKET_S30_INTERVAL_MS > confirmationAt) {
    return { ok: false, reason: "latest_s30_candle_not_completed_at_confirmation", direction: null, bars: tail.length, requiredBars };
  }
  const superTrend = computeSuperTrend(tail, { atrPeriod, atrMultiplier });
  const deMarker = computeDeMarker(tail, deMarkerPeriod);
  if (!superTrend.ready) return { ok: false, reason: superTrend.reason || "supertrend_unavailable", direction: null, bars: tail.length, requiredBars };
  if (!deMarker.ready) return { ok: false, reason: deMarker.reason || "demarker_unavailable", direction: null, bars: tail.length, requiredBars };
  const close = latest.c;
  const call = superTrend.trend === "bullish" && superTrend.line < close && deMarker.rising;
  const put = superTrend.trend === "bearish" && superTrend.line > close && deMarker.falling;
  const direction = call ? "CALL" : put ? "PUT" : null;
  let reason = null;
  if (!direction) {
    if (superTrend.trend === "bullish" && !(superTrend.line < close)) reason = "supertrend_line_not_below_price";
    else if (superTrend.trend === "bearish" && !(superTrend.line > close)) reason = "supertrend_line_not_above_price";
    else if (superTrend.trend === "bullish" && !deMarker.rising) reason = deMarker.direction === "flat" ? "demarker_not_rising" : "demarker_falling";
    else if (superTrend.trend === "bearish" && !deMarker.falling) reason = deMarker.direction === "flat" ? "demarker_not_falling" : "demarker_rising";
    else reason = "supertrend_direction_unavailable";
  }
  return {
    ok: Boolean(direction),
    direction,
    reason,
    signalBarAt: latest.t,
    signalBarCloseAt: latest.t + POCKET_S30_INTERVAL_MS,
    bars: tail.length,
    requiredBars,
    price: close,
    superTrend,
    deMarker,
    config: {
      timeframeSeconds: 30,
      deMarkerPeriod,
      atrPeriod,
      atrMultiplier,
      atrSettingsVerified: Boolean(config.atrSettingsVerified),
      expirySeconds: 120,
      sourceFeed: POCKET_S30_SOURCE_FEED
    }
  };
}

export function validatePocketS30Quote(input, now = Date.now()) {
  const sourceFeed = String(input?.sourceFeed || "");
  const symbol = String(input?.symbol || "").toUpperCase();
  const providerAt = Number(input?.providerAt);
  const receivedAt = Number(input?.receivedAt);
  const price = Number(input?.price);
  if (sourceFeed !== POCKET_S30_SOURCE_FEED) return { ok: false, reason: "source_feed_mismatch" };
  if (!POCKET_S30_SYMBOLS.includes(symbol)) return { ok: false, reason: "unsupported_otc_symbol" };
  if (![providerAt, receivedAt, price, Number(now)].every(Number.isFinite) || providerAt <= 0 || receivedAt <= 0 || price <= 0) {
    return { ok: false, reason: "invalid_source_quote" };
  }
  if (providerAt > Number(now) + 5000 || receivedAt > Number(now) + 5000) {
    return { ok: false, reason: "future_source_quote" };
  }
  if (Number(now) - receivedAt > POCKET_S30_MAX_SOURCE_AGE_MS ||
      receivedAt - providerAt > POCKET_S30_MAX_SOURCE_AGE_MS ||
      receivedAt - providerAt < -5000) {
    return { ok: false, reason: "stale_source_quote" };
  }
  return {
    ok: true,
    quote: {
      sourceFeed,
      symbol,
      providerAt,
      receivedAt,
      price,
      streamSession: String(input?.streamSession || "")
    }
  };
}

export function createPocketS30State(now = Date.now(), config = POCKET_S30_DEFAULT_CONFIG) {
  return {
    strategyId: POCKET_S30_STRATEGY_ID,
    sourceFeed: POCKET_S30_SOURCE_FEED,
    startedAt: Number(now),
    enabled: false,
    config: { ...config },
    pending: [],
    history: [],
    completedBars: {},
    currentBars: {},
    firstBucketToSkip: {},
    lastEvaluatedBarAt: {},
    lastQuoteBySymbol: {},
    rejectionReasons: {},
    observations: { firstEntryAt: null, lastEntryAt: null }
  };
}

export function restorePocketS30State(stored, now = Date.now(), config = POCKET_S30_DEFAULT_CONFIG) {
  if (!stored || stored.strategyId !== POCKET_S30_STRATEGY_ID || stored.sourceFeed !== POCKET_S30_SOURCE_FEED) {
    return createPocketS30State(now, config);
  }
  const state = {
    ...createPocketS30State(Number(stored.startedAt) || now, stored.config || config),
    enabled: Boolean(stored.enabled),
    pending: Array.isArray(stored.pending) ? stored.pending.filter(x =>
      x?.strategyId === POCKET_S30_STRATEGY_ID && x?.sourceFeed === POCKET_S30_SOURCE_FEED &&
      POCKET_S30_SYMBOLS.includes(x.symbol) && ["CALL", "PUT"].includes(x.direction) &&
      Number.isFinite(Number(x.entryAt)) && Number.isFinite(Number(x.expiryAt))
    ) : [],
    history: Array.isArray(stored.history) ? stored.history.filter(x =>
      x?.strategyId === POCKET_S30_STRATEGY_ID && x?.sourceFeed === POCKET_S30_SOURCE_FEED &&
      POCKET_S30_SYMBOLS.includes(x.symbol) && ["CALL", "PUT"].includes(x.direction)
    ).slice(0, POCKET_S30_MAX_HISTORY) : [],
    completedBars: stored.completedBars && typeof stored.completedBars === "object" ? stored.completedBars : {},
    currentBars: {},
    firstBucketToSkip: {},
    lastEvaluatedBarAt: stored.lastEvaluatedBarAt && typeof stored.lastEvaluatedBarAt === "object" ? stored.lastEvaluatedBarAt : {},
    lastQuoteBySymbol: stored.lastQuoteBySymbol && typeof stored.lastQuoteBySymbol === "object" ? stored.lastQuoteBySymbol : {},
    rejectionReasons: stored.rejectionReasons && typeof stored.rejectionReasons === "object" ? stored.rejectionReasons : {},
    observations: stored.observations && typeof stored.observations === "object"
      ? { firstEntryAt: Number(stored.observations.firstEntryAt) || null, lastEntryAt: Number(stored.observations.lastEntryAt) || null }
      : { firstEntryAt: null, lastEntryAt: null }
  };
  for (const symbol of POCKET_S30_SYMBOLS) {
    const bars = Array.isArray(state.completedBars[symbol]) ? state.completedBars[symbol]
      .filter(validBar).map(b => ({ t: Number(b.t), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), n: Number(b.n || 0) }))
      .sort((a, b) => a.t - b.t).slice(-200) : [];
    state.completedBars[symbol] = bars;
    const q = state.lastQuoteBySymbol[symbol];
    if (!q || q.sourceFeed !== POCKET_S30_SOURCE_FEED || !finite(q.providerAt) || !finite(q.receivedAt) || !finite(q.price)) {
      delete state.lastQuoteBySymbol[symbol];
    }
  }
  return state;
}

export function countPocketS30Rejection(state, reason, symbol = null, at = Date.now()) {
  const key = String(reason || "unspecified_rejection");
  const row = state.rejectionReasons[key] || { count: 0, lastAt: null, symbols: {} };
  row.count = Number(row.count || 0) + 1;
  row.lastAt = Number(at);
  if (symbol && POCKET_S30_SYMBOLS.includes(symbol)) {
    row.symbols[symbol] = Number(row.symbols[symbol] || 0) + 1;
  }
  state.rejectionReasons[key] = row;
}

function resolvePocketOutcome(direction, entryPrice, exitPrice) {
  const delta = Number(exitPrice) - Number(entryPrice);
  if (delta === 0) return "DRAW";
  return direction === "CALL" ? delta > 0 ? "WIN" : "LOSS" : delta < 0 ? "WIN" : "LOSS";
}

function moveSettledToHistory(state, now) {
  const remaining = [];
  for (const record of state.pending) {
    if (record.result && ["WIN", "LOSS", "DRAW", "VOID"].includes(record.result)) {
      record.completedAt = Number(now);
      state.history.unshift(record);
    } else remaining.push(record);
  }
  state.pending = remaining.slice(0, POCKET_S30_MAX_PENDING);
  state.history = state.history.slice(0, POCKET_S30_MAX_HISTORY);
}

export function capturePocketS30Entry(state, input, now = Date.now()) {
  const quoteCheck = validatePocketS30Quote({
    ...input?.quote,
    sourceFeed: input?.sourceFeed || input?.quote?.sourceFeed
  }, now);
  if (!quoteCheck.ok) return { ok: false, reason: quoteCheck.reason };
  const quote = quoteCheck.quote;
  const symbol = String(input?.symbol || quote.symbol).toUpperCase();
  const direction = String(input?.direction || "").toUpperCase();
  const signalBarAt = Number(input?.signalBarAt);
  if (state?.strategyId !== POCKET_S30_STRATEGY_ID || state?.sourceFeed !== POCKET_S30_SOURCE_FEED) {
    return { ok: false, reason: "strategy_state_isolation_mismatch" };
  }
  if (symbol !== quote.symbol || !["CALL", "PUT"].includes(direction) || !Number.isFinite(signalBarAt)) {
    return { ok: false, reason: "invalid_entry_fields" };
  }
  const signalBarCloseAt = signalBarAt + POCKET_S30_INTERVAL_MS;
  const confirmationDelayMs = quote.providerAt - signalBarCloseAt;
  if (confirmationDelayMs < 0 || confirmationDelayMs > POCKET_S30_MAX_SOURCE_AGE_MS) {
    return { ok: false, reason: "entry_quote_not_immediately_after_confirmation" };
  }
  if (!input?.score?.ok || input.score.direction !== direction ||
      !input.score.superTrend || !input.score.deMarker) {
    return { ok: false, reason: "entry_signal_not_qualified" };
  }
  if (state.pending.length >= POCKET_S30_MAX_PENDING) return { ok: false, reason: "pending_capacity_reached" };
  const sourceKey = [
    POCKET_S30_STRATEGY_ID, POCKET_S30_SOURCE_FEED, symbol, signalBarAt
  ].join("|");
  const duplicate = [...state.pending, ...state.history].find(x => x.sourceKey === sourceKey);
  if (duplicate) return { ok: true, duplicate: true, id: duplicate.id, sourceKey };
  const config = { ...state.config, ...(input.config || {}) };
  const record = {
    id: String(input.id || sourceKey),
    sourceKey,
    strategyId: POCKET_S30_STRATEGY_ID,
    sourceFeed: POCKET_S30_SOURCE_FEED,
    symbol,
    direction,
    entryPrice: quote.price,
    entryAt: quote.providerAt,
    entryReceivedAt: quote.receivedAt,
    expirySeconds: 120,
    expiryAt: quote.providerAt + 120000,
    result: null,
    exitPrice: null,
    exitAt: null,
    exitReceivedAt: null,
    voidReason: null,
    signalBarAt,
    signalBarCloseAt,
    confirmationDelayMs,
    superTrend: {
      atrPeriod: Number(config.atrPeriod),
      multiplier: Number(config.atrMultiplier),
      atr: Number(input.score.superTrend.atr),
      trendLine: Number(input.score.superTrend.line),
      direction: input.score.superTrend.trend
    },
    deMarker: {
      period: 7,
      value: Number(input.score.deMarker.value),
      previous: Number(input.score.deMarker.previous),
      direction: input.score.deMarker.direction
    },
    config,
    capturedAt: Number(now)
  };
  state.pending.unshift(record);
  state.observations.firstEntryAt = state.observations.firstEntryAt || record.entryAt;
  state.observations.lastEntryAt = record.entryAt;
  const quoteKey = [quote.symbol, quote.providerAt, quote.price, quote.streamSession].join("|");
  state.lastQuoteBySymbol[symbol] = { ...quote, quoteKey };
  return { ok: true, duplicate: false, id: record.id, sourceKey, record };
}

export function ingestPocketS30Quote(state, input, now = Date.now()) {
  const checked = validatePocketS30Quote(input, now);
  if (!checked.ok) {
    countPocketS30Rejection(state, checked.reason, input?.symbol, now);
    return { ok: false, accepted: false, reason: checked.reason, settled: [] };
  }
  const quote = checked.quote;
  const previous = state.lastQuoteBySymbol[quote.symbol];
  const quoteKey = [quote.symbol, quote.providerAt, quote.price, quote.streamSession].join("|");
  if (previous) {
    const previousAt = Number(previous.providerAt);
    if (quote.providerAt < previousAt) {
      countPocketS30Rejection(state, "out_of_order_source_quote", quote.symbol, now);
      return { ok: false, accepted: false, reason: "out_of_order_source_quote", settled: [] };
    }
    if (String(previous.quoteKey || "") === quoteKey) {
      return { ok: true, accepted: false, duplicate: true, reason: "duplicate_source_quote", settled: [] };
    }
  }
  const settled = [];
  for (const record of state.pending) {
    if (record.symbol !== quote.symbol || record.result) continue;
    const expiryAt = Number(record.expiryAt);
    const previousAt = Number(previous?.providerAt ?? record.entryAt);
    const crossedExpiry = previousAt < expiryAt && quote.providerAt >= expiryAt;
    const sourceSessionChanged = Boolean(previous?.streamSession && quote.streamSession &&
      previous.streamSession !== quote.streamSession);
    const gapCoversExpiry = crossedExpiry &&
      (quote.providerAt - previousAt > POCKET_S30_MAX_SOURCE_GAP_MS || sourceSessionChanged);
    if (gapCoversExpiry) {
      record.result = "VOID";
      record.voidReason = "source quote continuity gap crossed expiry; first quote cannot be verified";
      record.exitPrice = null;
      record.exitAt = null;
      record.exitReceivedAt = null;
      settled.push(record.id);
      countPocketS30Rejection(state, "settlement_source_gap", record.symbol, now);
      continue;
    }
    if (quote.providerAt >= expiryAt) {
      if (quote.providerAt > expiryAt + POCKET_S30_SETTLEMENT_GRACE_MS) {
        record.result = "VOID";
        record.voidReason = "no valid source quote within 15 seconds after expiry";
        countPocketS30Rejection(state, "settlement_quote_outside_grace", record.symbol, now);
      } else {
        record.exitPrice = quote.price;
        record.exitAt = quote.providerAt;
        record.exitReceivedAt = quote.receivedAt;
        record.exitStreamSession = quote.streamSession;
        record.exitSourceFeed = quote.sourceFeed;
        record.result = resolvePocketOutcome(record.direction, record.entryPrice, quote.price);
      }
      settled.push(record.id);
    }
  }
  state.lastQuoteBySymbol[quote.symbol] = { ...quote, quoteKey };
  moveSettledToHistory(state, now);
  return { ok: true, accepted: true, quote, settled, pending: state.pending.length };
}

export function expirePocketS30Pending(state, now = Date.now()) {
  const expired = [];
  for (const record of state.pending) {
    if (!record.result && Number(now) >= Number(record.expiryAt) + POCKET_S30_SETTLEMENT_GRACE_MS) {
      record.result = "VOID";
      record.voidReason = "no valid source quote within 15 seconds after expiry";
      record.exitPrice = null;
      record.exitAt = null;
      record.exitReceivedAt = null;
      expired.push(record.id);
      countPocketS30Rejection(state, "settlement_quote_missing", record.symbol, now);
    }
  }
  moveSettledToHistory(state, now);
  return { expired, pending: state.pending.length };
}

export function summarizePocketS30(state) {
  const history = Array.isArray(state?.history) ? state.history : [];
  const pending = Array.isArray(state?.pending) ? state.pending : [];
  const entries = [...history, ...pending];
  const settled = history.filter(x => ["WIN", "LOSS", "DRAW", "VOID"].includes(x.result));
  const wins = settled.filter(x => x.result === "WIN").length;
  const losses = settled.filter(x => x.result === "LOSS").length;
  const draws = settled.filter(x => x.result === "DRAW").length;
  const voids = settled.filter(x => x.result === "VOID").length;
  const wl = wins + losses;
  const bySymbol = {};
  for (const symbol of POCKET_S30_SYMBOLS) {
    const rows = settled.filter(x => x.symbol === symbol);
    bySymbol[symbol] = {
      total: entries.filter(x => x.symbol === symbol).length,
      pending: pending.filter(x => x.symbol === symbol).length,
      settled: rows.length,
      wins: rows.filter(x => x.result === "WIN").length,
      losses: rows.filter(x => x.result === "LOSS").length,
      draws: rows.filter(x => x.result === "DRAW").length,
      voids: rows.filter(x => x.result === "VOID").length,
      winRateExcludingDraws: (rows.filter(x => x.result === "WIN").length + rows.filter(x => x.result === "LOSS").length)
        ? rows.filter(x => x.result === "WIN").length / (rows.filter(x => x.result === "WIN").length + rows.filter(x => x.result === "LOSS").length) * 100
        : null
    };
  }
  const byDirection = {};
  for (const direction of ["CALL", "PUT"]) {
    const rows = settled.filter(x => x.direction === direction);
    byDirection[direction] = {
      total: entries.filter(x => x.direction === direction).length,
      pending: pending.filter(x => x.direction === direction).length,
      settled: rows.length,
      wins: rows.filter(x => x.result === "WIN").length,
      losses: rows.filter(x => x.result === "LOSS").length,
      draws: rows.filter(x => x.result === "DRAW").length,
      voids: rows.filter(x => x.result === "VOID").length,
      winRateExcludingDraws: (rows.filter(x => x.result === "WIN").length + rows.filter(x => x.result === "LOSS").length)
        ? rows.filter(x => x.result === "WIN").length / (rows.filter(x => x.result === "WIN").length + rows.filter(x => x.result === "LOSS").length) * 100
        : null
    };
  }
  const times = entries.map(x => Number(x.entryAt)).filter(Number.isFinite);
  return {
    ok: true,
    strategyId: POCKET_S30_STRATEGY_ID,
    sourceFeed: POCKET_S30_SOURCE_FEED,
    enabled: Boolean(state?.enabled),
    configuration: state?.config || POCKET_S30_DEFAULT_CONFIG,
    totalEntries: entries.length,
    pending: pending.length,
    settled: settled.length,
    wins, losses, draws, voids,
    winRateExcludingDraws: wl ? wins / wl * 100 : null,
    bySymbol,
    byDirection,
    observationDates: {
      first: times.length ? new Date(Math.min(...times)).toISOString().slice(0, 10) : null,
      last: times.length ? new Date(Math.max(...times)).toISOString().slice(0, 10) : null
    },
    rejectionReasons: state?.rejectionReasons || {}
  };
}


export class PocketS30DemarkerShadow extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.state = createPocketS30State(Date.now(), pocketS30ConfigFromEnv(env));
    this.runtime = { streamStatus: "not_started", lastQuoteAt: {}, lastProviderAt: {}, streamSession: null };
    this.skipFirstBucket = new Set(POCKET_S30_SYMBOLS);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get(POCKET_S30_STATE_KEY);
      this.state = restorePocketS30State(stored, Date.now(), pocketS30ConfigFromEnv(env));
      this.skipFirstBucket = new Set(POCKET_S30_SYMBOLS);
      this.runtime.streamStatus = this.state.enabled ? "awaiting_shared_otc_stream" : "not_started";
      if (this.state.enabled) await this.scheduleNextAlarm();
    });
  }

  async save() {
    await this.ctx.storage.put(POCKET_S30_STATE_KEY, this.state);
  }

  async ensureFeed() {
    if (!this.state.enabled) return { ok: false, reason: "shadow_collection_not_started" };
    const hub = this.env.TICK_HUB;
    if (!hub) return { ok: false, reason: "tick_hub_binding_missing" };
    try {
      const id = hub.idFromName("global-market-feed");
      const response = await hub.get(id).fetch("https://tick-hub/pocket-s30-feed/start", {
        method: "POST",
        headers: { "X-IQ3M-Cron-Secret": String(this.env.TELEGRAM_WEBHOOK_SECRET || "") }
      });
      const body = await response.json().catch(() => ({}));
      this.runtime.streamStatus = body.ok ? body.status || "connecting" : body.error || "feed_start_failed";
      return body;
    } catch (error) {
      this.runtime.streamStatus = String(error?.message || error).slice(0, 200);
      return { ok: false, reason: this.runtime.streamStatus };
    }
  }

  async scheduleNextAlarm() {
    if (!this.state.enabled) return;
    const pendingAt = this.state.pending
      .filter(x => !x.result)
      .reduce((n, x) => Math.min(n, Number(x.expiryAt) + POCKET_S30_SETTLEMENT_GRACE_MS), Infinity);
    const next = Math.min(Date.now() + 30000, Number.isFinite(pendingAt) ? pendingAt : Infinity);
    await this.ctx.storage.setAlarm(next);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/diagnostics" && request.method === "GET") return json(await this.diagnostics());
    if (url.pathname === "/stats" && request.method === "GET") return json(summarizePocketS30(this.state));
    if (url.pathname === "/start" && request.method === "POST") {
      const secret = String(this.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (!secret || request.headers.get("X-IQ3M-Cron-Secret") !== secret) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const config = pocketS30ConfigFromEnv(this.env);
      this.state.config = { ...config, sourceFeed: POCKET_S30_SOURCE_FEED };
      this.state.enabled = true;
      await this.save();
      const feed = await this.ensureFeed();
      await this.scheduleNextAlarm();
      return json({ ok: true, strategyId: POCKET_S30_STRATEGY_ID, configuration: this.state.config, feed });
    }
    if (url.pathname === "/quote" && request.method === "POST") {
      let quote;
      try { quote = await request.json(); } catch (_) { return json({ ok: false, error: "invalid_json" }, 400); }
      return json(await this.onQuote(quote));
    }
    if (url.pathname === "/feed-status" && request.method === "POST") {
      let payload;
      try { payload = await request.json(); } catch (_) { return json({ ok: false, error: "invalid_json" }, 400); }
      if (payload.sourceFeed !== POCKET_S30_SOURCE_FEED) return json({ ok: false, error: "source_feed_mismatch" }, 400);
      this.runtime.streamStatus = String(payload.status || "unknown");
      if (payload.streamSession) this.runtime.streamSession = String(payload.streamSession);
      return json({ ok: true });
    }
    return json({ ok: false, error: "not_found" }, 404);
  }

  async diagnostics() {
    const now = Date.now();
    const indicators = {};
    for (const symbol of POCKET_S30_SYMBOLS) {
      const bars = this.state.completedBars[symbol] || [];
      const score = scorePocketS30(bars, { ...this.state.config, confirmationAt: now });
      const latest = this.state.lastQuoteBySymbol[symbol];
      indicators[symbol] = {
        readyBars: bars.length,
        requiredBars: Math.max(Number(this.state.config.atrPeriod) + 2, 9),
        latestQuoteAgeMs: latest ? Math.max(0, now - Number(latest.receivedAt)) : null,
        latestProviderAt: latest?.providerAt || null,
        latestPrice: latest?.price || null,
        score: score.ok ? { direction: score.direction, signalBarAt: score.signalBarAt, superTrend: score.superTrend, deMarker: score.deMarker } : null,
        rejectionReason: score.ok ? null : score.reason
      };
    }
    return {
      ok: true,
      strategyId: POCKET_S30_STRATEGY_ID,
      version: "pocket-s30-supertrend-demarker-shadow-v1",
      enabled: this.state.enabled,
      mode: "shadow_only",
      source: { identity: POCKET_S30_SOURCE_FEED, venue: "Pocket Option OTC via OTCharts", sameSourceForEntryAndSettlement: true },
      streamStatus: this.runtime.streamStatus,
      streamSession: this.runtime.streamSession,
      config: this.state.config,
      totalEntries: this.state.pending.length + this.state.history.length,
      pending: this.state.pending.length,
      settled: this.state.history.length,
      observationDates: summarizePocketS30(this.state).observationDates,
      rejectionReasons: this.state.rejectionReasons,
      symbols: indicators
    };
  }

  async onQuote(input) {
    const now = Date.now();
    if (!this.state.enabled) return { ok: false, accepted: false, reason: "shadow_collection_not_started" };
    const checked = validatePocketS30Quote(input, now);
    if (!checked.ok) {
      countPocketS30Rejection(this.state, checked.reason, input?.symbol, now);
      await this.save();
      return { ok: false, accepted: false, reason: checked.reason };
    }
    const quote = checked.quote;
    const symbol = quote.symbol;
    const previousAt = Number(this.runtime.lastProviderAt[symbol] || 0);
    if (previousAt && quote.providerAt <= previousAt) {
      countPocketS30Rejection(this.state, quote.providerAt === previousAt ? "duplicate_source_quote" : "out_of_order_source_quote", symbol, now);
      return { ok: false, accepted: false, reason: quote.providerAt === previousAt ? "duplicate_source_quote" : "out_of_order_source_quote" };
    }
    this.runtime.lastProviderAt[symbol] = quote.providerAt;
    this.runtime.lastQuoteAt[symbol] = quote.receivedAt;
    this.runtime.streamSession = quote.streamSession || this.runtime.streamSession;
    const bucket = Math.floor(quote.providerAt / POCKET_S30_INTERVAL_MS) * POCKET_S30_INTERVAL_MS;
    let current = this.state.currentBars[symbol];
    if (current && bucket < Number(current.t)) {
      countPocketS30Rejection(this.state, "out_of_order_s30_tick", symbol, now);
      return { ok: false, accepted: false, reason: "out_of_order_s30_tick" };
    }
    let closed = null;
    if (!current) {
      const skip = this.skipFirstBucket.has(symbol);
      this.skipFirstBucket.delete(symbol);
      this.state.currentBars[symbol] = { t: bucket, o: quote.price, h: quote.price, l: quote.price, c: quote.price, n: 1, firstAt: quote.providerAt, lastAt: quote.providerAt, valid: !skip };
    } else if (bucket === Number(current.t)) {
      if (quote.providerAt - Number(current.lastAt) > POCKET_S30_MAX_SOURCE_GAP_MS) current.valid = false;
      current.h = Math.max(Number(current.h), quote.price);
      current.l = Math.min(Number(current.l), quote.price);
      current.c = quote.price;
      current.n = Number(current.n || 0) + 1;
      current.lastAt = quote.providerAt;
    } else {
      const oldBucket = Number(current.t);
      if (bucket - oldBucket !== POCKET_S30_INTERVAL_MS || quote.providerAt - Number(current.lastAt) > POCKET_S30_MAX_SOURCE_GAP_MS) current.valid = false;
      if (current.valid && current.n >= 2 &&
          Number(current.firstAt) <= oldBucket + POCKET_S30_MAX_SOURCE_GAP_MS &&
          Number(current.lastAt) >= oldBucket + POCKET_S30_INTERVAL_MS - POCKET_S30_MAX_SOURCE_GAP_MS) {
        closed = { t: oldBucket, o: Number(current.o), h: Number(current.h), l: Number(current.l), c: Number(current.c), n: Number(current.n) };
      } else {
        countPocketS30Rejection(this.state, "incomplete_or_gapped_s30_candle", symbol, now);
      }
      this.state.currentBars[symbol] = { t: bucket, o: quote.price, h: quote.price, l: quote.price, c: quote.price, n: 1, firstAt: quote.providerAt, lastAt: quote.providerAt, valid: bucket - oldBucket === POCKET_S30_INTERVAL_MS };
    }

    let entry = null;
    if (closed) {
      const bars = this.state.completedBars[symbol] || [];
      if (!bars.some(bar => bar.t === closed.t)) {
        bars.push(closed);
        this.state.completedBars[symbol] = bars.slice(-160);
      }
      if (this.state.lastEvaluatedBarAt[symbol] !== closed.t) {
        this.state.lastEvaluatedBarAt[symbol] = closed.t;
        const score = scorePocketS30(this.state.completedBars[symbol], { ...this.state.config, confirmationAt: quote.providerAt });
        if (!score.ok) {
          countPocketS30Rejection(this.state, score.reason, symbol, now);
        } else {
          const result = capturePocketS30Entry(this.state, {
            symbol, direction: score.direction, signalBarAt: closed.t, score, quote,
            config: this.state.config
          }, now);
          if (!result.ok) countPocketS30Rejection(this.state, result.reason, symbol, now);
          else if (!result.duplicate) entry = result.record;
        }
      }
      await this.save();
    }

    const settlement = ingestPocketS30Quote(this.state, quote, now);
    if (!settlement.ok && settlement.reason !== "duplicate_source_quote") {
      countPocketS30Rejection(this.state, settlement.reason, symbol, now);
    }
    if (settlement.settled?.length) await this.save();
    return { ok: true, accepted: true, entry, settled: settlement.settled || [], pending: this.state.pending.length };
  }

  async alarm() {
    await this.ready;
    if (this.state.enabled) {
      const expired = expirePocketS30Pending(this.state, Date.now());
      if (expired.expired.length) await this.save();
      await this.ensureFeed();
      await this.scheduleNextAlarm();
    }
  }
}
