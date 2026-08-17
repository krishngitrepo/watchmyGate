"""Test fixtures for the AI service.

This file previously described a world that no longer exists: it seeded two societies
against a docker-compose Postgres and imported `app.scripts.seed`. Both went when the
API moved to TypeScript and local Docker was dropped — the AI service owns no tables and
never talks to the database. It calls the TypeScript API over HTTP like any other client.

So there is nothing to seed and nothing to connect to. What is left is a settings fixture
that guarantees stub mode, because a test that accidentally picks up a real
`ANTHROPIC_API_KEY` from the environment would bill money and send a resident's bank
statement to an API during a unit-test run.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from app.common.config import Settings


@pytest.fixture
def stub_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[Settings]:
    """Settings with every external integration stubbed.

    The key is explicitly cleared rather than merely left unset. A developer with
    `ANTHROPIC_API_KEY` exported in their shell would otherwise run the whole suite
    against the live API without noticing until the bill arrived.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    yield Settings(
        environment="local",
        database_url="postgresql://unused/unused",
        jwt_secret="test-secret-at-least-16-chars",
        service_token="test-token",
    )
