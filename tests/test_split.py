from pathlib import Path

from fineprint.split import split_clauses

SAMPLE = Path(__file__).parents[1] / "samples" / "sketchy-lease.txt"


def test_sample_lease_splits_into_preamble_and_21_sections():
    clauses = split_clauses(SAMPLE.read_text(encoding="utf-8"))
    assert len(clauses) == 22
    assert clauses[0].heading == "Preamble"
    assert [c.number for c in clauses[1:]] == [str(n) for n in range(1, 22)]
    assert clauses[5].heading == "Cleaning Fee"
    assert clauses[17].heading == "Renter's Insurance"


def test_offsets_point_back_into_the_source():
    text = SAMPLE.read_text(encoding="utf-8").replace("\r\n", "\n")
    for c in split_clauses(text):
        assert c.text in text[c.start : c.end]


def test_sentences_starting_with_I_are_not_headings():
    text = "1. RENT. Pay rent.\nI agree to pay on time.\n2. TERM. One year."
    assert [c.number for c in split_clauses(text)] == ["1", "2"]


def test_section_keyword_and_decimal_numbers():
    text = "Section 4 - Utilities apply.\n4.2 Deposit rules here.\nARTICLE III. Pets are allowed."
    assert [c.number for c in split_clauses(text)] == ["4", "4.2", "III"]


def test_unstructured_text_falls_back_to_paragraphs():
    clauses = split_clauses("First paragraph here.\n\nSecond paragraph here.")
    assert [c.text for c in clauses] == ["First paragraph here.", "Second paragraph here."]
