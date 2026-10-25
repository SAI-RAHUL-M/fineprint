"""Smoke test against DigitalOcean: every model answers, the JSON harness works, and (if configured)
the Knowledge Base returns passages. Raw KB output is saved so we can see its exact format.

Run: uv run python scripts/smoke.py
"""

import asyncio
import json
from pathlib import Path

from fineprint.config import get_settings
from fineprint.llm import LLM
from fineprint.models import ALL_MODELS
from fineprint.retrieve import DOKnowledgeBase
from fineprint.schemas import Verdict

OUT = Path(__file__).parent / "out"


async def ping(llm: LLM, model: str) -> tuple[str, bool, str]:
    try:
        # One model only, so a failure isn't hidden by a fallback.
        text, meta = await llm.chat(
            (model,), [{"role": "user", "content": "Reply with exactly: pong"}], max_tokens=400
        )
        return (
            model,
            True,
            f"{meta.ms} ms, {meta.input_tokens}+{meta.output_tokens} tok, {text.strip()[:20]!r}",
        )
    except Exception as e:
        return model, False, str(e)[:100]


async def main() -> None:
    settings = get_settings()
    if not settings.model_access_key:
        raise SystemExit("MODEL_ACCESS_KEY missing: copy .env.example to .env and fill it in.")
    llm = LLM(settings)
    OUT.mkdir(exist_ok=True)

    print(f"== Pinging {len(ALL_MODELS)} models ==")
    rows = await asyncio.gather(*(ping(llm, m) for m in ALL_MODELS))
    for model, ok, info in rows:
        print(f"  {'OK  ' if ok else 'FAIL'} {model:28} {info}")

    print("\n== JSON harness (fast role) ==")
    try:
        verdict, meta = await llm.call_json(
            "fast",
            [
                {
                    "role": "user",
                    "content": (
                        'clause_id 5: "Tenant shall pay a non-refundable cleaning fee of $600 at move-in." '
                        "Return {clause_id, label (standard|uncommon|ask_about_this), explanation, cite_ids: [], "
                        "question_to_ask}."
                    ),
                }
            ],
            Verdict,
        )
        print(f"  {verdict.model_dump()}\n  {meta.model_dump()}")
    except Exception as e:
        print(f"  FAILED: {e}")

    print("\n== Knowledge Base retrieval (MCP) ==")
    if not (settings.kb_id and settings.do_api_token):
        print("  skipped: set KB_ID and DO_API_TOKEN once the knowledge base is indexed")
    else:
        kb = DOKnowledgeBase(settings)
        try:
            raw = await kb.call_raw("security deposit return and move-out inspection", 3)
            (OUT / "kb-response.json").write_text(json.dumps(raw, indent=2))
            print(f"  raw response saved to {OUT / 'kb-response.json'}")
            for p in await kb.retrieve("security deposit return and move-out inspection", 3):
                print(f"  [{p.id}] {p.source}: {p.text[:120]!r}")
        except Exception as e:
            print(f"  FAILED: {e}")

    failed = [m for m, ok, _ in rows if not ok]
    print(f"\n{'Swap these in src/fineprint/models.py: ' + ', '.join(failed) if failed else 'All models OK'}")


if __name__ == "__main__":
    asyncio.run(main())
