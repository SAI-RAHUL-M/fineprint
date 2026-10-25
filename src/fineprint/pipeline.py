"""The analysis pipeline: split -> classify -> retrieve -> jury (two model families) -> verify -> report.

`Pipeline.run` is an async generator of `Event`s so the API can stream progress to the browser.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from itertools import batched
from typing import Any, Literal

from . import prompts
from .config import Settings
from .llm import JSONCaller
from .models import Role
from .retrieve import Retriever
from .schemas import (
    SKIP_JURY,
    CallMeta,
    Classification,
    ClassifyBatch,
    Clause,
    ClauseResult,
    JuryBatch,
    Passage,
    Report,
    Verdict,
    VerifyBatch,
)
from .split import split_clauses

log = logging.getLogger(__name__)

Juror = Literal["a", "b"]
JUROR_ROLE: dict[Juror, Role] = {"a": "juror_a", "b": "juror_b"}
SEVERITY = {"standard": 0, "uncommon": 1, "ask_about_this": 2}


@dataclass
class Event:
    type: str
    data: dict[str, Any] = field(default_factory=dict)


def stage(name: str, status: Literal["start", "done", "error"], detail: str = "") -> Event:
    return Event("stage", {"stage": name, "status": status, "detail": detail})


class Pipeline:
    def __init__(self, llm: JSONCaller, retriever: Retriever, settings: Settings):
        self.llm = llm
        self.retriever = retriever
        self.s = settings
        self._sem = asyncio.Semaphore(settings.max_concurrency)
        self.calls: list[CallMeta] = []

    async def _json[T](self, role: Role, system: str, user: str, schema: type[T]) -> T:
        async with self._sem:
            data, meta = await self.llm.call_json(
                role,
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                schema,  # type: ignore[arg-type]
            )
        self.calls.append(meta)
        return data  # type: ignore[return-value]

    async def run(self, lease: str) -> AsyncIterator[Event]:
        self.calls = []

        # 1. Split (deterministic)
        clauses = split_clauses(lease)
        results = {c.id: ClauseResult(clause=c) for c in clauses}
        yield stage("split", "done", f"{len(clauses)} clauses")
        yield Event("clauses", {"clauses": [c.model_dump() for c in clauses]})

        # 2. Classify
        yield stage("classify", "start")
        async for batch in _as_done(
            [self._classify(chunk) for chunk in batched(clauses, self.s.classify_batch)]
        ):
            for item in batch:
                if item.clause_id in results:
                    results[item.clause_id].classification = item
            yield Event("classified", {"items": [i.model_dump() for i in batch]})
        for r in results.values():
            r.classification = r.classification or Classification(
                clause_id=r.clause.id, type="other", summary=""
            )
        yield stage("classify", "done")

        jury = [r for r in results.values() if r.classification and r.classification.type not in SKIP_JURY]

        # 3. Retrieve supporting passages per clause
        yield stage("retrieve", "start")
        async for cid, passages in _as_done([self._retrieve(r) for r in jury]):
            results[cid].passages = passages
            yield Event("retrieved", {"clause_id": cid, "passages": [p.model_dump() for p in passages]})
        yield stage("retrieve", "done", self.retriever.name)

        # 4. Jury: two model families judge every clause independently, in parallel
        yield stage("jury", "start", f"{len(jury)} clauses")
        tasks = [
            self._judge(juror, list(chunk))
            for chunk in batched(jury, self.s.jury_batch)
            for juror in ("a", "b")
        ]
        async for juror, verdicts in _as_done(tasks):
            for v in verdicts:
                setattr(results[v.clause_id], f"juror_{juror}", v)
            yield Event("verdicts", {"juror": juror, "verdicts": [v.model_dump() for v in verdicts]})
        yield stage("jury", "done")

        # 5. Verify that every cited flag is actually supported by its passages
        yield stage("verify", "start")
        removed = await self._verify(jury)
        yield Event("verified", {"unsupported_removed": removed})
        yield stage("verify", "done", f"{removed} unsupported")

        # 6. Aggregate
        for r in results.values():
            _aggregate(r)
        report = _report(list(results.values()), removed, self.retriever.name, self.calls)
        yield Event("report", report.model_dump())

    async def _classify(self, chunk: Sequence[Clause]) -> list[Classification]:
        try:
            out = await self._json(
                "fast", prompts.CLASSIFY_SYSTEM, prompts.classify_user(list(chunk)), ClassifyBatch
            )
            return out.items
        except Exception as e:
            log.warning("classify batch failed: %s", e)
            return []

    async def _retrieve(self, r: ClauseResult) -> tuple[int, list[Passage]]:
        c, cls = r.clause, r.classification
        query = f"{c.heading}. {cls.type.replace('_', ' ') if cls else ''}. {cls.summary if cls else c.text[:300]}"
        try:
            async with self._sem:
                return c.id, await self.retriever.retrieve(query, self.s.passages_per_clause)
        except Exception as e:
            log.warning("retrieval failed for clause %s: %s", c.id, e)
            return c.id, []

    async def _judge(self, juror: Juror, chunk: list[ClauseResult]) -> tuple[Juror, list[Verdict]]:
        items = [
            (r.clause, r.classification.type if r.classification else "other", r.passages) for r in chunk
        ]
        try:
            out = await self._json(
                JUROR_ROLE[juror], prompts.JUROR_SYSTEM, prompts.juror_user(items), JuryBatch
            )
        except Exception as e:
            log.warning("juror %s batch failed: %s", juror, e)
            return juror, []

        by_id = {r.clause.id: r for r in chunk}
        clean = []
        for v in out.verdicts:
            if v.clause_id not in by_id:
                continue  # model invented or misnumbered a clause
            allowed = {p.id for p in by_id[v.clause_id].passages}
            v.cite_ids = [c for c in v.cite_ids if c in allowed]
            if v.highlight and _squash(v.highlight) not in _squash(by_id[v.clause_id].clause.text):
                v.highlight = None  # only mark words that are really in the lease
            clean.append(v)
        return juror, clean

    async def _verify(self, jury: list[ClauseResult]) -> int:
        todo: list[tuple[ClauseResult, Juror, Verdict]] = []
        for r in jury:
            for juror in ("a", "b"):
                v: Verdict | None = getattr(r, f"juror_{juror}")
                if v and v.label != "standard" and v.cite_ids:
                    todo.append((r, juror, v))
        if not todo:
            return 0

        async def check(chunk: Sequence[tuple[ClauseResult, Juror, Verdict]]) -> VerifyBatch:
            items = [
                (r.clause.id, j, v.explanation, [p for p in r.passages if p.id in v.cite_ids])
                for r, j, v in chunk
            ]
            try:
                return await self._json(
                    "fast", prompts.VERIFY_SYSTEM, prompts.verify_user(items), VerifyBatch
                )
            except Exception as e:
                log.warning("verify batch failed: %s", e)
                return VerifyBatch(checks=[])  # unverifiable -> leave verdicts as they are

        batches = await asyncio.gather(*(check(c) for c in batched(todo, 8)))
        unsupported = {(c.clause_id, c.juror) for b in batches for c in b.checks if not c.supported}

        removed = 0
        for r, juror, v in todo:
            if (r.clause.id, juror) in unsupported:
                v.cite_ids = []
                if v.label == "ask_about_this":
                    v.label = "uncommon"  # no source, so don't escalate
                r.unverified = True
                removed += 1
        return removed


def _aggregate(r: ClauseResult) -> None:
    flags = [v for v in (r.juror_a, r.juror_b) if v and v.label != "standard"]
    if not flags:
        r.label, r.confidence = "standard", "none"
        return
    top = max(flags, key=lambda v: SEVERITY[v.label])
    r.label = top.label
    r.confidence = "high" if len(flags) == 2 else "maybe"
    by_severity = sorted(flags, key=lambda v: -SEVERITY[v.label])
    r.question_to_ask = next((v.question_to_ask for v in by_severity if v.question_to_ask), None)
    r.highlight = next((v.highlight for v in by_severity if v.highlight), None)


def _report(results: list[ClauseResult], removed: int, source: str, calls: list[CallMeta]) -> Report:
    penalty = 0
    for r in results:
        if r.label == "ask_about_this":
            penalty += 10 if r.confidence == "high" else 5
        elif r.label == "uncommon":
            penalty += 3 if r.confidence == "high" else 1
    flagged = sorted(
        (r for r in results if r.question_to_ask and r.label != "standard"),
        key=lambda r: (-SEVERITY[r.label], r.confidence != "high", r.clause.id),
    )
    return Report(
        clauses=results,
        clarity_score=max(0, 100 - penalty),
        questions=[r.question_to_ask for r in flagged if r.question_to_ask],
        unsupported_removed=removed,
        retrieval_source=source,
        calls=calls,
    )


def _squash(text: str) -> str:
    return " ".join(text.lower().split())


async def _as_done[T](coros: Sequence[Awaitable[T]]) -> AsyncIterator[T]:
    """Yield results in completion order, so the UI updates as each batch lands."""
    for fut in asyncio.as_completed(coros):
        yield await fut


AnalyzeFn = Callable[[str], AsyncIterator[Event]]
