"""Rastro API. Read-mostly over the canonical dataset and the published bundle; it holds no keys.

    uvicorn app.main:app --port 8000      # docs at /docs, OpenAPI at /openapi.json
"""
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import observability
from app.api import v1
from app.api.routes import router
from app.config import APP_VERSION, get_settings
from app.store import MalformedData


def create_app() -> FastAPI:
    s = get_settings()
    observability.configure_logging(s.log_level)
    app = FastAPI(title="Rastro API", version=APP_VERSION, lifespan=lifespan,
                  description="Cattle lineage, environmental evidence, risk decisions and HerdLedger reads. "
                              "All ranch, herd and permit data is synthetic.")
    app.add_middleware(CORSMiddleware, allow_origins=list(s.cors_origins), allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-Request-ID"], expose_headers=["X-Request-ID", "Content-Disposition"])
    observability.install(app)

    @app.exception_handler(MalformedData)
    async def _malformed(_, e: MalformedData):
        return observability.error_body(500, "malformed_data", "a dataset file is malformed", {"file": e.path.name, "line": e.line, "error": str(e)})

    app.include_router(router)
    app.include_router(v1.router)
    return app


@asynccontextmanager
async def lifespan(_app):
    # Building the lineage replay takes seconds on the full dataset: do it off the request path.
    if get_settings().warm_lineage:
        store = v1.get_store()
        if store.exists("ranches"):
            threading.Thread(target=store.lineage_service, name="warm-lineage", daemon=True).start()
    yield


app = create_app()
