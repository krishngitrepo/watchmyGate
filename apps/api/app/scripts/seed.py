"""Seed two societies with overlapping data.

Two societies is deliberate, not decorative: the cross-tenant isolation tests need a
second tenant whose rows must never be visible from the first. One of the residents
deliberately belongs to **both** societies, which is the realistic case that breaks
naive tenancy code.

    uv run python -m app.scripts.seed
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from decimal import Decimal

import structlog
from sqlalchemy import select

from app.common.tenancy import tenant_context, unscoped_context
from app.modules.auth.models import Person, Role, RoleAssignment, RoleCode, ScopeType
from app.modules.society.models import (
    PlanTier,
    Relationship,
    Society,
    SocietyStatus,
    Tower,
    Unit,
    UnitOccupancy,
    UnitStatus,
)

log = structlog.get_logger(__name__)

SOCIETY_A = uuid.UUID("11111111-1111-1111-1111-111111111111")
SOCIETY_B = uuid.UUID("22222222-2222-2222-2222-222222222222")

# Belongs to both societies — owner in A, tenant in B.
SHARED_PERSON = uuid.UUID("33333333-3333-3333-3333-333333333333")


async def _seed_society(
    society_id: uuid.UUID,
    name: str,
    slug: str,
    state_code: str,
    tower_names: list[str],
    units_per_tower: int,
) -> None:
    async with unscoped_context(reason="seed_society") as session:
        existing = await session.get(Society, society_id)
        if existing is None:
            session.add(
                Society(
                    id=society_id,
                    name=name,
                    slug=slug,
                    state_code=state_code,
                    plan_tier=PlanTier.pro,
                    status=SocietyStatus.active,
                )
            )

    async with tenant_context(society_id) as session:
        # Idempotent: the seed runs on every test session and on every developer's
        # `uv run python -m app.scripts.seed`, so re-running must be a no-op.
        already = await session.scalar(select(Tower).limit(1))
        if already is not None:
            log.info("seed_skipped", society=name, detail="already seeded")
            return

        for tower_name in tower_names:
            tower_id = uuid.uuid4()
            session.add(
                Tower(id=tower_id, society_id=society_id, name=tower_name, floors=units_per_tower)
            )
            for floor in range(1, units_per_tower + 1):
                session.add(
                    Unit(
                        id=uuid.uuid4(),
                        society_id=society_id,
                        tower_id=tower_id,
                        number=f"{tower_name}-{floor:02d}1",
                        floor=floor,
                        carpet_area_sqft=Decimal("1150.00"),
                        bhk=2,
                        status=UnitStatus.occupied,
                    )
                )

    log.info("seeded_society", society=name, towers=len(tower_names))


async def _seed_people() -> None:
    async with unscoped_context(reason="seed_people") as session:
        if await session.get(Person, SHARED_PERSON) is None:
            session.add(
                Person(
                    id=SHARED_PERSON,
                    phone="+919900000001",
                    name="Shared Resident",
                    email="shared@example.com",
                )
            )
        for i, (name, phone) in enumerate(
            [("Asha Rao", "+919900000002"), ("Vikram Nair", "+919900000003")], start=1
        ):
            pid = uuid.UUID(f"4444444{i}-4444-4444-4444-444444444444")
            if await session.get(Person, pid) is None:
                session.add(Person(id=pid, phone=phone, name=name))


async def _assign(society_id: uuid.UUID, person_id: uuid.UUID, role: RoleCode) -> None:
    async with unscoped_context(reason="seed_role_lookup") as session:
        role_row = await session.scalar(select(Role).where(Role.code == role))
        if role_row is None:
            raise RuntimeError(f"Role {role} missing — run migrations first.")
        role_id = role_row.id

    async with tenant_context(society_id) as session:
        existing = await session.scalar(
            select(RoleAssignment).where(
                RoleAssignment.person_id == person_id,
                RoleAssignment.role_id == role_id,
                RoleAssignment.valid_to.is_(None),
            )
        )
        if existing is not None:
            return

        session.add(
            RoleAssignment(
                id=uuid.uuid4(),
                society_id=society_id,
                person_id=person_id,
                role_id=role_id,
                scope_type=ScopeType.society,
                valid_from=dt.date.today(),
            )
        )


async def _occupy(society_id: uuid.UUID, person_id: uuid.UUID, relationship: Relationship) -> None:
    async with tenant_context(society_id) as session:
        unit = await session.scalar(select(Unit).limit(1))
        if unit is None:
            return

        existing = await session.scalar(
            select(UnitOccupancy).where(
                UnitOccupancy.person_id == person_id,
                UnitOccupancy.valid_to.is_(None),
            )
        )
        if existing is not None:
            return

        session.add(
            UnitOccupancy(
                id=uuid.uuid4(),
                society_id=society_id,
                unit_id=unit.id,
                person_id=person_id,
                relationship=relationship,
                is_billing_liable=relationship is Relationship.owner,
                has_voting_right=relationship is Relationship.owner,
                has_app_access=True,
                valid_from=dt.date.today() - dt.timedelta(days=365),
            )
        )


async def main() -> None:
    await _seed_society(
        SOCIETY_A, "Prestige Lakeside Habitat", "prestige-lakeside", "KA", ["A", "B"], 4
    )
    await _seed_society(SOCIETY_B, "Sobha Dream Acres", "sobha-dream-acres", "KA", ["C"], 3)
    await _seed_people()

    # The shared person: owner in A, tenant in B. Any tenancy bug shows up here first.
    await _assign(SOCIETY_A, SHARED_PERSON, RoleCode.resident)
    await _assign(SOCIETY_B, SHARED_PERSON, RoleCode.resident)
    await _occupy(SOCIETY_A, SHARED_PERSON, Relationship.owner)
    await _occupy(SOCIETY_B, SHARED_PERSON, Relationship.tenant)

    await _assign(
        SOCIETY_A, uuid.UUID("44444441-4444-4444-4444-444444444444"), RoleCode.society_admin
    )
    await _assign(SOCIETY_B, uuid.UUID("44444442-4444-4444-4444-444444444444"), RoleCode.guard)

    log.info("seed_complete", society_a=str(SOCIETY_A), society_b=str(SOCIETY_B))


if __name__ == "__main__":
    asyncio.run(main())
