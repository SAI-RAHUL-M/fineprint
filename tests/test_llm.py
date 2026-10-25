import pytest
from pydantic import BaseModel

from fineprint.llm import _validate, extract_json


def test_extracts_from_fences_and_think_blocks():
    text = '<think>maybe {"no": 1}</think>Sure!\n```json\n{"a": {"b": "x}"}}\n```'
    assert extract_json(text) == {"a": {"b": "x}"}}


def test_handles_escaped_quotes_inside_strings():
    assert extract_json(r'{"q": "say \"hi\" {ok}"}') == {"q": 'say "hi" {ok}'}


def test_raises_without_object():
    with pytest.raises(ValueError):
        extract_json("no json here")


class Thing(BaseModel):
    n: int


def test_validate_returns_model_or_error_message():
    assert _validate('{"n": 3}', Thing) == Thing(n=3)
    assert isinstance(_validate('{"n": "x"}', Thing), str)
