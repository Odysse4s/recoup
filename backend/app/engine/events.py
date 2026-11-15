"""SSE fan-out bus: one asyncio.Queue per connected client (desktop HUD and /mobile simultaneously)."""
from __future__ import annotations

import asyncio
import itertools
import time
from typing import Any

from ..contracts import EventType, ServerEvent


class EventBus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue[ServerEvent]] = set()
        self._ids = itertools.count(1)
        self.history: list[ServerEvent] = []

    def subscribe(self) -> asyncio.Queue[ServerEvent]:
        q: asyncio.Queue[ServerEvent] = asyncio.Queue()
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[ServerEvent]) -> None:
        self._subs.discard(q)

    def emit(
        self, run_id: str, type_: EventType, payload: dict[str, Any] | None = None, **kw: Any
    ) -> ServerEvent:
        ev = ServerEvent(
            id=next(self._ids), run_id=run_id, ts=time.time(), type=type_, payload=payload or {}, **kw
        )
        self.history.append(ev)
        for q in list(self._subs):
            q.put_nowait(ev)
        return ev

    def broadcast_ephemeral(
        self, type_: EventType, payload: dict[str, Any] | None = None, run_id: str = "system"
    ) -> ServerEvent:
        """Push an out-of-band SSE control event without polluting BUS.history."""
        ev = ServerEvent(
            id=next(self._ids), run_id=run_id, ts=time.time(), type=type_, payload=payload or {}
        )
        for q in list(self._subs):
            q.put_nowait(ev)
        return ev


BUS = EventBus()
