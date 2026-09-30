// V13.6.1 — five-minute automatic sniper audit with blocker stats instrumentation
import { DurableObject } from "cloudflare:workers";

export const VERSION = "13.6.7-cruz-cluster-session-stats";
export const DEFAULT_SYMBOLS = "EUR/USD,USD/JPY,GBP/USD,USD/CAD,AUD/USD,USD/CHF";
export const FIXED_UNIVERSE = DEFAULT_SYMBOLS.split(",");
export const SHORT_SHADOW_UNIVERSE = Object.freeze([
  ...FIXED_UNIVERSE,

  "NZD/USD",
  "EUR/JPY",
  "GBP/JPY",
  "EUR/GBP",
  "AUD/JPY",
  "CAD/JPY"
]);
export const SHORT_SHADOW_ID = "cruz-1m-ichimoku-dmi-shadow-v1";
export const SHORT_SHADOW_EXPIRIES = Object.freeze([60, 120]);
export const SHORT_SHADOW_MAX_PENDING = 250;
export const SHORT_SHADOW_MAX_HISTORY = 1000;
export const CRYPTO_SYMBOLS = new Set();
export const A_GRADE_MIN_QUALITY = 0.895;
export const SHORT_SHADOW_MIN_QUALITY = 0.86;
export const EXPIRY_SECONDS = 300;
export const BLOCKER_CLASSIFIER_VERSION = "v3-detailed-5m";
export const STRATEGY_ID = "v13.6-signal-only";
export const PREPARE_TTL_MS = 10 * 60 * 1000;
export const PULLBACK_TTL_MS = 5 * 60 * 1000;
export const GLOBAL_SIGNAL_COOLDOWN_MS = 0;
export const PAIR_SIGNAL_COOLDOWN_MS = 6 * 60 * 1000;
export const LOSS_CIRCUIT_BREAKER_MS = 20 * 60 * 1000;

export function classifyBlocker(reason) {
  const r = String(reason || "").toLowerCase();

  // Setup is valid but still progressing toward an entry.
  if (
    r.includes("trend armed") ||
    r.includes("waiting for the next pullback") ||
    r.includes("pullback recorded") ||
    r.includes("waiting for a fresh 1m continuation")
  ) {
    return "setup_progression";
  }

  // Structural/trend conditions.
  if (
    r.includes("waiting for a clean completed 5m trend") ||
    r.includes("5m trend is neutral") ||
    r.includes("completed 5m trend is neutral") ||
    r.includes("5m direction changed") ||
    r.includes("5m efficiency") ||
    r.includes("5m bullish sma stack") ||
    r.includes("5m bearish sma stack") ||
    r.includes("5m sma5/13") ||
    r.includes("15m trend opposes") ||
    r.includes("opposite 15m trend") ||
    r.includes("fractal") ||
    r.includes("sma 5/13 stack reversed") ||
    r.includes("volatility")
  ) {
    return "core_structure";
  }

  // Confirmation/strength conditions.
  if (
    r.includes("adx/dmi") ||
    r.includes("momentum confluence") ||
    r.includes("momentum is 2/4") ||
    r.includes("continuation candle is missing") ||
    r.includes("fresh completed 1m continuation candle is missing") ||
    r.includes("candle pressure") ||
    r.includes("fast slope")
  ) {
    return "supporting_confirmation";
  }

  // Short-lived market/feed/timing conditions.
  if (
    r.includes("live tick") ||
    r.includes("fresh live-tick burst") ||
    r.includes("tick confirmation") ||
    r.includes("30s/live timing") ||
    r.includes("live feed stale") ||
    r.includes("tiingo quote timestamp") ||
    r.includes("waiting for first live tiingo quote") ||
    r.includes("price moved too far") ||
    r.includes("entry quote") ||
    r.includes("spread") ||
    r.includes("no valid live price")
  ) {
    return "transient_timing";
  }

  // Entry gates that can recover while the setup remains valid.
  if (
    r.includes("extension") ||
    r.includes("room") ||
    r.includes("pullback is no longer present") ||
    r.includes("pullback has not qualified") ||
    r.includes("final a-grade timing failed")
  ) {
    return "redundant_gate";
  }

  // Risk-management restrictions.
  if (
    r.includes("cooldown") ||
    r.includes("circuit breaker") ||
    r.includes("exposure")
  ) {
    return "risk_cooldown";
  }

  return "other";
}

export function classifyEfficiencyBand(reason) {
  const r = String(reason || "");

  const match = r.match(
    /5m efficiency\s+([0-9]*\.?[0-9]+)\s+below/i
  );

  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  let key;
  let label;

  if (value < 0.10) {
    key = "very_choppy";
    label = "< 0.10";
  } else if (value < 0.15) {
    key = "weak";
    label = "0.10–0.149";
  } else {
    key = "near_qualified";
    label = "0.15–0.199";
  }

  let fineKey = null;
  let fineLabel = null;

  if (value >= 0.15 && value < 0.17) {
    fineKey = "near_150_169";
    fineLabel = "0.150–0.169";
  } else if (value >= 0.17 && value < 0.18) {
    fineKey = "near_170_179";
    fineLabel = "0.170–0.179";
  } else if (value >= 0.18 && value < 0.19) {
    fineKey = "near_180_189";
    fineLabel = "0.180–0.189";
  } else if (value >= 0.19 && value < 0.20) {
    fineKey = "near_190_199";
    fineLabel = "0.190–0.199";
  }

  return {
    key,
    label,
    value,
    fineKey,
    fineLabel
  };
}

// V13.4 shadow validation only. This rule is logged and cannot admit or reject a signal.
export const V13_4_SHADOW = Object.freeze({ id: "v13.4-frozen-dmi-adx", dmiGapMin: 20.930996673679135, adxMax: 76.22584098021053 });
export const PRIMARY_WORKER_URL = "https://iq3m-predictor.michaeljerry8723.workers.dev";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, Number(x) || 0)); }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + Number(b), 0) / xs.length : NaN; }
function normalizeSymbol(input) {
  let s = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
  s = s.replace(/[-_]/g, "/");
  if (/^[A-Z]{6}$/.test(s)) s = s.slice(0, 3) + "/" + s.slice(3);
  return /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(s) ? s : null;
}
function toTiingoSymbol(symbol) {
  const s = normalizeSymbol(symbol);
  return s ? s.replace("/", "").toLowerCase() : null;
}
function fromTiingoSymbol(ticker) {
  const x = String(ticker || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{6}$/.test(x) ? x.slice(0, 3) + "/" + x.slice(3) : normalizeSymbol(x);
}
function tsMs(t) { const n = Number(t); if (!Number.isFinite(n)) return Date.now(); return n < 1e12 ? n * 1000 : n; }
function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json;charset=UTF-8" } }); }
function formatFxPrice(symbol, p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return "n/a";
  const s = String(symbol || "");
  return n.toFixed(s.endsWith("/JPY") ? 3 : 5);
}
function isCryptoSymbol(symbol) { return CRYPTO_SYMBOLS.has(normalizeSymbol(symbol)); }
function medianNumber(xs) {
  const a = (xs || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function spreadQualitySnapshot(symbol, ticks, last, atr) {
  const now = Date.now(), cutoff = now - 60000;
  const spreads = (ticks || [])
    .filter(t => Number(t.r || t.t) >= cutoff)
    .map(t => {
      const bid = Number(t.bid), ask = Number(t.ask);
      return Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid ? ask - bid : NaN;
    })
    .filter(Number.isFinite)
    .slice(-60);

  const spread = medianNumber(spreads);
  if (!Number.isFinite(spread) || spread <= 0 || !Number.isFinite(last) || last <= 0) {
    return { ready: false, abnormal: false, spread: null, spreadBps: null, spreadAtrRatio: null, samples: spreads.length };
  }

  const spreadBps = (spread / last) * 10000;
  const spreadAtrRatio = Number.isFinite(atr) && atr > 0 ? spread / atr : null;
  const s = normalizeSymbol(symbol);

  // Tiingo is our market-data reference, not the user's execution venue.
  // Spread is therefore a sanity veto only for clearly abnormal conditions,
  // not a hard filter on ordinary quote differences.
  let maxBps = 3.5, softBps = 1.0, maxAtr = 0.65;

  const extremeAbsolute = spreadBps > maxBps;
  const extremeRelative = Number.isFinite(spreadAtrRatio) && spreadAtrRatio > maxAtr && spreadBps > softBps;
  return {
    ready: true,
    abnormal: extremeAbsolute || extremeRelative,
    spread, spreadBps, spreadAtrRatio, samples: spreads.length,
    maxBps, maxAtr
  };
}

function buildBars(ticks, seconds) {
  const m = new Map(), span = seconds * 1000;
  for (const t of ticks) {
    const b = Math.floor(t.t / span) * span;
    let x = m.get(b);
    if (!x) { x = { t: b, o: t.p, h: t.p, l: t.p, c: t.p, n: 1 }; m.set(b, x); }
    else { x.h = Math.max(x.h, t.p); x.l = Math.min(x.l, t.p); x.c = t.p; x.n++; }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
function emaSeries(vals, p) {
  p = Math.max(2, Math.floor(p)); const out = new Array(vals.length).fill(NaN); if (vals.length < p) return out;
  let seed = mean(vals.slice(0, p)); out[p - 1] = seed; const k = 2 / (p + 1);
  for (let i = p; i < vals.length; i++) out[i] = Number(vals[i]) * k + out[i - 1] * (1 - k);
  return out;
}
function smaSeries(vals, p) {
  p = Math.max(2, Math.floor(p)); const out = new Array(vals.length).fill(NaN);
  if (vals.length < p) return out;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += Number(vals[i]);
    if (i >= p) sum -= Number(vals[i - p]);
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function smmaSeries(vals, p) {
  p = Math.max(2, Math.floor(p)); const out = new Array(vals.length).fill(NaN); if (vals.length < p) return out;
  let seed = mean(vals.slice(0, p)); out[p - 1] = seed;
  for (let i = p; i < vals.length; i++) out[i] = (out[i - 1] * (p - 1) + Number(vals[i])) / p;
  return out;
}
function macdSnapshot(bars, fast = 3, slow = 8, signal = 3) {
  if (!bars || bars.length < slow + signal + 3) return { ready: false };
  const c = bars.map(b => Number(b.c)), ef = emaSeries(c, fast), es = emaSeries(c, slow), m = [];
  for (let i = 0; i < c.length; i++) if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) m.push(ef[i] - es[i]);
  if (m.length < signal + 3) return { ready: false };
  const sig = emaSeries(m, signal), i = m.length - 1;
  const hist = m[i] - sig[i], ph = m[i - 1] - sig[i - 1], p2 = m[i - 2] - sig[i - 2];
  return { ready: true, macd: m[i], signal: sig[i], hist, prevHist: ph, rising: hist > ph && ph >= p2, falling: hist < ph && ph <= p2 };
}
function alligatorSnapshot(bars) {
  if (!bars || bars.length < 22) return { ready: false };
  const med = bars.map(b => (Number(b.h) + Number(b.l)) / 2);
  const jaws = smmaSeries(med, 13), teeth = smmaSeries(med, 8), lips = smmaSeries(med, 5), i = bars.length - 1;
  const j = jaws[i - 3], t = teeth[i - 2], l = lips[i - 1], pj = jaws[i - 4], pt = teeth[i - 3], pl = lips[i - 2];
  if (![j, t, l, pj, pt, pl].every(Number.isFinite)) return { ready: false };
  return { ready: true, jaws: j, teeth: t, lips: l, jawsSlope: j - pj, teethSlope: t - pt, lipsSlope: l - pl, gap: Math.abs(l - j), prevGap: Math.abs(pl - pj) };
}
function aroonSnapshot(bars, p = 7) {
  if (!bars || bars.length < p + 1) return { ready: false };
  const xs = bars.slice(-p); let hi = -Infinity, lo = Infinity, hiIdx = 0, loIdx = 0;
  xs.forEach((b, i) => { if (Number(b.h) >= hi) { hi = Number(b.h); hiIdx = i; } if (Number(b.l) <= lo) { lo = Number(b.l); loIdx = i; } });
  const sinceHi = p - 1 - hiIdx, sinceLo = p - 1 - loIdx;
  return { ready: true, up: 100 * (p - sinceHi) / p, down: 100 * (p - sinceLo) / p, spread: 100 * ((p - sinceHi) - (p - sinceLo)) / p };
}
function fractalSnapshot(bars, p = 2) {
  p = Math.max(1, Math.floor(p));
  if (!bars || bars.length < (p * 2 + 3)) return { ready: false };
  let lastHigh = null, lastLow = null;
  for (let i = p; i < bars.length - p; i++) {
    const b = bars[i];
    let high = true, low = true;
    for (let k = 1; k <= p; k++) {
      if (!(Number(b.h) > Number(bars[i - k].h) && Number(b.h) > Number(bars[i + k].h))) high = false;
      if (!(Number(b.l) < Number(bars[i - k].l) && Number(b.l) < Number(bars[i + k].l))) low = false;
    }
    if (high) lastHigh = { price: Number(b.h), t: b.t };
    if (low) lastLow = { price: Number(b.l), t: b.t };
  }
  return { ready: Boolean(lastHigh || lastLow), lastHigh, lastLow, period: p };
}
function tickImpulse(ticks) {
  const xs = ticks.slice(-24); if (xs.length < 8) return { ready: false, samples: xs.length };
  let up = 0, down = 0, abs = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i].p - xs[i - 1].p; if (d > 0) up++; else if (d < 0) down++; abs += Math.abs(d);
  }
  const delta = xs.at(-1).p - xs[0].p, avg = abs / Math.max(1, xs.length - 1);
  return { ready: true, samples: xs.length, upRatio: up / Math.max(1, up + down), downRatio: down / Math.max(1, up + down), delta, norm: avg > 0 ? delta / avg : 0 };
}

function smaTrendSnapshot(bars, fast = 2, slow = 5) {
  if (!bars || bars.length < slow + 2) return { ready: false };
  const c = bars.map(b => Number(b.c)), sf = smaSeries(c, fast), ss = smaSeries(c, slow), i = c.length - 1;
  if (![sf[i], sf[i - 1], ss[i], ss[i - 1]].every(Number.isFinite)) return { ready: false };
  return {
    ready: true,
    fast: sf[i], slow: ss[i],
    prevFast: sf[i - 1], prevSlow: ss[i - 1],
    fastSlope: sf[i] - sf[i - 1],
    slowSlope: ss[i] - ss[i - 1],
    crossedUp: sf[i] > ss[i] && sf[i - 1] <= ss[i - 1],
    crossedDown: sf[i] < ss[i] && sf[i - 1] >= ss[i - 1]
  };
}
function parseUtcDateTime(v) {
  const x = String(v || "").trim().replace(" ", "T");
  if (!x) return NaN;
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(x) ? x : x + "Z");
}

function aggregateOhlcBars(bars, seconds) {
  const span = seconds * 1000, m = new Map();
  for (const b of bars || []) {
    const bucket = Math.floor(Number(b.t) / span) * span;
    let x = m.get(bucket);
    if (!x) {
      x = { t: bucket, o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), n: Number(b.n || 1) };
      m.set(bucket, x);
    } else {
      x.h = Math.max(x.h, Number(b.h));
      x.l = Math.min(x.l, Number(b.l));
      x.c = Number(b.c);
      x.n += Number(b.n || 1);
    }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
function atrSnapshot(bars, p = 14) {
  if (!bars || bars.length < p + 1) return { ready: false };
  const xs = bars.slice(-(p + 1)); let sum = 0;
  for (let i = 1; i < xs.length; i++) {
    const h = Number(xs[i].h), l = Number(xs[i].l), pc = Number(xs[i - 1].c);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return { ready: true, atr: sum / p };
}
function efficiencyRatio(bars, p = 8) {
  if (!bars || bars.length < p + 1) return 0;
  const xs = bars.slice(-(p + 1)).map(b => Number(b.c));
  const net = Math.abs(xs.at(-1) - xs[0]);
  let travel = 0;
  for (let i = 1; i < xs.length; i++)travel += Math.abs(xs[i] - xs[i - 1]);
  return travel > 0 ? net / travel : 0;
}
function regime5mSnapshot(bars1m) {
  const currentMinute = Math.floor(Date.now() / 60000) * 60000;
  const b5 = aggregateOhlcBars(bars1m, 300)
    .filter(b => Number(b.t) + 300000 <= currentMinute);
  if (b5.length < 15) return { ready: false, bars: b5.length };
  const c = b5.map(b => Number(b.c)), e5 = emaSeries(c, 5), e13 = emaSeries(c, 13), i = c.length - 1;
  if (![e5[i], e5[i - 1], e13[i], e13[i - 1]].every(Number.isFinite)) return { ready: false, bars: b5.length };
  const eff = efficiencyRatio(b5, 8);
  let direction = "NEUTRAL";
  if (e5[i] > e13[i] && e5[i] > e5[i - 1] && e13[i] >= e13[i - 1] && eff >= 0.32) direction = "CALL";
  if (e5[i] < e13[i] && e5[i] < e5[i - 1] && e13[i] <= e13[i - 1] && eff >= 0.32) direction = "PUT";
  return { ready: true, direction, efficiency: eff, emaFast: e5[i], emaSlow: e13[i], bars: b5.length };
}

function rsiSnapshot(bars, p = 7) {
  if (!bars || bars.length < p + 2) return { ready: false };
  const c = bars.map(b => Number(b.c));
  let gains = 0, losses = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / p, avgLoss = losses / p;
  if (avgLoss === 0) return { ready: true, rsi: 100 };
  const rs = avgGain / avgLoss;
  return { ready: true, rsi: 100 - (100 / (1 + rs)) };
}
function dmiAdxSnapshot(bars, p = 7) {
  if (!bars || bars.length < (p * 2 + 2)) return { ready: false };
  const trs = [], plus = [], minus = [];
  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i].h), l = Number(bars[i].l), ph = Number(bars[i - 1].h), pl = Number(bars[i - 1].l), pc = Number(bars[i - 1].c);
    const up = h - ph, dn = pl - l;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    plus.push(up > dn && up > 0 ? up : 0);
    minus.push(dn > up && dn > 0 ? dn : 0);
  }
  const dx = [];
  for (let i = p - 1; i < trs.length; i++) {
    let tr = 0, pdm = 0, mdm = 0;
    for (let j = i - p + 1; j <= i; j++) { tr += trs[j]; pdm += plus[j]; mdm += minus[j]; }
    if (tr <= 0) { dx.push(NaN); continue; }
    const pdi = 100 * pdm / tr, mdi = 100 * mdm / tr;
    dx.push((pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  const valid = dx.filter(Number.isFinite);
  if (valid.length < p) return { ready: false };
  const adx = mean(valid.slice(-p));
  let tr = 0, pdm = 0, mdm = 0;
  for (let j = trs.length - p; j < trs.length; j++) { tr += trs[j]; pdm += plus[j]; mdm += minus[j]; }
  if (tr <= 0) return { ready: false };
  return { ready: true, adx, plusDI: 100 * pdm / tr, minusDI: 100 * mdm / tr };
}
function candlePressure(bars, n = 3) {
  const xs = (bars || []).slice(-n);
  if (xs.length < n) return { ready: false };
  let bull = 0, bear = 0;
  for (const b of xs) {
    const d = Number(b.c) - Number(b.o);
    if (d > 0) bull++; else if (d < 0) bear++;
  }
  return { ready: true, bull, bear };
}

function completedAggregate(bars1m, seconds) {
  const nowBucket = Math.floor(Date.now() / (seconds * 1000)) * (seconds * 1000);
  return aggregateOhlcBars(bars1m, seconds).filter(b => Number(b.t) < nowBucket);
}
function trendRegime(bars, fast = 5, slow = 13, minEfficiency = 0.25) {
  if (!bars || bars.length < slow + 3) {
    return {
      ready: false,
      direction: "NEUTRAL",
      efficiency: 0,
      reason: `completed 5m context insufficient (${bars?.length || 0}/${slow + 3} bars)`
    };
  }

  const c = bars.map(b => Number(b.c));
  const sf = smaSeries(c, fast);
  const ss = smaSeries(c, slow);
  const i = c.length - 1;

  if (![sf[i], sf[i - 1], ss[i], ss[i - 1]].every(Number.isFinite)) {
    return {
      ready: false,
      direction: "NEUTRAL",
      efficiency: 0,
      reason: "5m SMA5/13 context unavailable"
    };
  }

  const eff = efficiencyRatio(
    bars,
    Math.min(8, bars.length - 1)
  );

  const fastSlope = sf[i] - sf[i - 1];

  let direction = "NEUTRAL";
  let reason = null;

  if (
    sf[i] > ss[i] &&
    sf[i] >= sf[i - 1] &&
    eff >= minEfficiency
  ) {
    direction = "CALL";
  } else if (
    sf[i] < ss[i] &&
    sf[i] <= sf[i - 1] &&
    eff >= minEfficiency
  ) {
    direction = "PUT";
  } else if (eff < minEfficiency) {
    reason =
      `5m efficiency ${eff.toFixed(3)} below ${minEfficiency.toFixed(3)}`;
  } else if (
    sf[i] > ss[i] &&
    fastSlope < 0
  ) {
    reason =
      "5m bullish SMA stack but fast SMA slope turned down";
  } else if (
    sf[i] < ss[i] &&
    fastSlope > 0
  ) {
    reason =
      "5m bearish SMA stack but fast SMA slope turned up";
  } else {
    reason =
      "5m SMA5/13 stack is not directionally aligned";
  }

  return {
    ready: true,
    direction,
    efficiency: eff,
    fast: sf[i],
    slow: ss[i],
    fastSlope,
    reason
  };
}
function roomToMoveSnapshot(bars1m, last, direction, atr) {
  const b15 = completedAggregate(bars1m, 900).slice(-32);
  if (b15.length < 7 || !Number.isFinite(atr) || atr <= 0) return { ready: false, roomAtr: 0, level: null, source: "not-ready" };

  // Use confirmed 15m swing levels, not every historical candle wick. The old
  // nearest-wick method repeatedly treated minor noise as resistance/support and
  // cancelled READY setups even while the broader structure remained valid.
  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < b15.length - 2; i++) {
    const h = Number(b15[i].h), l = Number(b15[i].l);
    if (Number.isFinite(h) &&
      h >= Number(b15[i - 1].h) && h >= Number(b15[i - 2].h) &&
      h > Number(b15[i + 1].h) && h > Number(b15[i + 2].h)) pivotHighs.push(h);
    if (Number.isFinite(l) &&
      l <= Number(b15[i - 1].l) && l <= Number(b15[i - 2].l) &&
      l < Number(b15[i + 1].l) && l < Number(b15[i + 2].l)) pivotLows.push(l);
  }

  if (direction === "CALL") {
    const levels = pivotHighs.filter(x => x > last);
    if (!levels.length) return { ready: true, roomAtr: Infinity, level: null, source: "15m-swing" };
    const level = Math.min(...levels);
    return { ready: true, roomAtr: (level - last) / atr, level, source: "15m-swing" };
  }

  const levels = pivotLows.filter(x => x < last);
  if (!levels.length) return { ready: true, roomAtr: Infinity, level: null, source: "15m-swing" };
  const level = Math.max(...levels);
  return { ready: true, roomAtr: (last - level) / atr, level, source: "15m-swing" };
}

function isHardReadyInvalidation(reason) {
  const r = String(reason || "").toLowerCase();
  return r.includes("completed 5m direction changed") ||
    r.includes("fractal structure failed") ||
    r.includes("sma 5/13 stack reversed") ||
    r.includes("strong opposite 15m trend");
}

function usdExposureSide(symbol, direction) {
  const s = normalizeSymbol(symbol);
  const d = String(direction || "").toUpperCase();
  if (!s || !["CALL", "PUT"].includes(d)) return null;
  const usdBase = new Set(["USD/JPY", "USD/CAD", "USD/CHF"]);
  const usdQuote = new Set(["EUR/USD", "GBP/USD", "AUD/USD"]);
  if (usdBase.has(s)) return d === "CALL" ? "USD_LONG" : "USD_SHORT";
  if (usdQuote.has(s)) return d === "CALL" ? "USD_SHORT" : "USD_LONG";
  return null;
}
function rangeMidpointAt(bars, endIndex, period) {
  const p = Math.max(1, Math.floor(period));
  const startIndex = endIndex - p + 1;

  if (
    !Array.isArray(bars) ||
    startIndex < 0 ||
    endIndex >= bars.length
  ) {
    return NaN;
  }

  let highest = -Infinity;
  let lowest = Infinity;

  for (let i = startIndex; i <= endIndex; i++) {
    const high = Number(bars[i]?.h);
    const low = Number(bars[i]?.l);

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low)
    ) {
      return NaN;
    }

    highest = Math.max(highest, high);
    lowest = Math.min(lowest, low);
  }

  return (highest + lowest) / 2;
}


export function cruzIchimokuSnapshot(
  bars,
  tenkanPeriod = 5,
  kijunPeriod = 10,
  spanBPeriod = 20
) {
  if (
    !Array.isArray(bars) ||
    bars.length < spanBPeriod + 2
  ) {
    return {
      ready: false,
      bars: Array.isArray(bars)
        ? bars.length
        : 0
    };
  }

  const i = bars.length - 1;
  const prev = i - 1;

  const tenkan =
    rangeMidpointAt(
      bars,
      i,
      tenkanPeriod
    );

  const kijun =
    rangeMidpointAt(
      bars,
      i,
      kijunPeriod
    );

  const spanB =
    rangeMidpointAt(
      bars,
      i,
      spanBPeriod
    );

  const prevTenkan =
    rangeMidpointAt(
      bars,
      prev,
      tenkanPeriod
    );

  const prevKijun =
    rangeMidpointAt(
      bars,
      prev,
      kijunPeriod
    );

  const prevSpanB =
    rangeMidpointAt(
      bars,
      prev,
      spanBPeriod
    );

  const spanA =
    (tenkan + kijun) / 2;

  const prevSpanA =
    (prevTenkan + prevKijun) / 2;

  const values = [
    tenkan,
    kijun,
    spanA,
    spanB,
    prevTenkan,
    prevKijun,
    prevSpanA,
    prevSpanB
  ];

  if (!values.every(Number.isFinite)) {
    return {
      ready: false,
      bars: bars.length
    };
  }

  return {
    ready: true,

    tenkanPeriod,
    kijunPeriod,
    spanBPeriod,

    tenkan,
    kijun,
    spanA,
    spanB,

    prevTenkan,
    prevKijun,
    prevSpanA,
    prevSpanB,

    cloudTop:
      Math.max(spanA, spanB),

    cloudBottom:
      Math.min(spanA, spanB),

    prevCloudTop:
      Math.max(
        prevSpanA,
        prevSpanB
      ),

    prevCloudBottom:
      Math.min(
        prevSpanA,
        prevSpanB
      )
  };
}
function wilderRmaSeries(values, period) {
  const p = Math.max(1, Math.floor(period));

  const out = new Array(values.length).fill(NaN);

  if (values.length < p) {
    return out;
  }

  let seed = 0;

  for (let i = 0; i < p; i++) {
    seed += Number(values[i]);
  }

  seed /= p;
  out[p - 1] = seed;

  for (let i = p; i < values.length; i++) {
    out[i] =
      (
        out[i - 1] * (p - 1) +
        Number(values[i])
      ) / p;
  }

  return out;
}
export function cruzDmiSnapshot(
  bars,
  diLength = 7,
  adxSmoothing = 14
) {
  if (
    !Array.isArray(bars) ||
    bars.length < diLength + adxSmoothing + 3
  ) {
    return {
      ready: false,
      bars: Array.isArray(bars)
        ? bars.length
        : 0
    };
  }

  const tr = [];
  const plusDm = [];
  const minusDm = [];

  for (let i = 1; i < bars.length; i++) {
    const high = Number(bars[i].h);
    const low = Number(bars[i].l);

    const prevHigh = Number(bars[i - 1].h);
    const prevLow = Number(bars[i - 1].l);
    const prevClose = Number(bars[i - 1].c);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );

    plusDm.push(
      upMove > downMove && upMove > 0
        ? upMove
        : 0
    );

    minusDm.push(
      downMove > upMove && downMove > 0
        ? downMove
        : 0
    );
  }

  const smoothTr =
    wilderRmaSeries(tr, diLength);

  const smoothPlus =
    wilderRmaSeries(plusDm, diLength);

  const smoothMinus =
    wilderRmaSeries(minusDm, diLength);

  const plusDI =
    new Array(tr.length).fill(NaN);

  const minusDI =
    new Array(tr.length).fill(NaN);

  const dx = [];

  for (let i = 0; i < tr.length; i++) {
    if (
      !Number.isFinite(smoothTr[i]) ||
      smoothTr[i] <= 0
    ) {
      continue;
    }

    plusDI[i] =
      100 * smoothPlus[i] / smoothTr[i];

    minusDI[i] =
      100 * smoothMinus[i] / smoothTr[i];

    const total =
      plusDI[i] + minusDI[i];

    if (total > 0) {
      dx.push(
        100 *
        Math.abs(
          plusDI[i] - minusDI[i]
        ) /
        total
      );
    }
  }

  const adxSeries =
    wilderRmaSeries(
      dx,
      adxSmoothing
    );

  const currentPlus =
    plusDI.at(-1);

  const currentMinus =
    minusDI.at(-1);

  const previousPlus =
    plusDI.at(-2);

  const previousMinus =
    minusDI.at(-2);

  const adx =
    adxSeries.at(-1);

  if (
    ![
      currentPlus,
      currentMinus,
      previousPlus,
      previousMinus
    ].every(Number.isFinite)
  ) {
    return {
      ready: false,
      bars: bars.length
    };
  }

  return {
    ready: true,

    diLength,
    adxSmoothing,

    plusDI: currentPlus,
    minusDI: currentMinus,

    previousPlusDI: previousPlus,
    previousMinusDI: previousMinus,

    crossUp:
      currentPlus > currentMinus &&
      previousPlus <= previousMinus,

    crossDown:
      currentMinus > currentPlus &&
      previousMinus <= previousPlus,

    adx:
      Number.isFinite(adx)
        ? adx
        : null,

    gap:
      Math.abs(
        currentPlus - currentMinus
      )
  };
}

export function setupSequenceSnapshot(bars1m) {
  const sma = smaTrendSnapshot(bars1m, 5, 13);
  const fr = fractalSnapshot(bars1m, 2);
  const atr = atrSnapshot(bars1m, 14);
  const b5 = completedAggregate(bars1m, 300);
  const reg5 = trendRegime(b5, 5, 13, 0.20);
  if (!sma.ready || !fr.ready || !atr.ready || !reg5.ready) {
    return {
      ready: false,
      direction: "NEUTRAL",
      trendReason: reg5.reason || "completed 5m trend context unavailable"
    };
  }

  const direction = reg5.direction;
  const lastBar = bars1m.at(-1);
  if (!lastBar || direction === "NEUTRAL") {
    return {
      ready: true,
      direction: "NEUTRAL",
      barT: Number(lastBar?.t || 0),
      trendReason: reg5.reason || "5m trend is neutral",
      regimeEfficiency: reg5.efficiency,
      smaFast5m: reg5.fast,
      smaSlow5m: reg5.slow,
      smaFast5mSlope: reg5.fastSlope
    };
  }

  const last = Number(lastBar.c);
  const structureOk = direction === "CALL"
    ? (!fr.lastLow || last > Number(fr.lastLow.price))
    : (!fr.lastHigh || last < Number(fr.lastHigh.price));

  // V13: the pullback must actually visit the 5/13 SMA zone, not merely approach it.
  const zoneLow = Math.min(sma.fast, sma.slow) - 0.18 * atr.atr;
  const zoneHigh = Math.max(sma.fast, sma.slow) + 0.18 * atr.atr;
  const recent = bars1m.slice(-4);
  const pullbackSeen = recent.some(b => Number(b.l) <= zoneHigh && Number(b.h) >= zoneLow);
  const pullbackBeforeLast = bars1m.slice(-4, -1).some(b => Number(b.l) <= zoneHigh && Number(b.h) >= zoneLow);

  const lastCandleBull = Number(lastBar.c) > Number(lastBar.o) && Number(lastBar.c) > sma.fast;
  const lastCandleBear = Number(lastBar.c) < Number(lastBar.o) && Number(lastBar.c) < sma.fast;
  const resumed = direction === "CALL" ? lastCandleBull : lastCandleBear;

  return {
    ready: true, direction, barT: Number(lastBar.t), structureOk, pullbackSeen, pullbackBeforeLast, resumed,
    smaFast: sma.fast, smaSlow: sma.slow, atr: atr.atr, regimeEfficiency: reg5.efficiency
  };
}

function completedTickBars(ticks, seconds) {
  const span = seconds * 1000;
  const current = Math.floor(Date.now() / span) * span;
  return buildBars(ticks, seconds).filter(b => Number(b.t) < current);
}
export function scoreCruz1mShadow(
  ticks,
  bars1m,
  symbol
) {
  if (
    !Array.isArray(bars1m) ||
    bars1m.length < 30
  ) {
    return {
      ok: false,
      reason: "Cruz 1m context is still building"
    };
  }

  const ichi =
    cruzIchimokuSnapshot(
      bars1m,
      5,
      10,
      20
    );

  const dmi =
    cruzDmiSnapshot(
      bars1m,
      7,
      14
    );

  if (!ichi.ready || !dmi.ready) {
    return {
      ok: false,
      reason: "Cruz Ichimoku/DMI context is not ready"
    };
  }

  const current =
    bars1m.at(-1);

  const previous =
    bars1m.at(-2);

  if (!current || !previous) {
    return {
      ok: false,
      reason: "Cruz 1m candles unavailable"
    };
  }

  const currentOpen =
    Number(current.o);

  const currentClose =
    Number(current.c);

  const previousClose =
    Number(previous.c);

  if (
    ![
      currentOpen,
      currentClose,
      previousClose
    ].every(Number.isFinite)
  ) {
    return {
      ok: false,
      reason: "Cruz candle prices invalid"
    };
  }

  const bullishCandle =
    currentClose > currentOpen;

  const bearishCandle =
    currentClose < currentOpen;


  // -------------------------------------------------
  // ICHIMOKU BREAK / RECLAIM
  // -------------------------------------------------

  const bullishSpanBBreak =
    previousClose <= ichi.prevSpanB &&
    currentClose > ichi.spanB;

  const bearishSpanBBreak =
    previousClose >= ichi.prevSpanB &&
    currentClose < ichi.spanB;


  const bullishCloudBreak =
    previousClose <= ichi.prevCloudTop &&
    currentClose > ichi.cloudTop;

  const bearishCloudBreak =
    previousClose >= ichi.prevCloudBottom &&
    currentClose < ichi.cloudBottom;


  const bullishIchimokuBreak =
    bullishSpanBBreak ||
    bullishCloudBreak;

  const bearishIchimokuBreak =
    bearishSpanBBreak ||
    bearishCloudBreak;


  // -------------------------------------------------
  // CRUZ BUY
  // +DI crosses ABOVE -DI
  // while price breaks/reclaims Ichimoku resistance
  // -------------------------------------------------

  const callSetup =
    dmi.crossUp &&
    bullishCandle &&
    bullishIchimokuBreak;


  // -------------------------------------------------
  // CRUZ SELL
  // -DI crosses ABOVE +DI
  // while price breaks below Ichimoku support
  // -------------------------------------------------

  const putSetup =
    dmi.crossDown &&
    bearishCandle &&
    bearishIchimokuBreak;


  if (!callSetup && !putSetup) {
    let reason =
      "Cruz entry conditions are not aligned";

    if (
      !dmi.crossUp &&
      !dmi.crossDown
    ) {
      reason =
        "no fresh Cruz DI crossover";
    } else if (
      dmi.crossUp &&
      !bullishCandle
    ) {
      reason =
        "+DI crossed up but 1m candle is not bullish";
    } else if (
      dmi.crossDown &&
      !bearishCandle
    ) {
      reason =
        "-DI crossed up but 1m candle is not bearish";
    } else if (
      dmi.crossUp &&
      !bullishIchimokuBreak
    ) {
      reason =
        "+DI crossed up but bullish Ichimoku break is missing";
    } else if (
      dmi.crossDown &&
      !bearishIchimokuBreak
    ) {
      reason =
        "-DI crossed up but bearish Ichimoku break is missing";
    }

    return {
      ok: false,
      reason,

      plusDI: dmi.plusDI,
      minusDI: dmi.minusDI,
      adx: dmi.adx,

      dmiCrossUp: dmi.crossUp,
      dmiCrossDown: dmi.crossDown,

      spanB: ichi.spanB,
      cloudTop: ichi.cloudTop,
      cloudBottom: ichi.cloudBottom
    };
  }


  const direction =
    callSetup
      ? "CALL"
      : "PUT";


  // Execution safeguard only.
  // This is NOT part of the Cruz strategy itself.
  const lastLive =
    Number(ticks?.at(-1)?.p);

  if (Number.isFinite(lastLive)) {
    const atr =
      atrSnapshot(
        bars1m,
        14
      );

    if (atr.ready) {
      const spread =
        spreadQualitySnapshot(
          symbol,
          ticks,
          lastLive,
          atr.atr
        );

      if (spread.abnormal) {
        return {
          ok: false,
          reason:
            "Cruz setup qualified but live spread is abnormal",
          strategyQualified: true,
          direction
        };
      }
    }
  }


  return {
    ok: true,

    strategyId:
      "cruz-1m-ichimoku-dmi-v1",

    direction,

    timeframe: "1m",

    expiryCandidates: [60, 120],


    // Exact configured indicator values
    ichimoku: {
      tenkanPeriod: 5,
      kijunPeriod: 10,
      spanBPeriod: 20,

      tenkan: ichi.tenkan,
      kijun: ichi.kijun,

      spanA: ichi.spanA,
      spanB: ichi.spanB,

      cloudTop: ichi.cloudTop,
      cloudBottom: ichi.cloudBottom
    },


    dmi: {
      diLength: 7,
      adxSmoothing: 14,

      plusDI: dmi.plusDI,
      minusDI: dmi.minusDI,

      previousPlusDI:
        dmi.previousPlusDI,

      previousMinusDI:
        dmi.previousMinusDI,

      crossUp:
        dmi.crossUp,

      crossDown:
        dmi.crossDown,

      adx:
        dmi.adx,

      gap:
        dmi.gap
    },


    trigger: {
      bullishCandle,
      bearishCandle,

      bullishSpanBBreak,
      bearishSpanBBreak,

      bullishCloudBreak,
      bearishCloudBreak
    },


    reasons:
      direction === "CALL"
        ? [
          "+DI crossed above -DI",
          "bullish 1m confirmation candle",
          "bullish Ichimoku break/reclaim"
        ]
        : [
          "-DI crossed above +DI",
          "bearish 1m confirmation candle",
          "bearish Ichimoku break/breakdown"
        ]
  };
}

export function scoreShortExpiryShadow(ticks, bars1m, symbol) {
  const sma = smaTrendSnapshot(bars1m, 3, 8);
  const macd = macdSnapshot(bars1m, 3, 8, 3);
  const rsi = rsiSnapshot(bars1m, 7);
  const dmi = dmiAdxSnapshot(bars1m, 7);
  const pressure = candlePressure(bars1m, 2);
  const atr = atrSnapshot(bars1m, 14);
  const impulse = tickImpulse(ticks);

  if (
    !sma.ready ||
    !macd.ready ||
    !rsi.ready ||
    !dmi.ready ||
    !pressure.ready ||
    !atr.ready ||
    !impulse.ready
  ) {
    return {
      ok: false,
      reason: "short-expiry context is still building"
    };
  }

  const lastBar = bars1m.at(-1);
  const last = Number(ticks.at(-1)?.p);

  if (!lastBar || !Number.isFinite(last)) {
    return {
      ok: false,
      reason: "short-expiry live price unavailable"
    };
  }

  const spread = spreadQualitySnapshot(
    symbol,
    ticks,
    last,
    atr.atr
  );

  if (spread.abnormal) {
    return {
      ok: false,
      reason: "spread is abnormal for short-expiry entry"
    };
  }

  let direction = "NEUTRAL";

  if (
    sma.fast > sma.slow &&
    sma.fastSlope > 0
  ) {
    direction = "CALL";
  }

  if (
    sma.fast < sma.slow &&
    sma.fastSlope < 0
  ) {
    direction = "PUT";
  }

  if (direction === "NEUTRAL") {
    return {
      ok: false,
      reason: "1m fast trend is not directional"
    };
  }

  const continuation =
    direction === "CALL"
      ? (
        Number(lastBar.c) > Number(lastBar.o) &&
        Number(lastBar.c) > sma.fast
      )
      : (
        Number(lastBar.c) < Number(lastBar.o) &&
        Number(lastBar.c) < sma.fast
      );

  if (!continuation) {
    return {
      ok: false,
      reason: "fresh 1m continuation candle missing"
    };
  }

  const efficiency =
    efficiencyRatio(bars1m, 5);

  if (efficiency < 0.12) {
    return {
      ok: false,
      reason:
        `short-expiry efficiency ${efficiency.toFixed(3)} below 0.120`
    };
  }

  const extensionAtr =
    Math.abs(last - sma.fast) / atr.atr;

  if (extensionAtr > 1.75) {
    return {
      ok: false,
      reason:
        `short-expiry entry extended ${extensionAtr.toFixed(2)} ATR`
    };
  }

  const macdAligned =
    direction === "CALL"
      ? (
        macd.macd > macd.signal &&
        macd.hist > 0
      )
      : (
        macd.macd < macd.signal &&
        macd.hist < 0
      );

  const rsiAligned =
    direction === "CALL"
      ? rsi.rsi >= 50 && rsi.rsi <= 78
      : rsi.rsi <= 50 && rsi.rsi >= 22;

  const dmiGap =
    Math.abs(dmi.plusDI - dmi.minusDI);

  const dmiAligned =
    direction === "CALL"
      ? dmi.plusDI > dmi.minusDI
      : dmi.minusDI > dmi.plusDI;

  const dmiStrong =
    dmiAligned &&
    dmi.adx >= 16 &&
    dmiGap >= 3;

  const pressureAligned =
    direction === "CALL"
      ? pressure.bull >= 1
      : pressure.bear >= 1;

  const tickAligned =
    direction === "CALL"
      ? (
        impulse.upRatio >= 0.57 &&
        impulse.norm >= 0.08
      )
      : (
        impulse.downRatio >= 0.57 &&
        impulse.norm <= -0.08
      );

  if (!tickAligned) {
    return {
      ok: false,
      reason: "live tick burst does not confirm short-expiry direction"
    };
  }

  const confirmations = {
    macd: macdAligned,
    rsi: rsiAligned,
    dmi: dmiStrong,
    pressure: pressureAligned
  };

  const confirmationCount =
    Object.values(confirmations)
      .filter(Boolean)
      .length;

  if (confirmationCount < 3) {
    return {
      ok: false,
      reason:
        `short-expiry momentum ${confirmationCount}/4 — need at least 3/4`,
      confirmations
    };
  }

  // Broader 5m context is a veto only.
  // It does not create the 1–2 minute signal.
  const b5 =
    completedAggregate(bars1m, 300);

  const broad =
    trendRegime(b5, 3, 8, 0.12);

  if (
    broad.ready &&
    broad.direction !== "NEUTRAL" &&
    broad.direction !== direction &&
    broad.efficiency >= 0.30
  ) {
    return {
      ok: false,
      reason: "strong completed 5m trend opposes short-expiry entry"
    };
  }

  let quality =
    0.80 +
    confirmationCount * 0.025;

  if (efficiency >= 0.25) {
    quality += 0.015;
  }

  if (dmi.adx >= 22) {
    quality += 0.015;
  }

  if (
    direction === "CALL"
      ? impulse.upRatio >= 0.65
      : impulse.downRatio >= 0.65
  ) {
    quality += 0.015;
  }

  if (
    broad.ready &&
    broad.direction === direction
  ) {
    quality += 0.015;
  }

  if (extensionAtr <= 0.80) {
    quality += 0.01;
  }

  quality = clamp(
    quality,
    0,
    0.97
  );

  if (quality < SHORT_SHADOW_MIN_QUALITY) {
    return {
      ok: false,
      reason:
        `short-expiry quality ${(quality * 100).toFixed(1)}% below threshold`,
      quality
    };
  }

  return {
    ok: true,
    strategyId: SHORT_SHADOW_ID,
    direction,
    quality,

    expiryCandidates: [60, 120],

    timeframe: "1m",

    efficiency,
    extensionAtr,

    smaFast: sma.fast,
    smaSlow: sma.slow,
    fastSlope: sma.fastSlope,

    rsi: rsi.rsi,
    adx: dmi.adx,
    dmiGap,

    tickUpRatio: impulse.upRatio,
    tickDownRatio: impulse.downRatio,
    tickNorm: impulse.norm,

    confirmationCount,
    confirmations,

    broad5m:
      broad.ready
        ? broad.direction
        : "NOT_READY"
  };
}

export function score5m(ticks, bars1m, symbol) {
  const sma1 = smaTrendSnapshot(bars1m, 5, 13);
  const fr1 = fractalSnapshot(bars1m, 2);
  const m1 = macdSnapshot(bars1m, 5, 13, 4);
  const ar1 = aroonSnapshot(bars1m, 14);
  const atr1 = atrSnapshot(bars1m, 14);
  const rsi1 = rsiSnapshot(bars1m, 7);
  const dmi = dmiAdxSnapshot(bars1m, 7);
  const pressure = candlePressure(bars1m, 3);

  const b5 = completedAggregate(bars1m, 300);
  const b15 = completedAggregate(bars1m, 900);
  const regime5 = trendRegime(b5, 5, 13, 0.20);
  const regime15 = trendRegime(b15, 3, 8, 0.18);

  const b30 = completedTickBars(ticks, 30);
  const m30 = macdSnapshot(b30, 3, 8, 3);

  if (!sma1.ready || !fr1.ready || !m1.ready || !ar1.ready || !atr1.ready || !rsi1.ready ||
    !dmi.ready || !pressure.ready || !regime5.ready) {
    return { ok: false, grade: "NO TRADE", reason: "5-minute sniper context is still building" };
  }

  const last = Number(ticks.at(-1)?.p);
  if (!Number.isFinite(last)) return { ok: false, grade: "NO TRADE", reason: "no valid live price" };

  const spreadInfo = spreadQualitySnapshot(symbol, ticks, last, atr1.atr);
  const spreadAtrRatio = spreadInfo.spreadAtrRatio;
  const spreadBps = spreadInfo.spreadBps;
  const atrRatio = last > 0 ? atr1.atr / last : 0;

  // Five-minute trades are highly sensitive to spread and abnormal volatility.
  if (spreadInfo.abnormal ||
    (Number.isFinite(spreadAtrRatio) && spreadAtrRatio > 0.35 && Number(spreadBps) > 0.80)) {
    return {
      ok: false, grade: "NO TRADE", reason: "spread is too large for a 5-minute entry",
      spreadAtrRatio, spreadBps
    };
  }
  if (atrRatio < 0.000008 || atrRatio > 0.0028) {
    return { ok: false, grade: "NO TRADE", reason: "volatility is outside the 5-minute sniper range", atrRatio };
  }

  const direction = regime5.direction;
  if (direction === "NEUTRAL") {
    return { ok: false, grade: "NO TRADE", reason: "completed 5m trend is neutral" };
  }

  // A strong opposite 15m trend vetoes the short-expiry setup.
  if (regime15.ready && regime15.direction !== "NEUTRAL" && regime15.direction !== direction && regime15.efficiency >= 0.30) {
    return {
      ok: false, grade: "NO TRADE", reason: "15m trend opposes the 5-minute setup",
      coreDirection: direction, regime15: regime15.direction
    };
  }

  // For a five-minute hold the SMA stack is the structural hard gate. The fast
  // slope can briefly flatten after a pullback, so it contributes to quality rather
  // than automatically cancelling an otherwise strong continuation.
  const smaStack = direction === "CALL" ? sma1.fast > sma1.slow : sma1.fast < sma1.slow;
  const fastSlopeAligned = direction === "CALL" ? sma1.fastSlope > 0 : sma1.fastSlope < 0;
  const slowSlopeAligned = direction === "CALL" ? sma1.slowSlope >= 0 : sma1.slowSlope <= 0;
  if (!smaStack) {
    return { ok: false, grade: "NO TRADE", reason: "SMA 5/13 stack reversed", coreDirection: direction };
  }

  if (direction === "CALL" && fr1.lastLow && last <= Number(fr1.lastLow.price)) {
    return { ok: false, grade: "NO TRADE", reason: "Fractal(2) support failed", coreDirection: direction };
  }
  if (direction === "PUT" && fr1.lastHigh && last >= Number(fr1.lastHigh.price)) {
    return { ok: false, grade: "NO TRADE", reason: "Fractal(2) resistance failed", coreDirection: direction };
  }

  // Five-minute entries can remain valid after a strong post-pullback expansion.
  // 2.50 ATR is the absolute chase cap; extension inside that range is penalized
  // through quality instead of acting as an automatic veto.
  const distanceFast = Math.abs(last - sma1.fast) / atr1.atr;
  if (distanceFast > 2.50) {
    return {
      ok: false, grade: "NO TRADE",
      reason: `entry extension ${distanceFast.toFixed(2)} ATR exceeds the 2.50 ATR five-minute limit`,
      distanceFastAtr: distanceFast, coreDirection: direction
    };
  }

  const room = roomToMoveSnapshot(bars1m, last, direction, atr1.atr);
  if (!room.ready) {
    return { ok: false, grade: "NO TRADE", reason: "structural room context is still building", roomAtr: room.roomAtr };
  }
  if (room.roomAtr < 0.35) {
    return {
      ok: false, grade: "NO TRADE",
      reason: `confirmed 15m structure leaves only ${Number(room.roomAtr).toFixed(2)} ATR room; need at least 0.35 ATR`,
      roomAtr: room.roomAtr, roomLevel: room.level, roomSource: room.source
    };
  }

  const dmiGap = Math.abs(Number(dmi.plusDI) - Number(dmi.minusDI));
  const dmiAligned = direction === "CALL"
    ? dmi.plusDI > dmi.minusDI
    : dmi.minusDI > dmi.plusDI;
  if (!dmiAligned || dmi.adx < 20 || dmiGap < 4) {
    return {
      ok: false, grade: "NO TRADE", reason: "ADX/DMI is not strong enough for the 5-minute setup",
      adx: dmi.adx, dmiGap, coreDirection: direction
    };
  }

  const macdAligned = direction === "CALL"
    ? (m1.macd > m1.signal && m1.hist > 0 && m1.hist >= m1.prevHist)
    : (m1.macd < m1.signal && m1.hist < 0 && m1.hist <= m1.prevHist);
  const rsiAligned = direction === "CALL"
    ? (rsi1.rsi >= 52 && rsi1.rsi <= 69)
    : (rsi1.rsi <= 48 && rsi1.rsi >= 31);
  const aroonAligned = direction === "CALL"
    ? ar1.up > ar1.down + 15
    : ar1.down > ar1.up + 15;
  const pressureAligned = direction === "CALL" ? pressure.bull >= 2 : pressure.bear >= 2;
  const momentumChecks = { macd: macdAligned, rsi: rsiAligned, aroon: aroonAligned, pressure: pressureAligned };
  const momentumConfirmations = Object.values(momentumChecks).filter(Boolean).length;
  const strongCoreForTwo = dmi.adx >= 23 && dmiGap >= 6 && regime5.efficiency >= 0.25;
  if (momentumConfirmations < 2 || (momentumConfirmations === 2 && !strongCoreForTwo)) {
    const failed = Object.entries(momentumChecks).filter(([, ok]) => !ok).map(([k]) => k.toUpperCase()).join(", ");
    return {
      ok: false, grade: "NO TRADE",
      reason: momentumConfirmations < 2
        ? `momentum confluence ${momentumConfirmations}/4 — need at least 2/4${failed ? "; missing " + failed : ""}`
        : `momentum is 2/4 but core strength is not high enough for the five-minute override`,
      momentumConfirmations, momentumChecks, strongCoreForTwo, rsi: rsi1.rsi, coreDirection: direction
    };
  }

  const last1 = bars1m.at(-1);
  const continuation = last1 && (direction === "CALL"
    ? Number(last1.c) > Number(last1.o) && Number(last1.c) > sma1.fast
    : Number(last1.c) < Number(last1.o) && Number(last1.c) < sma1.fast);
  if (!continuation) {
    return { ok: false, grade: "NO TRADE", reason: "fresh completed 1m continuation candle is missing" };
  }

  // The 30-second layer confirms timing only after the 1m/5m setup is already valid.
  // Free-tier runtime model: the Durable Object intentionally sleeps between scans.
  // A seven-minute in-memory 30s MACD history therefore cannot be a mandatory gate.
  // Use the 30s layer when it genuinely exists; otherwise require a stricter fresh
  // live-tick burst on top of the already-confirmed 1m continuation.
  const imp = tickImpulse(ticks);
  if (!imp.ready) {
    return { ok: false, grade: "NO TRADE", reason: `live tick confirmation needs more fresh ticks (${imp.samples || 0}/8)` };
  }
  const strongOpp = direction === "CALL"
    ? (imp.downRatio >= 0.68 && imp.norm < 0)
    : (imp.upRatio >= 0.68 && imp.norm > 0);
  if (strongOpp) {
    return { ok: false, grade: "NO TRADE", reason: "live tick flow is reversing against the setup" };
  }

  const has30sContext = Boolean(m30.ready && b30.length >= 14);
  let microMode = "live-burst";
  let microAligned = false;
  if (has30sContext) {
    const microMacd = direction === "CALL"
      ? (m30.macd > m30.signal && m30.hist > 0)
      : (m30.macd < m30.signal && m30.hist < 0);
    const microLast = b30.at(-1);
    const microCandle = direction === "CALL"
      ? Number(microLast.c) > Number(microLast.o)
      : Number(microLast.c) < Number(microLast.o);
    const tickAligned = direction === "CALL"
      ? (imp.upRatio >= 0.60 && imp.norm > 0)
      : (imp.downRatio >= 0.60 && imp.norm < 0);
    microAligned = microMacd && microCandle && tickAligned;
    microMode = "30s-macd+live";
  } else {
    microAligned = direction === "CALL"
      ? (imp.upRatio >= 0.57 && imp.norm >= 0.10)
      : (imp.downRatio >= 0.57 && imp.norm <= -0.10);
  }
  if (!microAligned) {
    return { ok: false, grade: "NO TRADE", reason: has30sContext ? "30s/live timing is not fully aligned" : "fresh live-tick burst is not strong enough" };
  }

  let score = 9.0;
  score += 0.15 * Math.max(0, momentumConfirmations - 2);
  if (regime15.ready && regime15.direction === direction) score += 0.5;
  if (regime5.efficiency >= 0.35) score += 0.3;
  if (dmi.adx >= 25) score += 0.3;
  if (fastSlopeAligned) score += 0.2;
  if (slowSlopeAligned) score += 0.1;
  if (distanceFast <= 0.60) score += 0.3;
  else if (distanceFast <= 1.25) score += 0.15;
  if (room.roomAtr >= 1.20) score += 0.3;
  if (imp.upRatio >= 0.65 || imp.downRatio >= 0.65) score += 0.2;

  const quality = clamp(
    0.895 +
    (regime15.ready && regime15.direction === direction ? 0.012 : 0) +
    Math.min(Math.max(dmi.adx - 20, 0), 15) / 15 * 0.018 +
    Math.min(Math.max(room.roomAtr - 0.35, 0), 0.85) / 0.85 * 0.014 +
    (fastSlopeAligned ? 0.005 : 0) +
    (slowSlopeAligned ? 0.003 : 0) +
    (distanceFast <= 0.60 ? 0.010 : (distanceFast <= 1.25 ? 0.005 : 0)) +
    (Math.max(imp.upRatio, imp.downRatio) >= 0.65 ? 0.008 : 0) +
    (momentumConfirmations === 4 ? 0.007 : (momentumConfirmations === 3 ? 0.004 : (strongCoreForTwo ? 0.002 : 0))),
    0.895, 0.970
  );

  if (quality < A_GRADE_MIN_QUALITY) {
    return {
      ok: false, grade: "NO TRADE",
      reason: `5-minute sniper score ${Math.round(quality * 100)}/100 is below threshold`,
      quality
    };
  }

  return {
    ok: true, grade: "A", direction, expirySeconds: EXPIRY_SECONDS, quality,
    callScore: direction === "CALL" ? score : 0, putScore: direction === "PUT" ? score : 0,
    edge: score, coreMajor: 10, microConfirmations: 3, microScore: 3,
    regime5: regime5.direction, regime15: regime15.ready ? regime15.direction : "NOT_READY",
    regime5Efficiency: regime5.efficiency, regime15Efficiency: regime15.ready ? regime15.efficiency : null,
    roomAtr: room.roomAtr, roomLevel: room.level, roomSource: room.source, spreadAtrRatio, spreadBps, atrRatio, rsi: rsi1.rsi, adx: dmi.adx,
    dmiGap, smaFastPeriod: 5, smaSlowPeriod: 13, fractalPeriod: 2,
    timeframe: "1min", expiryMinutes: 5, smaFast: sma1.fast, smaSlow: sma1.slow,
    distanceFastAtr: distanceFast, atr: atr1.atr,
    smaFastSlopeAligned: fastSlopeAligned,
    smaSlowSlopeAligned: slowSlopeAligned,
    strongCoreForTwo,
    entryExtensionBand: distanceFast <= 0.88 ? "pullback-zone" : (distanceFast <= 1.25 ? "continuation-zone" : (distanceFast <= 2.50 ? "expanded-continuation" : "overextended")),
    momentumConfirmations, momentumChecks,
    reasons: [
      "completed 5m trend aligned",
      "1m SMA(5/13) stack aligned",
      "Fractal(2) structure intact",
      "fresh completed 1m continuation",
      `momentum confluence ${momentumConfirmations}/4`,
      "ADX/DMI strong",
      "room-to-move passed",
      microMode === "30s-macd+live" ? "30s MACD + candle aligned" : "strict fresh live-tick burst aligned",
      "live tick flow aligned"
    ],
    microMode, microTickSamples: imp.samples || 0,
    bars1m: bars1m.length, bars30: b30.length, lastPrice: last
  };
}

export function preAlert5m(ticks, bars1m, symbol, direction) {
  if (!["CALL", "PUT"].includes(direction)) return { ok: false };

  const sequence = setupSequenceSnapshot(bars1m);
  if (!sequence.ready || sequence.direction !== direction || !sequence.structureOk || !sequence.pullbackSeen) {
    return { ok: false, reason: "valid SMA-zone pullback is no longer present" };
  }

  const sma = smaTrendSnapshot(bars1m, 5, 13);
  const atr = atrSnapshot(bars1m, 14);
  const dmi = dmiAdxSnapshot(bars1m, 7);
  const fr = fractalSnapshot(bars1m, 2);
  const m1 = macdSnapshot(bars1m, 5, 13, 4);
  const ar1 = aroonSnapshot(bars1m, 14);
  const rsi1 = rsiSnapshot(bars1m, 7);
  const pressure = candlePressure(bars1m, 3);
  const b5 = completedAggregate(bars1m, 300);
  const reg5 = trendRegime(b5, 5, 13, 0.20);
  const b15 = completedAggregate(bars1m, 900);
  const reg15 = trendRegime(b15, 3, 8, 0.18);

  if (!sma.ready || !atr.ready || !fr.ready || !dmi.ready || !m1.ready || !ar1.ready || !rsi1.ready || !pressure.ready || !reg5.ready)
    return { ok: false, reason: "prepare context is still building" };

  const last = Number(ticks.at(-1)?.p);
  if (!Number.isFinite(last) || !(atr.atr > 0)) return { ok: false, reason: "invalid live price or volatility" };

  const atrRatio = atr.atr / last;
  if (atrRatio < 0.000008 || atrRatio > 0.0028) return { ok: false, reason: "volatility left the acceptable range" };
  if (reg5.direction !== direction) return { ok: false, reason: "completed 5m direction changed" };
  const structureOk = direction === "CALL"
    ? (!fr.lastLow || last > Number(fr.lastLow.price))
    : (!fr.lastHigh || last < Number(fr.lastHigh.price));
  if (!structureOk) return { ok: false, reason: "Fractal structure failed" };

  const spread = spreadQualitySnapshot(symbol, ticks, last, atr.atr);
  if (!spread.ready || spread.abnormal || (Number.isFinite(spread.spreadAtrRatio) && spread.spreadAtrRatio > 0.35 && Number(spread.spreadBps) > 0.80)) {
    return { ok: false, reason: "spread became abnormal" };
  }

  if (reg15.ready && reg15.direction !== "NEUTRAL" && reg15.direction !== direction && reg15.efficiency >= 0.30) {
    return { ok: false, reason: "strong opposite 15m trend developed" };
  }

  const stack = direction === "CALL" ? sma.fast > sma.slow : sma.fast < sma.slow;
  const slope = direction === "CALL" ? sma.fastSlope >= 0 : sma.fastSlope <= 0;
  if (!stack) return { ok: false, reason: "SMA 5/13 stack reversed" };
  // A flat/briefly lagging fast slope is tolerated during READY for a 5-minute hold;
  // the final signal still requires the fast slope to point with the trade.
  const slopeSupport = slope;

  const dmiGap = Math.abs(Number(dmi.plusDI) - Number(dmi.minusDI));
  const dmiAligned = direction === "CALL" ? dmi.plusDI > dmi.minusDI : dmi.minusDI > dmi.plusDI;
  if (!dmiAligned || dmi.adx < 20 || dmiGap < 4) return { ok: false, reason: "ADX/DMI strength faded" };

  const macdAligned = direction === "CALL"
    ? (m1.macd > m1.signal && m1.hist > 0)
    : (m1.macd < m1.signal && m1.hist < 0);
  const rsiAligned = direction === "CALL"
    ? (rsi1.rsi >= 50 && rsi1.rsi <= 72)
    : (rsi1.rsi <= 50 && rsi1.rsi >= 28);
  const aroonAligned = direction === "CALL"
    ? ar1.up > ar1.down + 10
    : ar1.down > ar1.up + 10;
  const pressureAligned = direction === "CALL" ? pressure.bull >= 2 : pressure.bear >= 2;
  const preMomentumChecks = { macd: macdAligned, rsi: rsiAligned, aroon: aroonAligned, pressure: pressureAligned };
  const preMomentumConfirmations = Object.values(preMomentumChecks).filter(Boolean).length;
  if (preMomentumConfirmations < 2) {
    return {
      ok: false, reason: `momentum confluence ${preMomentumConfirmations}/4 — need at least 2/4 for READY`,
      preMomentumConfirmations, preMomentumChecks
    };
  }

  const distanceFast = Math.abs(last - sma.fast) / atr.atr;
  if (distanceFast > 2.50) {
    return {
      ok: false,
      reason: `price extension ${distanceFast.toFixed(2)} ATR exceeds the 2.50 ATR five-minute limit`,
      distanceFastAtr: distanceFast
    };
  }

  const room = roomToMoveSnapshot(bars1m, last, direction, atr.atr);
  if (!room.ready) return { ok: false, reason: "structural room context is still building" };
  if (room.roomAtr < 0.50) return {
    ok: false,
    reason: `confirmed 15m structure leaves only ${Number(room.roomAtr).toFixed(2)} ATR room; READY needs at least 0.50 ATR`
  };

  const imp = tickImpulse(ticks);
  if (imp.ready) {
    const strongOpp = direction === "CALL"
      ? (imp.downRatio >= 0.68 && imp.norm < 0)
      : (imp.upRatio >= 0.68 && imp.norm > 0);
    if (strongOpp) return { ok: false, reason: "live ticks reversed against the setup" };
  }

  const preScore = clamp(
    0.84 +
    Math.min(Math.max(dmi.adx - 20, 0), 15) / 15 * 0.035 +
    Math.min(Math.max(room.roomAtr - 0.50, 0), 0.70) / 0.70 * 0.025 +
    (reg15.ready && reg15.direction === direction ? 0.020 : 0) +
    (slopeSupport ? 0.008 : 0) +
    (distanceFast <= 0.65 ? 0.015 : (distanceFast <= 1.10 ? 0.008 : 0)),
    0.84, 0.94
  );

  return {
    ok: preScore >= 0.86,
    preScore,
    direction,
    adx: dmi.adx,
    roomAtr: room.roomAtr,
    roomLevel: room.level,
    roomSource: room.source,
    distanceFastAtr: distanceFast,
    atrRatio,
    spreadAtrRatio: spread.spreadAtrRatio,
    spreadBps: spread.spreadBps,
    smaFastSlopeAligned: slopeSupport,
    entryExtensionBand: distanceFast <= 0.88 ? "pullback-zone" : (distanceFast <= 2.50 ? "continuation-zone" : "overextended"),
    preMomentumConfirmations, preMomentumChecks
  };
}

export class AutoScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async ensure() {
    const now = Date.now();
    let alarm = null;
    try { alarm = await this.ctx.storage.getAlarm(); } catch (_) { }
    if (!alarm || Number(alarm) < now + 15000 || Number(alarm) > now + 90000) {
      await this.ctx.storage.setAlarm(now + 5000);
      alarm = now + 5000;
    }
    await this.ctx.storage.put("enabled", true);
    return { ok: true, enabled: true, nextAlarmAt: Number(alarm) };
  }

  async status() {
    let alarm = null;
    try { alarm = await this.ctx.storage.getAlarm(); } catch (_) { }
    return {
      ok: true,
      enabled: Boolean((await this.ctx.storage.get("enabled")) || false),
      nextAlarmAt: alarm ? Number(alarm) : null,
      lastAlarmAt: Number((await this.ctx.storage.get("lastAlarmAt")) || 0) || null,
      lastDispatchAt: Number((await this.ctx.storage.get("lastDispatchAt")) || 0) || null,
      lastHttpStatus: Number((await this.ctx.storage.get("lastHttpStatus")) || 0) || null,
      lastError: (await this.ctx.storage.get("lastError")) || null
    };
  }

  async alarm() {
    const now = Date.now();
    await this.ctx.storage.put("lastAlarmAt", now);
    try {
      const secret = String(this.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing");
      const r = await fetch(`${PRIMARY_WORKER_URL}/cron-scan`, {
        method: "POST",
        headers: { "X-IQ3M-Cron-Secret": secret }
      });
      await this.ctx.storage.put("lastDispatchAt", Date.now());
      await this.ctx.storage.put("lastHttpStatus", Number(r.status));
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`cron-scan HTTP ${r.status}: ${body.slice(0, 160)}`);
      }
      await this.ctx.storage.delete("lastError");
    } catch (e) {
      await this.ctx.storage.put("lastError", String(e?.message || e).slice(0, 300));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/ensure") return json(await this.ensure());
    if (u.pathname === "/status") return json(await this.status());
    return json({ ok: true });
  }
}

export class TickHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env; this.ws = null; this.cryptoWs = null; this.ticks = new Map(); this.symbols = new Set();
    this.lastStatus = "starting"; this.lastSubscribeStatus = null; this.connecting = false; this.cryptoConnecting = false; this.provider = "tiingo"; this.lastCryptoStatus = "starting"; this.lastCryptoSubscribeStatus = null; this.lastCryptoWsMessageAt = 0;
    this.lastWsMessageAt = 0; this.lastPriceReceivedAt = 0; this.lastConnectAt = 0; this.reconnectCount = 0; this.oneMinuteCache = new Map(); this.oneMinuteCacheDirty = false; this.quotaBlockedUntil = 0; this.pendingSignals = []; this.signalStats = { total: 0, wins: 0, losses: 0, draws: 0, voids: 0 }; this.signalHistory = []; this.forwardStats = null; this.alertChats = []; this.setupStates = {}; this.readyAlertClaims = {}; this.readyAudit = [];

    this.shortShadowState = {
      strategyId: SHORT_SHADOW_ID,
      startedAt: Date.now(),
      pending: [],
      history: []
    };

    this.blockerStats = {
      strategyId: STRATEGY_ID,
      classifierVersion: BLOCKER_CLASSIFIER_VERSION,
      startedAt: Date.now(),
      total: 0,
      byCategory: {},
      bySymbol: {},
      recent: []
    };

    this.ctx.blockConcurrencyWhile(async () => {

      const storedBlockers = await this.ctx.storage.get("blockerStats");

      if (
        storedBlockers?.strategyId === STRATEGY_ID &&
        storedBlockers?.classifierVersion === BLOCKER_CLASSIFIER_VERSION
      ) {
        const storedShortShadow =
          await this.ctx.storage.get("shortShadowState");

        if (
          storedShortShadow?.strategyId === SHORT_SHADOW_ID
        ) {
          this.shortShadowState = {
            strategyId: SHORT_SHADOW_ID,
            startedAt:
              Number(storedShortShadow.startedAt) || Date.now(),

            pending: Array.isArray(storedShortShadow.pending)
              ? storedShortShadow.pending
              : [],

            history: Array.isArray(storedShortShadow.history)
              ? storedShortShadow.history
              : []
          };
        } else {
          this.shortShadowState = {
            strategyId: SHORT_SHADOW_ID,
            startedAt: Date.now(),
            pending: [],
            history: []
          };

          await this.ctx.storage.put(
            "shortShadowState",
            this.shortShadowState
          );
        }
        this.blockerStats = {
          ...storedBlockers,
          total: Number(
            storedBlockers.total ??
            storedBlockers.totalEvaluations ??
            0
          ),
          byCategory: {
            ...(storedBlockers.byCategory || storedBlockers.counts || {})
          },
          bySymbol: {
            ...(storedBlockers.bySymbol || {})
          },
          recent: Array.isArray(storedBlockers.recent)
            ? storedBlockers.recent
            : []
        };

        // Persist the normalized schema so future restarts remain compatible.
        await this.ctx.storage.put("blockerStats", this.blockerStats);
      } else {
        this.blockerStats = {
          strategyId: STRATEGY_ID,
          classifierVersion: BLOCKER_CLASSIFIER_VERSION,
          startedAt: Date.now(),
          total: 0,
          byCategory: {},
          bySymbol: {},
          recent: []
        };

        await this.ctx.storage.put("blockerStats", this.blockerStats);
      }

      // V11.2: prefer the configured warm list over old persisted symbols so a Basic/trial
      // account does not keep resubscribing to unsupported pairs from earlier builds.
      const configured = String(env.WS_SYMBOLS || "")
        .split(",")
        .map(normalizeSymbol)
        .filter(Boolean);

      const warmSymbols = [
        ...new Set([
          ...SHORT_SHADOW_UNIVERSE,
          ...configured
        ])
      ];

      for (const s of warmSymbols) {
        if (s) this.symbols.add(s);
      }
      await this.ctx.storage.put("symbols", [...this.symbols]);
      const persistedContext = (await this.ctx.storage.get("oneMinuteCacheData")) || {};
      for (const [symbol, value] of Object.entries(persistedContext)) {
        if (value && Array.isArray(value.bars)) this.oneMinuteCache.set(symbol, value);
      }
      this.quotaBlockedUntil = Number((await this.ctx.storage.get("tiingoQuotaBlockedUntil")) || 0);
      this.pendingSignals = (await this.ctx.storage.get("pendingSignals")) || [];
      this.signalStats = (await this.ctx.storage.get("signalStats")) || { total: 0, wins: 0, losses: 0, draws: 0, voids: 0 };
      this.signalHistory = (await this.ctx.storage.get("signalHistory")) || [];

      const emptyForwardBucket = () => ({ total: 0, wins: 0, losses: 0, draws: 0, voids: 0 });
      const storedForward = await this.ctx.storage.get("v13_4ForwardStats");
      if (storedForward?.shadowId === V13_4_SHADOW.id && storedForward?.strategyId === STRATEGY_ID) {
        this.forwardStats = storedForward;
      } else {
        const seeded = {
          strategyId: STRATEGY_ID,
          shadowId: V13_4_SHADOW.id,
          frozenRule: { dmiGapMin: V13_4_SHADOW.dmiGapMin, adxMax: V13_4_SHADOW.adxMax },
          initializedAt: Date.now(),
          firstObservedAt: null,
          lastObservedAt: null,
          eligible: emptyForwardBucket(),
          nonEligible: emptyForwardBucket()
        };
        const tagged = this.signalHistory
          .filter(x => this.isCurrentStrategyRecord(x) && x?.features?.v13_4Shadow?.id === V13_4_SHADOW.id);
        for (const rec of tagged) {
          const bucket = rec.features.v13_4Shadow.eligible === true ? seeded.eligible : seeded.nonEligible;
          bucket.total++;
          if (rec.result === "WIN") bucket.wins++;
          else if (rec.result === "LOSS") bucket.losses++;
          else if (rec.result === "DRAW") bucket.draws++;
          else if (rec.result === "VOID") bucket.voids++;
          const at = Number(rec.settledAt || rec.entryAt || 0) || null;
          if (at) {
            seeded.firstObservedAt = seeded.firstObservedAt == null ? at : Math.min(seeded.firstObservedAt, at);
            seeded.lastObservedAt = seeded.lastObservedAt == null ? at : Math.max(seeded.lastObservedAt, at);
          }
        }
        this.forwardStats = seeded;
        await this.ctx.storage.put("v13_4ForwardStats", this.forwardStats);
      }

      this.alertChats = (await this.ctx.storage.get("alertChats")) || [];
      this.setupStates = (await this.ctx.storage.get("setupStates")) || {};
      this.readyAlertClaims = (await this.ctx.storage.get("readyAlertClaims")) || {};
      this.readyAudit = (await this.ctx.storage.get("readyAudit")) || [];
      const setupStateStrategyId = String((await this.ctx.storage.get("setupStateStrategyId")) || "");
      if (setupStateStrategyId !== STRATEGY_ID) {
        this.setupStates = {};
        this.readyAlertClaims = {};
        await this.ctx.storage.put("setupStates", this.setupStates);
        await this.ctx.storage.put("readyAlertClaims", this.readyAlertClaims);
        this.readyAudit = [];
        await this.ctx.storage.put("readyAudit", this.readyAudit);
        await this.ctx.storage.put("setupStateStrategyId", STRATEGY_ID);
      }
      if (!this.alertChats.length) {
        const recovered = [...this.pendingSignals, ...this.signalHistory]
          .flatMap(x => Array.isArray(x.chatIds) ? x.chatIds : [x.chatId])
          .filter(x => x != null)
          .map(String);
        this.alertChats = [...new Set(recovered)].slice(-10);
        if (this.alertChats.length) await this.ctx.storage.put("alertChats", this.alertChats);
      }
      // Keep Durable Object startup lightweight. Network connections are opened lazily
      // by market-data routes/alarm so Telegram commands are never blocked by feed startup.
      await this.scheduleAlarm();
    });
  }

  latestReceivedAge(symbol) {
    const arr = this.ticks.get(symbol) || [];
    if (!arr.length) return Infinity;
    const last = arr.at(-1);
    return Math.max(0, (Date.now() - Number(last.r || last.t)) / 1000);
  }

  latestMarketAge(symbol) {
    const arr = this.ticks.get(symbol) || [];
    if (!arr.length) return Infinity;
    return Math.max(0, (Date.now() - Number(arr.at(-1).t)) / 1000);
  }

  async scheduleAlarm() {
    const now = Date.now();

    const shortPending =
      this.shortShadowState?.pending || [];

    if (
      !this.pendingSignals.length &&
      !shortPending.length
    ) {
      try {
        await this.ctx.storage.deleteAlarm();
      } catch (_) { }

      return;
    }

    let next = Infinity;

    // Existing 5-minute settlements
    for (const p of this.pendingSignals) {
      const exp = Number(p.expiresAt || 0);

      if (exp > now) {
        next = Math.min(next, exp);
      } else {
        next = Math.min(next, now + 250);
      }
    }

    // Experimental 60s / 120s settlements
    for (const p of shortPending) {
      if (!p.result60) {
        const exp60 = Number(p.expiry60At || 0);

        next = Math.min(
          next,
          exp60 > now
            ? exp60
            : now + 2000
        );
      }

      if (!p.result120) {
        const exp120 = Number(p.expiry120At || 0);

        next = Math.min(
          next,
          exp120 > now
            ? exp120
            : now + 2000
        );
      }
    }

    await this.ctx.storage.setAlarm(
      Math.max(
        now + 250,
        Number.isFinite(next)
          ? next
          : now + 1000
      )
    );
  }

  async fetchTopSnapshots(symbols = []) {
    const fx = [...new Set(symbols.map(normalizeSymbol).filter(s => s && !isCryptoSymbol(s)))];
    if (!fx.length) return 0;
    const key = String(this.env.TIINGO_API_TOKEN || "").trim();
    if (!key) throw new Error("missing TIINGO_API_TOKEN");
    const tickers = fx.map(toTiingoSymbol).filter(Boolean);
    if (!tickers.length) return 0;
    const url = new URL("https://api.tiingo.com/tiingo/fx/top");
    url.searchParams.set("tickers", tickers.join(","));
    const res = await fetch(url.toString(), { headers: { accept: "application/json", authorization: `Token ${key}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data)) throw new Error(String(data?.detail || data?.message || `Tiingo top request failed (${res.status})`));
    let pushed = 0;
    for (const q of data) {
      const symbol = fromTiingoSymbol(q?.ticker);
      const t = Date.parse(String(q?.quoteTimestamp || q?.timestamp || ""));
      const bid = Number(q?.bidPrice), ask = Number(q?.askPrice), mid = Number(q?.midPrice);
      const p = Number.isFinite(mid) ? mid : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN);
      if (symbol && Number.isFinite(t) && Number.isFinite(p)) {
        this.pushTick(symbol, t, p, bid, ask);
        pushed++;
      }
    }
    return pushed;
  }

  async primeLiveFlow(sampleMs = 5000) {
    const ms = Math.max(2000, Math.min(8000, Number(sampleMs) || 5000));
    try { this.captureSampledMinuteBars(); } catch (_) { }
    // QUOTA-SAFE: do not call Tiingo REST here. This route runs every minute and
    // a single REST request per scan would exceed Tiingo Starter's 50/hour limit.
    // Fresh quotes come from the WebSocket; REST is reserved for historical context,
    // explicit /checkall health checks and settlement snapshots.
    const before = {};
    for (const symbol of SHORT_SHADOW_UNIVERSE) before[symbol] = (this.ticks.get(symbol) || []).length;
    await this.ensureSocket();
    await sleep(ms);
    const rows = SHORT_SHADOW_UNIVERSE.map(symbol => {
      const arr = this.ticks.get(symbol) || [];
      const last = arr.at(-1);
      return {
        symbol,
        sampleTicks: Math.max(0, arr.length - Number(before[symbol] || 0)),
        bufferedTicks: arr.length,
        lastTickAgeSeconds: last ? this.latestReceivedAge(symbol) : null,
        providerTickAgeSeconds: last ? this.latestMarketAge(symbol) : null
      };
    });
    return { ok: true, sampleSeconds: ms / 1000, rows };
  }

  async sampleTickFlow(sampleMs = 5000) {
    const result = await this.primeLiveFlow(sampleMs);
    await this.closeFeeds("tick sample complete");
    return result;
  }

  async getTopHealth() {
    const requested = [...FIXED_UNIVERSE];
    let fetchError = null;
    try {
      await this.fetchTopSnapshots(requested);
    } catch (e) {
      fetchError = String(e?.message || e);
    }

    const rows = requested.map(symbol => {
      const arr = this.ticks.get(symbol) || [];
      const q = arr.at(-1);
      const received = q ? Math.max(0, (Date.now() - Number(q.r || q.t)) / 1000) : null;
      const provider = q ? Math.max(0, (Date.now() - Number(q.t)) / 1000) : null;
      let health = "NO DATA";
      if (q && Number.isFinite(provider)) {
        if (provider <= 90) health = "LIVE";
        else if (provider <= 300) health = "WARMING";
        else health = "STALE";
      } else if (fetchError) {
        health = "ERROR";
      }
      return {
        symbol,
        health,
        connected: Boolean(q),
        ticks: arr.length,
        receivedAge: Number.isFinite(received) ? received : null,
        providerAge: Number.isFinite(provider) ? provider : null,
        price: q ? Number(q.p) : null,
        bid: q?.bid ?? null,
        ask: q?.ask ?? null,
        quoteAt: q ? Number(q.t) : null,
        source: "tiingo-rest-top",
        status: fetchError || health
      };
    });

    return { ok: !fetchError, source: "tiingo-rest-top", error: fetchError, rows };
  }

  async closeFeeds(reason = "free-tier sleep") {
    // Persist the live WebSocket sample into the one-minute context before the
    // Durable Object sleeps. This lets future scans advance indicators without
    // repeatedly consuming Tiingo's hourly historical REST allocation.
    try { this.captureSampledMinuteBars(); } catch (e) { this.lastStatus = `sample capture error: ${String(e?.message || e)}`; }
    if (this.oneMinuteCacheDirty) {
      try { await this.persistOneMinuteCache(); } catch (e) { this.lastStatus = `context persist error: ${String(e?.message || e)}`; }
    }
    try { if (this.ws) { try { this.ws.close(1000, reason); } catch (_) { } } } catch (_) { }
    try { if (this.cryptoWs) { try { this.cryptoWs.close(1000, reason); } catch (_) { } } } catch (_) { }
    this.ws = null; this.cryptoWs = null; this.connecting = false; this.cryptoConnecting = false;
    this.lastStatus = "sleeping";
    this.lastCryptoStatus = "sleeping";
    return { ok: true, status: "sleeping" };
  }

  async sendTrackedResult(chatId, text) {
    const token = String(this.env.TELEGRAM_BOT_TOKEN || "").trim();
    if (!token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
      });
    } catch (_) { }
  }

  async settlePendingSignals() {
    if (!this.pendingSignals.length) return;
    const now = Date.now(), keep = [], settled = [];

    for (const sig of this.pendingSignals) {
      if (Number(sig.expiresAt) > now) { keep.push(sig); continue; }

      const arr = this.ticks.get(sig.symbol) || [];
      const exitTick = arr.find(t => Number(t.r || t.t) >= Number(sig.expiresAt));

      if (!exitTick) {
        if (now - Number(sig.expiresAt) < 15000) { keep.push(sig); continue; }

        const rec = { ...sig, result: "VOID", exitPrice: null, settledAt: now };
        settled.push(rec);
        this.signalStats.total++;
        this.signalStats.voids++;
        const chats = Array.isArray(sig.chatIds) && sig.chatIds.length ? sig.chatIds : [sig.chatId];
        for (const chat of chats) if (chat != null) await this.sendTrackedResult(
          chat,
          `RESULT — ${sig.symbol}\n${sig.direction === "CALL" ? "⬆️ CALL" : "⬇️ PUT"} • 5 minutes\n⚪ VOID — no fresh Tiingo tick was available at expiry`
        );
        continue;
      }

      const entry = Number(sig.entryPrice), exit = Number(exitTick.p);
      const delta = exit - entry;
      let result = "DRAW";
      if (Math.abs(delta) > 1e-12) {
        const won = sig.direction === "CALL" ? delta > 0 : delta < 0;
        result = won ? "WIN" : "LOSS";
      }

      const rec = { ...sig, result, exitPrice: exit, exitTickAt: Number(exitTick.r || exitTick.t), settledAt: now };
      settled.push(rec);
      this.signalStats.total++;
      if (result === "WIN") this.signalStats.wins++;
      else if (result === "LOSS") this.signalStats.losses++;
      else this.signalStats.draws++;

      const mark = result === "WIN" ? "✅" : result === "LOSS" ? "❌" : "➖";
      const chats = Array.isArray(sig.chatIds) && sig.chatIds.length ? sig.chatIds : [sig.chatId];
      for (const chat of chats) if (chat != null) await this.sendTrackedResult(
        chat,
        `RESULT — ${sig.symbol}\n${sig.direction === "CALL" ? "⬆️ CALL" : "⬇️ PUT"} • 5 minutes\nENTRY: ${formatFxPrice(sig.symbol, entry)}\nEXIT: ${formatFxPrice(sig.symbol, exit)}\n${mark} ${result}\nTRACKING: Tiingo feed`
      );
    }

    const previousPendingCount = this.pendingSignals.length;
    this.pendingSignals = keep;
    if (settled.length) {
      let forwardChanged = false;
      for (const rec of settled) forwardChanged = this.recordForwardSettlement(rec) || forwardChanged;
      this.signalHistory = [...settled, ...this.signalHistory].slice(0, 100);
      await this.ctx.storage.put("pendingSignals", this.pendingSignals);
      await this.ctx.storage.put("signalStats", this.signalStats);
      await this.ctx.storage.put("signalHistory", this.signalHistory);
      if (forwardChanged) await this.ctx.storage.put("v13_4ForwardStats", this.forwardStats);
    } else if (keep.length !== previousPendingCount) {
      await this.ctx.storage.put("pendingSignals", this.pendingSignals);
    }
  }

  async alarm() {
    try {
      const now = Date.now();

      const normalDue = this.pendingSignals
        .filter(
          x =>
            Number(x.expiresAt || 0) <=
            now + 2000
        )
        .map(x => x.symbol);

      const shortDue = (
        this.shortShadowState?.pending || []
      )
        .filter(x =>
          (
            !x.result60 &&
            Number(x.expiry60At || 0) <=
            now + 2000
          ) ||
          (
            !x.result120 &&
            Number(x.expiry120At || 0) <=
            now + 2000
          )
        )
        .map(x => x.symbol);

      const dueSymbols = [
        ...new Set([
          ...normalDue,
          ...shortDue
        ])
      ];

      if (dueSymbols.length) {
        await this.fetchTopSnapshots(
          dueSymbols
        );
      }

      // Existing 5-minute settlement
      await this.settlePendingSignals();

      // Independent short-expiry settlement
      await this.settleShortShadow();

    } catch (e) {
      this.lastStatus =
        `alarm error: ${String(
          e?.message || e
        )}`;
    } finally {
      await this.closeFeeds(
        "alarm complete"
      );

      await this.scheduleAlarm();
    }
  }

  async forceReconnect(reason = "manual reconnect") {
    this.reconnectCount++;
    this.lastStatus = `reconnecting: ${reason}`;
    try { if (this.ws) { try { this.ws.close(1000, "reconnect"); } catch (_) { } } } catch (_) { }
    this.ws = null;
    this.connecting = false;
    await sleep(150);
    await this.ensureSocket(true);
  }

  async forceCryptoReconnect(reason = "manual reconnect") {
    this.reconnectCount++;
    this.lastCryptoStatus = `reconnecting: ${reason}`;
    try { if (this.cryptoWs) { try { this.cryptoWs.close(1000, "reconnect"); } catch (_) { } } } catch (_) { }
    this.cryptoWs = null;
    this.cryptoConnecting = false;
    await sleep(150);
    await this.ensureCryptoSocket(true);
  }

  async ensureSocket(force = false) {
    if (!force && this.ws && this.ws.readyState === 1) return;
    if (this.connecting) return;

    const key = String(this.env.TIINGO_API_TOKEN || "").trim();
    if (!key) { this.lastStatus = "missing TIINGO_API_TOKEN"; return; }

    this.connecting = true;
    try {
      const ws = new WebSocket("wss://api.tiingo.com/fx");
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connecting = false;
        this.lastConnectAt = Date.now();
        this.lastWsMessageAt = Date.now();
        this.lastStatus = "connected";

        const tickers = [...this.symbols].filter(x => !isCryptoSymbol(x)).map(toTiingoSymbol).filter(Boolean);
        ws.send(JSON.stringify({
          eventName: "subscribe",
          authorization: key,
          eventData: { thresholdLevel: 5, tickers }
        }));
      });

      ws.addEventListener("message", ev => this.onMessage(ev));
      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        this.connecting = false;
        this.lastStatus = "closed";
      });
      ws.addEventListener("error", () => { this.lastStatus = "tiingo fx websocket error"; });
    } catch (e) {
      this.connecting = false;
      this.ws = null;
      this.lastStatus = String(e?.message || e);
    }
  }

  async ensureCryptoSocket(force = false) {
    const wantsCrypto = [...this.symbols].some(isCryptoSymbol);
    if (!wantsCrypto) return;
    if (!force && this.cryptoWs && this.cryptoWs.readyState === 1) return;
    if (this.cryptoConnecting) return;

    const key = String(this.env.TIINGO_API_TOKEN || "").trim();
    if (!key) { this.lastCryptoStatus = "missing TIINGO_API_TOKEN"; return; }

    this.cryptoConnecting = true;
    try {
      const ws = new WebSocket("wss://api.tiingo.com/crypto");
      this.cryptoWs = ws;

      ws.addEventListener("open", () => {
        this.cryptoConnecting = false;
        this.lastCryptoWsMessageAt = Date.now();
        this.lastCryptoStatus = "connected";
        const tickers = [...this.symbols].filter(isCryptoSymbol).map(toTiingoSymbol).filter(Boolean);
        ws.send(JSON.stringify({
          eventName: "subscribe",
          authorization: key,
          eventData: { thresholdLevel: 2, tickers }
        }));
      });

      ws.addEventListener("message", ev => this.onCryptoMessage(ev));
      ws.addEventListener("close", () => {
        if (this.cryptoWs === ws) this.cryptoWs = null;
        this.cryptoConnecting = false;
        this.lastCryptoStatus = "closed";
      });
      ws.addEventListener("error", () => { this.lastCryptoStatus = "tiingo crypto websocket error"; });
    } catch (e) {
      this.cryptoConnecting = false;
      this.cryptoWs = null;
      this.lastCryptoStatus = String(e?.message || e);
    }
  }

  pushTick(symbol, t, p, bid = null, ask = null) {
    const r = Date.now();
    if (!symbol || !Number.isFinite(p) || !Number.isFinite(t) || !this.symbols.has(symbol)) return;
    this.lastPriceReceivedAt = r;
    const arr = this.ticks.get(symbol) || [];
    arr.push({ t, p, r, bid: Number.isFinite(bid) ? bid : null, ask: Number.isFinite(ask) ? ask : null });
    const cutoff = Date.now() - 45 * 60 * 1000;
    while (arr.length && Number(arr[0].r || arr[0].t) < cutoff) arr.shift();
    if (arr.length > 20000) arr.splice(0, arr.length - 20000);
    this.ticks.set(symbol, arr);
  }

  onMessage(ev) {
    this.lastWsMessageAt = Date.now();
    try {
      const x = JSON.parse(String(ev.data || "{}"));
      if (x.messageType === "I") {
        this.lastSubscribeStatus = x;
        this.lastStatus = x?.response?.message || "subscribed";
        return;
      }
      if (x.messageType === "H") {
        if (this.lastStatus === "closed" || this.lastStatus.startsWith("reconnecting")) this.lastStatus = "connected";
        return;
      }
      if (x.messageType === "E") {
        this.lastSubscribeStatus = x;
        this.lastStatus = `tiingo fx error: ${x?.response?.message || "subscription error"}`;
        return;
      }
      if (x.messageType !== "A" || x.service !== "fx" || !Array.isArray(x.data)) return;
      const d = x.data;
      if (d[0] !== "Q") return;
      const symbol = fromTiingoSymbol(d[1]);
      const t = Date.parse(String(d[2] || ""));
      const bid = Number(d[4]), mid = Number(d[5]), ask = Number(d[7]);
      const p = Number.isFinite(mid) ? mid : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN);
      if (!Number.isFinite(p) || !Number.isFinite(t)) return;
      this.lastStatus = "ok";
      this.pushTick(symbol, t, p, bid, ask);
    } catch (e) {
      this.lastStatus = `tiingo fx parse error: ${String(e?.message || e)}`;
    }
  }

  onCryptoMessage(ev) {
    this.lastCryptoWsMessageAt = Date.now();
    try {
      const x = JSON.parse(String(ev.data || "{}"));
      if (x.messageType === "I") {
        this.lastCryptoSubscribeStatus = x;
        this.lastCryptoStatus = x?.response?.message || "subscribed";
        return;
      }
      if (x.messageType === "H") {
        if (this.lastCryptoStatus === "closed" || this.lastCryptoStatus.startsWith("reconnecting")) this.lastCryptoStatus = "connected";
        return;
      }
      if (x.messageType === "E") {
        this.lastCryptoSubscribeStatus = x;
        this.lastCryptoStatus = `tiingo crypto error: ${x?.response?.message || "subscription error"}`;
        return;
      }
      if (x.messageType !== "A" || x.service !== "crypto_data" || !Array.isArray(x.data)) return;
      const d = x.data;
      const symbol = fromTiingoSymbol(d[1]);
      const t = Date.parse(String(d[2] || ""));
      let p = NaN, bid = null, ask = null;
      if (d[0] === "T") {
        p = Number(d[5]);
      } else if (d[0] === "Q") {
        bid = Number(d[5]); const mid = Number(d[6]); ask = Number(d[8]);
        p = Number.isFinite(mid) ? mid : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN);
      } else return;
      if (!Number.isFinite(p) || !Number.isFinite(t)) return;
      this.lastCryptoStatus = "ok";
      this.pushTick(symbol, t, p, bid, ask);
    } catch (e) {
      this.lastCryptoStatus = `tiingo crypto parse error: ${String(e?.message || e)}`;
    }
  }

  async refreshIfStale(symbol) {
    const receiveAge = this.latestReceivedAge(symbol);
    const crypto = isCryptoSymbol(symbol);
    const msgAge = crypto
      ? (this.lastCryptoWsMessageAt ? Math.max(0, (Date.now() - this.lastCryptoWsMessageAt) / 1000) : Infinity)
      : (this.lastWsMessageAt ? Math.max(0, (Date.now() - this.lastWsMessageAt) / 1000) : Infinity);

    if (!Number.isFinite(receiveAge)) {
      if (crypto) await this.ensureCryptoSocket();
      else await this.ensureSocket();
      return;
    }

    const open = crypto
      ? Boolean(this.cryptoWs && this.cryptoWs.readyState === 1)
      : Boolean(this.ws && this.ws.readyState === 1);

    if (receiveAge > 15 || msgAge > 45 || !open) {
      if (crypto) await this.forceCryptoReconnect(`stale ${symbol} feed`);
      else await this.forceReconnect(`stale ${symbol} feed`);
      await sleep(1800);
    }
  }

  async subscribe(symbol) {
    symbol = normalizeSymbol(symbol);
    if (!symbol || !SHORT_SHADOW_UNIVERSE.includes(symbol)) return false;

    if (!this.symbols.has(symbol)) {
      this.symbols.add(symbol);
      await this.ctx.storage.put("symbols", [...this.symbols]);
      if (isCryptoSymbol(symbol)) await this.forceCryptoReconnect("ticker universe changed");
      else await this.forceReconnect("ticker universe changed");
    } else {
      if (isCryptoSymbol(symbol)) await this.ensureCryptoSocket();
      else await this.ensureSocket();
    }
    return true;
  }

  async persistOneMinuteCache() {
    const out = {};
    for (const [symbol, value] of this.oneMinuteCache.entries()) out[symbol] = value;
    await this.ctx.storage.put("oneMinuteCacheData", out);
    this.oneMinuteCacheDirty = false;
  }

  mergeOneMinuteContext(symbol, cachedBars = []) {
    const currentMinute = Math.floor(Date.now() / 60000) * 60000;
    const liveBars = buildBars(this.ticks.get(symbol) || [], 60).filter(b => Number(b.t) < currentMinute);
    const merged = new Map();
    for (const b of cachedBars || []) {
      if (Number(b?.t) < currentMinute) merged.set(Number(b.t), b);
    }
    for (const b of liveBars) merged.set(Number(b.t), b);
    return [...merged.values()].sort((a, b) => a.t - b.t).slice(-480);
  }

  captureSampledMinuteBars() {
    const currentMinute = Math.floor(Date.now() / 60000) * 60000;
    let changed = false;
    for (const symbol of SHORT_SHADOW_UNIVERSE) {
      const arr = this.ticks.get(symbol) || [];
      if (!arr.length) continue;
      const sampled = buildBars(arr, 60).filter(b => Number(b.t) <= currentMinute);
      if (!sampled.length) continue;
      const cached = this.oneMinuteCache.get(symbol);
      const merged = new Map();
      for (const b of cached?.bars || []) merged.set(Number(b.t), { ...b });
      for (const b of sampled) {
        const t = Number(b.t);
        const prev = merged.get(t);
        if (!prev) {
          merged.set(t, { ...b, sampled: true });
        } else {
          merged.set(t, {
            t,
            o: Number(prev.o),
            h: Math.max(Number(prev.h), Number(b.h)),
            l: Math.min(Number(prev.l), Number(b.l)),
            c: Number(b.c),
            n: Number(prev.n || 0) + Number(b.n || 0),
            sampled: Boolean(prev.sampled || false)
          });
        }
      }
      const bars = [...merged.values()].sort((a, b) => Number(a.t) - Number(b.t)).slice(-480);
      this.oneMinuteCache.set(symbol, { at: Date.now(), bars });
      changed = true;
    }
    if (changed) this.oneMinuteCacheDirty = true;
    return changed;
  }

  contextIsUsable(bars) {
    if (!Array.isArray(bars) || bars.length < 24) return false;
    const xs = bars.slice(-24);
    const last = xs.at(-1);
    if (!last || Date.now() - Number(last.t) > 3 * 60 * 1000) return false;
    // Once Tiingo REST has hydrated the baseline history, the one-minute cache is
    // extended every automatic scan from the live WebSocket. Reject only genuinely
    // broken recent context rather than refetching historical bars every minute.
    for (let i = 1; i < xs.length; i++) {
      if (Number(xs[i].t) - Number(xs[i - 1].t) > 3 * 60 * 1000) return false;
    }
    return true;
  }

  quotaRetryMinutes() {
    const left = Math.max(0, this.quotaBlockedUntil - Date.now());
    return Math.max(1, Math.ceil(left / 60000));
  }

  async fetchOneMinuteBars(symbol) {
    const cached = this.oneMinuteCache.get(symbol);
    const merged = this.mergeOneMinuteContext(symbol, cached?.bars || []);
    if (this.contextIsUsable(merged)) {
      if (!cached || merged.at(-1)?.t !== cached.bars?.at(-1)?.t) {
        this.oneMinuteCache.set(symbol, { at: Date.now(), bars: merged });
        this.oneMinuteCacheDirty = true;
      }
      return merged;
    }

    if (this.quotaBlockedUntil > Date.now()) {
      const e = new Error("Tiingo hourly request quota is temporarily exhausted");
      e.quotaExceeded = true;
      e.retryAfterMinutes = this.quotaRetryMinutes();
      throw e;
    }

    const key = String(this.env.TIINGO_API_TOKEN || "").trim();
    if (!key) throw new Error("missing TIINGO_API_TOKEN");

    const ticker = toTiingoSymbol(symbol);
    if (!ticker) throw new Error("invalid Tiingo ticker");

    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let url;
    if (isCryptoSymbol(symbol)) {
      url = new URL("https://api.tiingo.com/tiingo/crypto/prices");
      url.searchParams.set("tickers", ticker);
      url.searchParams.set("startDate", start);
      url.searchParams.set("resampleFreq", "1min");
    } else {
      url = new URL(`https://api.tiingo.com/tiingo/fx/${ticker}/prices`);
      url.searchParams.set("startDate", start);
      url.searchParams.set("resampleFreq", "1min");
    }

    const res = await fetch(url.toString(), {
      headers: { accept: "application/json", authorization: `Token ${key}` }
    });

    let data;
    try { data = await res.json(); } catch (_) { data = null; }

    if (!res.ok || !Array.isArray(data)) {
      const msg = String(data?.detail || data?.message || `Tiingo 1m context request failed (${res.status})`);
      if (/hourly request allocation|hourly.*limit|request.*hour/i.test(msg)) {
        this.quotaBlockedUntil = (Math.floor(Date.now() / 3600000) + 1) * 3600000 + 60000;
        await this.ctx.storage.put("tiingoQuotaBlockedUntil", this.quotaBlockedUntil);
        const e = new Error("Tiingo hourly request quota is temporarily exhausted");
        e.quotaExceeded = true;
        e.retryAfterMinutes = this.quotaRetryMinutes();
        throw e;
      }
      throw new Error(msg);
    }

    const currentMinute = Math.floor(Date.now() / 60000) * 60000;
    let rows = data;
    if (isCryptoSymbol(symbol)) {
      const item = data.find(x => String(x?.ticker || "").toLowerCase() === ticker) || data[0];
      rows = Array.isArray(item?.priceData) ? item.priceData : [];
    }

    const restBars = rows.map(v => ({
      t: Date.parse(String(v.date || "")),
      o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close), n: Number(v.tradesDone || 1)
    })).filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t < currentMinute)
      .sort((a, b) => a.t - b.t)
      .slice(-480);

    if (restBars.length < 30) throw new Error(`only ${restBars.length} completed Tiingo 1m bars available for ${symbol}`);

    const fresh = this.mergeOneMinuteContext(symbol, restBars);
    this.oneMinuteCache.set(symbol, { at: Date.now(), bars: fresh });
    this.quotaBlockedUntil = 0;
    await this.ctx.storage.delete("tiingoQuotaBlockedUntil");
    await this.persistOneMinuteCache();
    return fresh;
  }

  async advanceSetupState(symbol, bars1m) {
    const snap = setupSequenceSnapshot(bars1m);
    const now = Date.now();
    let st = this.setupStates[symbol] || { stage: "SEEK", direction: null, lastBarT: 0, updatedAt: 0 };

    const save = async next => {
      this.setupStates[symbol] = next;
      await this.ctx.storage.put("setupStates", this.setupStates);
      return next;
    };

    if (!snap.ready || snap.direction === "NEUTRAL" || !snap.structureOk) {
      if (st.stage === "PREPARE" || st.stage === "READY") await this.finishReadyAudit(st.readyKey, snap.ready ? "CANCELLED" : "EXPIRED", now);
      const next = { stage: "SEEK", direction: null, lastBarT: Number(snap.barT || 0), updatedAt: now };
      if (st.stage !== "SEEK" || st.direction || Number(st.lastBarT) !== Number(next.lastBarT)) await save(next);
      return { ...next, snapshot: snap };
    }

    if (st.direction !== snap.direction || now - Number(st.updatedAt || 0) > 35 * 60 * 1000) {
      if (st.stage === "PREPARE" || st.stage === "READY") await this.finishReadyAudit(st.readyKey, st.direction !== snap.direction ? "CANCELLED" : "EXPIRED", now);
      const next = { stage: "ARMED", direction: snap.direction, lastBarT: snap.barT, updatedAt: now };
      await save(next);
      return { ...next, snapshot: snap };
    }

    // Expiry is wall-clock based, so a stalled/repeated completed candle cannot
    // keep a warned setup alive indefinitely.
    if ((st.stage === "PREPARE" || st.stage === "READY") && now - Number(st.prepareAt || st.updatedAt || 0) > PREPARE_TTL_MS) {
      await this.finishReadyAudit(st.readyKey, "EXPIRED", now);
      const next = { stage: "ARMED", direction: snap.direction, lastBarT: snap.barT, updatedAt: now };
      await save(next);
      return { ...next, snapshot: snap };
    }

    // A recorded pullback must not survive indefinitely. If it leaves the recent
    // setup window or ages beyond four minutes, re-arm for a genuinely fresh pullback.
    if (st.stage === "PULLBACK" && (
      !snap.pullbackSeen ||
      now - Number(st.pullbackAt || st.updatedAt || 0) > PULLBACK_TTL_MS
    )) {
      const next = { stage: "ARMED", direction: snap.direction, lastBarT: snap.barT, updatedAt: now };
      await save(next);
      return { ...next, snapshot: snap };
    }

    // Repeated /signal commands within the same completed 1m candle must not
    // artificially advance the sequence.
    if (Number(st.lastBarT) === Number(snap.barT)) {
      return { ...st, snapshot: snap };
    }

    let next = { ...st, lastBarT: snap.barT, updatedAt: now };
    if (st.stage === "SEEK") {
      next = { stage: "ARMED", direction: snap.direction, lastBarT: snap.barT, updatedAt: now };
    } else if (st.stage === "ARMED" && snap.pullbackSeen) {
      next = { stage: "PULLBACK", direction: snap.direction, lastBarT: snap.barT, pullbackAt: now, updatedAt: now };
    } else if (st.stage === "READY") {
      const ageBars = Math.max(0, (Number(snap.barT) - Number(st.readyBarT || st.lastBarT)) / 60000);
      if (ageBars > 1) {
        await this.finishReadyAudit(st.readyKey, "EXPIRED", now);
        next = { stage: "ARMED", direction: snap.direction, lastBarT: snap.barT, updatedAt: now };
      }
    }

    if (JSON.stringify(next) !== JSON.stringify(st)) await save(next);
    return { ...next, snapshot: snap };
  }

  async setSetupStage(symbol, next) {
    this.setupStates[symbol] = next;
    await this.ctx.storage.put("setupStates", this.setupStates);
    return next;
  }

  async updateReadyAuditBlocker(key, reason) {
    if (!key || !reason) return;
    const row = this.readyAudit.find(x => x.key === key && !x.outcome);
    if (!row) return;
    row.lastBlocker = String(reason).slice(0, 220);
    row.lastCheckedAt = Date.now();
    await this.ctx.storage.put("readyAudit", this.readyAudit);
  }

  async finishReadyAudit(key, outcome, at = Date.now(), reason = null) {
    if (!key) return;
    const row = this.readyAudit.find(x => x.key === key && !x.outcome);
    if (!row) return;
    row.outcome = outcome;
    row.eventualState = outcome;
    row.outcomeAt = at;
    row.signalAt = outcome === "SIGNALLED" ? at : null;
    row.timeToSignalMs = outcome === "SIGNALLED" ? Math.max(0, at - Number(row.readyAlertAt || at)) : null;
    row.timeToSignalSeconds = Number.isFinite(row.timeToSignalMs) ? row.timeToSignalMs / 1000 : null;
    if (reason) row.lastBlocker = String(reason).slice(0, 220);
    await this.ctx.storage.put("readyAudit", this.readyAudit);
    console.log(JSON.stringify({ event: "ready-alert-outcome", ...row }));
  }

  exposureConflict(symbol, direction) {
    const side = usdExposureSide(symbol, direction);
    if (!side) return null;
    const now = Date.now();
    for (const sig of this.pendingSignals) {
      if (!this.isCurrentStrategyRecord(sig) || Number(sig.expiresAt) <= now) continue;
      if (sig.symbol === symbol) continue;
      const other = usdExposureSide(sig.symbol, sig.direction);
      if (other === side) {
        return {
          conflict: true, side, withSymbol: sig.symbol, withDirection: sig.direction,
          retrySeconds: Math.max(1, Math.ceil((Number(sig.expiresAt) - now) / 1000))
        };
      }
    }
    return null;
  }

  async getBlockerStats() {
    const stats = this.blockerStats || {};

    const byCategory = {
      ...(stats.byCategory || stats.counts || {})
    };

    const calculatedTotal = Object.values(byCategory)
      .reduce((sum, value) => sum + Number(value || 0), 0);

    const totalEvaluations = Number(
      stats.totalEvaluations ??
      stats.total ??
      calculatedTotal
    );

    return {
      ok: true,
      strategyId: STRATEGY_ID,
      startedAt: stats.startedAt || null,
      totalEvaluations,
      total: totalEvaluations,
      byCategory,
      bySymbol: {
        ...(stats.bySymbol || {})
      },
      efficiencyBands: {
        ...(stats.efficiencyBands || {})
      },
      efficiencyFineBands: {
        ...(stats.efficiencyFineBands || {})
      },
      recent: (stats.recent || []).slice(0, 25)
    };
  }

  formatBlockerStatsMessage(stats) {
    const total = Number(
      stats?.totalEvaluations ??
      stats?.total ??
      0
    );

    const by = stats?.byCategory || {};

    const efficiency = stats?.efficiencyBands || {};

    const fineEfficiency = stats?.efficiencyFineBands || {};

    const efficiencyTotal =
      Object.values(efficiency)
        .reduce((sum, value) => sum + Number(value || 0), 0);

    const categories = [
      ["Setup Progression", "setup_progression"],
      ["Core Structure", "core_structure"],
      ["Supporting Confirmation", "supporting_confirmation"],
      ["Transient Timing", "transient_timing"],
      ["Redundant Gate", "redundant_gate"],
      ["Risk / Cooldown", "risk_cooldown"],
      ["Other", "other"]
    ];

    const lines = categories.map(([label, key]) => {
      const count = Number(by[key] || 0);

      const pct = total > 0
        ? ((count / total) * 100).toFixed(1)
        : "0.0";

      return `${label}: ${count} (${pct}%)`;
    });

    const efficiencyLines = efficiencyTotal > 0
      ? [
        "",
        "5M EFFICIENCY FAILURES",
        `< 0.10: ${Number(efficiency.very_choppy || 0)}`,
        `0.10–0.149: ${Number(efficiency.weak || 0)}`,
        `0.15–0.199: ${Number(efficiency.near_qualified || 0)}`,
        "",
        "NEAR-QUALIFIED BREAKDOWN",
        `0.150–0.169: ${Number(fineEfficiency.near_150_169 || 0)}`,
        `0.170–0.179: ${Number(fineEfficiency.near_170_179 || 0)}`,
        `0.180–0.189: ${Number(fineEfficiency.near_180_189 || 0)}`,
        `0.190–0.199: ${Number(fineEfficiency.near_190_199 || 0)}`
      ]
      : [];

    return [
      "SIGNAL BLOCKER STATS",
      `Strategy: ${stats?.strategyId || STRATEGY_ID}`,
      `Total evaluations: ${total}`,
      "",
      ...lines,
      ...efficiencyLines
    ].join("\n");
  }
  formatRecentBlockersMessage(stats, limit = 20) {
    const recent = Array.isArray(stats?.recent)
      ? stats.recent.slice(0, Math.max(1, Math.min(Number(limit) || 20, 30)))
      : [];

    if (!recent.length) {
      return "RECENT SIGNAL BLOCKERS\n\nNo blocker events recorded yet.";
    }

    const lines = recent.map((row, index) => {
      const time = Number(row?.at)
        ? new Date(Number(row.at)).toISOString().slice(11, 19)
        : "n/a";

      return (
        `${index + 1}. ${row?.symbol || "UNKNOWN"} — ${row?.category || "other"}\n` +
        `${row?.reason || "No reason"}\n` +
        `Time: ${time} UTC`
      );
    });

    return [
      "RECENT SIGNAL BLOCKERS",
      `Showing latest ${recent.length}`,
      "",
      ...lines
    ].join("\n\n");
  }

  async recordBlocker(symbol, reason, at = Date.now()) {
    const category = classifyBlocker(reason);
    const efficiencyBand = classifyEfficiencyBand(reason);
    const pair = normalizeSymbol(symbol) || String(symbol || "");

    if (
      !this.blockerStats ||
      this.blockerStats.strategyId !== STRATEGY_ID ||
      this.blockerStats.classifierVersion !== BLOCKER_CLASSIFIER_VERSION
    ) {
      this.blockerStats = {
        strategyId: STRATEGY_ID,
        classifierVersion: BLOCKER_CLASSIFIER_VERSION,
        startedAt: at,
        total: 0,
        byCategory: {},
        bySymbol: {},
        recent: [],
        efficiencyBands: {},
        efficiencyFineBands: {}
      };
    }

    if (!this.blockerStats.byCategory) {
      this.blockerStats.byCategory = {
        ...(this.blockerStats.counts || {})
      };
    }

    if (!this.blockerStats.bySymbol) {
      this.blockerStats.bySymbol = {};
    }

    if (!Array.isArray(this.blockerStats.recent)) {
      this.blockerStats.recent = [];
    }

    if (!this.blockerStats.efficiencyBands) {
      this.blockerStats.efficiencyBands = {};
      if (!this.blockerStats.efficiencyFineBands) {
        this.blockerStats.efficiencyFineBands = {};
      }
    }

    if (efficiencyBand) {
      this.blockerStats.efficiencyBands[efficiencyBand.key] =
        Number(
          this.blockerStats.efficiencyBands[efficiencyBand.key] || 0
        ) + 1;

      if (efficiencyBand?.fineKey) {
        this.blockerStats.efficiencyFineBands[efficiencyBand.fineKey] =
          Number(
            this.blockerStats.efficiencyFineBands[efficiencyBand.fineKey] || 0
          ) + 1;
      }

    }

    this.blockerStats.total =
      Number(this.blockerStats.total || 0) + 1;

    this.blockerStats.byCategory[category] =
      Number(this.blockerStats.byCategory[category] || 0) + 1;

    if (!this.blockerStats.bySymbol[pair]) {
      this.blockerStats.bySymbol[pair] = {};
    }

    this.blockerStats.bySymbol[pair][category] =
      Number(this.blockerStats.bySymbol[pair][category] || 0) + 1;

    this.blockerStats.recent.unshift({
      at,
      symbol: pair,
      category,
      reason: String(reason || "").slice(0, 220),
      efficiencyBand: efficiencyBand?.key || null,
      efficiencyValue: efficiencyBand?.value ?? null
    });

    this.blockerStats.recent =
      this.blockerStats.recent.slice(0, 200);

    await this.ctx.storage.put("blockerStats", this.blockerStats);

    return {
      ok: true,
      category,
      total: this.blockerStats.total,
      count: this.blockerStats.byCategory[category]
    };
  }

  async analyze(symbol) {
    symbol = normalizeSymbol(symbol); if (!symbol) return { ok: false, error: "invalid symbol" };
    const pairWait = this.pairCooldownSeconds(symbol);
    if (pairWait > 0) return { ok: false, cooldown: true, retrySeconds: pairWait, symbol, reason: "pair cooldown" };

    await this.subscribe(symbol);
    if (isCryptoSymbol(symbol)) await this.ensureCryptoSocket();
    else await this.ensureSocket();
    await this.refreshIfStale(symbol);

    let arr = this.ticks.get(symbol) || [];
    if (arr.length < 8) { await sleep(1000); arr = this.ticks.get(symbol) || []; }

    const receiveAge = arr.length ? this.latestReceivedAge(symbol) : Infinity;
    const marketAge = arr.length ? this.latestMarketAge(symbol) : Infinity;
    const status = isCryptoSymbol(symbol) ? this.lastCryptoStatus : this.lastStatus;

    if (!arr.length) {
      return {
        ok: false, warming: true, symbol, ticks: 0, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge,
        status, reason: "waiting for first live Tiingo quote"
      };
    }
    if (receiveAge > 12) {
      return {
        ok: false, symbol, ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge,
        status, reason: `live feed stale: no received tick for ${receiveAge.toFixed(1)}s`
      };
    }
    if (marketAge > 20) {
      return {
        ok: false, symbol, ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge,
        status, reason: `Tiingo quote timestamp is ${marketAge.toFixed(1)}s behind live time`
      };
    }

    let bars1m;
    try { bars1m = await this.fetchOneMinuteBars(symbol); }
    catch (e) {
      if (e?.quotaExceeded) {
        return {
          ok: false, quotaExceeded: true, retryAfterMinutes: Number(e.retryAfterMinutes) || 1, symbol, ticks: arr.length,
          receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status,
          reason: "Tiingo hourly request quota is temporarily exhausted"
        };
      }
      return {
        ok: false, symbol, ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge,
        status, reason: `1m context unavailable: ${String(e?.message || e)}`
      };
    }

    let phase = await this.advanceSetupState(symbol, bars1m);
    let pullbackBlocker = null;
    if (phase.stage === "PULLBACK") {
      const pre = preAlert5m(arr, bars1m, symbol, phase.direction);
      if (pre.ok) {
        const readyKey = `${symbol}|${phase.direction}|${Number(phase.lastBarT)}`;
        phase = await this.setSetupStage(symbol, {
          stage: "PREPARE", direction: phase.direction, lastBarT: phase.lastBarT,
          setupCandleT: Number(phase.lastBarT), prepareAt: Date.now(), readyKey,
          internalPrepare: true, updatedAt: Date.now()
        });
        // Signal-only mode: continue immediately into final validation.
      } else {
        pullbackBlocker = pre.reason || "pullback has not qualified for PREPARE";
      }
    }

    if (phase.stage === "PREPARE") {
      const pre = preAlert5m(arr, bars1m, symbol, phase.direction);
      if (!pre.ok) {
        const reason = pre.reason || "PREPARE setup temporarily not aligned";
        // Once READY has actually been delivered, do not throw the setup away for
        // transient issues such as room compression, momentum fading, spread,
        // extension or a missing continuation candle. Preserve it until TTL so it
        // can recover. Only structural invalidations cancel the READY immediately.
        if (!isHardReadyInvalidation(reason)) {
          return {
            ok: false, grade: "NO TRADE", symbol, setupStage: "PREPARE", setupDirection: phase.direction,
            setupCandleT: phase.setupCandleT, readyKey: phase.readyKey, preAlert: false, preScore: pre.preScore || null,
            ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status,
            reason: `setup preserved — ${reason}`
          };
        }
        await this.finishReadyAudit(phase.readyKey, "CANCELLED", Date.now(), reason);
        phase = await this.setSetupStage(symbol, { stage: "SEEK", direction: null, lastBarT: Number(phase.lastBarT || 0), updatedAt: Date.now() });
        return {
          ok: false, grade: "NO TRADE", symbol, setupStage: "SEEK", ticks: arr.length,
          receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status, reason
        };
      }

      const final = score5m(arr, bars1m, symbol);

      if (!final.ok) {
        await this.updateReadyAuditBlocker(phase.readyKey, final.reason || "waiting for final continuation/timing confirmation");
        return {
          ...final, symbol, setupStage: "PREPARE", setupDirection: phase.direction,
          setupCandleT: phase.setupCandleT, readyKey: phase.readyKey, preAlert: false,
          preScore: pre.preScore, ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status
        };
      }
      phase = await this.setSetupStage(symbol, { ...phase, stage: "READY", readyBarT: Number(bars1m.at(-1)?.t || 0), internalReady: true, updatedAt: Date.now() });
    }

    if (phase.stage !== "READY") {
      const phaseReason = phase.stage === "SEEK"
        ? (
          phase.snapshot?.trendReason ||
          "waiting for a clean completed 5m trend"
        )
        : phase.stage === "ARMED"
          ? "trend armed — waiting for the next pullback into the SMA zone"
          : (pullbackBlocker || "pullback recorded — waiting for a fresh 1m continuation");

      return {
        ok: false, grade: "NO TRADE", symbol, setupStage: phase.stage, setupDirection: phase.direction,
        preAlert: false, preScore: null,
        ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status,
        reason: phaseReason
      };
    }

    const x = score5m(arr, bars1m, symbol);
    if (!x.ok) {
      if (phase.stage === "READY") {
        await this.finishReadyAudit(phase.readyKey, "CANCELLED", Date.now(), x.reason || "final A-grade timing failed");
        await this.setSetupStage(symbol, { stage: "SEEK", direction: null, lastBarT: Number(phase.lastBarT || 0), updatedAt: Date.now() });
      }
      return { ...x, symbol, setupStage: phase.stage, ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status };
    }

    const conflict = this.exposureConflict(symbol, x.direction);
    if (conflict) {
      await this.finishReadyAudit(phase.readyKey, "CANCELLED", Date.now(), `correlated exposure conflict with ${conflict.withSymbol}`);
      await this.setSetupStage(symbol, { stage: "SEEK", direction: null, lastBarT: Number(phase.lastBarT || 0), updatedAt: Date.now() });
      return {
        ok: false, grade: "NO TRADE", symbol, setupStage: phase.stage,
        reason: `correlated ${conflict.side === "USD_LONG" ? "USD-long" : "USD-short"} exposure already active on ${conflict.withSymbol}`,
        retrySeconds: conflict.retrySeconds, exposureConflict: conflict,
        ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge, status
      };
    }

    return {
      ...x, symbol, setupStage: phase.stage, readyAlertAt: Number(phase.readyAlertAt || 0),
      ticks: arr.length, receiveAgeSeconds: receiveAge, marketAgeSeconds: marketAge,
      status, reconnectCount: this.reconnectCount, generatedAt: Date.now()
    };
  }

  isCurrentStrategyRecord(record) {
    if (!record) return false;
    if (record.strategyId) return record.strategyId === STRATEGY_ID;
    const entry = Number(record.entryAt || 0), expiry = Number(record.expiresAt || 0);
    const inferredSeconds = entry && expiry ? Math.round((expiry - entry) / 1000) : 0;
    return inferredSeconds === EXPIRY_SECONDS;
  }

  getRiskGate() {
    const now = Date.now();
    // Do not globally block scans while another 5-minute trade is still pending.
    // pairCooldownSeconds() already excludes the active pair, so the remaining pairs
    // can still be scanned for independent qualified opportunities.

    const hist = this.signalHistory.filter(x => this.isCurrentStrategyRecord(x)).sort((a, b) => Number(b.settledAt || b.entryAt) - Number(a.settledAt || a.entryAt));
    const latest = hist[0];
    if (latest) {
      const sinceEntry = now - Number(latest.entryAt || 0);
      if (sinceEntry < GLOBAL_SIGNAL_COOLDOWN_MS) {
        return { ok: false, reason: "global precision cooldown", retrySeconds: Math.ceil((GLOBAL_SIGNAL_COOLDOWN_MS - sinceEntry) / 1000) };
      }
    }

    const resolved = hist.filter(x => x.result === "WIN" || x.result === "LOSS");
    if (resolved.length >= 2 && resolved[0].result === "LOSS" && resolved[1].result === "LOSS") {
      const sinceLatest = now - Number(resolved[0].settledAt || resolved[0].entryAt || 0);
      if (sinceLatest < LOSS_CIRCUIT_BREAKER_MS) {
        return { ok: false, reason: "two-loss circuit breaker", retrySeconds: Math.ceil((LOSS_CIRCUIT_BREAKER_MS - sinceLatest) / 1000) };
      }
    }

    // If the last three resolved trades contain two or more losses, cool down globally for 10 minutes.
    const last3 = resolved.slice(0, 3);
    if (last3.length === 3 && last3.filter(x => x.result === "LOSS").length >= 2) {
      const sinceLatest = now - Number(last3[0].settledAt || last3[0].entryAt || 0);
      const adaptive = 10 * 60 * 1000;
      if (sinceLatest < adaptive) {
        return { ok: false, reason: "recent performance cooldown", retrySeconds: Math.ceil((adaptive - sinceLatest) / 1000) };
      }
    }

    return { ok: true };
  }

  pairCooldownSeconds(symbol) {
    const now = Date.now();
    const all = [...this.pendingSignals, ...this.signalHistory]
      .filter(x => x.symbol === symbol && this.isCurrentStrategyRecord(x))
      .sort((a, b) => Number(b.entryAt) - Number(a.entryAt));
    const latest = all[0];
    if (!latest) return 0;

    const resolved = all.filter(x => x.result === "WIN" || x.result === "LOSS");
    if (resolved.length >= 2 && resolved[0].result === "LOSS" && resolved[1].result === "LOSS") {
      const left = 30 * 60 * 1000 - (now - Number(resolved[0].settledAt || resolved[0].entryAt || 0));
      if (left > 0) return Math.ceil(left / 1000);
    }
    if (resolved[0]?.result === "LOSS") {
      const left = 12 * 60 * 1000 - (now - Number(resolved[0].settledAt || resolved[0].entryAt || 0));
      if (left > 0) return Math.ceil(left / 1000);
    }

    const left = PAIR_SIGNAL_COOLDOWN_MS - (now - Number(latest.entryAt || 0));
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  async trackSignal(req) {
    const body = await req.json();
    const symbol = normalizeSymbol(body?.symbol);
    const direction = String(body?.direction || "").toUpperCase();
    const entryPrice = Number(body?.entryPrice);
    const chatId = body?.chatId;
    const chatIds = Array.isArray(body?.chatIds) ? body.chatIds.map(String).filter(Boolean) : [];
    const sourceUpdateId = String(body?.sourceUpdateId ?? "");
    const entryAt = Number(body?.entryAt) || Date.now();

    if (!symbol || !FIXED_UNIVERSE.includes(symbol)) return { ok: false, error: "invalid symbol" };
    if (!["CALL", "PUT"].includes(direction)) return { ok: false, error: "invalid direction" };
    if (!Number.isFinite(entryPrice) || (chatId == null && !chatIds.length)) return { ok: false, error: "invalid tracking payload" };

    if (sourceUpdateId) {
      const duplicate = this.pendingSignals.find(x => String(x.sourceUpdateId) === sourceUpdateId) ||
        this.signalHistory.find(x => String(x.sourceUpdateId) === sourceUpdateId);
      if (duplicate) return { ok: true, duplicate: true, id: duplicate.id };
    }

    const sig = {
      id: crypto.randomUUID(),
      sourceUpdateId,
      chatId: chatId == null ? (chatIds[0] || null) : chatId,
      chatIds: chatIds.length ? chatIds : undefined,
      symbol,
      direction,
      entryPrice,
      entryAt,
      expiresAt: entryAt + EXPIRY_SECONDS * 1000,
      expirySeconds: EXPIRY_SECONDS,
      strategyId: STRATEGY_ID,
      version: VERSION,
      features: body?.features || null
    };
    this.pendingSignals.push(sig);
    await this.ctx.storage.put("pendingSignals", this.pendingSignals);
    const setup = this.setupStates[symbol];
    if (setup?.readyKey) await this.finishReadyAudit(setup.readyKey, "SIGNALLED", entryAt);
    this.setupStates[symbol] = { stage: "SEEK", direction: null, lastBarT: 0, updatedAt: Date.now() };
    await this.ctx.storage.put("setupStates", this.setupStates);
    await this.scheduleAlarm();
    return { ok: true, id: sig.id, expiresAt: sig.expiresAt };
  }

  async registerAlertChat(req) {
    const body = await req.json();
    const chatId = body?.chatId;
    if (chatId == null) return { ok: false, error: "missing chatId" };
    const id = String(chatId);
    if (!this.alertChats.includes(id)) {
      this.alertChats.push(id);
      this.alertChats = this.alertChats.slice(-10);
      await this.ctx.storage.put("alertChats", this.alertChats);
    }
    return { ok: true, chatId: id, count: this.alertChats.length };
  }

  async getAlertChats() {
    return { ok: true, chats: [...this.alertChats] };
  }

  async claimReadyAlert(req) {
    const body = await req.json();
    const symbol = normalizeSymbol(body?.symbol);
    const direction = String(body?.direction || "").toUpperCase();
    const setupCandleT = Number(body?.setupCandleT);
    const requestedKey = String(body?.readyKey || "");
    if (!symbol || !["CALL", "PUT"].includes(direction) || !Number.isFinite(setupCandleT)) return { ok: false, error: "invalid ready-alert claim" };

    const now = Date.now();
    const ttl = PREPARE_TTL_MS;
    for (const [k, v] of Object.entries(this.readyAlertClaims || {})) {
      if (now - Number(v || 0) > ttl) delete this.readyAlertClaims[k];
    }

    const key = `${symbol}|${direction}|${setupCandleT}`;
    const setup = this.setupStates[symbol];
    if (key !== requestedKey || setup?.stage !== "PREPARE" || setup.readyKey !== key) {
      return { ok: false, claimed: false, error: "setup is no longer in PREPARE" };
    }
    const last = Number(this.readyAlertClaims[key] || 0);
    if (last && now - last < ttl) {
      return { ok: true, claimed: false, retrySeconds: Math.ceil((ttl - (now - last)) / 1000) };
    }

    this.readyAlertClaims[key] = now;
    await this.ctx.storage.put("readyAlertClaims", this.readyAlertClaims);
    setup.readyAlertAt = now;
    setup.updatedAt = now;
    await this.setSetupStage(symbol, setup);
    const audit = {
      key, setupId: key, setupCandleT, readyAlertAt: now, symbol, direction, setupStage: "PREPARE",
      outcome: null, eventualState: null, outcomeAt: null, signalAt: null, timeToSignalMs: null, timeToSignalSeconds: null
    };
    this.readyAudit = [audit, ...this.readyAudit.filter(x => x.key !== key)].slice(0, 200);
    await this.ctx.storage.put("readyAudit", this.readyAudit);
    console.log(JSON.stringify({ event: "ready-alert", ...audit }));
    return { ok: true, claimed: true, key };
  }

  async finishReadySetup(req) {
    const body = await req.json();
    const symbol = normalizeSymbol(body?.symbol);
    const outcome = String(body?.outcome || "").toUpperCase();
    if (!symbol || !["CANCELLED", "EXPIRED"].includes(outcome)) return { ok: false, error: "invalid READY outcome" };
    const setup = this.setupStates[symbol];
    if (setup?.readyKey) await this.finishReadyAudit(setup.readyKey, outcome, Date.now(), body?.reason || null);
    await this.setSetupStage(symbol, { stage: "SEEK", direction: null, lastBarT: Number(setup?.lastBarT || 0), updatedAt: Date.now() });
    return { ok: true };
  }

  recordForwardSettlement(rec) {
    const tag = rec?.features?.v13_4Shadow;
    if (!tag || tag.id !== V13_4_SHADOW.id || typeof tag.eligible !== "boolean") return false;
    if (!this.forwardStats || this.forwardStats.shadowId !== V13_4_SHADOW.id || this.forwardStats.strategyId !== STRATEGY_ID) {
      this.forwardStats = {
        strategyId: STRATEGY_ID,
        shadowId: V13_4_SHADOW.id,
        frozenRule: { dmiGapMin: V13_4_SHADOW.dmiGapMin, adxMax: V13_4_SHADOW.adxMax },
        initializedAt: Date.now(),
        firstObservedAt: null,
        lastObservedAt: null,
        eligible: { total: 0, wins: 0, losses: 0, draws: 0, voids: 0 },
        nonEligible: { total: 0, wins: 0, losses: 0, draws: 0, voids: 0 }
      };
    }
    const bucket = tag.eligible === true ? this.forwardStats.eligible : this.forwardStats.nonEligible;
    bucket.total++;
    if (rec.result === "WIN") bucket.wins++;
    else if (rec.result === "LOSS") bucket.losses++;
    else if (rec.result === "DRAW") bucket.draws++;
    else if (rec.result === "VOID") bucket.voids++;
    const at = Number(rec.settledAt || Date.now());
    this.forwardStats.firstObservedAt = this.forwardStats.firstObservedAt == null ? at : Math.min(Number(this.forwardStats.firstObservedAt), at);
    this.forwardStats.lastObservedAt = this.forwardStats.lastObservedAt == null ? at : Math.max(Number(this.forwardStats.lastObservedAt), at);
    return true;
  }

  async getForwardStats() {
    const base = this.forwardStats || {
      strategyId: STRATEGY_ID,
      shadowId: V13_4_SHADOW.id,
      frozenRule: {
        dmiGapMin: V13_4_SHADOW.dmiGapMin,
        adxMax: V13_4_SHADOW.adxMax
      },
      initializedAt: null,
      firstObservedAt: null,
      lastObservedAt: null,
      eligible: {
        total: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        voids: 0
      },
      nonEligible: {
        total: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        voids: 0
      }
    };

    const summarize = b => {
      const x = b || {
        total: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        voids: 0
      };

      const wl =
        Number(x.wins || 0) +
        Number(x.losses || 0);

      return {
        ...x,
        wl,
        winRate: wl
          ? (Number(x.wins || 0) / wl) * 100
          : null
      };
    };

    const pending = this.pendingSignals.filter(
      x =>
        this.isCurrentStrategyRecord(x) &&
        x?.features?.v13_4Shadow?.id === V13_4_SHADOW.id &&
        x.features.v13_4Shadow.eligible === true
    ).length;

    return {
      ok: true,
      strategyId: STRATEGY_ID,
      shadowId: V13_4_SHADOW.id,
      frozenRule: {
        dmiGapMin: V13_4_SHADOW.dmiGapMin,
        adxMax: V13_4_SHADOW.adxMax
      },
      initializedAt: base.initializedAt || null,
      firstObservedAt: base.firstObservedAt || null,
      lastObservedAt: base.lastObservedAt || null,
      eligible: summarize(base.eligible),
      nonEligible: summarize(base.nonEligible),
      pendingEligible: pending,
      targetMinimum: 50,
      targetPreferred: 100,
      persistence: "durable-object-aggregate"
    };
  }

  async getShortShadowStats() {
    const state = this.shortShadowState || {
      strategyId: SHORT_SHADOW_ID,
      startedAt: null,
      pending: [],
      history: []
    };

    const pending = Array.isArray(state.pending)
      ? state.pending
      : [];

    const history = Array.isArray(state.history)
      ? state.history
      : [];

    const records = [
      ...history,
      ...pending
    ];


    const summarizeSubset = (items, key) => {
      const terminal = [
        "WIN",
        "LOSS",
        "DRAW",
        "VOID"
      ];

      const settled = items.filter(x =>
        terminal.includes(
          String(
            x?.[key] || ""
          ).toUpperCase()
        )
      );

      const wins = settled.filter(
        x =>
          String(
            x?.[key] || ""
          ).toUpperCase() === "WIN"
      ).length;

      const losses = settled.filter(
        x =>
          String(
            x?.[key] || ""
          ).toUpperCase() === "LOSS"
      ).length;

      const draws = settled.filter(
        x =>
          String(
            x?.[key] || ""
          ).toUpperCase() === "DRAW"
      ).length;

      const voids = settled.filter(
        x =>
          String(
            x?.[key] || ""
          ).toUpperCase() === "VOID"
      ).length;

      const wl =
        wins + losses;

      return {
        settled: settled.length,
        wins,
        losses,
        draws,
        voids,

        winRate:
          wl > 0
            ? (wins / wl) * 100
            : null
      };
    };


    const summarize = key =>
      summarizeSubset(
        records,
        key
      );


    // -------------------------------------------------
    // PERFORMANCE BY PAIR
    // -------------------------------------------------

    const byPair = {};

    for (
      const symbol
      of SHORT_SHADOW_UNIVERSE
    ) {
      const pairRecords =
        records.filter(
          x =>
            x?.symbol === symbol
        );

      const pairPending =
        pending.filter(
          x =>
            x?.symbol === symbol
        ).length;

      byPair[symbol] = {
        pending: pairPending,

        expiry60:
          summarizeSubset(
            pairRecords,
            "result60"
          ),

        expiry120:
          summarizeSubset(
            pairRecords,
            "result120"
          )
      };
    }


    // -------------------------------------------------
    // PERFORMANCE BY DIRECTION
    // -------------------------------------------------

    const byDirection = {};

    for (
      const direction
      of ["CALL", "PUT"]
    ) {
      const directionRecords =
        records.filter(
          x =>
            String(
              x?.direction || ""
            ).toUpperCase() ===
            direction
        );

      const directionPending =
        pending.filter(
          x =>
            String(
              x?.direction || ""
            ).toUpperCase() ===
            direction
        ).length;

      byDirection[direction] = {
        pending:
          directionPending,

        expiry60:
          summarizeSubset(
            directionRecords,
            "result60"
          ),

        expiry120:
          summarizeSubset(
            directionRecords,
            "result120"
          )
      };
    }
    // -------------------------------------------------
    // PERFORMANCE BY UTC MARKET WINDOW
    // Observational only — does not affect entries.
    // -------------------------------------------------

    const marketWindow = entryAt => {
      const t = Number(entryAt);

      if (!Number.isFinite(t)) {
        return "UNKNOWN";
      }

      const hour =
        new Date(t).getUTCHours();

      if (hour >= 0 && hour < 7) {
        return "ASIA";
      }

      if (hour >= 7 && hour < 13) {
        return "LONDON";
      }

      if (hour >= 13 && hour < 17) {
        return "OVERLAP";
      }

      if (hour >= 17 && hour < 21) {
        return "NEW_YORK";
      }

      return "LATE";
    };


    const bySession = {};

    for (
      const session of [
        "ASIA",
        "LONDON",
        "OVERLAP",
        "NEW_YORK",
        "LATE"
      ]
    ) {
      const sessionRecords =
        records.filter(
          x =>
            marketWindow(x?.entryAt) ===
            session
        );

      const sessionPending =
        pending.filter(
          x =>
            marketWindow(x?.entryAt) ===
            session
        ).length;

      bySession[session] = {
        pending:
          sessionPending,

        expiry60:
          summarizeSubset(
            sessionRecords,
            "result60"
          ),

        expiry120:
          summarizeSubset(
            sessionRecords,
            "result120"
          )
      };
    }

    // -------------------------------------------------
    // CAPTURE CLUSTERS
    // Same-minute captures help identify correlated
    // multi-pair bursts.
    // -------------------------------------------------

    const clusterMap =
      new Map();

    for (const rec of records) {
      const entryAt =
        Number(rec?.entryAt);

      if (
        !Number.isFinite(entryAt)
      ) {
        continue;
      }

      const minute =
        Math.floor(
          entryAt / 60000
        ) * 60000;

      const list =
        clusterMap.get(minute) || [];

      list.push({
        symbol:
          rec.symbol,

        direction:
          rec.direction,

        entryAt,

        result60:
          rec.result60 || null,

        result120:
          rec.result120 || null
      });

      clusterMap.set(
        minute,
        list
      );
    }


    const clusterRows =
      [...clusterMap.entries()]
        .map(
          ([minute, setups]) => ({
            minute,

            count:
              setups.length,

            symbols: [
              ...new Set(
                setups.map(
                  x => x.symbol
                )
              )
            ],

            directions:
              setups.reduce(
                (acc, x) => {
                  const d =
                    String(
                      x.direction || ""
                    ).toUpperCase();

                  if (d === "CALL") {
                    acc.CALL++;
                  } else if (
                    d === "PUT"
                  ) {
                    acc.PUT++;
                  }

                  return acc;
                },
                {
                  CALL: 0,
                  PUT: 0
                }
              )
          })
        )
        .sort(
          (a, b) =>
            Number(b.minute) -
            Number(a.minute)
        );


    const clusterStats = {
      totalClusters:
        clusterRows.length,

      multiSetupClusters:
        clusterRows.filter(
          x =>
            x.count > 1
        ).length,

      maxClusterSize:
        clusterRows.length
          ? Math.max(
            ...clusterRows.map(
              x => x.count
            )
          )
          : 0,

      recent:
        clusterRows.slice(
          0,
          10
        )
    };

    const summarizeClusterPerformance = (
      key,
      session = null
    ) => {
      const terminal = [
        "WIN",
        "LOSS",
        "DRAW",
        "VOID"
      ];

      const rows =
        [...clusterMap.entries()]
          .filter(
            ([minute]) =>
              session == null ||
              marketWindow(minute) === session
          )
          .map(([minute, setups]) => {
            const settled =
              setups.filter(x =>
                terminal.includes(
                  String(
                    x?.[key] || ""
                  ).toUpperCase()
                )
              );

            const wins =
              settled.filter(
                x =>
                  String(
                    x?.[key] || ""
                  ).toUpperCase() === "WIN"
              ).length;

            const losses =
              settled.filter(
                x =>
                  String(
                    x?.[key] || ""
                  ).toUpperCase() === "LOSS"
              ).length;

            const draws =
              settled.filter(
                x =>
                  String(
                    x?.[key] || ""
                  ).toUpperCase() === "DRAW"
              ).length;

            const voids =
              settled.filter(
                x =>
                  String(
                    x?.[key] || ""
                  ).toUpperCase() === "VOID"
              ).length;

            const wl =
              wins + losses;

            return {
              minute,

              setupCount:
                setups.length,

              settled:
                settled.length,

              wins,
              losses,
              draws,
              voids,

              wl,

              winRate:
                wl > 0
                  ? (wins / wl) * 100
                  : null
            };
          })
          .filter(
            x =>
              x.settled > 0
          )
          .sort(
            (a, b) =>
              Number(b.minute) -
              Number(a.minute)
          );


      const scored =
        rows.filter(
          x => x.wl > 0
        );


      const equalClusterWinRate =
        scored.length
          ? scored.reduce(
            (sum, x) =>
              sum + Number(x.winRate),
            0
          ) / scored.length
          : null;


      return {
        settledClusters:
          rows.length,

        scoredClusters:
          scored.length,

        winningClusters:
          scored.filter(
            x =>
              x.wins > x.losses
          ).length,

        losingClusters:
          scored.filter(
            x =>
              x.losses > x.wins
          ).length,

        tiedClusters:
          scored.filter(
            x =>
              x.wins === x.losses
          ).length,

        multiSetupClusters:
          rows.filter(
            x =>
              x.setupCount > 1
          ).length,

        equalClusterWinRate,

        recent:
          rows.slice(0, 10)
      };
    };


    const clusterAdjusted = {
      expiry60:
        summarizeClusterPerformance(
          "result60"
        ),

      expiry120:
        summarizeClusterPerformance(
          "result120"
        )
    };

    const clusterAdjustedBySession = {};

    for (
      const session of [
        "ASIA",
        "LONDON",
        "OVERLAP",
        "NEW_YORK",
        "LATE"
      ]
    ) {
      clusterAdjustedBySession[session] = {
        expiry60:
          summarizeClusterPerformance(
            "result60",
            session
          ),

        expiry120:
          summarizeClusterPerformance(
            "result120",
            session
          )
      };
    }

    const fullySettledClusters =
      Math.min(
        Number(
          clusterAdjusted.expiry60
            ?.settledClusters || 0
        ),
        Number(
          clusterAdjusted.expiry120
            ?.settledClusters || 0
        )
      );


    const evidence = {
      settledClusters:
        fullySettledClusters,

      minimumTarget:
        50,

      preferredTarget:
        100,

      minimumProgressPct:
        Math.min(
          100,
          (
            fullySettledClusters /
            50
          ) * 100
        ),

      preferredProgressPct:
        Math.min(
          100,
          (
            fullySettledClusters /
            100
          ) * 100
        ),

      status:
        fullySettledClusters >= 100
          ? "preferred target reached"
          : fullySettledClusters >= 50
            ? "minimum target reached"
            : "collecting"
    };

    return {
      ok: true,

      strategyId:
        SHORT_SHADOW_ID,

      startedAt:
        state.startedAt || null,

      pending:
        pending.length,

      expiry60:
        summarize(
          "result60"
        ),

      expiry120:
        summarize(
          "result120"
        ),

      byPair,

      byDirection,

      bySession,

      clusters:
        clusterStats,

      clusterAdjusted,
      clusterAdjustedBySession,
      evidence,
      recent:
        history.slice(
          0,
          20
        )
    };
  }

  async captureShortShadow(body = {}) {
    const symbol = normalizeSymbol(body?.symbol);
    const direction = String(body?.direction || "").toUpperCase();
    const entryPrice = Number(body?.entryPrice);
    const entryAt = Number(body?.entryAt) || Date.now();

    if (!symbol || !SHORT_SHADOW_UNIVERSE.includes(symbol)) {
      return { ok: false, error: "invalid short-shadow symbol" };
    }

    if (!["CALL", "PUT"].includes(direction)) {
      return { ok: false, error: "invalid short-shadow direction" };
    }

    if (!Number.isFinite(entryPrice)) {
      return { ok: false, error: "invalid short-shadow entry price" };
    }

    if (!this.shortShadowState) {
      this.shortShadowState = {
        strategyId: SHORT_SHADOW_ID,
        startedAt: Date.now(),
        pending: [],
        history: []
      };
    }

    const sourceKey = String(
      body?.sourceKey ||
      `${symbol}|${direction}|${Math.floor(entryAt / 60000)}`
    );

    const all = [
      ...(this.shortShadowState.pending || []),
      ...(this.shortShadowState.history || [])
    ];

    const duplicate = all.find(
      x => String(x?.sourceKey || "") === sourceKey
    );

    if (duplicate) {
      return {
        ok: true,
        duplicate: true,
        id: duplicate.id
      };
    }

    const record = {
      id: crypto.randomUUID(),
      sourceKey,
      strategyId: SHORT_SHADOW_ID,
      symbol,
      direction,
      entryPrice,
      entryAt,
      expiry60At: entryAt + 60 * 1000,
      expiry120At: entryAt + 120 * 1000,
      result60: null,
      result120: null,
      exit60Price: null,
      exit120Price: null,
      exit60TickAt: null,
      exit120TickAt: null,
      features: body?.features || null,
      capturedAt: Date.now()
    };

    this.shortShadowState.pending = [
      record,
      ...(this.shortShadowState.pending || [])
    ].slice(0, SHORT_SHADOW_MAX_PENDING);

    await this.ctx.storage.put(
      "shortShadowState",
      this.shortShadowState
    );

    await this.scheduleAlarm();

    return {
      ok: true,
      id: record.id,
      sourceKey,
      symbol,
      direction,
      entryPrice,
      entryAt,
      expiry60At: record.expiry60At,
      expiry120At: record.expiry120At
    };
  }

  async settleShortShadow(now = Date.now()) {
    const state = this.shortShadowState;

    if (
      !state ||
      !Array.isArray(state.pending) ||
      !state.pending.length
    ) {
      return {
        ok: true,
        settled60: 0,
        settled120: 0,
        completed: 0
      };
    }

    let settled60 = 0;
    let settled120 = 0;
    let completed = 0;
    let changed = false;

    const keep = [];
    const finished = [];

    const resolveOutcome = (
      direction,
      entryPrice,
      exitPrice
    ) => {
      const delta =
        Number(exitPrice) - Number(entryPrice);

      if (Math.abs(delta) <= 1e-12) {
        return "DRAW";
      }

      const won =
        direction === "CALL"
          ? delta > 0
          : delta < 0;

      return won ? "WIN" : "LOSS";
    };

    for (const original of state.pending) {
      const rec = { ...original };

      const ticks =
        this.ticks.get(rec.symbol) || [];

      if (
        !rec.result60 &&
        now >= Number(rec.expiry60At)
      ) {
        const tick60 = ticks.find(
          t =>
            Number(t.r || t.t) >=
            Number(rec.expiry60At)
        );

        if (tick60) {
          rec.exit60Price = Number(tick60.p);
          rec.exit60TickAt =
            Number(tick60.r || tick60.t);

          rec.result60 = resolveOutcome(
            rec.direction,
            rec.entryPrice,
            rec.exit60Price
          );

          settled60++;
          changed = true;
        } else if (
          now - Number(rec.expiry60At) >= 15000
        ) {
          rec.result60 = "VOID";
          settled60++;
          changed = true;
        }
      }

      if (
        !rec.result120 &&
        now >= Number(rec.expiry120At)
      ) {
        const tick120 = ticks.find(
          t =>
            Number(t.r || t.t) >=
            Number(rec.expiry120At)
        );

        if (tick120) {
          rec.exit120Price = Number(tick120.p);
          rec.exit120TickAt =
            Number(tick120.r || tick120.t);

          rec.result120 = resolveOutcome(
            rec.direction,
            rec.entryPrice,
            rec.exit120Price
          );

          settled120++;
          changed = true;
        } else if (
          now - Number(rec.expiry120At) >= 15000
        ) {
          rec.result120 = "VOID";
          settled120++;
          changed = true;
        }
      }

      if (rec.result60 && rec.result120) {
        rec.completedAt = now;

        finished.push(rec);
        completed++;
        changed = true;
      } else {
        keep.push(rec);
      }
    }

    state.pending = keep;

    if (finished.length) {
      state.history = [
        ...finished,
        ...(state.history || [])
      ].slice(0, SHORT_SHADOW_MAX_HISTORY);
    }

    if (changed) {
      await this.ctx.storage.put(
        "shortShadowState",
        state
      );
    }

    return {
      ok: true,
      settled60,
      settled120,
      completed
    };
  }

  async evaluateShortShadow(symbol) {
    symbol = normalizeSymbol(symbol);

    if (!symbol || !SHORT_SHADOW_UNIVERSE.includes(symbol)) {
      return {
        ok: false,
        error: "invalid short-shadow symbol"
      };
    }

    // Do not overlap experimental trades on the same pair.
    const active = (
      this.shortShadowState?.pending || []
    ).find(x => x.symbol === symbol);

    if (active) {
      return {
        ok: false,
        skipped: true,
        symbol,
        reason: "short-shadow position already pending on pair"
      };
    }

    await this.subscribe(symbol);
    await this.ensureSocket();
    await this.refreshIfStale(symbol);

    const ticks = this.ticks.get(symbol) || [];

    if (ticks.length < 8) {
      return {
        ok: false,
        warming: true,
        symbol,
        reason: `short-shadow live ticks still building (${ticks.length}/8)`
      };
    }

    const receiveAge = this.latestReceivedAge(symbol);
    const marketAge = this.latestMarketAge(symbol);

    if (receiveAge > 8) {
      return {
        ok: false,
        symbol,
        reason:
          `short-shadow live quote stale: ${receiveAge.toFixed(1)}s`
      };
    }

    if (marketAge > 20) {
      return {
        ok: false,
        symbol,
        reason:
          `short-shadow provider quote is ${marketAge.toFixed(1)}s old`
      };
    }

    let bars1m;

    try {
      bars1m =
        await this.fetchOneMinuteBars(symbol);
    } catch (e) {
      return {
        ok: false,
        symbol,
        quotaExceeded:
          Boolean(e?.quotaExceeded),
        retryAfterMinutes:
          Number(e?.retryAfterMinutes || 0),
        reason:
          `short-shadow 1m context unavailable: ${String(
            e?.message || e
          )}`
      };
    }

    const candidate =
      scoreCruz1mShadow(
        ticks,
        bars1m,
        symbol
      );

    if (!candidate.ok) {
      return {
        ...candidate,
        symbol,
        captured: false
      };
    }

    const quote = ticks.at(-1);
    const entryPrice = Number(quote?.p);

    if (!Number.isFinite(entryPrice)) {
      return {
        ok: false,
        symbol,
        reason: "short-shadow entry quote unavailable"
      };
    }

    const entryAt = Date.now();

    const sourceKey =
      `${SHORT_SHADOW_ID}|${symbol}|` +
      `${candidate.direction}|` +
      `${Math.floor(entryAt / 60000)}`;

    const capture =
      await this.captureShortShadow({
        symbol,
        direction: candidate.direction,
        entryPrice,
        entryAt,
        sourceKey,

        features: {
          model:
            "cruz-1m-ichimoku-dmi",

          timeframe:
            candidate.timeframe,

          expiryCandidates:
            candidate.expiryCandidates,

          ichimoku:
            candidate.ichimoku,

          dmi:
            candidate.dmi,

          trigger:
            candidate.trigger,

          reasons:
            candidate.reasons
        }
      });

    return {
      ...candidate,
      symbol,
      captured:
        Boolean(
          capture?.ok &&
          !capture?.duplicate
        ),
      duplicate:
        Boolean(capture?.duplicate),
      shadowId:
        capture?.id || null,
      entryPrice,
      entryAt
    };
  }

  async getTrackingStats() {
    const current = this.signalHistory.filter(x => this.isCurrentStrategyRecord(x));
    const wins = current.filter(x => x.result === "WIN").length;
    const losses = current.filter(x => x.result === "LOSS").length;
    const draws = current.filter(x => x.result === "DRAW").length;
    const voids = current.filter(x => x.result === "VOID").length;
    const resolved = wins + losses;
    const winRate = resolved > 0 ? (wins / resolved) * 100 : null;
    const pending = this.pendingSignals.filter(x => this.isCurrentStrategyRecord(x)).length;
    return {
      ok: true,
      strategyId: STRATEGY_ID,
      expirySeconds: EXPIRY_SECONDS,
      total: current.length,
      wins, losses, draws, voids, pending, winRate,
      recent: current.slice(0, 5),
      readyAudit: this.readyAudit.slice(0, 20),
      allTime: { ...this.signalStats }
    };
  }

  async fetch(req) {
    const u = new URL(req.url), symbol = normalizeSymbol(u.searchParams.get("symbol") || "");

    if (u.pathname === "/sleep") return json(await this.closeFeeds("request complete"));

    if (u.pathname === "/claim-cron" && req.method === "POST") {
      const now = Date.now(), minute = Math.floor(now / 60000);
      const last = Number((await this.ctx.storage.get("lastCronMinute")) ?? -1);
      if (last === minute) return json({ ok: true, claimed: false, minute });
      const count = Number((await this.ctx.storage.get("cronScanCount")) || 0) + 1;
      await this.ctx.storage.put("lastCronMinute", minute);
      await this.ctx.storage.put("lastCronClaimAt", now);
      await this.ctx.storage.put("cronScanCount", count);
      return json({ ok: true, claimed: true, minute, count });
    }

    if (u.pathname === "/cron-result" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = body?.result || null;

      const summary = result ? {
        ok: Boolean(result.ok),
        ready: Boolean(result.ready),
        symbol: result.symbol || null,
        direction: result.direction || null,
        reason: result.reason || null,

        readyAlertsSent:
          Number(result.readyAlertsSent || 0),

        shortShadowChecked:
          Number(result.shortShadowChecked || 0),

        shortShadowCaptured:
          Number(result.shortShadowCaptured || 0),

        shortShadowSymbols:
          Array.isArray(result.shortShadowSymbols)
            ? result.shortShadowSymbols.slice(0, 6)
            : []
      } : null;

      await this.ctx.storage.put(
        "lastCronResultAt",
        Date.now()
      );

      await this.ctx.storage.put(
        "lastCronResult",
        summary
      );

      return json({ ok: true });
    }

    if (u.pathname === "/cronstatus") {
      const lastCronClaimAt = Number((await this.ctx.storage.get("lastCronClaimAt")) || 0);
      const lastCronResultAt = Number((await this.ctx.storage.get("lastCronResultAt")) || 0);
      const count = Number((await this.ctx.storage.get("cronScanCount")) || 0);
      const lastResult = (await this.ctx.storage.get("lastCronResult")) || null;
      const ageSeconds = lastCronClaimAt ? Math.max(0, (Date.now() - lastCronClaimAt) / 1000) : null;
      return json({
        ok: true, lastCronClaimAt, lastCronResultAt, ageSeconds, count, lastResult,
        quotaBlockedUntil: Number(this.quotaBlockedUntil || 0) || null,
        quotaRetryMinutes: this.quotaBlockedUntil > Date.now() ? this.quotaRetryMinutes() : 0
      });
    }

    if (u.pathname === "/reconnect") {
      await this.forceReconnect("requested");
      await this.forceCryptoReconnect("requested");
      return json({
        ok: true, version: VERSION,
        fxStatus: this.lastStatus, cryptoStatus: this.lastCryptoStatus,
        reconnectCount: this.reconnectCount
      });
    }

    if (u.pathname === "/signal") {
      const result = await this.analyze(symbol);

      if (!result?.ok && result?.reason) {
        try {
          await this.recordBlocker(symbol, result.reason);
        } catch (e) {
          console.error(
            "recordBlocker failed",
            symbol,
            String(e?.message || e)
          );
        }
      }

      return json(result);
    }

    if (u.pathname === "/short-shadow") {
      return json(
        await this.evaluateShortShadow(symbol)
      );
    }

    if (u.pathname === "/quote") {
      if (!symbol) return json({ ok: false, error: "invalid symbol" }, 400);
      await this.subscribe(symbol);
      if (isCryptoSymbol(symbol)) await this.ensureCryptoSocket();
      else await this.ensureSocket();
      const arr = this.ticks.get(symbol) || [];
      const q = arr.at(-1);
      if (!q) return json({ ok: false, symbol, error: "no live quote" });
      return json({
        ok: true,
        symbol,
        price: Number(q.p),
        bid: q.bid,
        ask: q.ask,
        providerAt: Number(q.t),
        receivedAt: Number(q.r || q.t),
        receiveAgeSeconds: this.latestReceivedAge(symbol),
        marketAgeSeconds: this.latestMarketAge(symbol)
      });
    }
    if (u.pathname === "/tick-sample") {
      const ms = Math.max(2000, Math.min(8000, Number(u.searchParams.get("ms") || 5000)));
      return json(await this.sampleTickFlow(ms));
    }
    if (u.pathname === "/prime-live") {
      const ms = Math.max(2000, Math.min(8000, Number(u.searchParams.get("ms") || 5000)));
      return json(await this.primeLiveFlow(ms));
    }
    if (u.pathname === "/top-health") return json(await this.getTopHealth());
    if (u.pathname === "/risk") return json(this.getRiskGate());
    if (u.pathname === "/register-chat" && req.method === "POST") return json(await this.registerAlertChat(req));
    if (u.pathname === "/claim-ready" && req.method === "POST") return json(await this.claimReadyAlert(req));
    if (u.pathname === "/ready-outcome" && req.method === "POST") return json(await this.finishReadySetup(req));
    if (u.pathname === "/chats") return json(await this.getAlertChats());
    if (u.pathname === "/track" && req.method === "POST") return json(await this.trackSignal(req));
    if (u.pathname === "/stats") return json(await this.getTrackingStats());
    if (u.pathname === "/forwardstats") return json(await this.getForwardStats());
    if (u.pathname === "/shortstats") {
      return json(await this.getShortShadowStats());
    }
    if (u.pathname === "/blockerstats") {
      const stats = await this.getBlockerStats();

      return json({
        ...stats,
        message: this.formatBlockerStatsMessage(stats)
      });
    }

    if (u.pathname === "/blockerrecent") {
      const stats = await this.getBlockerStats();

      const limit = Math.max(
        1,
        Math.min(
          30,
          Number(u.searchParams.get("limit")) || 20
        )
      );

      return json({
        ok: true,
        recent: stats.recent.slice(0, limit),
        message: this.formatRecentBlockersMessage(stats, limit)
      });
    }

    if (u.pathname === "/status") {
      if (symbol) await this.subscribe(symbol);
      const crypto = isCryptoSymbol(symbol);

      if (symbol && Number.isFinite(this.latestReceivedAge(symbol)) && this.latestReceivedAge(symbol) > 30) {
        try {
          if (crypto) await this.forceCryptoReconnect(`status detected stale ${symbol}`);
          else await this.forceReconnect(`status detected stale ${symbol}`);
        } catch (_) { }
      } else {
        if (crypto) await this.ensureCryptoSocket();
        else await this.ensureSocket();
      }

      const arr = symbol ? (this.ticks.get(symbol) || []) : [];
      const connected = crypto
        ? Boolean(this.cryptoWs && this.cryptoWs.readyState === 1)
        : Boolean(this.ws && this.ws.readyState === 1);
      const status = crypto ? this.lastCryptoStatus : this.lastStatus;
      const subscribeStatus = crypto ? this.lastCryptoSubscribeStatus : this.lastSubscribeStatus;
      const lastMessageAt = crypto ? this.lastCryptoWsMessageAt : this.lastWsMessageAt;
      const lastMessageAge = lastMessageAt ? Math.max(0, (Date.now() - lastMessageAt) / 1000) : null;

      return json({
        version: VERSION,
        provider: crypto ? "tiingo-crypto" : "tiingo-fx",
        status,
        subscribeStatus,
        connected,
        symbols: [...this.symbols],
        symbol,
        ticks: arr.length,
        bars60: buildBars(arr, 60).length,
        lastTickAgeSeconds: arr.length ? this.latestReceivedAge(symbol) : null,
        providerTickAgeSeconds: arr.length ? this.latestMarketAge(symbol) : null,
        lastWsMessageAgeSeconds: lastMessageAge,
        reconnectCount: this.reconnectCount,
        expirySeconds: EXPIRY_SECONDS
      });
    }

    return json({ ok: true, version: VERSION, expirySeconds: EXPIRY_SECONDS });
  }
}

async function tgSend(env, chatId, text, replyMarkup = null) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  body.reply_markup = replyMarkup || { remove_keyboard: true };
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${JSON.stringify(data) || "send failed"}`);
  return data?.result || null;
}
function parseSignalText(text) {
  const t = String(text || "").trim();
  const m = t.match(/^\/signal(?:\s+(.+))?$/i); if (m) return normalizeSymbol(m[1] || "");
  return normalizeSymbol(t);
}
async function hub(env, path) {
  const id = env.TICK_HUB.idFromName("global-market-feed"), stub = env.TICK_HUB.get(id);
  const r = await stub.fetch(`https://tickhub${path}`); return await r.json();
}
async function hubPost(env, path, body) {
  const id = env.TICK_HUB.idFromName("global-market-feed"), stub = env.TICK_HUB.get(id);
  const r = await stub.fetch(`https://tickhub${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await r.json();
}

async function schedulerGet(env, path) {
  if (!env.AUTO_SCHEDULER) throw new Error("AUTO_SCHEDULER binding is missing from the active Cloudflare deployment");
  const id = env.AUTO_SCHEDULER.idFromName("global-auto-scheduler"), stub = env.AUTO_SCHEDULER.get(id);
  const r = await stub.fetch(`https://autoscheduler${path}`);
  if (!r.ok) throw new Error(`AUTO_SCHEDULER HTTP ${r.status}`);
  return await r.json();
}


async function scanUniverse(env) {
  const checked = [];
  for (const symbol of FIXED_UNIVERSE) {
    try {
      const r = await hub(env, `/signal?symbol=${encodeURIComponent(symbol)}`);
      checked.push({ ...r, symbol });
      if (r?.quotaExceeded) {
        return {
          ok: false,
          quotaExceeded: true,
          retryAfterMinutes: Number(r.retryAfterMinutes) || 1,
          checked,
          preAlerts: [],
          reason: "Tiingo hourly request quota is temporarily exhausted."
        };
      }
    } catch (e) {
      checked.push({ ok: false, symbol, reason: String(e?.message || e) });
    }
  }

  const qualified = checked.filter(x => x?.ok && x?.grade === "A" && x?.direction && Number(x.quality) >= A_GRADE_MIN_QUALITY);
  qualified.sort((a, b) =>
    Number(b.quality || 0) - Number(a.quality || 0) ||
    Number(b.edge || 0) - Number(a.edge || 0) ||
    Number(b.microConfirmations || 0) - Number(a.microConfirmations || 0)
  );

  const preAlerts = checked
    .filter(x => x?.preAlert && x?.setupDirection && Number(x.preScore) >= 0.86)
    .sort((a, b) => Number(b.preScore || 0) - Number(a.preScore || 0));

  if (!qualified.length) {
    return {
      ok: false,
      checked,
      preAlerts,
      reason: "No fully qualified 5-minute entry across the six-pair FX universe."
    };
  }
  return { ok: true, best: qualified[0], checked, preAlerts };
}


async function issueReadyAlert(env, chatIds, candidate) {
  const chats = (chatIds || []).map(String).filter(Boolean);
  if (!chats.length || !candidate?.symbol || !candidate?.setupDirection) return { ok: false, reason: "invalid ready alert" };

  const claim = await hubPost(env, "/claim-ready", {
    symbol: candidate.symbol,
    direction: candidate.setupDirection,
    setupCandleT: candidate.setupCandleT,
    readyKey: candidate.readyKey
  });
  if (!claim?.claimed) return { ok: false, duplicate: true, reason: "ready alert already sent for this setup" };

  const pm = Number(candidate.preMomentumConfirmations);
  const msg =
    `READY 🔥🔥\n` +
    `${candidate.symbol} setup developing.\n` +
    `Trend, pullback, structure and strength aligned${Number.isFinite(pm) ? ` • momentum ${pm}/4` : ""}.
`+
    `DO NOT ENTER YET — wait for the actual 5-minute signal.`;

  let delivered = 0;
  for (const chat of chats) {
    try {
      await tgSend(env, chat, msg);
      delivered++;
    } catch (e) {
      console.error("READY alert delivery failed", candidate.symbol, String(e?.message || e));
    }
  }

  // The claim is written before Telegram delivery to prevent duplicate warnings.
  // If delivery failed everywhere, cancel the setup so no unseen READY can ever
  // be followed by a final trading signal.
  if (!delivered) {
    await hubPost(env, "/ready-outcome", { symbol: candidate.symbol, outcome: "CANCELLED" });
    return { ok: false, reason: "READY alert could not be delivered; setup cancelled" };
  }

  return {
    ok: true, symbol: candidate.symbol, direction: candidate.setupDirection, preScore: candidate.preScore,
    preMomentumConfirmations: candidate.preMomentumConfirmations, delivered
  };
}


async function issueAgradeSignal(env, chatIds, candidate, sourceUpdateId = "auto", automatic = false, cancelOnFail = true) {
  const chats = (chatIds || []).map(String).filter(Boolean);
  if (!chats.length) return { ok: false, reason: "no alert chat registered" };

  const symbol = candidate.symbol;
  const result = await hub(env, `/signal?symbol=${encodeURIComponent(symbol)}`);
  if (!result.ok || result.grade !== "A" || result.direction !== candidate.direction || Number(result.quality) < A_GRADE_MIN_QUALITY) {
    const blocker = result?.reason || "setup changed during final check";
    if (cancelOnFail) await hubPost(env, "/ready-outcome", { symbol, outcome: "CANCELLED", reason: blocker });
    return { ok: false, reason: blocker, preserved: !cancelOnFail };
  }
  const quoteBefore = await hub(env, `/quote?symbol=${encodeURIComponent(symbol)}`);
  if (!quoteBefore.ok || !Number.isFinite(Number(quoteBefore.price)) || Number(quoteBefore.receiveAgeSeconds) > 8) {
    const blocker = "fresh entry quote unavailable";
    if (cancelOnFail) await hubPost(env, "/ready-outcome", { symbol, outcome: "CANCELLED", reason: blocker });
    return { ok: false, reason: blocker, preserved: !cancelOnFail };
  }
  const driftAtr = Number(result.atr) > 0
    ? Math.abs(Number(quoteBefore.price) - Number(result.lastPrice)) / Number(result.atr)
    : Infinity;
  if (!Number.isFinite(driftAtr) || driftAtr > 0.30) {
    const blocker = "price moved too far during final 5-minute entry check";
    if (cancelOnFail) await hubPost(env, "/ready-outcome", { symbol, outcome: "CANCELLED", reason: blocker });
    return { ok: false, reason: blocker, preserved: !cancelOnFail };
  }

  const arrow = result.direction === "CALL" ? "⬆️" : "⬇️";
  const label = automatic ? "AUTO 5-MINUTE SNIPER" : "5-MINUTE SNIPER";
  const textMsg = `${arrow} ${symbol}\n${label}\nEXPIRY: 5 minutes\nGRADE: A\nSETUP SCORE: ${Math.round(Number(result.quality) * 100)}/100\nTRACKING: ON`;

  let sentAt = null;
  for (const chat of chats) {
    const sent = await tgSend(env, chat, textMsg);
    if (sent?.date && !sentAt) sentAt = sent.date;
  }

  const quoteAfter = await hub(env, `/quote?symbol=${encodeURIComponent(symbol)}`);
  const entryPrice = quoteAfter.ok && Number.isFinite(Number(quoteAfter.price))
    ? Number(quoteAfter.price)
    : Number(quoteBefore.price);

  await hubPost(env, "/track", {
    sourceUpdateId: String(sourceUpdateId),
    chatIds: chats,
    symbol,
    direction: result.direction,
    entryPrice,
    entryAt: Date.now(),
    telegramMessageDate: sentAt,
    features: {
      quality: result.quality,
      adx: result.adx,
      dmiGap: result.dmiGap,
      rsi: result.rsi,
      roomAtr: result.roomAtr,
      distanceFastAtr: result.distanceFastAtr,
      regime5: result.regime5,
      regime15: result.regime15,
      regime5Efficiency: result.regime5Efficiency,
      regime15Efficiency: result.regime15Efficiency,
      spreadAtrRatio: result.spreadAtrRatio,
      spreadBps: result.spreadBps,
      atrRatio: result.atrRatio,
      reasons: result.reasons,
      v13_4Shadow: {
        id: V13_4_SHADOW.id,
        eligible: Number(result.dmiGap) >= V13_4_SHADOW.dmiGapMin && Number(result.adx) <= V13_4_SHADOW.adxMax,
        dmiGapMin: V13_4_SHADOW.dmiGapMin,
        adxMax: V13_4_SHADOW.adxMax,
        observedDmiGap: Number(result.dmiGap),
        observedAdx: Number(result.adx),
        capturedAt: Date.now()
      }
    }
  });
  return { ok: true, symbol, direction: result.direction, quality: result.quality };
}

async function scanShortShadowUniverse(env) {
  const checked = [];
  const captured = [];

  for (const symbol of SHORT_SHADOW_UNIVERSE) {
    try {
      const result = await hub(
        env,
        `/short-shadow?symbol=${encodeURIComponent(symbol)}`
      );

      const row = {
        ...result,
        symbol
      };

      checked.push(row);

      if (row?.captured) {
        captured.push(row);
      }

      // Tiingo quota is global, so do not keep hammering
      // the remaining pairs once the quota is blocked.
      if (row?.quotaExceeded) {
        break;
      }
    } catch (e) {
      checked.push({
        ok: false,
        symbol,
        captured: false,
        reason: String(e?.message || e)
      });
    }
  }

  return {
    ok: true,
    checked: checked.length,
    captured: captured.length,
    symbols: captured.map(x => x.symbol),
    rows: checked
  };
}

async function autoScanAndAlert(env) {
  try {
    // Prime the live WebSocket first so both engines
    // work from the same fresh market sample.
    await hub(env, "/prime-live?ms=5000");

    // -------------------------------------------------
    // SHORT-EXPIRY SHADOW
    // Runs independently of the 5-minute risk gate.
    // It records experimental 60s/120s entries only.
    // It NEVER sends a short-expiry Telegram trade.
    // -------------------------------------------------
    const shortShadow =
      await scanShortShadowUniverse(env);

    const shortSummary = {
      shortShadowChecked:
        Number(shortShadow?.checked || 0),

      shortShadowCaptured:
        Number(shortShadow?.captured || 0),

      shortShadowSymbols:
        Array.isArray(shortShadow?.symbols)
          ? shortShadow.symbols
          : []
    };
    // -------------------------------------------------
    // EXISTING 5-MINUTE LIVE ENGINE
    // -------------------------------------------------
    const chatState =
      await hub(env, "/chats");

    const chats =
      Array.isArray(chatState?.chats)
        ? chatState.chats
        : [];

    if (!chats.length) {
      return {
        ok: false,
        reason: "no registered chat",
        readyAlertsSent: 0,

        ...shortSummary
      };
    }

    const risk =
      await hub(env, "/risk");

    if (!risk.ok) {
      return {
        ok: false,
        reason:
          risk.reason || "risk gate",
        readyAlertsSent: 0,
        ...shortSummary
      };
    }

    const scan =
      await scanUniverse(env);

    // Existing 5-minute signal-only mode.
    if (scan.ok) {
      const minuteKey =
        Math.floor(Date.now() / 60000);

      const signal =
        await issueAgradeSignal(
          env,
          chats,
          scan.best,
          `auto-${minuteKey}-${scan.best.symbol}`,
          true
        );

      return {
        ...signal,
        readyAlertsSent: 0,
        ...shortSummary
      };
    }

    return {
      ok: false,
      reason:
        scan.reason ||
        "no fully qualified setup",

      readyAlertsSent: 0,
      ...shortSummary
    };

  } finally {
    try {
      await hub(env, "/sleep");
    } catch (_) { }
  }
}

async function checkAllFeeds(env) {
  try {
    const st = await hub(env, "/top-health");
    if (Array.isArray(st?.rows)) return st.rows;
    throw new Error(st?.error || "REST top-of-book health check returned no rows");
  } catch (e) {
    const msg = String(e?.message || e);
    return FIXED_UNIVERSE.map(symbol => ({
      symbol,
      health: "ERROR",
      connected: false,
      ticks: 0,
      receivedAge: null,
      providerAge: null,
      status: msg,
      source: "tiingo-rest-top"
    }));
  } finally {
    try { await hub(env, "/sleep"); } catch (_) { }
  }
}


export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, version: VERSION, expirySeconds: EXPIRY_SECONDS });
    if (u.pathname === "/diag") return json({
      ok: true,
      version: VERSION,
      telegramTokenConfigured: Boolean(String(env.TELEGRAM_BOT_TOKEN || "").trim()),
      webhookSecretConfigured: Boolean(String(env.TELEGRAM_WEBHOOK_SECRET || "").trim()),
      tiingoTokenConfigured: Boolean(String(env.TIINGO_API_TOKEN || "").trim()),
      tickHubBound: Boolean(env.TICK_HUB),
      service: "iq3m-predictor diagnostic"
    });
    if (u.pathname === "/telegram-check") {
      const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
      if (!token) return json({ ok: false, error: "TELEGRAM_BOT_TOKEN missing" }, 500);
      try {
        const [meResp, whResp] = await Promise.all([
          fetch(`https://api.telegram.org/bot${token}/getMe`),
          fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
        ]);
        const me = await meResp.json().catch(() => null);
        const wh = await whResp.json().catch(() => null);
        return json({
          ok: Boolean(meResp.ok && me?.ok && whResp.ok && wh?.ok),
          getMeHttp: meResp.status,
          botOk: Boolean(me?.ok),
          botUsername: me?.result?.username || null,
          webhookHttp: whResp.status,
          webhookOk: Boolean(wh?.ok),
          webhookUrl: wh?.result?.url || null,
          pendingUpdateCount: Number(wh?.result?.pending_update_count || 0),
          lastErrorDate: wh?.result?.last_error_date || null,
          lastErrorMessage: wh?.result?.last_error_message || null
        });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }
    if (u.pathname === "/feed") {
      const s = normalizeSymbol(u.searchParams.get("symbol") || "EUR/USD") || "EUR/USD";
      return json(await hub(env, `/status?symbol=${encodeURIComponent(s)}`));
    }
    if (u.pathname === "/cron-scan" && request.method === "POST") {
      const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      const supplied = String(request.headers.get("X-IQ3M-Cron-Secret") || "");
      if (!expected || supplied !== expected) return new Response("forbidden", { status: 403 });
      try {
        const claim = await hubPost(env, "/claim-cron", {});
        if (!claim?.claimed) return json({ ok: true, skipped: true, reason: "minute already claimed" });
        const result = await autoScanAndAlert(env);
        try { await hubPost(env, "/cron-result", { result }); } catch (_) { }
        return json({ ok: true, claimed: true, result });
      } catch (e) {
        console.error("cron-scan failed", String(e?.stack || e?.message || e));
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }
    if (request.method !== "POST") return new Response("V13.6 five-minute auto sniper — signal-only", { status: 200 });
    if (u.pathname !== "/telegram") return new Response("Not found", { status: 404 });
    const secret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    if (secret && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return new Response("forbidden", { status: 403 });
    const update = await request.json(); const msg = update.message || update.edited_message; if (!msg?.chat?.id) return new Response("ok");
    const chatId = msg.chat.id, text = String(msg.text || "").trim();
    // Free-tier autonomous fallback: a Durable Object alarm keeps the one-minute
    // scanner alive even when the account cannot attach another Cron Trigger.
    ctx.waitUntil(schedulerGet(env, "/ensure").catch(e => console.error("scheduler ensure failed", String(e?.message || e))));
    // Lightweight commands must not enter the Durable Object. This keeps Telegram
    // responsive even when the market-feed object has exhausted its free-tier duration.
    if (/^\/version$/i.test(text)) { await tgSend(env, chatId, VERSION); return new Response("ok"); }
    if (/^\/ping$/i.test(text)) { await tgSend(env, chatId, "PONG — webhook and Telegram delivery are healthy."); return new Response("ok"); }
    // Acknowledge Telegram immediately so one failing Durable Object call cannot
    // block the entire Telegram update queue. Command work continues in waitUntil().
    ctx.waitUntil((async () => {
      try {
        try { await hubPost(env, "/register-chat", { chatId }); }
        catch (e) { console.error("register-chat failed", String(e?.stack || e?.message || e)); }
        if (/^\/start$/i.test(text)) {
          await tgSend(
            env,
            chatId,
            "V13.6 — FIVE-MINUTE SIGNAL-ONLY MODE. READY Telegram warnings are disabled. Pullback and preparation states are tracked internally and Telegram receives only final CALL/PUT signals. The 5m trend, SMA stack, fractal structure, DMI/ADX, structural room, completed 1m continuation and live-tick timing remain required. The quality floor is 89.5% and continuation extension is allowed up to 2.50 ATR. Use /diagnose for blockers and /stats for performance."
          );
          return new Response("ok");
        }
        if (/^\/tickstats$/i.test(text)) {
          const st = await hub(env, "/tick-sample?ms=5000");
          const rows = Array.isArray(st?.rows) ? st.rows : [];
          const lines = rows.map(r => {
            const rx = r.lastTickAgeSeconds == null ? "n/a" : Number(r.lastTickAgeSeconds).toFixed(1) + "s";
            return `${r.symbol}: ${r.sampleTicks || 0} ticks in ${Number(st.sampleSeconds || 5).toFixed(0)}s • buffered ${r.bufferedTicks || 0} • last Rx ${rx}`;
          });
          await tgSend(
            env,
            chatId,
            `LIVE TICK FLOW SAMPLE\n${Number(st.sampleSeconds || 5).toFixed(0)}-second WebSocket sample\n\n${lines.join("\n")}\n\nBuffered counts are in-memory only and can reset when the Durable Object sleeps/restarts. /checkall uses REST snapshots and intentionally does not show cumulative ticks.`
          );
          return new Response("ok");
        }
        if (/^\/checkall$/i.test(text)) {
          const rows = await checkAllFeeds(env);
          const icon = h => h === "LIVE" ? "🟢" : h === "WARMING" ? "🟡" : h === "STALE" ? "🔴" : h === "ERROR" ? "❌" : "⚪";
          const lines = rows.map(r => {
            const px = r.providerAge == null ? "n/a" : r.providerAge.toFixed(1) + "s";
            const price = Number.isFinite(Number(r.price)) ? formatFxPrice(r.symbol, Number(r.price)) : "n/a";
            const source = r.source === "tiingo-rest-top" ? "REST top-of-book" : "feed";
            return `${icon(r.health)} ${r.symbol} — ${r.health}\nPrice: ${price} • Quote age: ${px} • ${source}`;
          });
          const liveCount = rows.filter(r => r.health === "LIVE").length;
          await tgSend(
            env,
            chatId,
            `SIX-PAIR FX FEED HEALTH\nLIVE: ${liveCount}/${FIXED_UNIVERSE.length}\n\n${lines.join("\n\n")}`
          );
          return new Response("ok");
        }
        if (/^\/stats$/i.test(text)) {
          const st = await hub(env, "/stats");
          const wr = st.winRate == null ? "n/a" : Number(st.winRate).toFixed(1) + "%";
          await tgSend(
            env,
            chatId,
            `TRACKED SIGNAL STATS\nTotal settled: ${st.total || 0}\nWins: ${st.wins || 0}\nLosses: ${st.losses || 0}\nDraws: ${st.draws || 0}\nVoids: ${st.voids || 0}\nPending: ${st.pending || 0}\nWin rate (W/L only): ${wr}\n\nResults are measured from Tiingo prices, not Pocket Option settlement prices.`
          );
          return new Response("ok");
        }
        if (/^\/shortstats$/i.test(text)) {
          try {
            const st = await hub(env, "/shortstats");

            const wr60 =
              st.expiry60?.winRate == null
                ? "n/a"
                : Number(st.expiry60.winRate).toFixed(1) + "%";

            const wr120 =
              st.expiry120?.winRate == null
                ? "n/a"
                : Number(st.expiry120.winRate).toFixed(1) + "%";

            const formatBucket = bucket => {
              const b = bucket || {};

              const wr =
                b.winRate == null
                  ? "n/a"
                  : Number(b.winRate).toFixed(1) + "%";

              return `${b.wins || 0}W ${b.losses || 0}L (${wr})`;
            };

            const formatClusterBucket = bucket => {
              const b = bucket || {};

              const wr =
                b.equalClusterWinRate == null
                  ? "n/a"
                  : Number(
                    b.equalClusterWinRate
                  ).toFixed(1) + "%";

              return (
                `${wr} — ` +
                `${b.winningClusters || 0}W ` +
                `${b.losingClusters || 0}L ` +
                `${b.tiedClusters || 0}T ` +
                `(${b.settledClusters || 0} clusters)`
              );
            };

            const pairLines =
              SHORT_SHADOW_UNIVERSE
                .map(symbol => {
                  const row =
                    st.byPair?.[symbol] || {};

                  return (
                    `${symbol} — ` +
                    `60s ${formatBucket(row.expiry60)} | ` +
                    `120s ${formatBucket(row.expiry120)}` +
                    `${Number(row.pending || 0) > 0
                      ? ` | P:${row.pending}`
                      : ""
                    }`
                  );
                })
                .join("\n");


            const callStats =
              st.byDirection?.CALL || {};

            const putStats =
              st.byDirection?.PUT || {};

            const sessionLabels = {
              ASIA:
                "ASIA 00:00-06:59 UTC",

              LONDON:
                "LONDON 07:00-12:59 UTC",

              OVERLAP:
                "OVERLAP 13:00-16:59 UTC",

              NEW_YORK:
                "NEW YORK 17:00-20:59 UTC",

              LATE:
                "LATE 21:00-23:59 UTC"
            };


            const sessionLines =
              Object.entries(sessionLabels)
                .map(([key, label]) => {
                  const row =
                    st.bySession?.[key] || {};

                  return (
                    `${label}\n` +
                    `60s ${formatBucket(row.expiry60)} | ` +
                    `120s ${formatBucket(row.expiry120)}` +
                    `${Number(row.pending || 0) > 0
                      ? ` | Pending: ${row.pending}`
                      : ""
                    }`
                  );
                })
                .join("\n");

            const clusterSessionLines =
              Object.entries(sessionLabels)
                .map(([key, label]) => {
                  const row =
                    st.clusterAdjustedBySession?.[key] || {};

                  return (
                    `${label}\n` +
                    `60s ${formatClusterBucket(row.expiry60)}\n` +
                    `120s ${formatClusterBucket(row.expiry120)}`
                  );
                })
                .join("\n");

            const clusterStats =
              st.clusters || {};

            const adjusted60 =
              st.clusterAdjusted?.expiry60 || {};

            const adjusted120 =
              st.clusterAdjusted?.expiry120 || {};


            const adjustedWr60 =
              adjusted60.equalClusterWinRate == null
                ? "n/a"
                : Number(
                  adjusted60.equalClusterWinRate
                ).toFixed(1) + "%";

            const adjustedWr120 =
              adjusted120.equalClusterWinRate == null
                ? "n/a"
                : Number(
                  adjusted120.equalClusterWinRate
                ).toFixed(1) + "%";

            const evidence =
              st.evidence || {};

            const minimumProgress =
              Number(
                evidence.minimumProgressPct || 0
              ).toFixed(1);

            const preferredProgress =
              Number(
                evidence.preferredProgressPct || 0
              ).toFixed(1);

            const recentClusters =
              Array.isArray(clusterStats.recent)
                ? clusterStats.recent
                  .slice(0, 3)
                  .map(c =>
                    `${c.count || 0} setup${Number(c.count || 0) === 1 ? "" : "s"} — ` +
                    `${Array.isArray(c.symbols)
                      ? c.symbols.join(", ")
                      : "n/a"
                    }`
                  )
                  .join("\n")
                : "";

            await tgSend(
              env,
              chatId,

              `SHORT-EXPIRY SHADOW\n` +
              `Strategy: ${st.strategyId}\n` +
              `Pending setups: ${st.pending || 0}\n\n` +

              `60 SECOND\n` +
              `Settled: ${st.expiry60?.settled || 0}\n` +
              `Wins: ${st.expiry60?.wins || 0}\n` +
              `Losses: ${st.expiry60?.losses || 0}\n` +
              `Draws: ${st.expiry60?.draws || 0}\n` +
              `Voids: ${st.expiry60?.voids || 0}\n` +
              `W/L win rate: ${wr60}\n\n` +

              `120 SECOND\n` +
              `Settled: ${st.expiry120?.settled || 0}\n` +
              `Wins: ${st.expiry120?.wins || 0}\n` +
              `Losses: ${st.expiry120?.losses || 0}\n` +
              `Draws: ${st.expiry120?.draws || 0}\n` +
              `Voids: ${st.expiry120?.voids || 0}\n` +
              `W/L win rate: ${wr120}\n\n` +

              `BY DIRECTION\n` +
              `CALL — 60s ${formatBucket(callStats.expiry60)} | ` +
              `120s ${formatBucket(callStats.expiry120)} | ` +
              `Pending: ${callStats.pending || 0}\n` +

              `PUT — 60s ${formatBucket(putStats.expiry60)} | ` +
              `120s ${formatBucket(putStats.expiry120)} | ` +
              `Pending: ${putStats.pending || 0}\n\n` +

              `BY UTC MARKET WINDOW\n` +
              `${sessionLines}\n\n` +

              `BY PAIR\n` +
              `${pairLines}\n\n` +

              `CAPTURE CLUSTERS\n` +
              `Total clusters: ${clusterStats.totalClusters || 0}\n` +
              `Multi-setup clusters: ${clusterStats.multiSetupClusters || 0}\n` +
              `Largest cluster: ${clusterStats.maxClusterSize || 0} setups\n\n` +

              `CLUSTER-ADJUSTED PERFORMANCE\n` +

              `60s — ${adjustedWr60}\n` +
              `Settled clusters: ${adjusted60.settledClusters || 0}\n` +
              `Winning: ${adjusted60.winningClusters || 0} | ` +
              `Losing: ${adjusted60.losingClusters || 0} | ` +
              `Tied: ${adjusted60.tiedClusters || 0}\n\n` +

              `120s — ${adjustedWr120}\n` +
              `Settled clusters: ${adjusted120.settledClusters || 0}\n` +
              `Winning: ${adjusted120.winningClusters || 0} | ` +
              `Losing: ${adjusted120.losingClusters || 0} | ` +
              `Tied: ${adjusted120.tiedClusters || 0}\n\n` +
              `EVIDENCE PROGRESS\n` +
              `Settled independent clusters: ${evidence.settledClusters || 0}\n` +
              `Minimum target: ${evidence.minimumTarget || 50}\n` +
              `Progress to minimum: ${minimumProgress}%\n` +
              `Preferred target: ${evidence.preferredTarget || 100}\n` +
              `Progress to preferred: ${preferredProgress}%\n` +
              `Status: ${evidence.status || "collecting"}\n\n` +
              `${recentClusters
                ? `Recent clusters:\n${recentClusters}\n\n`
                : "\n"
              }` +

              `Shadow mode only — no short-expiry trade alerts are being sent yet.`
            );

          } catch (e) {
            console.error(
              "shortstats failed",
              String(e?.stack || e?.message || e)
            );

            await tgSend(
              env,
              chatId,
              `SHORT-STATS ERROR\n${String(
                e?.message || e
              ).slice(0, 300)}`
            );
          }

          return new Response("ok");
        }
        if (/^\/blockerstats$/i.test(text)) {
          try {
            const st = await hub(env, "/blockerstats");

            await tgSend(
              env,
              chatId,
              st?.message ||
              `SIGNAL BLOCKER STATS\nTotal evaluations: ${st?.totalEvaluations || 0}`
            );
          } catch (e) {
            console.error(
              "blockerstats failed",
              String(e?.stack || e?.message || e)
            );

            await tgSend(
              env,
              chatId,
              `BLOCKER STATS ERROR\n${String(e?.message || e).slice(0, 300)}`
            );
          }

          return new Response("ok");
        }

        if (/^\/blockerrecent(?:\s+\d+)?$/i.test(text)) {
          try {
            const match = text.match(/^\/blockerrecent(?:\s+(\d+))?$/i);

            const limit = Math.max(
              1,
              Math.min(30, Number(match?.[1]) || 15)
            );

            const st = await hub(
              env,
              `/blockerrecent?limit=${limit}`
            );

            await tgSend(
              env,
              chatId,
              st?.message || "No recent blocker data available."
            );
          } catch (e) {
            console.error(
              "blockerrecent failed",
              String(e?.stack || e?.message || e)
            );

            await tgSend(
              env,
              chatId,
              `BLOCKER RECENT ERROR\n${String(e?.message || e).slice(0, 300)}`
            );
          }

          return new Response("ok");
        }

        if (/^\/readystats$/i.test(text)) {
          await tgSend(env, chatId,
            `SIGNAL-ONLY MODE\nREADY alerts are disabled in ${VERSION}.\nPreparation is tracked internally; Telegram now receives only final CALL/PUT signals.\nUse /diagnose for current blockers and /stats for settled performance.`);
          return new Response("ok");
        }
        if (/^\/forwardstats$/i.test(text)) {
          try {
            const st = await hub(env, "/forwardstats");
            if (!st?.ok) throw new Error(st?.error || "forward stats unavailable");
            const e = st.eligible || {}, n = st.nonEligible || {};
            const ewr = e.winRate == null ? "n/a" : Number(e.winRate).toFixed(1) + "%";
            const nwr = n.winRate == null ? "n/a" : Number(n.winRate).toFixed(1) + "%";
            await tgSend(env, chatId, `V13.4 FORWARD SHADOW STATS\nFrozen rule: DMI gap >= ${Number(st.frozenRule?.dmiGapMin).toFixed(2)} + ADX <= ${Number(st.frozenRule?.adxMax).toFixed(2)}\n\nSHADOW-ELIGIBLE\nSettled: ${e.total || 0}\nWins: ${e.wins || 0}\nLosses: ${e.losses || 0}\nDraws: ${e.draws || 0}\nVoids: ${e.voids || 0}\nPending: ${st.pendingEligible || 0}\nW/L win rate: ${ewr}\n\nNON-ELIGIBLE COMPARISON\nSettled: ${n.total || 0}\nWins: ${n.wins || 0}\nLosses: ${n.losses || 0}\nW/L win rate: ${nwr}\n\nEvidence target: 50 minimum, 100 preferred eligible settled signals.\nTracking uses Tiingo prices, not Pocket Option settlement prices.`);
          } catch (e) {
            console.error("forwardstats failed", String(e?.stack || e?.message || e));
            try { await tgSend(env, chatId, `V13.4 FORWARD STATS ERROR\n${String(e?.message || e).slice(0, 300)}\n\nTry /version and /stats. If those respond, the bot is live and only the V13.4 stats route needs attention.`); } catch (_) { }
          }
          return new Response("ok");
        }
        if (/^\/diagnose$/i.test(text)) {
          try { await hub(env, "/prime-live?ms=5000"); } catch (_) { }
          const rows = [];
          for (const symbol of FIXED_UNIVERSE) {
            try {
              const r = await hub(env, `/signal?symbol=${encodeURIComponent(symbol)}`);
              rows.push(`${symbol}: ${r.ok && r.grade === "A" ? "A-GRADE" : (r.reason || "not ready")}`);
            } catch (e) {
              rows.push(`${symbol}: error`);
            }
          }
          await tgSend(env, chatId, `V13.5 FIVE-MINUTE SNIPER DIAGNOSIS\n\n${rows.join("\n")}`);
          return new Response("ok");
        }
        if (/^\/cronstatus$/i.test(text)) {
          let sch = {}, schedulerError = null;
          try {
            await schedulerGet(env, "/ensure");
            sch = await schedulerGet(env, "/status");
          } catch (e) {
            schedulerError = String(e?.message || e);
          }
          const st = await hub(env, "/cronstatus");
          const age = st.ageSeconds == null ? "n/a" : Number(st.ageSeconds).toFixed(0) + "s";
          const r = st.lastResult || {};
          const next = sch.nextAlarmAt ? Math.max(0, Math.ceil((Number(sch.nextAlarmAt) - Date.now()) / 1000)) + "s" : "n/a";
          const source = schedulerError ? "NOT ARMED" : (sch.enabled ? "Durable Object alarm" : "NOT ARMED");
          const quota = Number(st.quotaRetryMinutes || 0) > 0 ? `BLOCKED — about ${st.quotaRetryMinutes}m to reset` : "OK";
          await tgSend(
            env,
            chatId,
            `AUTO-SCAN STATUS\n` +
            `Version: ${VERSION}\n` +
            `Scheduler: ${source}\n` +
            `Last scan: ${age} ago\n` +
            `Scans recorded: ${st.count || 0}\n` +
            `Next scheduler wake: ${next}\n` +
            `Tiingo REST quota: ${quota}\n\n` +

            `SHORT-EXPIRY SHADOW\n` +
            `Pairs checked last scan: ${Number(r.shortShadowChecked || 0)}/${SHORT_SHADOW_UNIVERSE.length}\n` +
            `Setups captured last scan: ${Number(r.shortShadowCaptured || 0)}\n` +
            `Captured pairs: ${Array.isArray(r.shortShadowSymbols) &&
              r.shortShadowSymbols.length
              ? r.shortShadowSymbols.join(", ")
              : "none"
            }\n\n` +

            `5-MINUTE ENGINE\n` +
            `Last result: ${r.ok
              ? "qualified/handled"
              : (r.reason || "no qualified setup")
            }\n` +
            `READY alerts: ${r.readyAlertsSent || 0}` +
            `${r.symbol ? `\nSymbol: ${r.symbol}` : ""}` +
            `${schedulerError ? `\nScheduler error: ${schedulerError}` : ""}` +
            `${sch.lastError ? `\nAlarm error: ${sch.lastError}` : ""}`
          );
        }
        if (/^\/reconnect$/i.test(text)) {
          const st = await hub(env, "/reconnect");
          await tgSend(env, chatId, `FEED RECONNECT REQUESTED\nFX: ${st.fxStatus || "n/a"}\nCRYPTO: ${st.cryptoStatus || "n/a"}\nRECONNECTS: ${st.reconnectCount || 0}`);
          return new Response("ok");
        }
        if (/^\/feed/i.test(text)) {
          const s = normalizeSymbol(text.replace(/^\/feed\s*/i, "")) || "EUR/USD";
          const st = await hub(env, `/status?symbol=${encodeURIComponent(s)}`);
          await tgSend(env, chatId,
            `FEED ${s}\n` +
            `PROVIDER: ${st.provider || "tiingo"}\n` +
            `CONNECTED: ${st.connected ? "YES" : "NO"}\n` +
            `TICKS: ${st.ticks || 0}\n` +
            `1m LIVE BARS: ${st.bars60 || 0}\n` +
            `RECEIVED TICK AGE: ${st.lastTickAgeSeconds ?? "n/a"}s\n` +
            `PROVIDER TICK AGE: ${st.providerTickAgeSeconds ?? "n/a"}s\n` +
            `WS MESSAGE AGE: ${st.lastWsMessageAgeSeconds ?? "n/a"}s\n` +
            `RECONNECTS: ${st.reconnectCount || 0}\n` +
            `EXPIRY: 300s\n` +
            `STATUS: ${st.status || "n/a"}\n` +
            `SUBSCRIBE: ${st.subscribeStatus?.response?.message || st.subscribeStatus?.status || "n/a"}`
          );
          return new Response("ok");
        }
        const isUniverseScan = /^\/signal\s*$/i.test(text);
        if (isUniverseScan) {
          const risk = await hub(env, "/risk");
          if (!risk.ok) {
            const mins = Math.max(1, Math.ceil(Number(risk.retrySeconds || 60) / 60));
            await tgSend(
              env,
              chatId,
              `🛡️ 5-MINUTE MODE PAUSED\n${risk.reason}.\nTry /signal again in about ${mins} minute${mins === 1 ? "" : "s"}.`
            );
            return new Response("ok");
          }

          try { await hub(env, "/prime-live?ms=5000"); } catch (_) { }
          const scan = await scanUniverse(env);
          if (!scan.ok) {
            if (scan.quotaExceeded) {
              const mins = Math.max(1, Number(scan.retryAfterMinutes) || 1);
              await tgSend(
                env,
                chatId,
                `⏳ HISTORICAL CONTEXT LIMIT REACHED\nTiingo live WebSocket ticks are still available, but the hourly REST allowance used to hydrate 1-minute history is temporarily exhausted.\nTry /signal again in about ${mins} minute${mins === 1 ? "" : "s"}.\nV13.5 now persists WebSocket-sampled minute bars so normal automatic scans should stop repeatedly consuming this REST allowance after the next successful history refresh.`
              );
              return new Response("ok");
            }

            const checked = scan.checked || [];
            const warming = checked.filter(x => x?.warming);
            if (checked.length && warming.length === checked.length) {
              await tgSend(
                env,
                chatId,
                "⏳ LIVE FEEDS STARTING\nNo usable live Tiingo quote is available yet across the six-pair FX scan. Try /signal again in about 1 minute."
              );
              return new Response("ok");
            }

            const reasons = checked.map(x => x?.reason).filter(Boolean);
            const top = reasons.length ? reasons.sort((x, y) =>
              reasons.filter(z => z === y).length - reasons.filter(z => z === x).length
            )[0] : null;
            await tgSend(
              env,
              chatId,
              `⏳ NO HIGH-CONFIDENCE 5-MINUTE SETUP RIGHT NOW\nFeeds are live across the scan.${top ? "\nMain blocker: " + top : ""}\nAutomatic scanning remains active.`
            );
            return new Response("ok");
          }

          const issued = await issueAgradeSignal(env, [chatId], scan.best, `manual-${update.update_id}`, false);
          if (!issued.ok) {
            await tgSend(env, chatId, `⏳ ${issued.reason || "setup failed final validation"}\nAutomatic scanning remains active.`);
          }
          return new Response("ok");
        }

        if (/^\/signal\b/i.test(text)) {
          await tgSend(env, chatId, "You do not need /signal for normal use: automatic scans run every minute. /signal is optional for an immediate six-pair scan and still returns only a fully qualified 5-minute setup.");
          return new Response("ok");
        }

        return new Response("ok");
      } catch (e) {
        console.error("telegram command failed", String(e?.stack || e?.message || e));
        try {
          await tgSend(env, chatId, `BOT RUNTIME ERROR\n${String(e?.message || e).slice(0, 350)}\n\nThe webhook itself acknowledged this update, so Telegram will not remain blocked.`);
        } catch (_) { }
      } finally {
        try { await hub(env, "/sleep"); } catch (_) { }
      }
    })());
    return new Response("ok");
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const secret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
        if (!secret) return;
        await fetch(`${PRIMARY_WORKER_URL}/cron-scan`, {
          method: "POST",
          headers: { "X-IQ3M-Cron-Secret": secret }
        });
      } catch (e) {
        console.error("scheduled primary dispatch failed", String(e?.message || e));
      }
    })());
  }

};
