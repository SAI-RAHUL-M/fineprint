"""Run the real pipeline on the sample lease and save it for `?demo=1` replays.

Uses live DigitalOcean models (a few cents). Run again whenever prompts or models change.
Run: uv run python scripts/record_demo.py
"""

import asyncio

from fineprint import prompts
from fineprint.app import DEMO_RUN, SAMPLE
from fineprint.config import get_settings
from fineprint.demo import record, save
from fineprint.llm import LLM
from fineprint.pipeline import Pipeline
from fineprint.retrieve import make_retriever
from fineprint.schemas import EmailDraft


async def main() -> None:
    settings = get_settings()
    llm = LLM(settings)
    pipeline = Pipeline(llm, make_retriever(settings), settings)

    print("Analyzing the sample lease with live models…")
    events = await record(pipeline.run(SAMPLE.read_text(encoding="utf-8")))
    report = events[-1]
    if report["type"] != "report":
        raise SystemExit(f"Run did not finish cleanly (last event: {report['type']}); not saving.")

    questions = [
        (f"Section {c['clause']['number']}, {c['clause']['heading']}", c["question_to_ask"])
        for c in report["data"]["clauses"]
        if c["question_to_ask"] and c["label"] != "standard"
    ]
    emails = {}
    for tone in ("friendly", "firm"):
        print(f"Writing the {tone} email…")
        draft, _ = await llm.call_json(
            "writer",
            [
                {"role": "system", "content": prompts.EMAIL_SYSTEM},
                {"role": "user", "content": prompts.email_user(questions, tone)},
            ],
            EmailDraft,
        )
        emails[tone] = draft.model_dump()

    save(DEMO_RUN, events, emails)
    data = report["data"]
    asks = sum(c["label"] == "ask_about_this" for c in data["clauses"])
    print(
        f"Saved {len(events)} events to {DEMO_RUN} ({events[-1]['t']:.0f}s run, {asks} 'ask about' clauses, score {data['clarity_score']})."
    )


if __name__ == "__main__":
    asyncio.run(main())
