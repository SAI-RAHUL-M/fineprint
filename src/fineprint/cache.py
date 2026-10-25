"""Small in-memory cache so the same lease (or email) isn't paid for twice.

Keys are SHA-256 hashes, so the cache never holds a lease's text as a key. It lives in process memory only:
nothing is written to disk, and it empties on restart.
"""

import hashlib
import json
from collections import OrderedDict
from typing import Any


def key(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


class LRU[V]:
    def __init__(self, size: int):
        self.size = size
        self._items: OrderedDict[str, V] = OrderedDict()

    def get(self, k: str) -> V | None:
        if k in self._items:
            self._items.move_to_end(k)
            return self._items[k]
        return None

    def put(self, k: str, v: V) -> None:
        self._items[k] = v
        self._items.move_to_end(k)
        while len(self._items) > self.size:
            self._items.popitem(last=False)
