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
