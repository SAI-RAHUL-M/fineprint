# Fineprint

**Know what you're signing.** Paste your lease and get it back marked up, the way a friend with a red pen
would: what each clause means in plain English, and which ones to ask your landlord about before you sign.

**Live demo:** https://starfish-app-cv6n5.ondigitalocean.app

Built at Hacktoberfest Hack Day × GDSC UMD (College Park) for the **Best Open-Source AI Project** track.

> **Not legal advice.** Fineprint explains what a lease says. It never tells you whether a clause is legal.
> For that, talk to UMD Off-Campus Housing or Student Legal Aid.

---

## Features

- **Clause-by-clause markup.** Every clause gets a one-line plain-English summary and a label:
  **Normal** (✓), **Unusual** (highlighter) or **Ask about this** (red pen).
- **Exact words highlighted.** Reviewers quote the phrase that matters; it's only shown if it appears in the
  lease word for word.
- **Two independent reviewers.** Two open-weight models from different families judge every clause on their
  own. The page shows whether one or both flagged it.
- **Every flag is sourced.** "Ask about this" requires a citation to a guide passage, and a third model
  checks each note against its source. Unsupported notes are softened, and the page says so.
- **Questions to ask.** A ranked list of polite, specific questions for your landlord.
- **Email draft.** One click turns the questions into a short, editable email, friendly or firm.
- **Practice mode.** Rehearse the conversation with a role-played landlord while a coach rates each message
  for clarity and politeness and ticks off the questions you've covered.
- **Print or save as PDF**, light / dark / auto theme, keyboard navigation, screen-reader labels,
  WCAG AA contrast, mobile layout.

## How it works

1. **Split (plain Python, no AI).** `split.py` finds section headings like `5. CLEANING FEE.`, `Section 7` or
   ALL-CAPS lines and cuts the lease into clauses, keeping character offsets for highlighting.
2. **Summarize.** `gpt-oss-20b` writes a one-line summary and a type (rent, deposit, entry, …) for each clause.
3. **Retrieve.** Each clause becomes a query to our DigitalOcean Knowledge Base, which holds a
   plain-language lease guide. The KB sometimes merges several guide sections into one chunk, so
   `retrieve.py` splits results back into sections and keeps the ones that best match the clause.
4. **Review.** `gpt-oss-120b` and `gemma-4-31B-it` each read the clauses with their guide sections and
   return a label, a short explanation, the exact phrase, a cited section and a question to ask. They run
   in parallel.
5. **Check (code).** Citations must point to sections the model was actually given; quotes must appear in
   the lease; "Ask about this" without a valid citation is downgraded to "Unusual".
6. **Verify.** `gpt-oss-20b` checks each cited note against its source and softens unsupported ones.
7. **Combine.** Both reviewers flag a clause = high confidence; one = "maybe". The page gets the labels,
   a clarity score and the question list, streamed live as each step finishes.

If the guide has no section for a clause (e.g. quiet hours or parking), the reviewers judge it by typical
leases and leave the citation empty, so the clause can be **Normal** or **Unusual** but never
**Ask about this**. We only tell students to raise something with the landlord when a source backs it.

The models are not fine-tuned. Behavior comes from the prompts (`prompts.py`), the retrieved guide
sections, and the rules the code enforces in steps 5–7.

```
Browser ──POST /api/analyze──▶ App Platform (FastAPI in Docker)
                                 │  streams progress back as Server-Sent Events
                                 ├─ split.py      cut into clauses (no AI)
                                 ├─ classify      gpt-oss-20b ─────────┐
                                 ├─ retrieve.py   Knowledge Base (MCP) │  DigitalOcean
                                 ├─ jury          gpt-oss-120b ∥ Gemma ├─ Serverless
                                 ├─ verify        gpt-oss-20b ─────────┘  Inference
                                 └─ report        labels, score, questions
```

## DigitalOcean services used

| Service | What it does in Fineprint | How it's connected |
|---|---|---|
| **Serverless Inference** | Runs every model: `openai-gpt-oss-120b` (reviewer A, email writer, practice landlord), `gemma-4-31B-it` (reviewer B), `openai-gpt-oss-20b` (summaries, fact-check, practice coach). Each role has an open-weight fallback (`deepseek-3.2`, `mistral-3-14B`). | OpenAI-compatible API at `https://inference.do-ai.run/v1`, called with the official `openai` Python SDK and one `MODEL_ACCESS_KEY`. No GPU servers to manage; billed per token. |
| **Knowledge Bases** | Stores the lease guide that every "Ask about this" must cite. | `kb/lease-questions.md` uploaded and embedded with **GTE Large EN v1.5**, stored in a managed **OpenSearch** database. Searched through the KB **MCP endpoint** (`https://kbaas.do-ai.run/v1/mcp`, tool `retrieve_knowledge_base`) using `KB_ID` and a `DO_API_TOKEN` with the GenAI read scope. If the KB is unreachable, a bundled copy of the guide (BM25 search) takes over. |
| **App Platform** | Hosts the web app. | Docker build straight from this GitHub repo, redeploys on every push to `main`. One 512 MB container (`apps-s-1vcpu-0.5gb`). Spec in `.do/app.yaml`; secrets set as encrypted environment variables. Edge cache disabled so the live Server-Sent Events stream isn't buffered. |

## Tech stack

| Layer | Tools |
|---|---|
| Language & packaging | Python 3.12, [uv](https://github.com/astral-sh/uv) |
| Web server | FastAPI, Uvicorn, Server-Sent Events for live progress |
| Data & validation | Pydantic v2, pydantic-settings |
| AI calls | `openai` SDK against DigitalOcean Serverless Inference; HTTPX for the Knowledge Base MCP endpoint |
| Frontend | Jinja2 template, hand-written CSS and vanilla JavaScript (no framework, no build step); Newsreader + Public Sans fonts |
| Quality | pytest (39 offline tests with a scripted fake model), ruff (lint + format) |
| Deployment | Docker, DigitalOcean App Platform |

## Project layout

| Path | What it is |
|---|---|
| `src/fineprint/app.py` | Routes: page, `/api/analyze` (streaming), `/api/email`, `/api/practice`, `/api/sample`, `/healthz`; result cache; `?demo=1` replay |
| `src/fineprint/pipeline.py` | The steps above: reviewer agreement, citation and quote checks, scoring |
| `src/fineprint/llm.py` | DigitalOcean inference client: fallback model per role, JSON validation with one repair retry |
| `src/fineprint/retrieve.py` | Knowledge Base over MCP (handshake, session, section ranking) and the bundled-guide fallback |
| `src/fineprint/split.py` | Deterministic clause splitter |
| `src/fineprint/prompts.py` | Every prompt in one place |
| `src/fineprint/models.py` | Which open-weight model plays which role |
| `src/fineprint/practice.py` | Practice mode: landlord reply and coach note, in parallel |
| `src/fineprint/cache.py` | Small in-memory LRU cache for repeat analyses and emails |
| `src/fineprint/evaluate.py` | Scores a run against hand labels |
| `src/fineprint/static/`, `templates/` | The interface |
| `kb/lease-questions.md` | The lease guide (the same file uploaded to the Knowledge Base) |
| `samples/` | Sample lease, its hand labels, a recorded live run, evaluation results |
| `scripts/` | Smoke test, demo recorder, evaluation, fake-model dev server |
| `tests/` | Offline test suite |
| `Dockerfile`, `.do/app.yaml` | Container and App Platform spec |

## Run locally

```bash
uv sync
cp .env.example .env
uv run fineprint        # http://localhost:8000
```

`.env` settings:

| Variable | Needed for | Where to get it |
|---|---|---|
| `MODEL_ACCESS_KEY` | All analysis | DigitalOcean → Inference → Model Access Keys |
| `KB_ID` | Knowledge Base retrieval (optional) | Your Knowledge Base's UUID |
| `DO_API_TOKEN` | Knowledge Base retrieval (optional) | DigitalOcean → API → Tokens, custom scope **GenAI: read** |

Without `KB_ID` / `DO_API_TOKEN` the app uses the bundled guide, so everything still works.

```bash
uv run pytest                          # offline tests, no credits used
uv run python scripts/smoke.py         # live: pings every model and the Knowledge Base
uv run python scripts/fake_server.py   # UI development with a scripted fake model (port 8001)
```

## Deploy to DigitalOcean App Platform

1. Create the app: **Create App → GitHub → this repo** (the Dockerfile is detected), or
   `doctl apps create --spec .do/app.yaml`.
2. Use **1 container** at the smallest size (512 MB); the console's default is larger than this app needs.
3. Under **Settings → Environment Variables**, add `MODEL_ACCESS_KEY`, `KB_ID` and `DO_API_TOKEN`, marked
   **Encrypt**, with a scope that includes run time.
4. Check `GET /healthz`: it should return `"llm": true` and `"retrieval": "digitalocean-kb"`.

Every push to `main` redeploys. To run the image yourself:

```bash
docker build -t fineprint .
docker run --rm -p 8080:8080 --env-file .env fineprint
```

## How well it works

We wrote a fictional College Park lease (`samples/sketchy-lease.txt`, 21 clauses) and labelled every clause
by hand (`samples/sketchy-lease.labels.json`): 7 we'd want a student to ask about, 2 a bit unusual, the rest
normal. `scripts/evaluate.py` compares a run against those labels. Averaged over 4 live runs (results vary,
so we report the average, not the best run):

| | Label accuracy | Flag precision | Flag recall | Caught "ask" clauses |
|---|---|---|---|---|
| Reviewer A (gpt-oss-120b) | 77% | 90% | 89% | 71% |
| Reviewer B (gemma-4-31B-it) | 85% | 100% | 89% | 79% |
| **Both, combined** | **80%** | **90%** | **89%** | **79% (about 5.5 of 7)** |

The second model adds little raw accuracy here; its value is the visible agreement signal. With retrieval
through the Knowledge Base, every flagged clause in our run cited exactly its matching guide section.

A full analysis takes about 35–55 seconds and costs roughly one cent in model usage (about 14 calls).
Analyzing the same lease again is served from the in-memory cache, so it's free.

**Demo safety net:** `scripts/record_demo.py` records one live run of the sample lease; opening the app
with `?demo=1` replays it (and its emails) without calling any model.

## Privacy

- Leases are **not saved**: there is no database and nothing is written to disk.
- Lease text is sent to DigitalOcean Serverless Inference to be analyzed. Clauses are sent to the
  Knowledge Base only as search queries; the KB holds only our guide.
- Recent results stay in the server's memory (up to 32, keyed by a SHA-256 hash of the lease) so a repeat
  request is instant. They're cleared whenever the app restarts or redeploys.

## Limitations

- The guide is written by us. It's a plain-language companion, not an official or legal source.
- Clauses on topics the guide doesn't cover can be marked Unusual at most.
- The evaluation uses one lease we wrote and labelled ourselves. It shows the system behaves consistently,
  not that it's accurate on real leases; the next step is testing on real leases labelled by experts.
- Text only: scanned PDFs aren't supported (paste text or drop a `.txt` file).

## License

MIT
