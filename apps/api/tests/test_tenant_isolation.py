"""Cross-tenant isolation — a required build gate.

If any test in this file fails, the build must fail. A query that escapes the
`tenant_context` wrapper silently returns another society's data, which is the worst
defect this product could ship: a committee seeing a neighbouring society's finances,
or a guard seeing another society's residents.

These tests deliberately use raw sessions to probe the database the way a bug would.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.common.tenancy import tenant_context, unscoped_context
from app.scripts.seed import SOCIETY_A, SOCIETY_B

pytestmark = [pytest.mark.isolation, pytest.mark.asyncio]

#: Must match TENANT_TABLES in alembic/versions/0001_foundation.py.
TENANT_TABLES = ("towers", "units", "unit_occupancies", "role_assignments")


@pytest.fixture(autouse=True)
async def _seeded(seeded_database: None) -> None:
    """Every test in this module needs both societies present."""


async def test_every_tenant_table_has_rls_enabled() -> None:
    """RLS must be enabled *and* forced on every tenant-scoped table.

    Without FORCE, the policy does not apply to the table owner, so an admin or
    migration connection would silently see every society.
    """
    async with unscoped_context(reason="test_rls_metadata") as session:
        rows = await session.execute(
            text("""
                SELECT relname, relrowsecurity, relforcerowsecurity
                FROM pg_class
                WHERE relname = ANY(:tables) AND relkind = 'r'
            """),
            {"tables": list(TENANT_TABLES)},
        )
        state = {name: (rls, force) for name, rls, force in rows}

    missing = [t for t in TENANT_TABLES if t not in state]
    assert not missing, f"Tenant tables absent from the database: {missing}"

    not_enabled = [t for t, (rls, _) in state.items() if not rls]
    assert not not_enabled, f"RLS not enabled on: {not_enabled}"

    not_forced = [t for t, (_, force) in state.items() if not force]
    assert not not_forced, f"RLS not FORCEd on: {not_forced}"


async def test_every_tenant_table_has_a_policy() -> None:
    async with unscoped_context(reason="test_rls_policies") as session:
        rows = await session.execute(
            text("SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'")
        )
        with_policy = {r[0] for r in rows}

    missing = set(TENANT_TABLES) - with_policy
    assert not missing, f"Missing tenant_isolation policy on: {sorted(missing)}"


@pytest.mark.parametrize("table", TENANT_TABLES)
async def test_society_a_cannot_read_society_b(table: str) -> None:
    """Scoped to A, every row of B must be invisible."""
    async with tenant_context(SOCIETY_A) as session:
        count = await session.scalar(
            text(f"SELECT count(*) FROM {table} WHERE society_id = :other"),
            {"other": SOCIETY_B},
        )
    assert count == 0, f"LEAK: {table} exposed {count} rows of society B while scoped to A."


@pytest.mark.parametrize("table", TENANT_TABLES)
async def test_society_b_cannot_read_society_a(table: str) -> None:
    async with tenant_context(SOCIETY_B) as session:
        count = await session.scalar(
            text(f"SELECT count(*) FROM {table} WHERE society_id = :other"),
            {"other": SOCIETY_A},
        )
    assert count == 0, f"LEAK: {table} exposed {count} rows of society A while scoped to B."


@pytest.mark.parametrize("table", TENANT_TABLES)
async def test_unscoped_query_returns_nothing(table: str) -> None:
    """Fail closed.

    With no tenant set, `current_setting('app.society_id', true)` is NULL and the
    policy comparison is false, so the query must return zero rows — not every row.
    This is the property that turns a forgotten scope into a visible bug rather than a
    silent breach.
    """
    async with unscoped_context(reason="test_unscoped_read") as session:
        count = await session.scalar(text(f"SELECT count(*) FROM {table}"))
    assert count == 0, (
        f"FAIL-OPEN: {table} returned {count} rows with no tenant scope set. "
        "An unscoped query must return zero rows."
    )


@pytest.mark.parametrize("table", TENANT_TABLES)
async def test_cannot_write_into_another_society(table: str) -> None:
    """WITH CHECK must block relabelling a row into another society.

    Postgres raises rather than silently updating zero rows, which is the stronger
    outcome: an attempt to move data across tenants is an error, not a no-op that a
    caller might not notice.
    """
    with pytest.raises(Exception) as exc:
        async with tenant_context(SOCIETY_A) as session:
            await session.execute(
                text(f"UPDATE {table} SET society_id = :other WHERE society_id = :own"),
                {"other": SOCIETY_B, "own": SOCIETY_A},
            )

    message = str(exc.value).lower()
    assert "row-level security" in message or "violates" in message, (
        f"LEAK: {table} allowed rows to be moved from society A to B. Got: {message}"
    )


async def test_shared_person_sees_only_the_active_society() -> None:
    """The realistic case that breaks naive tenancy code.

    One person is a resident of both societies. Scoped to A they must see only their
    A membership, and scoped to B only their B membership — never both at once.
    """
    from app.scripts.seed import SHARED_PERSON

    async with tenant_context(SOCIETY_A) as session:
        a_rows = await session.scalar(
            text("SELECT count(*) FROM role_assignments WHERE person_id = :pid"),
            {"pid": SHARED_PERSON},
        )
    async with tenant_context(SOCIETY_B) as session:
        b_rows = await session.scalar(
            text("SELECT count(*) FROM role_assignments WHERE person_id = :pid"),
            {"pid": SHARED_PERSON},
        )

    assert a_rows == 1, f"Expected exactly 1 role in society A, saw {a_rows}."
    assert b_rows == 1, f"Expected exactly 1 role in society B, saw {b_rows}."


async def test_app_role_cannot_bypass_rls() -> None:
    """The application role must be NOBYPASSRLS.

    Without this, a future `GRANT` or a superuser connection string in an env file
    would quietly disable every policy above.
    """
    async with unscoped_context(reason="test_role_attributes") as session:
        row = await session.execute(
            text("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user")
        )
        bypass, is_super = row.one()

    assert not bypass, "The application role has BYPASSRLS — tenant isolation is void."
    assert not is_super, "The application role is a superuser — tenant isolation is void."


async def test_audit_log_is_append_only() -> None:
    """A compromised application must not be able to rewrite history."""
    async with unscoped_context(reason="test_audit_immutability") as session:
        await session.execute(
            text("""
                INSERT INTO audit_log (id, society_id, action, entity_type, entity_id)
                VALUES (:id, :sid, 'test.write', 'test', :eid)
            """),
            {"id": uuid.uuid4(), "sid": SOCIETY_A, "eid": uuid.uuid4()},
        )

    with pytest.raises(Exception) as exc:
        async with unscoped_context(reason="test_audit_update") as session:
            await session.execute(text("UPDATE audit_log SET action = 'tampered'"))
    assert "permission" in str(exc.value).lower() or "denied" in str(exc.value).lower()

    with pytest.raises(Exception) as exc:
        async with unscoped_context(reason="test_audit_delete") as session:
            await session.execute(text("DELETE FROM audit_log"))
    assert "permission" in str(exc.value).lower() or "denied" in str(exc.value).lower()
