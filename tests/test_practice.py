import pytest
from fastapi.testclient import TestClient

from fineprint.app import app
from fineprint.practice import practice_turn
from fineprint.schemas import CallMeta, CoachNote, PracticeRequest

META = CallMeta(role="x", model="m", ms=1)


class PracticeFake:
    def __init__(self, coach_fails=False, landlord_fails=False):
        self.coach_fails, self.landlord_fails = coach_fails, landlord_fails
        self.landlord_msgs = None
        self.coach_user = None

    async def chat(self, models, messages, *, role="", **kw):
        if self.landlord_fails:
            raise RuntimeError("down")
        self.landlord_msgs = messages
        return "  It's our standard fee, but I can check.  ", META

    async def call_json(self, role, messages, schema):
        if self.coach_fails:
            raise RuntimeError("down")
        self.coach_user = messages[-1]["content"]
        return CoachNote(clarity=4, politeness=5, tip="Name the fee.", covered=[1, 7, -1, 1]), META


REQ = PracticeRequest(
    lease="5. CLEANING FEE. Non-refundable $600.",
    questions=["Is the cleaning fee refundable?", "How much notice before entry?"],
    history=[
        {"role": "landlord", "text": "Any questions?"},
        {"role": "student", "text": "Hi!"},
    ],
    message="Is the $600 cleaning fee refundable?",
)


async def test_turn_maps_roles_and_cleans_coach_output():
    llm = PracticeFake()
    reply = await practice_turn(llm, REQ)
    assert reply.landlord == "It's our standard fee, but I can check."
    roles = [m["role"] for m in llm.landlord_msgs]
    assert roles == ["system", "assistant", "user", "user"]
    assert "CLEANING FEE" in llm.landlord_msgs[0]["content"]
    assert reply.coach.covered == [1]  # deduped, out-of-range dropped
    assert "0. Is the cleaning fee refundable?" in llm.coach_user


async def test_coach_failure_still_returns_landlord_reply():
    reply = await practice_turn(PracticeFake(coach_fails=True), REQ)
    assert reply.coach is None and reply.landlord


async def test_landlord_failure_raises():
    with pytest.raises(RuntimeError):
        await practice_turn(PracticeFake(landlord_fails=True), REQ)


def test_endpoint_returns_502_when_landlord_fails():
    with TestClient(app) as client:
        client.app.state.llm = PracticeFake(landlord_fails=True)
        res = client.post("/api/practice", json=REQ.model_dump())
        assert res.status_code == 502
        client.app.state.llm = PracticeFake()
        assert client.post("/api/practice", json=REQ.model_dump()).json()["coach"]["tip"] == "Name the fee."
