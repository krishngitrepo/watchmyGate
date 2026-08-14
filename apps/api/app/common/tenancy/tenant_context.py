"""Tenant scoping — the single entry point for all database access.

Why this exists
---------------
Isolation between societies is enforced by Postgres Row-Level Security, not by
application code remembering to add `WHERE society_id = ...`. Each policy compares
against `current_setting('app.society_id')`, so that setting must be present on the
connection running the query.

Neon pools connections in PgBouncer **transaction mode**, which means session state
does not survive between queries — a plain `SET` would leak into, or be lost by, an
unrelated request. `set_config(..., is_local => true)` is transaction-scoped, so it is
correct under transaction pooling, but only inside an explicit transaction.

Hence the rule: every query runs inside this context manager. Ruff bans importing the
engine or session factory anywhere else.

Failure mode by design
----------------------
`current_setting('app.society_id', true)` returns NULL when unset, and the policy
comparison then yields false, so an unscoped query returns **zero rows** rather than
every society's data. It fails closed.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.db import session_factory

log = structlog.get_logger(__name__)

_SET_TENANT = text("SELECT set_config('app.society_id', :society_id, true)")
_SET_ACTOR = text("SELECT set_config('app.actor_id', :actor_id, true)")


@asynccontextmanager
async def tenant_context(
    society_id: uuid.UUID,
    *,
    actor_id: uuid.UUID | None = None,
) -> AsyncIterator[AsyncSession]:
    """Open a transaction scoped to one society.

    Commits on clean exit, rolls back on any exception.

    Args:
        society_id: tenant whose rows this transaction may see.
        actor_id: person performing the action, recorded for the audit log trigger.

    Usage:
        async with tenant_context(society_id, actor_id=person_id) as session:
            result = await session.execute(select(Unit))
    """
    async with session_factory() as session, session.begin():
        await session.execute(_SET_TENANT, {"society_id": str(society_id)})
        if actor_id is not None:
            await session.execute(_SET_ACTOR, {"actor_id": str(actor_id)})
        yield session


@asynccontextmanager
async def unscoped_context(*, reason: str) -> AsyncIterator[AsyncSession]:
    """Open a transaction with **no** tenant scope.

    Only legitimate for genuinely cross-tenant work: platform login before a society
    is chosen, super-admin portfolio reads, and scheduled jobs that sweep every tenant.

    This does *not* grant a bypass. The application role is created NOBYPASSRLS, so
    tenant-scoped tables still return zero rows here — this context is for tables that
    carry no `society_id` at all, such as `persons` and `sessions`.

    Every use is logged with its reason so the audit surface stays reviewable.
    """
    log.info("unscoped_db_access", reason=reason)
    async with session_factory() as session, session.begin():
        yield session


@asynccontextmanager
async def system_context(
    society_id: uuid.UUID,
    *,
    reason: str,
    actor_id: uuid.UUID | None = None,
) -> AsyncIterator[AsyncSession]:
    """Tenant-scoped access performed by the platform rather than a logged-in user.

    Used by workers: billing runs, SLA sweeps, approval-ladder timers. Identical
    scoping to `tenant_context`, but logged distinctly so background writes are
    distinguishable from user actions during an incident.
    """
    log.info("system_db_access", society_id=str(society_id), reason=reason)
    async with tenant_context(society_id, actor_id=actor_id) as session:
        yield session
