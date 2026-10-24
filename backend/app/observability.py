"""Structured JSON logs, request ids and structured error responses."""
import json
import logging
import time
import uuid
from contextvars import ContextVar

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

request_id: ContextVar[str] = ContextVar("request_id", default="-")
log = logging.getLogger("rastro.api")


class JsonFormatter(logging.Formatter):
    def format(self, record):
        out = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"), "level": record.levelname, "logger": record.name,
               "msg": record.getMessage(), "request_id": request_id.get()}
        out.update(getattr(record, "fields", {}))
        return json.dumps(out, ensure_ascii=False)


def configure_logging(level: str) -> None:
    h = logging.StreamHandler()
    h.setFormatter(JsonFormatter())
    root = logging.getLogger("rastro")
    root.handlers[:] = [h]
    root.setLevel(level)
    root.propagate = False


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def error_body(status, code, message, details=None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "details": details,
                                                               "request_id": request_id.get()}},
                        headers={"X-Request-ID": request_id.get()})


import os
import re
from collections import defaultdict, deque

# Expensive endpoints (lineage replays, re-assessment, bundle rebuilds, zips): per-client sliding window.
EXPENSIVE = re.compile(r"^/api/v1/(shipments/[^/]+/(assess|evidence/download|lineage/graph|lineage/report|certificate/bundle)"
                       r"|certificates/[^/]+/(verify|report)|lots/[^/]+/lineage)$")
_hits: dict = defaultdict(deque)


def _limited(client: str) -> bool:
    limit = int(os.environ.get("RASTRO_RATE_LIMIT_PER_MIN", "60"))
    if limit <= 0:
        return False
    now, q = time.monotonic(), _hits[client]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


def install(app: FastAPI) -> None:
    @app.middleware("http")
    async def _request_id(request: Request, call_next):
        rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
        token = request_id.set(rid[:64])
        t0 = time.perf_counter()
        if EXPENSIVE.match(request.url.path) and _limited(request.client.host if request.client else "-"):
            response = error_body(429, "rate_limited", "too many expensive requests; retry in a minute",
                                  {"limit_per_minute": int(os.environ.get("RASTRO_RATE_LIMIT_PER_MIN", "60"))})
            response.headers["Retry-After"] = "60"
            request_id.reset(token)
            return response
        try:
            response = await call_next(request)
        except Exception:  # unhandled: structured 500, logged with the request id
            log.exception("unhandled error", extra={"fields": {"path": request.url.path}})
            response = error_body(500, "internal_error", "unexpected server error")
        response.headers["X-Request-ID"] = request_id.get()
        log.info("request", extra={"fields": {"method": request.method, "path": request.url.path, "status": response.status_code,
                                              "ms": round(1000 * (time.perf_counter() - t0), 1)}})
        request_id.reset(token)
        return response

    @app.exception_handler(APIError)
    async def _api_error(_, e: APIError):
        return error_body(e.status, e.code, e.message, e.details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_, e: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "http_error")
        return error_body(e.status_code, code, str(e.detail))

    @app.exception_handler(RequestValidationError)
    async def _validation(_, e: RequestValidationError):
        details = [{"loc": list(x["loc"]), "msg": x["msg"], "type": x["type"]} for x in e.errors()]
        return error_body(422, "invalid_request", "request failed validation", details)
