# Fineprint

A jury of open-weight models explains your lease before you sign it.

Paste a lease and Fineprint splits it into clauses, finds plain-language tenant guidance for each one,
and has two open-weight models from different families judge every clause independently as
**Standard**, **Uncommon** or **Ask about this**. A verifier drops any explanation its cited sources
don't support. You get a clarity score and a list of questions to ask your landlord.

> Educational tool, not legal advice. Fineprint never says whether a clause is legal.

## Built with DigitalOcean

| Piece | Service |
|---|---|
| Jurors, classifier, verifier | Serverless Inference: `openai-gpt-oss-120b`, `qwen3.5-397b-a17b`, `openai-gpt-oss-20b` (with open-weight fallbacks) |
| Tenant guidance retrieval | Knowledge Bases (MCP retrieval), with a bundled local fallback |
| Hosting | App Platform |

## Run locally

```bash
uv sync
cp .env.example .env   # add MODEL_ACCESS_KEY (and KB_ID / DO_API_TOKEN when ready)
uv run fineprint       # http://localhost:8000
```

Checks:

```bash
uv run pytest                     # offline, no credits used
uv run python scripts/smoke.py    # live: pings every model and the knowledge base
```

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
4. Every push to `main` redeploys. `GET /healthz` reports whether the model key and knowledge base are configured.

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
