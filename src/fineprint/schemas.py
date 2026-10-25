"""Data shapes shared by the pipeline, the API and the LLM prompts."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

Label = Literal["standard", "uncommon", "ask_about_this"]
Confidence = Literal["high", "maybe", "none"]

CLAUSE_TYPES = (
    "parties",
    "term",
    "rent",
    "late_fees",
    "security_deposit",
    "fees",
    "utilities",
    "occupancy_guests",
    "maintenance_repairs",
    "landlord_entry",
    "alterations",
    "pets",
    "subletting",
    "renewal",
    "early_termination",
    "liability",
    "insurance",
    "rules",
    "move_out",
    "notices",
    "boilerplate",
    "other",
)
ClauseType = Literal[CLAUSE_TYPES]  # type: ignore[valid-type]

# Clause types that are never sent to the jury: nothing for a student to ask about.
SKIP_JURY: frozenset[str] = frozenset({"parties", "boilerplate"})


class Clause(BaseModel):
    id: int
    number: str | None
    heading: str
    text: str
    start: int  # character offsets into the original lease, for UI highlighting
    end: int


class Classification(BaseModel):
    clause_id: int
    type: ClauseType
    summary: str = Field(description="One plain-English sentence, 8th-grade reading level.")

    @field_validator("type", mode="before")
    @classmethod
    def _unknown_type_is_other(cls, v: object) -> object:
        # Models occasionally invent a type; don't burn a repair retry on that.
        v = str(v).strip().lower().replace(" ", "_").replace("-", "_")
        return v if v in CLAUSE_TYPES else "other"


class ClassifyBatch(BaseModel):
    items: list[Classification]


class Passage(BaseModel):
    id: str
    text: str
    source: str  # URL or file name
    title: str = ""


class Verdict(BaseModel):
    clause_id: int
    label: Label
    explanation: str = Field(max_length=600)
    cite_ids: list[str] = Field(default_factory=list)
    question_to_ask: str | None = None


class JuryBatch(BaseModel):
    verdicts: list[Verdict]


class Check(BaseModel):
    clause_id: int
    juror: Literal["a", "b"]
    supported: bool
    reason: str = ""


class VerifyBatch(BaseModel):
    checks: list[Check]


class CallMeta(BaseModel):
    role: str
    model: str
    ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    used_fallback: bool = False
    repaired: bool = False


class ClauseResult(BaseModel):
    clause: Clause
    classification: Classification | None = None
    passages: list[Passage] = Field(default_factory=list)
    juror_a: Verdict | None = None
    juror_b: Verdict | None = None
    label: Label = "standard"
    confidence: Confidence = "none"
    question_to_ask: str | None = None
    unverified: bool = False  # a juror's cited claim failed verification


class Report(BaseModel):
    clauses: list[ClauseResult]
    clarity_score: int
    questions: list[str]
    unsupported_removed: int
    retrieval_source: str
    calls: list[CallMeta]
