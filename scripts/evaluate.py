"""Score the pipeline on the sample lease against its hand labels.

By default this scores the recorded demo run (free). Pass --live to run the models again (a few cents).
Run: uv run python scripts/evaluate.py [--live]
"""

import asyncio
import json
import sys

from fineprint.app import DEMO_RUN, SAMPLE
from fineprint.config import ROOT, get_settings
from fineprint.demo import load
from fineprint.evaluate import evaluate, markdown

LABELS = ROOT / "samples" / "sketchy-lease.labels.json"
OUT = ROOT / "samples" / "eval-results.json"


async def live_report() -> dict:
    from fineprint.llm import LLM
    from fineprint.pipeline import Pipeline
    from fineprint.retrieve import make_retriever

    settings = get_settings()
    events = [
        e async for e in Pipeline(LLM(settings), make_retriever(settings), settings).run(SAMPLE.read_text())
    ]
    return events[-1].data


def main() -> None:
    if "--live" in sys.argv:
        report = asyncio.run(live_report())
    else:
        recorded = load(DEMO_RUN)
        if recorded is None:
            raise SystemExit("No recorded run. Run scripts/record_demo.py first, or pass --live.")
        report = recorded["events"][-1]["data"]

    expected = json.loads(LABELS.read_text())["expected"]
    results = evaluate(report, expected)
    models = {c["role"]: c["model"] for c in report["calls"] if c["role"] in ("juror_a", "juror_b")}
    OUT.write_text(json.dumps({"models": models, "results": results}, indent=2))

    print(markdown(results, models))
    print(f"\nSaved to {OUT}. Paste the table into the README.")


if __name__ == "__main__":
    main()
