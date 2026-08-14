"""Database engine and session factory.

Do not import `engine` or `session_factory` outside this module and
`app.common.tenancy` — ruff bans it (see pyproject.toml). Every query must go
through `tenant_context`, which is what applies Row-Level Security scoping.
A query that escapes that wrapper silently loses tenant scoping.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.common.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def _build_engine() -> AsyncEngine:
    settings = get_settings()
    return create_async_engine(
        settings.database_url,
        echo=settings.db_echo,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_pre_ping=True,
        # Neon (and our local pgbouncer) pool in transaction mode, which is
        # incompatible with asyncpg's implicit prepared-statement cache.
        connect_args={"statement_cache_size": 0, "prepared_statement_cache_size": 0},
    )


engine: AsyncEngine = _build_engine()

session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    autoflush=False,
)


async def dispose_engine() -> None:
    await engine.dispose()
