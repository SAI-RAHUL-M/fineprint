import json
from pathlib import Path

from fineprint.retrieve import FallbackRetriever, LocalCorpus, _parse_rpc, _passages_from_tool_result

KB_DIR = Path(__file__).parents[1] / "kb"


async def test_local_corpus_finds_relevant_section():
    corpus = LocalCorpus(KB_DIR)
    hits = await corpus.retrieve("landlord may enter at any time without notice", 2)
    assert hits[0].title == "Landlord entry"


async def test_fallback_used_when_primary_fails():
    class Broken:
        name = "broken"

        async def retrieve(self, query, k):
            raise RuntimeError("down")

    r = FallbackRetriever(Broken(), LocalCorpus(KB_DIR))
    assert await r.retrieve("security deposit", 1)
    assert r.name == "local (fallback)"


def test_parses_sse_framed_rpc():
    assert _parse_rpc('event: message\ndata: {"result": {}}\n\n') == {"result": {}}


def test_passages_from_json_text_block():
    result = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {"results": [{"text_content": "Deposit info", "metadata": {"url": "https://x"}}]}
                ),
            }
        ]
    }
    [p] = _passages_from_tool_result(result)
    assert p.text == "Deposit info" and p.source == "https://x" and p.id.startswith("kb:")


def test_passages_from_plain_text_block():
    [p] = _passages_from_tool_result({"content": [{"type": "text", "text": "just text"}]})
    assert p.text == "just text"


async def test_do_kb_initializes_once_then_retrieves_with_session():
    import httpx

    from fineprint.config import Settings
    from fineprint.retrieve import DOKnowledgeBase

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((body["method"], request.headers.get("mcp-session-id")))
        if body["method"] == "initialize":
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": body["id"], "result": {}}, headers={"Mcp-Session-Id": "s1"}
            )
        if body["method"] == "notifications/initialized":
            return httpx.Response(202)
        result = {
            "content": [{"type": "text", "text": "3 results"}],
            "structuredContent": {
                "total_results": 1,
                "results": [
                    {
                        "text_content": "Ask when the deposit is returned.",
                        "metadata": {"source": "lease-questions.md"},
                    }
                ],
            },
        }
        frame = (
            "event: message\ndata: "
            + json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result})
            + "\n\n"
        )
        return httpx.Response(200, text=frame, headers={"content-type": "text/event-stream"})

    kb = DOKnowledgeBase(
        Settings(_env_file=None, kb_id="kb-1", do_api_token="t"),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    first = await kb.retrieve("deposit", 3)
    await kb.retrieve("entry", 3)
    assert [m for m, _ in seen] == ["initialize", "notifications/initialized", "tools/call", "tools/call"]
    assert seen[2][1] == "s1" and seen[3][1] == "s1"
    assert first[0].text.startswith("Ask when") and first[0].source == "lease-questions.md"


async def test_do_kb_tool_error_raises_so_fallback_kicks_in():
    import httpx
    import pytest

    from fineprint.config import Settings
    from fineprint.retrieve import DOKnowledgeBase

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "tools/call":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {"isError": True, "content": [{"type": "text", "text": "bad id"}]},
                },
            )
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body.get("id"), "result": {}})

    kb = DOKnowledgeBase(
        Settings(_env_file=None, kb_id="x", do_api_token="t"),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(RuntimeError, match="KB tool error"):
        await kb.retrieve("q", 3)


def test_merged_chunk_is_split_and_best_section_wins():
    from fineprint.retrieve import Passage, _best_sections

    merged = Passage(
        id="kb:x",
        source="lease-questions.md",
        text="Lease Questions Guide\n\nIntro text.\n\nLate fees\n\nTypical: a grace period.\n\n"
        "Landlord entry\n\nTypical: advance notice before entering.\n\nQuestions to ask: How much notice?",
    )
    top = _best_sections([merged], "Landlord entry without notice", 2)
    assert top[0].title == "Landlord entry"
    assert "advance notice" in top[0].text and "grace period" not in top[0].text
    assert top[0].id.startswith("kb:") and top[0].source == "lease-questions.md"
