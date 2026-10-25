# Fineprint

**Know what you're signing.** Paste your lease and get it back marked up, the way a friend with a red pen
would: what each clause means in plain English, and which ones to ask your landlord about before you sign.

**Live:** https://starfish-app-cv6n5.ondigitalocean.app

Fineprint splits the lease into clauses, looks up each one in a plain-language lease guide stored in a
DigitalOcean Knowledge Base, and has two open-weight models from different families (gpt-oss and Gemma)
label every clause independently as **Normal**, **Unusual** or **Ask about this**, quoting the exact words
and citing the guide. A third model checks every note against its source and softens anything unsupported.

## How a request flows

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

| File | What it does |
|---|---|
| `src/fineprint/app.py` | Web routes: page, `/api/analyze` (streaming), `/api/email`, `/api/practice`, `/healthz`; result cache |
| `src/fineprint/pipeline.py` | The steps above; agreement between reviewers, citation and quote checks |
| `src/fineprint/llm.py` | Calls DigitalOcean's OpenAI-compatible API; backup model per role; validates JSON, one repair retry |
| `src/fineprint/retrieve.py` | Knowledge Base over MCP (handshake, session, section ranking); bundled guide as fallback |
| `src/fineprint/prompts.py` | Every prompt in one place |
| `src/fineprint/models.py` | Which open-weight model plays which role |
| `src/fineprint/static/`, `templates/` | The interface: plain HTML, CSS and JavaScript, no build step |
| `kb/lease-questions.md` | The guide (also uploaded to the Knowledge Base) |

Then you can:
- **Draft the email**: turn the questions into a short, editable email (friendly or firm).
- **Practice asking**: role-play the conversation with a landlord played by `gpt-oss-120b`, while a coach
  (`gpt-oss-20b`) rates each message for clarity and politeness, suggests better wording, and ticks off
  the questions you've covered.

> Educational tool, not legal advice. Fineprint never says whether a clause is legal.

## Built with DigitalOcean

| Piece | Service |
|---|---|
| Jurors, classifier, verifier | Serverless Inference: `openai-gpt-oss-120b`, `gemma-4-31B-it`, `openai-gpt-oss-20b` (with open-weight fallbacks) |
| Guide retrieval | Knowledge Bases: `kb/lease-questions.md` indexed with GTE Large over OpenSearch, searched via the KB MCP endpoint; a bundled BM25 copy is the fallback |
| Hosting | App Platform |

## Run locally

```bash
uv sync
cp .env.example .env   # add MODEL_ACCESS_KEY; KB_ID + DO_API_TOKEN (GenAI read scope) to use the Knowledge Base
uv run fineprint       # http://localhost:8000
```

Checks:

```bash
uv run pytest                     # offline, no credits used
uv run python scripts/smoke.py    # live: pings every model and the knowledge base
```

## How well it works

Averaged over 4 live runs on our hand-labelled sample lease (21 clauses; 7 we'd want a student to ask
about, 2 that are a bit unusual). Results vary from run to run, so we report the average, not the best run:

| | Label accuracy | Flag precision | Flag recall | Caught 'ask' clauses |
|---|---|---|---|---|
| Reviewer A (gpt-oss-120b) | 77% | 90% | 89% | 71% |
| Reviewer B (gemma-4-31B-it) | 85% | 100% | 89% | 79% |
| **Both, combined** | **80%** | **90%** | **89%** | **79% (about 5.5 of 7)** |

The second model doesn't add much raw accuracy here. What it adds is a confidence signal the reader can
see: when two model families flag a clause independently, it's marked "flagged by both reviewers".

A full analysis costs about one cent in model usage (roughly 14 calls and 35k tokens) and takes 35–55
seconds. Analyzing the same lease again is served from an in-memory cache, so it's free.

## Demo safety net and accuracy

```bash
uv run python scripts/record_demo.py   # run the sample lease on live models once and save it
uv run python scripts/evaluate.py      # score that run against samples/sketchy-lease.labels.json
```

Open the app with `?demo=1` to replay the recorded run (and its emails) without calling any model.
The evaluation compares each reviewer alone with the combined verdict.

## Deploy to DigitalOcean App Platform

The app ships as a Docker image (`Dockerfile`) and an App Platform spec (`.do/app.yaml`).

1. Push this repo to GitHub as `SAI-RAHUL-M/fineprint` (or edit `github.repo` in `.do/app.yaml`).
2. Create the app, either in the console (Create App → GitHub → this repo; it detects the Dockerfile)
   or with the CLI:
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
3. In the app's Settings → Environment Variables, set `MODEL_ACCESS_KEY` (and `KB_ID`, `DO_API_TOKEN`
   once the knowledge base is ready). Mark the keys as encrypted.
4. If you create the app in the console instead of with the spec, set **Containers: 1** and the smallest
   size (512 MB, `apps-s-1vcpu-0.5gb`); the console's default is larger than this app needs.
5. Every push to `main` redeploys. `GET /healthz` reports whether the model key and knowledge base are configured.

The spec sets `disable_edge_cache: true` because the analysis streams over Server-Sent Events,
which the CDN cache would otherwise buffer. The server also sends a keep-alive comment every 10 seconds
while it waits on a model.

Build and run the image locally:

```bash
docker build -t fineprint .
docker run --rm -p 8080:8080 --env-file .env fineprint
```

## License

MIT
