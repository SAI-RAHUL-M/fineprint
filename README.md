# Fineprint

A jury of open-weight models explains your lease before you sign it.

Paste a lease and Fineprint splits it into clauses, finds plain-language tenant guidance for each one,
and has two open-weight models from different families judge every clause independently as
**Standard**, **Uncommon** or **Ask about this**. A verifier drops any explanation its cited sources
don't support. You get a clarity score and a list of questions to ask your landlord.

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
