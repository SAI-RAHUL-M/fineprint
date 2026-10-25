from fineprint.evaluate import evaluate, markdown, score


def test_score_counts_flags_and_asks():
    s = score([("ask_about_this", "ask_about_this"), ("uncommon", "standard"), ("standard", "uncommon")])
    assert s.n == 3
    assert s.accuracy == 0.333
    assert s.flag_precision == 0.5  # flagged 2, one was right
    assert s.flag_recall == 0.5  # should flag 2, caught 1
    assert s.ask_recall == 1.0


def clause(number, label, a, b):
    verdict = lambda lab: {"label": lab} if lab else None  # noqa: E731
    return {"clause": {"number": number}, "label": label, "juror_a": verdict(a), "juror_b": verdict(b)}


def test_evaluate_scores_each_reviewer_and_the_combination():
    report = {
        "clauses": [
            clause(None, "standard", None, None),  # preamble: not in the answer key
            clause("1", "ask_about_this", "ask_about_this", "standard"),
            clause("2", "standard", "standard", "standard"),
            clause("3", "uncommon", "standard", "uncommon"),
        ]
    }
    expected = {"1": "ask", "2": "standard", "3": "uncommon"}
    out = evaluate(report, expected)
    assert out["combined"]["accuracy"] == 1.0
    assert out["reviewer_a"]["flag_recall"] == 0.5
    assert out["reviewer_b"]["ask_recall"] == 0.0
    assert "**Both, combined**" in markdown(out, {"juror_a": "a", "juror_b": "b"})
