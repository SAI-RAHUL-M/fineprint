"""Passage retrieval: DigitalOcean Knowledge Base (via its MCP endpoint) with a bundled local fallback.

The local corpus keeps the demo working before the KB finishes indexing, or if the KB is unreachable.
"""

import asyncio
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
    """Calls the `retrieve_knowledge_base` tool on DigitalOcean's Knowledge Base MCP endpoint.

    The endpoint is stateless, but the docs ask clients to `initialize` first, so we do that once and
    carry a session id if the server hands one back.
    """

    name = "digitalocean-kb"
    PROTOCOL = "2025-03-26"

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._kb_id = settings.kb_id
        self._url = settings.kb_mcp_url
        self._client = client or httpx.AsyncClient(
            timeout=30,
            headers={
                "Authorization": f"Bearer {settings.do_api_token}",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Mcp-Protocol-Version": self.PROTOCOL,
            },
        )
        self._session: str | None = None
        self._ready = False
        self._lock = asyncio.Lock()
        self._next_id = 0

    async def _post(self, method: str, params: dict[str, Any] | None = None, *, notify: bool = False):
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if not notify:
            self._next_id += 1
            payload["id"] = self._next_id
        headers = {"Mcp-Session-Id": self._session} if self._session else {}
        res = await self._client.post(self._url, json=payload, headers=headers)
        res.raise_for_status()
        self._session = res.headers.get("mcp-session-id", self._session)
        return None if notify or not res.text.strip() else _parse_rpc(res.text)

    async def _ensure_ready(self) -> None:
        async with self._lock:
            if self._ready:
                return
            init = await self._post(
                "initialize",
                {
                    "protocolVersion": self.PROTOCOL,
                    "capabilities": {},
                    "clientInfo": {"name": "fineprint", "version": "0.1"},
                },
            )
            if init and "error" in init:
                raise RuntimeError(f"KB MCP initialize failed: {init['error']}")
            await self._post("notifications/initialized", notify=True)
            self._ready = True

    async def call_raw(self, query: str, k: int) -> dict[str, Any]:
        await self._ensure_ready()
        args = {"knowledge_base_id": self._kb_id, "query": query, "num_results": k}
        return await self._post("tools/call", {"name": "retrieve_knowledge_base", "arguments": args}) or {}

    async def retrieve(self, query: str, k: int) -> list[Passage]:
        rpc = await self.call_raw(query, k + 2)
        if "error" in rpc:
            raise RuntimeError(f"KB MCP error: {rpc['error']}")
        result = rpc.get("result", {})
        if result.get("isError"):
            raise RuntimeError(f"KB tool error: {str(result.get('content'))[:200]}")
        return _best_sections(_passages_from_tool_result(result), query, k)


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
        passages.append(Passage(id=_pid("kb", text), text=text.strip(), source=str(source)))
    return passages


# A short line with no sentence punctuation, on its own between blank lines: a section heading.
_HEADING = re.compile(r"^[A-Z][^\n.:?!]{1,48}$")


def _sections(p: Passage) -> list[Passage]:
    """Split a chunk that merged several guide sections back into one passage per section."""
    blocks = [b.strip() for b in re.split(r"\n\s*\n", p.text) if b.strip()]
    groups: list[list[str]] = []
    for b in blocks:
        if _HEADING.match(b) or not groups:
            groups.append([b])
        else:
            groups[-1].append(b)
    out = []
    for g in groups:
        title = g[0] if _HEADING.match(g[0]) else ""
        text = "\n".join(g)
        out.append(Passage(id=_pid("kb", text), text=text[:1500], source=p.source, title=title))
    return out


def _best_sections(chunks: list[Passage], query: str, k: int) -> list[Passage]:
    """Rank the sections inside the KB's chunks by overlap with the query (title words count double).

    The knowledge base does the search; this keeps citations pointed at the specific section that applies.
    """
    q = set(_tokens(query))
    scored = []
    for rank, chunk in enumerate(chunks):
        for s in _sections(chunk):
            overlap = len(q & set(_tokens(s.text))) + 2 * len(q & set(_tokens(s.title)))
            scored.append((overlap, -rank, s))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    seen, out = set(), []
    for overlap, _, s in scored:
        if s.id in seen or (overlap == 0 and out):
            continue
        seen.add(s.id)
        out.append(s)
        if len(out) == k:
            break
    return out


class FallbackRetriever:
    """Tries `primary`; on error or no results uses `fallback`. `name` reflects what actually answered last."""

    def __init__(self, primary: Retriever, fallback: Retriever):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    async def retrieve(self, query: str, k: int) -> list[Passage]:
        try:
            if found := await self.primary.retrieve(query, k):
                self.name = self.primary.name
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
