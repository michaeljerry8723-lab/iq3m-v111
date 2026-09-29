/*
 * Deterministic synthetic market data generator for V13.6 FX Sniper testing.
 * Creates mathematically consistent OHLC bars and ticks matching production requirements.
 */

export function createBars({
  count = 90,
  startPrice = 1.08000,
  direction = "CALL",
  withPullback = true,
  withContinuation = true,
  extensionAtr = 0.8, // extension above SMA fast in ATR units
  breakFractal = false,
  reverseTrend = false,
  now = Date.now()
} = {}) {
  const currentMinute = Math.floor(now / 60000) * 60000;
  const bars = [];
  const spanMs = 60000;
  const atrPips = 0.00045; // ~4.5 pips ATR

  let price = startPrice;
  const isCall = direction === "CALL";
  const trendStep = isCall ? 0.00008 : -0.00008;

  // Generate baseline trending bars
  for (let i = 0; i < count; i++) {
    const t = currentMinute - (count - i) * spanMs;
    let o, h, l, c;

    if (i < count - 8) {
      // Steady trend phase
      o = price;
      price += trendStep * (0.8 + (i % 3) * 0.2);
      c = price;
      h = Math.max(o, c) + atrPips * 0.3;
      l = Math.min(o, c) - atrPips * 0.3;
    } else if (i < count - 3 && withPullback) {
      // Pullback phase: retraces into SMA zone
      const pullbackStep = isCall ? -0.00008 : 0.00008;
      o = price;
      price += pullbackStep;
      c = price;
      h = Math.max(o, c) + atrPips * 0.2;
      l = Math.min(o, c) - atrPips * 0.2;
    } else if (i >= count - 3 && withContinuation) {
      // Continuation phase: strong candle resuming the trend
      const contStep = isCall ? 0.00025 : -0.00025;
      o = price;
      price += contStep;
      if (i === count - 1 && extensionAtr && bars.length >= 4) {
        const previousFourCloseSum = bars
          .slice(-4)
          .reduce((sum, bar) => sum + Number(bar.c), 0);

        const targetDistance = extensionAtr * atrPips;

        price = isCall
          ? (previousFourCloseSum + 5 * targetDistance) / 4
          : (previousFourCloseSum - 5 * targetDistance) / 4;
      }
      c = price;
      h = Math.max(o, c) + atrPips * 0.15;
      l = Math.min(o, c) - atrPips * 0.15;
    } else {
      // Neutral / sideways
      o = price;
      c = price + (isCall ? 0.00002 : -0.00002);
      h = Math.max(o, c) + atrPips * 0.2;
      l = Math.min(o, c) - atrPips * 0.2;
      price = c;
    }

    if (reverseTrend && i >= count - 25) {
      // Force completed 5m trend reversal
      const revStep = isCall ? -0.00040 : 0.00040;
      o = price;
      price += revStep;
      c = price;
      h = Math.max(o, c) + atrPips * 0.2;
      l = Math.min(o, c) - atrPips * 0.2;
    }

    bars.push({ t, o, h, l, c, n: 25 });
  }

  if (breakFractal && bars.length >= 12) {
    const pivotIndex = bars.length - 7;
    const pivot = bars[pivotIndex];

    if (isCall) {
      // Create a confirmed Fractal(2) support.
      const neighbourLows = [
        bars[pivotIndex - 2].l,
        bars[pivotIndex - 1].l,
        bars[pivotIndex + 1].l,
        bars[pivotIndex + 2].l
      ].map(Number);

      const support =
        Math.min(...neighbourLows, Number(pivot.l)) - atrPips * 0.35;

      pivot.l = support;

      // Break that confirmed support slightly on the final candle.
      const last = bars.at(-1);
      const brokenClose = support - atrPips * 0.15;

      last.c = brokenClose;
      last.l = Math.min(
        Number(last.l),
        brokenClose - atrPips * 0.10
      );
      last.h = Math.max(
        Number(last.h),
        Number(last.o)
      );

    } else {
      // Create a confirmed Fractal(2) resistance.
      const neighbourHighs = [
        bars[pivotIndex - 2].h,
        bars[pivotIndex - 1].h,
        bars[pivotIndex + 1].h,
        bars[pivotIndex + 2].h
      ].map(Number);

      const resistance =
        Math.max(...neighbourHighs, Number(pivot.h)) + atrPips * 0.35;

      pivot.h = resistance;

      // Break that confirmed resistance slightly on the final candle.
      const last = bars.at(-1);
      const brokenClose = resistance + atrPips * 0.15;

      last.c = brokenClose;
      last.h = Math.max(
        Number(last.h),
        brokenClose + atrPips * 0.10
      );
      last.l = Math.min(
        Number(last.l),
        Number(last.o)
      );
    }
  }

  return bars;
}

export function createTicks({
  lastPrice,
  direction = "CALL",
  count = 16,
  now = Date.now(),
  spread = 0.00002, // 0.2 pips
  aligned = true
} = {}) {
  const ticks = [];
  const isCall = direction === "CALL";
  const step = (isCall && aligned) || (!isCall && !aligned) ? 0.00001 : -0.00001;

  let p = lastPrice - count * step * 0.5;
  for (let i = 0; i < count; i++) {
    const t = now - (count - i) * 200; // 200ms tick interval
    p += step * (0.8 + (i % 2) * 0.4);
    const bid = p - spread / 2;
    const ask = p + spread / 2;
    ticks.push({ t, r: t, p, bid, ask });
  }

  return ticks;
}
