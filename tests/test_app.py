import asyncio

import pytest
from fastapi.testclient import TestClient

from fineprint.app import app, with_heartbeat
from fineprint.schemas import CallMeta, EmailDraft


async def slow_chunks():
    yield "a"
    await asyncio.sleep(0.05)
    yield "b"


async def test_heartbeat_fills_gaps_and_keeps_order():
    out = [c async for c in with_heartbeat(slow_chunks(), every=0.01)]
    assert out[0] == "a" and out[-1] == "b"
    assert ": keep-alive\n\n" in out


async def test_no_heartbeat_when_chunks_are_fast():
    async def fast():
        for c in "xyz":
            yield c

    assert [c async for c in with_heartbeat(fast(), every=1)] == ["x", "y", "z"]


class EmailLLM:
    def __init__(self):
        self.seen: list[dict] = []

    async def call_json(self, role, messages, schema):
        self.seen.append({"role": role, "user": messages[-1]["content"]})
        assert schema is EmailDraft
        return EmailDraft(subject="Questions", body="Hi [Landlord name], ..."), CallMeta(
            role=role, model="m", ms=1
        )


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_email_draft_uses_writer_and_passes_questions_and_tone(client):
    llm = EmailLLM()
    client.app.state.llm = llm
    res = client.post(
        "/api/email",
        json={
            "tone": "firm",
            "questions": [{"heading": "Section 5, Cleaning Fee", "question": "Is it refundable?"}],
        },
    )
    assert res.status_code == 200
    assert res.json()["subject"] == "Questions"
    assert llm.seen[0]["role"] == "writer"
    assert "(Section 5, Cleaning Fee) Is it refundable?" in llm.seen[0]["user"]
    assert "direct" in llm.seen[0]["user"]


def test_email_requires_at_least_one_question(client):
    client.app.state.llm = EmailLLM()
    assert client.post("/api/email", json={"questions": []}).status_code == 422


def test_email_without_key_is_503(client):
    client.app.state.llm = None
    res = client.post("/api/email", json={"questions": [{"heading": "h", "question": "q"}]})
    assert res.status_code == 503
