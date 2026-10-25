from fastapi.testclient import TestClient
from test_pipeline import LEASE, FakeLLM

from fineprint.app import app
from fineprint.cache import LRU, key


def test_lru_evicts_oldest_and_refreshes_on_get():
    c = LRU[int](2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1  # "a" is now most recent
    c.put("c", 3)
    assert c.get("b") is None and c.get("a") == 1 and c.get("c") == 3


def test_key_is_stable_and_order_independent_for_dicts():
    assert key("x", {"a": 1, "b": 2}) == key("x", {"b": 2, "a": 1})
    assert key("x", "lease one") != key("x", "lease two")


class CountingLLM(FakeLLM):
    calls = 0

    async def call_json(self, role, messages, schema):
        CountingLLM.calls += 1
        return await super().call_json(role, messages, schema)


def run(client):
    with client.stream("POST", "/api/analyze", json={"text": LEASE}) as res:
        return [line[7:] for line in res.iter_lines() if line.startswith("event: ")]


def test_same_lease_twice_calls_the_models_once():
    with TestClient(app) as client:
        client.app.state.llm = CountingLLM()
        first = run(client)
        used = CountingLLM.calls
        second = run(client)
        assert used > 0 and CountingLLM.calls == used  # second run came from the cache
        assert first == second and second[-1] == "report"
