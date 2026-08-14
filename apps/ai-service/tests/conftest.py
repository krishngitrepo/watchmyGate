"""Test fixtures.

Database-backed tests run against the local docker-compose Postgres as
`watchmygate_app` — the restricted NOBYPASSRLS role the application uses in production.
Connecting as the owner would make every isolation test pass vacuously, so the role is
itself asserted in tests/test_tenant_isolation.py.

`seeded_database` is deliberately **not** autouse: pure-arithmetic tests such as
tests/test_money.py must run with no database at all.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.scripts.seed import main as seed_main


@pytest.fixture(scope="session")
async def seeded_database() -> None:
    """Seed two societies once per session.

    The isolation tests need a second tenant to prove nothing leaks across, and a
    person who belongs to both to prove scoping follows the relationship rather than
    the person.
    """
    await seed_main()


@pytest.fixture
async def client(seeded_database: None) -> AsyncIterator[AsyncClient]:
    from app.main import app

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as async_client:
        yield async_client
