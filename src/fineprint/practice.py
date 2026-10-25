"""Practice mode: one turn of a role-played conversation with the landlord, plus a coach's note.

The browser keeps the conversation; each turn sends it back. The landlord reply and the coach's note
run in parallel, since the coach only judges the student's own message.
"""

import asyncio
import logging
from typing import Protocol

from . import prompts
from .models import MODELS, Role
from .schemas import CallMeta, CoachNote, PracticeReply, PracticeRequest

log = logging.getLogger(__name__)

WHO = {"student": "Student", "landlord": "Landlord"}


class PracticeLLM(Protocol):
    async def chat(
        self, models: tuple[str, ...], messages: list[dict[str, str]], *, role: str = "", **kw: object
    ) -> tuple[str, CallMeta]: ...

    async def call_json(
        self, role: Role, messages: list[dict[str, str]], schema: type
    ) -> tuple[object, CallMeta]: ...


async def practice_turn(llm: PracticeLLM, req: PracticeRequest) -> PracticeReply:
    # The landlord sees the student as "user" and its own lines as "assistant".
    convo = [{"role": "user" if m.role == "student" else "assistant", "content": m.text} for m in req.history]
    landlord_msgs = [
        {"role": "system", "content": prompts.LANDLORD_SYSTEM + prompts.clip(req.lease, 20_000)},
        *convo,
        {"role": "user", "content": req.message},
    ]
    coach_msgs = [
        {"role": "system", "content": prompts.COACH_SYSTEM},
        {
            "role": "user",
            "content": prompts.coach_user(
                req.questions, [(WHO[m.role], m.text) for m in req.history], req.message
            ),
        },
    ]

    landlord, coach = await asyncio.gather(
        llm.chat(MODELS["writer"], landlord_msgs, role="landlord", temperature=0.7, max_tokens=1500),
        llm.call_json("fast", coach_msgs, CoachNote),
        return_exceptions=True,
    )
    if isinstance(landlord, BaseException):
        raise landlord

    note: CoachNote | None = None
    if isinstance(coach, BaseException):
        log.warning("coach failed: %s", coach)
    else:
        note = coach[0]  # type: ignore[assignment]
        note.covered = sorted({i for i in note.covered if 0 <= i < len(req.questions)})
    return PracticeReply(landlord=landlord[0].strip(), coach=note)
