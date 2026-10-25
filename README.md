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

## License

MIT
