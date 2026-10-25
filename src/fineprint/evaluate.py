"""Score a finished report against hand-labelled expectations.

Compares each reviewer alone with the combined verdict, so we can show what the second model adds.
"""

from dataclasses import asdict, dataclass
from typing import Any

SHORT = {"ask": "ask_about_this", "uncommon": "uncommon", "standard": "standard"}


@dataclass
class Scores:
    n: int
    accuracy: float  # exact label match
    flag_precision: float  # of clauses we flagged (unusual or ask), how many should be
    flag_recall: float  # of clauses that should be flagged, how many we flagged
    ask_recall: float  # of "ask about this" clauses, how many we caught as ask


def _ratio(a: int, b: int) -> float:
    return round(a / b, 3) if b else 0.0


def score(pairs: list[tuple[str, str]]) -> Scores:
    """pairs = [(expected, predicted)] with full label names."""
    flagged = lambda label: label != "standard"  # noqa: E731
    tp = sum(flagged(e) and flagged(p) for e, p in pairs)
    return Scores(
        n=len(pairs),
        accuracy=_ratio(sum(e == p for e, p in pairs), len(pairs)),
        flag_precision=_ratio(tp, sum(flagged(p) for _, p in pairs)),
        flag_recall=_ratio(tp, sum(flagged(e) for e, _ in pairs)),
        ask_recall=_ratio(
            sum(e == p == "ask_about_this" for e, p in pairs), sum(e == "ask_about_this" for e, _ in pairs)
        ),
    )


def evaluate(report: dict[str, Any], expected: dict[str, str]) -> dict[str, dict[str, Any]]:
    """`report` is a Report as JSON; `expected` maps section number -> ask|uncommon|standard."""
    rows: dict[str, list[tuple[str, str]]] = {"reviewer_a": [], "reviewer_b": [], "combined": []}
    for c in report["clauses"]:
        number = c["clause"]["number"]
        if number not in expected:
            continue
        want = SHORT[expected[number]]
        rows["combined"].append((want, c["label"]))
        for key, juror in (("reviewer_a", "juror_a"), ("reviewer_b", "juror_b")):
            rows[key].append((want, c[juror]["label"] if c[juror] else "standard"))
    return {name: asdict(score(pairs)) for name, pairs in rows.items()}


def markdown(results: dict[str, dict[str, Any]], models: dict[str, str]) -> str:
    head = "| | Label accuracy | Flag precision | Flag recall | Caught 'ask' clauses |\n|---|---|---|---|---|"
    names = {
        "reviewer_a": f"Reviewer A ({models.get('juror_a', '?')})",
        "reviewer_b": f"Reviewer B ({models.get('juror_b', '?')})",
        "combined": "**Both, combined**",
    }
    pct = lambda x: f"{x:.0%}"  # noqa: E731
    lines = [
        f"| {names[k]} | {pct(r['accuracy'])} | {pct(r['flag_precision'])} | {pct(r['flag_recall'])} | {pct(r['ask_recall'])} |"
        for k, r in results.items()
    ]
    return "\n".join([head, *lines])
