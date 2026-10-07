"""Read-only Pocket Option OTC tick bridge for the shadow collector.

The unofficial client exposes order methods, but this process deliberately
uses only connect, subscribe, and get_realtime_ticks. It never places trades.
"""

from __future__ import annotations

import logging
import math
import os
import sys
import time
from collections import deque
from typing import Any

import requests
from pocketoptionapi import PocketOption


LOG = logging.getLogger("pocketoption_bridge")
ASSETS = (
    "EURUSD_otc",
    "GBPUSD_otc",
    "USDJPY_otc",
    "AUDUSD_otc",
    "USDCAD_otc",
)
SYMBOLS = {
    "EURUSD_otc": "EUR/USD",
    "GBPUSD_otc": "GBP/USD",
    "USDJPY_otc": "USD/JPY",
    "AUDUSD_otc": "AUD/USD",
    "USDCAD_otc": "USD/CAD",
}
BATCH_SIZE = 200
POLL_SECONDS = 0.25
SEND_SECONDS = 1.0
MAX_TICK_AGE_SECONDS = 90


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value


def tick_to_utc_ms(api: PocketOption, tick: tuple[Any, Any]) -> tuple[int, float] | None:
    try:
        raw_time, raw_price = tick
        timestamp = float(raw_time)
        price = float(raw_price)
        if not math.isfinite(timestamp) or not math.isfinite(price) or price <= 0:
            return None

        # PocketOption's updateStream timestamps may be server UTC+2. The
        # library detects that offset and exposes it on its synchronizer.
        # Subtract it so the Cloudflare 30-second buckets align to UTC.
        offset = float(getattr(api.api.time_sync, "_stream_tz_offset", 0) or 0)
        timestamp -= offset
        if timestamp < 1_000_000_000:
            return None

        utc_ms = int(timestamp * 1000)
        if abs(time.time() * 1000 - utc_ms) > MAX_TICK_AGE_SECONDS * 1000:
            return None
        return utc_ms, price
    except (TypeError, ValueError, OverflowError):
        return None


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    ssid = required_env("PO_SSID")
    ingest_url = required_env("PO_FEED_INGEST_URL")
    ingest_secret = required_env("PO_FEED_INGEST_SECRET")
    if not ingest_url.startswith("https://"):
        raise RuntimeError("PO_FEED_INGEST_URL must use HTTPS")

    # Do not print the SSID, auth payload, or secret. Use a demo account SSID
    # for this shadow-only data collection.
    api = PocketOption(ssid)
    connected, error = api.connect()
    if not connected:
        raise RuntimeError(f"Pocket Option connection failed: {error or 'unknown error'}")

    for asset in ASSETS:
        if not api.subscribe(asset, period=30):
            raise RuntimeError(f"Subscription failed for {asset}")
        LOG.info("Subscribed to %s at 30 seconds", asset)

    # Establish cursors after subscribing, so startup history in the client's
    # ring buffers is not replayed into the fresh shadow dataset.
    cursors: dict[str, tuple[float, float] | None] = {}
    for asset in ASSETS:
        existing = api.get_realtime_ticks(asset, limit=500)
        cursors[asset] = tuple(existing[-1]) if existing else None

    queue: deque[dict[str, Any]] = deque()
    session = requests.Session()
    session.headers.update({
        "Authorization": f"Bearer {ingest_secret}",
        "Content-Type": "application/json",
    })
    last_send = time.monotonic()
    last_status = last_send
    last_connected = True
    LOG.info("Read-only OTC bridge is running for %d pairs", len(ASSETS))

    while True:
        is_connected = bool(api.check_connect())
        if is_connected != last_connected:
            LOG.warning("Pocket Option websocket %s", "connected" if is_connected else "disconnected")
            last_connected = is_connected

        if is_connected:
            for asset in ASSETS:
                ticks = api.get_realtime_ticks(asset, limit=500)
                cursor = cursors[asset]
                start = 0
                if cursor is not None:
                    # The buffer is ordered; continue immediately after the
                    # last item sent for this asset, tolerating duplicate ticks.
                    matches = [i for i, item in enumerate(ticks) if tuple(item) == cursor]
                    if matches:
                        start = matches[-1] + 1
                    elif ticks:
                        # More than 500 updates arrived between polls. Resume
                        # from the newest buffer content to avoid replaying stale data.
                        start = len(ticks)

                for item in ticks[start:]:
                    cursors[asset] = tuple(item)
                    converted = tick_to_utc_ms(api, item)
                    if converted is None:
                        continue
                    timestamp, price = converted
                    if len(queue) >= 5000:
                        queue.popleft()
                        LOG.warning("Upload backlog exceeded 5,000 ticks; dropping the oldest queued tick")
                    queue.append({
                        "symbol": SYMBOLS[asset],
                        "time": timestamp,
                        "price": price,
                    })

        current = time.monotonic()
        if queue and (len(queue) >= BATCH_SIZE or current - last_send >= SEND_SECONDS):
            batch = [queue.popleft() for _ in range(min(BATCH_SIZE, len(queue)))]
            try:
                response = session.post(
                    ingest_url,
                    json={"ticks": batch},
                    timeout=10,
                )
                response.raise_for_status()
                result = response.json()
                if not result.get("ok"):
                    raise RuntimeError("Cloudflare rejected the tick batch")
                LOG.info(
                    "Forwarded %d ticks; accepted %s, rejected %s",
                    len(batch), result.get("accepted", 0), result.get("rejected", 0),
                )
            except Exception as exc:
                # Retry this batch before newer data, without logging headers.
                for item in reversed(batch):
                    queue.appendleft(item)
                LOG.warning("Tick upload failed (%s); will retry", type(exc).__name__)
                time.sleep(2)
            last_send = time.monotonic()

        if current - last_status >= 60:
            LOG.info("Bridge heartbeat; queued ticks=%d", len(queue))
            last_status = current

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        LOG.info("Bridge stopped")
        raise SystemExit(0)
    except Exception as exc:
        LOG.error("Bridge stopped: %s", exc)
        raise SystemExit(1)
