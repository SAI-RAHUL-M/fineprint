"""Run the app with a scripted, slightly slow fake LLM, for UI work without spending credits.

Juror answers come from samples/sketchy-lease.labels.json; juror B disagrees on a couple of clauses
so the UI shows both "both agree" and "one model flagged" states.

Run: uv run python scripts/fake_server.py   (then open http://localhost:8001)
"""

import asyncio
import json
import random
import re
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn

from fineprint.app import app
from fineprint.schemas import CallMeta, ClassifyBatch, CoachNote, EmailDraft, JuryBatch, VerifyBatch

ROOT = Path(__file__).parents[1]
EXPECTED: dict[str, str] = json.loads((ROOT / "samples" / "sketchy-lease.labels.json").read_text())[
    "expected"
]
LABEL = {"ask": "ask_about_this", "uncommon": "uncommon", "standard": "standard"}
B_DISAGREES = {"14": "standard", "8": "standard", "6": "uncommon"}
TYPES = {
    "late fees": "late_fees",
    "security deposit": "security_deposit",
    "cleaning fee": "fees",
    "utilities": "utilities",
    "landlord entry": "landlord_entry",
    "renewal": "renewal",
    "early termination": "early_termination",
    "limitation of liability": "liability",
    "maintenance and repairs": "maintenance_repairs",
}


LANDLORD_LINES = [
    "That's in our standard lease, so every unit has it. What part worries you?",
    "Fair question. The fee covers a professional clean and carpet shampoo when you move out.",
    "I hear you. If you leave it in great shape, I could put a partial refund in writing.",
    "Let me check with the owner and get back to you by Friday.",
]
COMMON = set(
    [
        "could",
        "you",
        "explain",
        "terms",
        "there",
        "flexibility",
        "about",
        "this",
        "that",
        "what",
        "with",
        "your",
        "have",
        "here",
    ]
)


class SlowFakeLLM:
    def __init__(self):
        self.turn = 0

    async def chat(self, models, messages, *, role="", **kw):
        await asyncio.sleep(random.uniform(0.8, 1.6))
        line = LANDLORD_LINES[self.turn % len(LANDLORD_LINES)]
        self.turn += 1
        return line, CallMeta(role=role, model=models[0], ms=1200)

    async def call_json(self, role, messages, schema):
        await asyncio.sleep(random.uniform(0.6, 1.8))
        user = messages[-1]["content"]
        meta = CallMeta(
            role=role,
            model={"juror_a": "openai-gpt-oss-120b", "juror_b": "qwen3.5-397b-a17b"}.get(
                role, "openai-gpt-oss-20b"
            ),
            ms=random.randint(900, 4000),
            input_tokens=random.randint(1500, 4000),
            output_tokens=random.randint(300, 900),
        )

        if schema is ClassifyBatch:
            items = []
            for cid, heading in re.findall(r"\[clause_id (\d+)\] ([^\n]+)", user):
                t = "parties" if cid == "0" else TYPES.get(heading.lower(), "other")
                items.append(
                    {
                        "clause_id": int(cid),
                        "type": t,
                        "summary": f"What the {heading.lower()} section means for you, in one sentence.",
                    }
                )
            return ClassifyBatch.model_validate({"items": items}), meta

        if schema is JuryBatch:
            verdicts = []
            for block in user.split("\n\n---\n\n"):
                cid = int(re.search(r"\[clause_id (\d+)\]", block)[1])
                heading = re.search(r"\] ([^\n(]+?) \(type", block)[1]
                cites = re.findall(r"\[(local:[0-9a-f]+)\]", block)[:1]
                label = LABEL[EXPECTED.get(str(cid), "standard")]
                if role == "juror_b" and str(cid) in B_DISAGREES:
                    label = B_DISAGREES[str(cid)]
                flagged = label != "standard"
                verdicts.append(
                    {
                        "clause_id": cid,
                        "label": label,
                        "explanation": (
                            f"This {heading.lower()} clause is stricter than most student leases, so it's worth "
                            "clarifying before you sign."
                            if flagged
                            else "This is common in student leases."
                        ),
                        "cite_ids": cites if flagged else [],
                        "question_to_ask": f"Could you explain the {heading.lower()} terms, and is there flexibility here?"
                        if flagged
                        else None,
                    }
                )
            return JuryBatch.model_validate({"verdicts": verdicts}), meta

        if schema is VerifyBatch:
            checks = [
                {"clause_id": int(c), "juror": j, "supported": not (c == "7" and j == "a")}
                for c, j in re.findall(r"clause_id (\d+), juror (a|b)", user)
            ]
            return VerifyBatch.model_validate({"checks": checks}), meta

        if schema is EmailDraft:
            asks = re.findall(r"^- \(([^)]*)\) (.+)$", user, flags=re.M)
            lines = "\n".join(f"{n}. {q} ({heading})" for n, (heading, q) in enumerate(asks, 1))
            firm = "Tone: polite but direct" in user
            body = (
                "Hi [Landlord name],\n\n"
                + (
                    "Before I sign, I'd like to get a few things in writing:\n\n"
                    if firm
                    else "Thanks again for showing me the apartment. I really like it! Before I sign, "
                    "I had a few questions about the lease:\n\n"
                )
                + lines
                + "\n\nThanks for your help,\n[Your name]"
            )
            return EmailDraft(subject="A few questions about the lease before I sign", body=body), meta

        if schema is CoachNote:
            questions = re.findall(r"^(\d+)\. (.+)$", user.split("Conversation so far:")[0], flags=re.M)
            newest = user.split("Newest student message:")[-1].lower()
            covered = [
                int(i)
                for i, q in questions
                if any(w in newest for w in re.findall(r"[a-z]{5,}", q.lower()) if w not in COMMON)
            ]
            short = len(newest.split()) < 6
            return CoachNote(
                clarity=3 if short else 4,
                politeness=5 if any(w in newest for w in ("please", "thanks", "thank")) else 4,
                tip="Name the exact clause or amount so they can't give a vague answer."
                if short
                else "Nice and specific. Ask them to confirm any change in writing.",
                better="Hi! Is the $600 cleaning fee refundable if I leave the place clean?"
                if short
                else None,
                covered=covered,
            ), meta
        raise AssertionError(schema)


def main() -> None:
    real_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(a):
        async with real_lifespan(a):
            a.state.llm = SlowFakeLLM()  # swap in after the real setup ran
            yield

    app.router.lifespan_context = lifespan
    uvicorn.run(app, host="127.0.0.1", port=8001)


if __name__ == "__main__":
    main()
