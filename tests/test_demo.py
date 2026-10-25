import json

import pytest
from fastapi.testclient import TestClient
from test_pipeline import LEASE, ROOT, FakeLLM

from fineprint import app as app_module
from fineprint.config import Settings
from fineprint.demo import record, replay, save
from fineprint.pipeline import Pipeline
from fineprint.retrieve import LocalCorpus


@pytest.fixture
async def recorded():
    pipeline = Pipeline(FakeLLM(), LocalCorpus(ROOT / "kb"), Settings(_env_file=None))
    return await record(pipeline.run(LEASE))


async def test_replay_reproduces_the_recorded_events(recorded):
    replayed = [e async for e in replay(recorded, speed=1e9)]
    assert [(e.type, e.data) for e in replayed] == [(e["type"], e["data"]) for e in recorded]
    assert replayed[-1].type == "report"


def test_demo_endpoints_replay_saved_run(recorded, tmp_path, monkeypatch):
    path = tmp_path / "demo-run.json"
    save(path, recorded, {"friendly": {"subject": "Hi", "body": "Recorded body"}})
    monkeypatch.setattr(app_module, "DEMO_RUN", path)

    with TestClient(app_module.app) as client:
        client.app.state.llm = None  # demo must work without a model key
        with client.stream("POST", "/api/analyze?demo=1", json={"text": LEASE}) as res:
            events = [line[7:] for line in res.iter_lines() if line.startswith("event: ")]
        assert res.status_code == 200 and events[-1] == "report"

        q = {"questions": [{"heading": "h", "question": "q"}]}
        assert client.post("/api/email?demo=1", json=q).json()["body"] == "Recorded body"


def test_demo_without_recording_is_404(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "DEMO_RUN", tmp_path / "missing.json")
    with TestClient(app_module.app) as client:
        assert client.post("/api/analyze?demo=1", json={"text": LEASE}).status_code == 404


def test_saved_file_is_plain_json(recorded, tmp_path):
    path = tmp_path / "d.json"
    save(path, recorded, {})
    assert json.loads(path.read_text())["events"][0]["type"] == "stage"
