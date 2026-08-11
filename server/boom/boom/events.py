"""In-process SSE fan-out for Boom events."""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Optional


class EventHub:
    """Broadcasts events to all connected SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._subscribers.add(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._subscribers.discard(q)

    async def publish(self, event: dict[str, Any]) -> None:
        async with self._lock:
            dead: list[asyncio.Queue[dict[str, Any]]] = []
            for q in self._subscribers:
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    # Drop oldest to keep live stream moving.
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        q.put_nowait(event)
                    except asyncio.QueueFull:
                        dead.append(q)
            for q in dead:
                self._subscribers.discard(q)

    async def sse_stream(
        self,
        *,
        replay: list[dict[str, Any]],
        keepalive_seconds: float = 15.0,
    ) -> AsyncIterator[str]:
        """Yield SSE-formatted chunks: replay first, then live + keepalives."""
        for ev in replay:
            yield format_sse(ev)
        q = await self.subscribe()
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=keepalive_seconds)
                    yield format_sse(ev)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await self.unsubscribe(q)


def format_sse(event: dict[str, Any]) -> str:
    eid = event.get("id")
    etype = event.get("type", "message")
    data = {
        "id": eid,
        "schema": event.get("schema"),
        "type": etype,
        "entity_id": event.get("entity_id"),
        "payload": event.get("payload"),
        "ts": event.get("ts"),
    }
    lines = [f"event: {etype}", f"data: {json.dumps(data, separators=(',', ':'))}"]
    if eid is not None:
        lines.insert(0, f"id: {eid}")
    return "\n".join(lines) + "\n\n"
