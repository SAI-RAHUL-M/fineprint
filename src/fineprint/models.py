"""Open-weight models on DigitalOcean Serverless Inference, by role.

Each role is (primary, fallback); the LLM client retries on the fallback if the primary errors.
"""

from typing import Literal

Role = Literal["juror_a", "juror_b", "fast", "writer"]

MODELS: dict[Role, tuple[str, str]] = {
    "juror_a": ("openai-gpt-oss-120b", "deepseek-3.2"),
    "juror_b": ("qwen3.5-397b-a17b", "gemma-4-31B-it"),
    "fast": ("openai-gpt-oss-20b", "mistral-3-14B"),
    "writer": ("openai-gpt-oss-120b", "glm-5.2"),
}

ALL_MODELS: list[str] = list(dict.fromkeys(m for pair in MODELS.values() for m in pair))
