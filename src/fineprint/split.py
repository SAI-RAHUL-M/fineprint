"""Deterministic lease splitting: numbered sections, ALL CAPS headings, or paragraphs as a last resort."""

import re

from .schemas import Clause

# "5. CLEANING FEE." / "4.2 Deposit" / "Section 7 - Utilities" / "ARTICLE III."
# Bare numbers need a trailing "." or ")" so sentences like "I agree..." aren't treated as headings.
_NUMBERED = re.compile(
    r"^[ \t]*(?:(?:section|article)\s+(?P<a>[0-9]+(?:\.[0-9]+)*|[IVXLC]+)[.:)\-]?"
    r"|(?P<b>[0-9]+\.[0-9]+(?:\.[0-9]+)*[.)]?|[0-9]+[.)]|[IVXLC]+[.)]))\s+(?P<rest>.*)$",
    re.I,
)
_CAPS_HEADING = re.compile(r"^[ \t]*([A-Z][A-Z0-9 ,&'/\-]{3,60})[.:]?[ \t]*$")
_CAPS_PREFIX = re.compile(r"^([A-Z][A-Z0-9 ,&'/\-]{2,60}?)[.:]")


def _heading(rest: str) -> str:
    """'CLEANING FEE. In addition to...' -> 'Cleaning Fee'."""
    m = _CAPS_PREFIX.match(rest)
    raw = m.group(1) if m else " ".join(re.split(r"[.:]", rest)[0].split()[:6])
    return re.sub(r"(^|[\s\-/])([a-z])", lambda g: g.group(1) + g.group(2).upper(), raw.lower()).strip()


def split_clauses(lease: str) -> list[Clause]:
    text = lease.replace("\r\n", "\n")
    starts: list[tuple[int, str | None, str]] = []  # (offset, section number, rest of heading line)

    offset = 0
    for line in text.split("\n"):
        m = _NUMBERED.match(line)
        if m and re.search(r"[A-Za-z]", m["rest"]):
            number = (m["a"] or m["b"]).rstrip(".)")
            starts.append((offset, number, m["rest"]))
        elif starts and _CAPS_HEADING.match(line):
            # Caps lines only count after the first section, so the document title stays in the preamble.
            starts.append((offset, None, line.strip()))
        offset += len(line) + 1

    clauses: list[Clause] = []

    def push(start: int, end: int, number: str | None, heading: str) -> None:
        body = text[start:end].strip()
        if body:
            clauses.append(
                Clause(id=len(clauses), number=number, heading=heading, text=body, start=start, end=end)
            )

    if not starts:
        pos = 0
        for para in re.split(r"\n\s*\n", text):
            start = text.find(para, pos)
            pos = start + len(para)
            push(start, pos, None, _heading(para))
        return clauses

    if starts[0][0] > 0:
        push(0, starts[0][0], None, "Preamble")
    for i, (at, number, rest) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        push(at, end, number, _heading(rest))
    return clauses
