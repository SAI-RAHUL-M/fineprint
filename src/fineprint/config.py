from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / ".env", ROOT / ".env.local"), extra="ignore")

    model_access_key: str = ""
    inference_base_url: str = "https://inference.do-ai.run/v1"

    kb_id: str = ""
    do_api_token: str = ""
    kb_mcp_url: str = "https://kbaas.do-ai.run/v1/mcp"
    local_corpus_dir: Path = ROOT / "kb"

    agent_endpoint: str = ""
    agent_key: str = ""

    # Pipeline tuning
    llm_timeout_s: float = 90.0
    max_concurrency: int = 6
    classify_batch: int = 8
    jury_batch: int = 5
    passages_per_clause: int = 3
    heartbeat_s: float = 10.0  # SSE keep-alive interval while waiting on models


@lru_cache
def get_settings() -> Settings:
    return Settings()
