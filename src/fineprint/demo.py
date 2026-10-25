"""Record a real analysis once, replay it on demand (`?demo=1`) when the network or rate limits misbehave."""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from .pipeline import Event

MAX_GAP_S = 2.0  # never make the audience wait longer than this between updates


async def record(events: AsyncIterator[Event]) -> list[dict[str, Any]]:
    t0 = time.perf_counter()
    return [{"t": round(time.perf_counter() - t0, 3), "type": e.type, "data": e.data} async for e in events]


def save(path: Path, events: list[dict[str, Any]], emails: dict[str, Any]) -> None:
    path.write_text(json.dumps({"events": events, "emails": emails}), encoding="utf-8")


def load(path: Path) -> dict[str, Any] | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


async def replay(events: list[dict[str, Any]], speed: float = 1.5) -> AsyncIterator[Event]:
    last = 0.0
    for e in events:
        await asyncio.sleep(min(max(e["t"] - last, 0) / speed, MAX_GAP_S))
        last = e["t"]
        yield Event(e["type"], e["data"])
