"""Open-weight models on DigitalOcean Serverless Inference, by role.

Each role is (primary, fallback); the LLM client retries on the fallback if the primary errors.
The two jurors come from different model families (OpenAI gpt-oss, Google Gemma), and so do their fallbacks,
so agreement between them means something. Picked for speed and price from a live smoke test.
"""

from typing import Literal

Role = Literal["juror_a", "juror_b", "fast", "writer"]

MODELS: dict[Role, tuple[str, str]] = {
    "juror_a": ("openai-gpt-oss-120b", "deepseek-3.2"),
    "juror_b": ("gemma-4-31B-it", "mistral-3-14B"),
    "fast": ("openai-gpt-oss-20b", "mistral-3-14B"),
    "writer": ("openai-gpt-oss-120b", "deepseek-3.2"),
}

# Per-model reasoning_effort overrides. Empty on purpose: "low" made gpt-oss-20b return empty answers
# (forcing fallbacks), and on gpt-oss-120b it saved only ~20% of output while weakening its reviews.
REASONING_EFFORT: dict[str, str] = {}

ALL_MODELS: list[str] = list(dict.fromkeys(m for pair in MODELS.values() for m in pair))
