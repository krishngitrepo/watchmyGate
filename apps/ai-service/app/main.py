"""WatchMyGate API entrypoint."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, ORJSONResponse
from sqlalchemy import text

from app.common.config import get_settings
from app.common.db import dispose_engine, engine
from app.common.errors import AppError
from app.modules.auth.router import router as auth_router

settings = get_settings()

logging.basicConfig(level=settings.log_level, format="%(message)s")
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer()
        if settings.is_production
        else structlog.dev.ConsoleRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(settings.log_level)),
)

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    log.info(
        "api_starting",
        environment=settings.environment,
        region=settings.gcp_region,
        sms_stubbed=settings.sms_is_stubbed,
        payments_stubbed=settings.payments_are_stubbed,
    )
    if settings.sms_is_stubbed and not settings.is_production:
        log.warning("sms_stub_mode", detail="OTP codes are written to this log, not sent by SMS.")
    yield
    await dispose_engine()
    log.info("api_stopped")


app = FastAPI(
    title="WatchMyGate API",
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
    """Liveness only — deliberately does not touch the database.

    Cloud Run restarts a container that fails this, and restarting will not fix a
    database outage. Readiness is separate.
    """
    return {"status": "ok"}


@app.get("/readyz", tags=["ops"])
async def readyz() -> dict[str, str]:
    """Readiness — verifies the database is reachable."""
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ready"}


app.include_router(auth_router)
