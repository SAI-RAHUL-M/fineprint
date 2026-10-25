"""Prompt text for each pipeline stage. Kept in one place so it can be tuned without touching logic."""

from .schemas import CLAUSE_TYPES, Clause, Passage

SAFETY = (
    "You help university students understand their lease. You are NOT a lawyer and this is NOT legal advice. "
    "Never say whether anything is legal, illegal, enforceable, void or a violation, and never mention laws or "
    "statutes. Write plain English at an 8th-grade reading level."
)

CLASSIFY_SYSTEM = (
    f"{SAFETY}\nClassify each lease clause. For each clause return clause_id, type (one of: "
    f"{', '.join(CLAUSE_TYPES)}) and a one-sentence plain-English summary of what it means for the tenant.\n"
    'Schema: {"items": [{"clause_id": int, "type": str, "summary": str}]}'
)

JUROR_SYSTEM = (
    f"{SAFETY}\n"
    "For each clause, decide how it compares with typical student leases, using ONLY the numbered passages "
    "given for that clause:\n"
    "- standard: common and unsurprising.\n"
    "- uncommon: unusual but not a big concern.\n"
    "- ask_about_this: the student should ask the landlord about it before signing.\n"
    "Explain what the clause means and why you chose the label in at most 3 sentences. Put the ids of the "
    "passages that support your explanation in cite_ids (only ids shown for that clause). If the passages do "
    "not cover the clause, use your general sense of typical leases, leave cite_ids empty, and never choose "
    "ask_about_this without a passage. For uncommon or ask_about_this, add one short, polite question_to_ask "
    "the landlord.\n"
    'Schema: {"verdicts": [{"clause_id": int, "label": "standard"|"uncommon"|"ask_about_this", '
    '"explanation": str, "cite_ids": [str], "question_to_ask": str|null}]}'
)

VERIFY_SYSTEM = (
    "You check whether explanations are supported by their cited passages. For each item, answer "
    "supported=true only if the cited passages actually discuss the same topic and back up the explanation's "
    "statements about what is typical or worth asking. If the passages are about something else, or the "
    "explanation claims more than they say, answer supported=false. Give a short reason.\n"
    'Schema: {"checks": [{"clause_id": int, "juror": "a"|"b", "supported": bool, "reason": str}]}'
)


def clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def classify_user(clauses: list[Clause]) -> str:
    return "\n\n".join(f"[clause_id {c.id}] {c.heading}\n{clip(c.text, 1200)}" for c in clauses)


def passages_block(passages: list[Passage]) -> str:
    if not passages:
        return "(no passages found)"
    return "\n".join(f"[{p.id}] ({p.source}) {clip(p.text, 700)}" for p in passages)


def juror_user(items: list[tuple[Clause, str, list[Passage]]]) -> str:
    return "\n\n---\n\n".join(
        f"[clause_id {c.id}] {c.heading} (type: {ctype})\n{clip(c.text, 1200)}\n\nPassages:\n{passages_block(ps)}"
        for c, ctype, ps in items
    )


def verify_user(items: list[tuple[int, str, str, list[Passage]]]) -> str:
    return "\n\n---\n\n".join(
        f"clause_id {cid}, juror {juror}\nExplanation: {explanation}\nCited passages:\n{passages_block(ps)}"
        for cid, juror, explanation, ps in items
    )
