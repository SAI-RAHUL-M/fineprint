"""Thin harness over DigitalOcean's OpenAI-compatible inference API.

Open-weight models don't have documented native tool calling on DO, so structured output is done by
prompting for JSON, validating with Pydantic, and giving the model one chance to repair invalid output.
"""

import json
import logging
import re
import time
from typing import Protocol

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from .config import Settings
from .models import MODELS, REASONING_EFFORT, Role
from .schemas import CallMeta

log = logging.getLogger(__name__)

JSON_RULES = (
    "Respond with ONLY one JSON object that matches the requested schema. "
    "No prose, no markdown, no code fences."
)

Messages = list[dict[str, str]]


class LLMError(RuntimeError):
    pass


class JSONCaller(Protocol):
    """What the pipeline needs from an LLM client (lets tests inject a fake)."""

    async def call_json[T: BaseModel](
        self, role: Role, messages: Messages, schema: type[T]
    ) -> tuple[T, CallMeta]: ...


def extract_json(text: str) -> object:
    """Return the first balanced {...} object in a model reply, ignoring fences and <think> blocks."""
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I)
    cleaned = re.sub(r"```(?:json)?", "", cleaned, flags=re.I)
    start = cleaned.find("{")
    if start == -1:
        raise ValueError("no JSON object found")
    depth, in_str, i = 0, False, start
    while i < len(cleaned):
        c = cleaned[i]
        if in_str:
            if c == "\\":
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return json.loads(cleaned[start : i + 1])
        i += 1
    raise ValueError("unterminated JSON object")


def _validate[T: BaseModel](text: str, schema: type[T]) -> T | str:
    """Parsed model, or an error message to feed back to the model."""
    try:
        return schema.model_validate(extract_json(text))
    except (ValueError, ValidationError) as e:
        return str(e)[:800]


class LLM:
    def __init__(self, settings: Settings):
        if not settings.model_access_key:
            raise LLMError("MODEL_ACCESS_KEY is not set")
        self._client = AsyncOpenAI(
            base_url=settings.inference_base_url,
            api_key=settings.model_access_key,
            timeout=settings.llm_timeout_s,
            max_retries=1,
        )

    async def chat(
        self,
        models: tuple[str, ...],
        messages: Messages,
        *,
        role: str = "",
        temperature: float = 0.2,
        max_tokens: int = 4000,
    ) -> tuple[str, CallMeta]:
        """Chat completion that falls through `models` in order until one succeeds."""
        last_err: Exception | None = None
        for i, model in enumerate(models):
            t0 = time.perf_counter()
            try:
                res = await self._client.chat.completions.create(
                    model=model,
                    messages=messages,  # type: ignore[arg-type]
                    temperature=temperature,
                    max_completion_tokens=max_tokens,
                    **({"reasoning_effort": REASONING_EFFORT[model]} if model in REASONING_EFFORT else {}),
                )
                text = (res.choices[0].message.content or "") if res.choices else ""
                if not text.strip():
                    raise LLMError(f"empty response from {model}")
                meta = CallMeta(
                    role=role,
                    model=res.model or model,
                    ms=int((time.perf_counter() - t0) * 1000),
                    input_tokens=res.usage.prompt_tokens if res.usage else 0,
                    output_tokens=res.usage.completion_tokens if res.usage else 0,
                    used_fallback=i > 0,
                )
                return text, meta
            except Exception as e:
                last_err = e
                log.warning("model %s failed: %s", model, e)
        raise LLMError(f"all models failed for role {role!r}: {last_err}") from last_err

    async def call_json[T: BaseModel](
        self, role: Role, messages: Messages, schema: type[T]
    ) -> tuple[T, CallMeta]:
        """Chat call whose reply must validate against `schema`; one repair retry on failure."""
        msgs = [{"role": "system", "content": JSON_RULES}, *messages]
        text, meta = await self.chat(MODELS[role], msgs, role=role)
        parsed = _validate(text, schema)
        if isinstance(parsed, BaseModel):
            return parsed, meta

        # Repair on the model that actually answered so the conversation stays coherent.
        repair = [
            *msgs,
            {"role": "assistant", "content": text},
            {"role": "user", "content": f"That reply was invalid: {parsed}. Return ONLY the corrected JSON."},
        ]
        text2, meta2 = await self.chat((meta.model,), repair, role=role)
        fixed = _validate(text2, schema)
        if not isinstance(fixed, BaseModel):
            raise LLMError(f"invalid JSON from {meta2.model} after repair: {fixed}")
        return fixed, meta2.model_copy(
            update={
                "ms": meta.ms + meta2.ms,
                "input_tokens": meta.input_tokens + meta2.input_tokens,
                "output_tokens": meta.output_tokens + meta2.output_tokens,
                "used_fallback": meta.used_fallback,
                "repaired": True,
            }
        )
