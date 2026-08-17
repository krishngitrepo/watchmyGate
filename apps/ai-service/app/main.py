"""WatchMyGate AI service.

The Python half of the split: **TypeScript owns money, Python owns machines and models.**
This service does OCR on bank statements, transcribes spoken complaints, and will drive
gate hardware. It owns no tables, holds no session, and cannot write to the ledger.

That last point is structural rather than a promise: there are no database credentials
in this process. A model can therefore suggest a reconciliation but never post one.

---

This file was previously the old Python API's entrypoint and **could not start**. It
imported `app.common.db` and `app.modules.auth.router`, neither of which has existed
since the API moved to TypeScript, and its readiness probe opened a database connection
this service has no reason to hold. Nobody noticed because the service had never been
run — the skeleton was not merely incomplete, it was broken. Rewritten here for what the
service actually is.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, ORJSONResponse

from app.common.config import get_settings
from app.common.errors import AppError
from app.modules.routes import router as ai_router

settings = get_settings()

logging.basicConfig(level=settings.log_level, format="%(message)s")
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    log.info(
        "ai_service_starting",
        environment=settings.environment,
        region=settings.gcp_region,
        ocr_stubbed=settings.ocr_is_stubbed,
    )
    if settings.ocr_is_stubbed:
        log.warning(
            "ocr_stub_mode",
            detail="No Anthropic key — extraction and transcription return placeholders.",
        )
    yield
    log.info("ai_service_stopped")


app = FastAPI(
    title="WatchMyGate AI Service",
    version="0.1.0",
    default_response_class=ORJSONResponse,
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None,
)


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict[str, str]:
    """Liveness. Deliberately checks nothing external.

    Cloud Run restarts a container that fails this, and restarting fixes neither a
    missing API key nor an Anthropic outage — it would only turn a degraded service into
    a crash loop.
    """
    return {"status": "ok"}


@app.get("/readyz", tags=["ops"])
async def readyz() -> dict[str, object]:
    """Readiness.

    Reports stub mode rather than failing on it. A service with no Anthropic key is
    correctly configured for local development and should take traffic — the endpoints
    themselves say plainly that they are stubbed.
    """
    return {"status": "ready", "ocrStubbed": settings.ocr_is_stubbed}


app.include_router(ai_router)
