"""Society, tower, unit and occupancy models.

The occupancy model is the part competitors get wrong — see design/DATA_MODEL.md §1.
Billing liability, voting rights and app access are three separate relationships to a
unit and routinely belong to different people.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.db import Base
from app.common.models import PkMixin, TenantMixin, TimestampMixin


class SocietyStatus(enum.StrEnum):
    onboarding = "onboarding"
    active = "active"
    suspended = "suspended"


class PlanTier(enum.StrEnum):
    basic = "basic"
    pro = "pro"
    enterprise = "enterprise"


class UnitStatus(enum.StrEnum):
    occupied = "occupied"
    vacant = "vacant"
    under_renovation = "under_renovation"


class Relationship(enum.StrEnum):
    owner = "owner"
    tenant = "tenant"
    family_member = "family_member"
    occupant = "occupant"


class Society(PkMixin, TimestampMixin, Base):
    """A tenant. Not itself tenant-scoped — this table defines the tenants."""

    __tablename__ = "societies"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    # Drives the statutory rule-pack: billing heads and AGM rules differ by state.
    state_code: Mapped[str] = mapped_column(String(2), nullable=False)
    plan_tier: Mapped[PlanTier] = mapped_column(
        Enum(PlanTier, name="plan_tier"), nullable=False, default=PlanTier.basic
    )
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Kolkata")
    status: Mapped[SocietyStatus] = mapped_column(
        Enum(SocietyStatus, name="society_status"), nullable=False, default=SocietyStatus.onboarding
    )


class Tower(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "towers"
    __table_args__ = (UniqueConstraint("society_id", "name", name="uq_tower_society_name"),)

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    floors: Mapped[int | None] = mapped_column(Integer)


class Unit(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "units"
    __table_args__ = (
        UniqueConstraint("society_id", "tower_id", "number", name="uq_unit_society_tower_number"),
        Index("ix_units_society_status", "society_id", "status"),
    )

    tower_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("towers.id", ondelete="RESTRICT"), nullable=False
    )
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    floor: Mapped[int | None] = mapped_column(Integer)
    carpet_area_sqft: Mapped[float | None] = mapped_column(Numeric(10, 2))
    bhk: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[UnitStatus] = mapped_column(
        Enum(UnitStatus, name="unit_status"), nullable=False, default=UnitStatus.vacant
    )


class UnitOccupancy(PkMixin, TenantMixin, TimestampMixin, Base):
    """Who is connected to a unit, over time — bitemporal.

    `valid_from`/`valid_to` are business time: when the person actually occupied the
    unit. `recorded_at` is system time: when we learned it. When a resident says six
    weeks later "I actually moved out on the 3rd", we insert a corrected row and stamp
    `superseded_at` on the old one. Bills regenerate correctly from business time while
    the audit trail keeps what we believed and when.
    """

    __tablename__ = "unit_occupancies"
    __table_args__ = (
        CheckConstraint(
            "valid_to IS NULL OR valid_to >= valid_from", name="ck_occupancy_valid_range"
        ),
        Index(
            "ix_occupancy_current",
            "society_id",
            "unit_id",
            postgresql_where="valid_to IS NULL AND superseded_at IS NULL",
        ),
        Index("ix_occupancy_person", "society_id", "person_id"),
    )

    unit_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False
    )
    relationship: Mapped[Relationship] = mapped_column(
        Enum(Relationship, name="occupancy_relationship"), nullable=False
    )

    # Three distinct rights. The owner may vote while the tenant pays, and both need access.
    is_billing_liable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_voting_right: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_app_access: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    valid_from: Mapped[dt.date] = mapped_column(Date, nullable=False)
    valid_to: Mapped[dt.date | None] = mapped_column(Date)
    superseded_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
