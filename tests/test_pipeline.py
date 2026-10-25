"""Runs the full pipeline with a scripted fake LLM, so no network or credits are needed."""

import re
from pathlib import Path

from fineprint.config import Settings
from fineprint.pipeline import Pipeline
from fineprint.retrieve import LocalCorpus
from fineprint.schemas import CallMeta, ClassifyBatch, JuryBatch, VerifyBatch

ROOT = Path(__file__).parents[1]
LEASE = (ROOT / "samples" / "sketchy-lease.txt").read_text(encoding="utf-8")
FLAG_A = {"Cleaning Fee", "Landlord Entry", "Renewal"}  # juror A flags these
FLAG_B = {"Cleaning Fee", "Landlord Entry"}  # juror B agrees on two
HIGHLIGHT = {
    "Cleaning Fee": "Non-Refundable  cleaning and carpet replacement fee",  # real (case/space differ)
    "Landlord Entry": "words that are not in the lease",  # invented: must be dropped
}


class FakeLLM:
    def __init__(self):
        self.roles: list[str] = []

    async def call_json(self, role, messages, schema):
        self.roles.append(role)
        user = messages[-1]["content"]
        ids = [int(i) for i in re.findall(r"clause_id (\d+)", user)]
        meta = CallMeta(role=role, model=f"fake-{role}", ms=1)

        if schema is ClassifyBatch:
            items = [{"clause_id": i, "type": "parties" if i == 0 else "fees", "summary": "s"} for i in ids]
            return ClassifyBatch.model_validate({"items": items}), meta

        if schema is JuryBatch:
            flag = FLAG_A if role == "juror_a" else FLAG_B
            verdicts = []
            for block in user.split("---"):
                m = re.search(r"\[clause_id (\d+)\] ([^\n(]+?) \(type", block)
                cid, heading = int(m[1]), m[2].strip()
                cite = [*re.findall(r"\[(local:[0-9a-f]+)\]", block)[:1], "made-up-id"]
                flagged = heading in flag
                verdicts.append(
                    {
                        "clause_id": cid,
                        "label": "ask_about_this" if flagged else "standard",
                        "explanation": "e",
                        "cite_ids": cite if flagged else [],
                        "question_to_ask": f"Q about {heading}?" if flagged else None,
                        "highlight": HIGHLIGHT.get(heading) if flagged else None,
                    }
                )
            verdicts.append({"clause_id": 999, "label": "standard", "explanation": "invented"})
            return JuryBatch.model_validate({"verdicts": verdicts}), meta

        if schema is VerifyBatch:
            # Reject juror A's citation on every clause it flagged alone.
            checks = [
                {"clause_id": int(cid), "juror": j, "supported": not (j == "a" and int(cid) == 14)}
                for cid, j in re.findall(r"clause_id (\d+), juror (a|b)", user)
            ]
            return VerifyBatch.model_validate({"checks": checks}), meta

        raise AssertionError(schema)


async def run():
    llm = FakeLLM()
    events = [e async for e in Pipeline(llm, LocalCorpus(ROOT / "kb"), Settings(_env_file=None)).run(LEASE)]
    return llm, events


async def test_streams_stages_in_order_and_ends_with_report():
    _, events = await run()
    stages = [(e.data["stage"], e.data["status"]) for e in events if e.type == "stage"]
    assert [s for s, st in stages if st == "done"] == ["split", "classify", "retrieve", "jury", "verify"]
    assert events[-1].type == "report"


async def test_jury_agreement_verification_and_score():
    llm, events = await run()
    report = events[-1].data
    by_heading = {c["clause"]["heading"]: c for c in report["clauses"]}

    assert by_heading["Cleaning Fee"]["label"] == "ask_about_this"
    assert by_heading["Cleaning Fee"]["confidence"] == "high"
    assert by_heading["Cleaning Fee"]["highlight"].startswith("Non-Refundable")
    assert by_heading["Landlord Entry"]["highlight"] is None

    renewal = by_heading["Renewal"]  # flagged by A only, and its citation was rejected
    assert renewal["confidence"] == "maybe"
    assert renewal["label"] == "uncommon"
    assert renewal["unverified"] and renewal["juror_a"]["cite_ids"] == []
    assert report["unsupported_removed"] == 1

    assert by_heading["Preamble"]["juror_a"] is None  # parties clause skipped by the jury
    assert all("made-up-id" not in (c["juror_a"] or {}).get("cite_ids", []) for c in report["clauses"])
    assert report["questions"][:2] == ["Q about Cleaning Fee?", "Q about Landlord Entry?"]
    assert report["clarity_score"] == 100 - 10 - 10 - 1
    assert {"juror_a", "juror_b", "fast"} <= set(llm.roles)


async def test_ask_without_a_valid_citation_is_downgraded():
    class OneVerdict:
        async def call_json(self, role, messages, schema):
            v = {"clause_id": 1, "label": "ask_about_this", "explanation": "e", "cite_ids": ["made-up-id"]}
            return JuryBatch.model_validate({"verdicts": [v]}), CallMeta(role=role, model="m", ms=1)

    from fineprint.schemas import Clause, ClauseResult

    clause = Clause(id=1, number="1", heading="Pets", text="No pets.", start=0, end=8)
    pipeline = Pipeline(OneVerdict(), LocalCorpus(ROOT / "kb"), Settings(_env_file=None))
    _, [verdict] = await pipeline._judge("a", [ClauseResult(clause=clause)])
    assert verdict.label == "uncommon" and verdict.cite_ids == []
