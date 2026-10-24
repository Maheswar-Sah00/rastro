"""Backend configuration, read once from environment variables (see ../.env.example).

The backend holds no private keys. Oracle signing stays in the trusted replay tooling
(contracts/replay); the API only reads chain state and prepares unsigned transactions.
"""
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
API_VERSION = "v1"
APP_VERSION = "0.2.0"


@dataclass(frozen=True)
class Settings:
    data_dir: Path            # published web bundle (web/public/data)
    allow_mock: bool
    cors_origins: tuple[str, ...]
    dataset_dir: Path         # canonical dataset (data/synthetic/<preset>)
    pipeline_dir: Path        # pipeline package root (provides `rastro`)
    chain_mode: str           # "auto" (RPC, fall back to local records) | "local" | "rpc"
    rpc_url: str | None       # overrides onchain.json's rpc
    rpc_timeout_s: float
    log_level: str
    state_dir: Path | None    # investigator annotations (default: <dataset>/derived/reviews)
    warm_lineage: bool


def _bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _path(name: str, default: Path) -> Path:
    p = Path(os.environ.get(name, default))
    return p if p.is_absolute() else (REPO / p).resolve()


@lru_cache
def get_settings() -> Settings:
    origins = os.environ.get("RASTRO_CORS_ORIGINS", "http://localhost:5173,http://localhost:4173")
    return Settings(
        data_dir=_path("RASTRO_DATA_DIR", REPO / "web" / "public" / "data"),
        allow_mock=_bool(os.environ.get("RASTRO_ALLOW_MOCK", "true")),
        cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        dataset_dir=_path("RASTRO_DATASET_DIR", REPO / "data" / "synthetic" / "evaluation"),
        pipeline_dir=_path("RASTRO_PIPELINE_DIR", REPO / "pipeline"),
        chain_mode=os.environ.get("RASTRO_CHAIN_MODE", "auto").strip().lower(),
        rpc_url=os.environ.get("RASTRO_RPC_URL") or None,
        rpc_timeout_s=float(os.environ.get("RASTRO_RPC_TIMEOUT_S", "2")),
        log_level=os.environ.get("RASTRO_LOG_LEVEL", "INFO"),
        state_dir=_path("RASTRO_STATE_DIR", Path(".")) if os.environ.get("RASTRO_STATE_DIR") else None,
        warm_lineage=_bool(os.environ.get("RASTRO_WARM_LINEAGE", "true")),
    )
