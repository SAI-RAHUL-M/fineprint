# Fineprint

**Know what you're signing.** Paste your lease and get it back marked up, the way a friend with a red pen
would: what each clause means in plain English, and which ones to ask your landlord about before you sign.

Built in one day at Hacktoberfest Hack Day × GDSC UMD (College Park, October 2026).
Winner of the event's **UI/UX Design Challenge**.

Live demo: https://starfish-app-cv6n5.ondigitalocean.app (may be offline after the event)

> **Not legal advice.** Fineprint explains what a lease says. It never tells you whether a clause is legal.
> For that, talk to UMD Off-Campus Housing or Student Legal Aid.

## Features

- **Clause-by-clause markup:** a plain-English summary and a label for every clause: **Normal**,
  **Unusual** or **Ask about this**, with the exact words highlighted.
- **Two independent reviewers:** two open-weight models from different families judge each clause; the
  page shows whether one or both flagged it.
- **Sourced flags:** "Ask about this" must cite a section of our lease guide, and a third model checks each
  note against its source.
- **Next steps:** a ranked list of questions for the landlord, a one-click email draft, and a practice mode
  with a role-played landlord and a coach.
- Print / save as PDF, light and dark themes, keyboard navigation, mobile layout.

## How it works

1. **Split** the lease into clauses with plain Python (`split.py`), keeping character offsets.
2. **Summarize** each clause and tag its type with `gpt-oss-20b`.
3. **Retrieve** matching sections of our lease guide from a DigitalOcean Knowledge Base. The KB can merge
   several guide sections into one chunk, so results are split back into sections and ranked.
4. **Review** with `gpt-oss-120b` and `gemma-4-31B-it` in parallel. Each returns a label, a short
   explanation, the exact phrase, a cited section and a question to ask.
5. **Check in code:** citations must point to sections the model was given, quoted phrases must appear in
   the lease, and "Ask about this" without a valid citation becomes "Unusual".
6. **Verify** each cited note against its source with `gpt-oss-20b`; unsupported notes are softened.
7. **Combine:** both reviewers flag a clause = high confidence, one = "maybe". Results stream to the page
   as each step finishes.

The models aren't fine-tuned; behavior comes from the prompts (`prompts.py`), the retrieved guide sections
and the checks in steps 5–7.

## DigitalOcean services

| Service | Use |
|---|---|
| **Serverless Inference** | All models, via the OpenAI-compatible API and the `openai` SDK. Each role has an open-weight fallback (`deepseek-3.2`, `mistral-3-14B`). |
| **Knowledge Bases** | Holds `kb/lease-questions.md` (GTE Large embeddings, OpenSearch), searched through the KB MCP endpoint. If it's unreachable, a bundled copy of the guide is used. |
| **App Platform** | Hosts the Docker image; one 512 MB container (`.do/app.yaml`). Edge cache is disabled so the live progress stream isn't buffered. |

## Code map

Python 3.12 · uv · FastAPI (Server-Sent Events) · Pydantic · vanilla HTML/CSS/JS (no build step) · pytest · ruff · Docker

| Path | What it is |
|---|---|
| `src/fineprint/pipeline.py` | The analysis steps above |
| `src/fineprint/app.py` | Routes (`/api/analyze`, `/api/email`, `/api/practice`, `/healthz`), result cache, `?demo=1` replay |
| `src/fineprint/llm.py` | Inference client: fallback per role, JSON validation with one repair retry |
| `src/fineprint/retrieve.py` | Knowledge Base client and bundled-guide fallback |
| `src/fineprint/prompts.py`, `models.py` | Prompts; which model plays which role |
| `src/fineprint/static/`, `templates/` | The interface |
| `kb/`, `samples/`, `scripts/`, `tests/` | Lease guide; sample lease and labels; dev scripts; offline tests |

## Run locally

```bash
uv sync
cp .env.example .env    # MODEL_ACCESS_KEY; optionally KB_ID and DO_API_TOKEN (GenAI read scope)
uv run fineprint        # http://localhost:8000
```

Without `KB_ID` / `DO_API_TOKEN` the app uses the bundled guide.

```bash
uv run pytest                          # offline tests, no credits used
uv run python scripts/fake_server.py   # UI with a scripted fake model, port 8001
uv run python scripts/smoke.py         # live check of every model and the Knowledge Base
```

## Deploy

1. App Platform → **Create App → GitHub → this repo** (the Dockerfile is detected), or
   `doctl apps create --spec .do/app.yaml`. Use 1 container at 512 MB.
2. Add `MODEL_ACCESS_KEY`, `KB_ID` and `DO_API_TOKEN` as encrypted environment variables.
3. `GET /healthz` should return `"llm": true` and `"retrieval": "digitalocean-kb"`.

## How well it works

We wrote a fictional College Park lease (`samples/sketchy-lease.txt`, 21 clauses) and labelled each clause
by hand: 7 worth asking about, 2 a bit unusual, the rest normal. Averaged over 4 live runs:

| | Label accuracy | Flag precision | Flag recall | Caught "ask" clauses |
|---|---|---|---|---|
| Reviewer A (gpt-oss-120b) | 77% | 90% | 89% | 71% |
| Reviewer B (gemma-4-31B-it) | 85% | 100% | 89% | 79% |
| **Both, combined** | **80%** | **90%** | **89%** | **79%** |

This is one lease we wrote and labelled ourselves, so it shows consistency, not accuracy on real leases.
The second model adds little raw accuracy here; its value is the visible agreement signal. A full
analysis takes about 35–55 seconds and roughly one cent in model usage; repeat analyses come from cache.

## Privacy

Leases aren't stored: there's no database and nothing is written to disk. Lease text is sent to
DigitalOcean Serverless Inference for analysis. Recent results are kept in memory (keyed by a hash of the
lease) until the app restarts.

## Limitations

- The guide is written by us: a plain-language companion, not an official or legal source.
- Clauses on topics the guide doesn't cover can be marked Unusual at most.
- Text only: paste the lease or drop a `.txt` file; scanned PDFs aren't supported.

## License

MIT
