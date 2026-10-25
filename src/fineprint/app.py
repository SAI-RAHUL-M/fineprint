"""FastAPI app: serves the UI and streams analysis progress as Server-Sent Events."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from .config import ROOT, get_settings
from .llm import LLM, LLMError
from .models import MODELS
from .pipeline import Event, Pipeline
from .retrieve import make_retriever

log = logging.getLogger(__name__)
HERE = Path(__file__).parent
SAMPLE = ROOT / "samples" / "sketchy-lease.txt"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.settings = settings
    app.state.retriever = make_retriever(settings)
    try:
        app.state.llm = LLM(settings)
    except LLMError as e:
        # Start anyway so the UI loads; /api/analyze reports the problem.
        log.warning("LLM disabled: %s", e)
        app.state.llm = None
    yield


app = FastAPI(title="Fineprint", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=200, max_length=60_000)


def sse(event: Event) -> str:
    return f"event: {event.type}\ndata: {json.dumps(event.data)}\n\n"


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html", {"models": MODELS})


@app.get("/api/sample", response_class=PlainTextResponse)
async def sample() -> str:
    return SAMPLE.read_text(encoding="utf-8")


@app.get("/healthz")
async def healthz(request: Request) -> dict[str, object]:
    return {
        "ok": True,
        "llm": request.app.state.llm is not None,
        "retrieval": request.app.state.retriever.name,
    }


@app.post("/api/analyze")
async def analyze(body: AnalyzeRequest, request: Request) -> StreamingResponse:
    state = request.app.state
    if state.llm is None:
        raise HTTPException(503, "MODEL_ACCESS_KEY is not configured on the server.")
    pipeline = Pipeline(state.llm, state.retriever, state.settings)

    async def stream() -> AsyncIterator[str]:
        try:
            async for event in pipeline.run(body.text):
                yield sse(event)
        except Exception:
            log.exception("analysis failed")
            yield sse(Event("error", {"message": "Analysis failed. Please try again."}))

    return StreamingResponse(
        with_heartbeat(stream(), state.settings.heartbeat_s),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def with_heartbeat(chunks: AsyncIterator[str], every: float) -> AsyncIterator[str]:
    """Interleave SSE comments so proxies don't close the stream while a slow model call is running."""
    it = aiter(chunks)
    pending = asyncio.ensure_future(anext(it))
    try:
        while True:
            done, _ = await asyncio.wait({pending}, timeout=every)
            if not done:
                yield ": keep-alive\n\n"
                continue
            try:
                chunk = pending.result()
            except StopAsyncIteration:
                return
            yield chunk
            pending = asyncio.ensure_future(anext(it))
    finally:
        pending.cancel()


def run() -> None:
    """Local dev server with auto-reload. Production runs uvicorn directly (see Dockerfile)."""
    import uvicorn

    uvicorn.run("fineprint.app:app", host="127.0.0.1", port=8000, reload=True)
