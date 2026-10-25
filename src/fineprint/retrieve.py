"""Passage retrieval: DigitalOcean Knowledge Base (via its MCP endpoint) with a bundled local fallback.

The local corpus keeps the demo working before the KB finishes indexing, or if the KB is unreachable.
"""

import hashlib
import json
import logging
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Protocol

import httpx

from .config import Settings
from .schemas import Passage

log = logging.getLogger(__name__)


class Retriever(Protocol):
    name: str

    async def retrieve(self, query: str, k: int) -> list[Passage]: ...


def _pid(prefix: str, text: str) -> str:
    return f"{prefix}:{hashlib.sha1(text.encode()).hexdigest()[:8]}"


_WORD = re.compile(r"[a-z0-9']+")
_STOP = frozenset(
    [
        "the",
        "a",
        "an",
        "and",
        "or",
        "of",
        "to",
        "in",
        "for",
        "on",
        "is",
        "are",
        "be",
        "by",
        "with",
        "this",
        "that",
        "it",
        "as",
        "at",
        "if",
        "any",
        "all",
    ]
)


def _tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


class LocalCorpus:
    """BM25 over `## ` sections of the markdown files in a directory."""

    name = "local"

    def __init__(self, directory: Path):
        self.passages: list[Passage] = []
        for path in sorted(directory.glob("*.md")):
            for section in re.split(r"(?m)^## ", path.read_text(encoding="utf-8"))[1:]:
                title, _, body = section.partition("\n")
                text = f"{title.strip()}\n{body.strip()}"
                self.passages.append(
                    Passage(id=_pid("local", text), text=text, source=path.name, title=title)
                )
        self._docs = [_tokens(p.text) for p in self.passages]
        self._avg_len = sum(map(len, self._docs)) / max(len(self._docs), 1)
        df = Counter(t for d in self._docs for t in set(d))
        n = len(self._docs)
        self._idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    async def retrieve(self, query: str, k: int) -> list[Passage]:
        q = _tokens(query)
        scored = []
        for passage, doc in zip(self.passages, self._docs, strict=True):
            tf = Counter(doc)
            score = sum(
                self._idf.get(t, 0) * tf[t] * 2.2 / (tf[t] + 1.2 * (0.25 + 0.75 * len(doc) / self._avg_len))
                for t in q
            )
            if score > 0:
                scored.append((score, passage))
        scored.sort(key=lambda s: s[0], reverse=True)
        return [p for _, p in scored[:k]]


class DOKnowledgeBase:
    """Calls the `retrieve_knowledge_base` tool on DigitalOcean's stateless Knowledge Base MCP endpoint."""

    name = "digitalocean-kb"

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._kb_id = settings.kb_id
        self._url = settings.kb_mcp_url
        self._client = client or httpx.AsyncClient(
            timeout=30,
            headers={
                "Authorization": f"Bearer {settings.do_api_token}",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
        )

    async def call_raw(self, query: str, k: int) -> dict[str, Any]:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "retrieve_knowledge_base",
                "arguments": {"knowledge_base_id": self._kb_id, "query": query, "num_results": k},
            },
        }
        res = await self._client.post(self._url, json=payload)
        res.raise_for_status()
        return _parse_rpc(res.text)

    async def retrieve(self, query: str, k: int) -> list[Passage]:
        rpc = await self.call_raw(query, k)
        if "error" in rpc:
            raise RuntimeError(f"KB MCP error: {rpc['error']}")
        return _passages_from_tool_result(rpc.get("result", {}))[:k]


def _parse_rpc(body: str) -> dict[str, Any]:
    """The endpoint may answer with plain JSON or a single SSE `data:` frame."""
    body = body.strip()
    if body.startswith("{"):
        return json.loads(body)
    for line in body.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise ValueError(f"unrecognised MCP response: {body[:200]}")


def _passages_from_tool_result(result: dict[str, Any]) -> list[Passage]:
    # The result format isn't documented; accept structuredContent or JSON/plain text content blocks.
    items: list[Any] = []
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        items = structured.get("results") or structured.get("chunks") or []
    if not items:
        for block in result.get("content", []):
            if block.get("type") != "text":
                continue
            try:
                data = json.loads(block["text"])
                items.extend(data if isinstance(data, list) else data.get("results", [data]))
            except (json.JSONDecodeError, AttributeError):
                items.append({"text": block["text"]})

    passages = []
    for item in items:
        if not isinstance(item, dict):
            continue
        meta = item.get("metadata") or {}
        text = item.get("text_content") or item.get("content") or item.get("text") or item.get("chunk") or ""
        if not text.strip():
            continue
        source = (
            meta.get("url")
            or meta.get("source")
            or meta.get("item_name")
            or item.get("source")
            or "knowledge base"
        )
        passages.append(Passage(id=_pid("kb", text), text=text.strip()[:1500], source=str(source)))
    return passages


class FallbackRetriever:
    """Tries `primary`; on error or no results uses `fallback`. `name` reflects what actually answered last."""

    def __init__(self, primary: Retriever, fallback: Retriever):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    async def retrieve(self, query: str, k: int) -> list[Passage]:
        try:
            if found := await self.primary.retrieve(query, k):
                return found
        except Exception as e:
            log.warning("%s retrieval failed, using %s: %s", self.primary.name, self.fallback.name, e)
        self.name = f"{self.fallback.name} (fallback)"
        return await self.fallback.retrieve(query, k)


def make_retriever(settings: Settings) -> Retriever:
    local = LocalCorpus(settings.local_corpus_dir)
    if settings.kb_id and settings.do_api_token:
        return FallbackRetriever(DOKnowledgeBase(settings), local)
    return local
