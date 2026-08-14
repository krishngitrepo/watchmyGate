"""Identity, sessions and roles.

`persons` is deliberately **not** tenant-scoped: one human can be a resident in society
A and a committee member in society B. Tenant scoping lives on the relationship
(`role_assignments`, `unit_occupancies`), never on the person.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.db import Base
from app.common.models import PkMixin, TenantMixin, TimestampMixin


class PersonStatus(enum.StrEnum):
    active = "active"
    deactivated = "deactivated"


class RoleCode(enum.StrEnum):
    super_admin = "super_admin"
    society_admin = "society_admin"
    mc_member = "mc_member"
    accountant = "accountant"
    auditor = "auditor"
    guard = "guard"
    resident = "resident"
    staff = "staff"


class ScopeType(enum.StrEnum):
    society = "society"
    tower = "tower"
    unit = "unit"


#: Roles that must complete TOTP two-factor before privileged actions.
ROLES_REQUIRING_2FA: frozenset[RoleCode] = frozenset(
    {RoleCode.super_admin, RoleCode.society_admin, RoleCode.accountant, RoleCode.auditor}
)


class Person(PkMixin, TimestampMixin, Base):
    __tablename__ = "persons"

    #: E.164, the login identity. Unique platform-wide.
    phone: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    name: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(320))
    status: Mapped[PersonStatus] = mapped_column(
        Enum(PersonStatus, name="person_status"), nullable=False, default=PersonStatus.active
    )
    #: Secret is stored in Secret Manager; this is the enrolment marker only.
    totp_enrolled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Role(PkMixin, Base):
    __tablename__ = "roles"

    code: Mapped[RoleCode] = mapped_column(
        Enum(RoleCode, name="role_code"), nullable=False, unique=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)


class RoleAssignment(PkMixin, TenantMixin, TimestampMixin, Base):
    """A person's role within one society, optionally narrowed to a tower or unit."""

    __tablename__ = "role_assignments"
    __table_args__ = (
        Index("ix_role_assignment_person", "person_id", "society_id"),
        Index(
            "ix_role_assignment_active",
            "society_id",
            "person_id",
            postgresql_where="valid_to IS NULL",
        ),
    )

    person_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("persons.id", ondelete="CASCADE"), nullable=False
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False
    )
    scope_type: Mapped[ScopeType] = mapped_column(
        Enum(ScopeType, name="role_scope_type"), nullable=False, default=ScopeType.society
    )
    scope_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    valid_from: Mapped[dt.date] = mapped_column(Date, nullable=False)
    valid_to: Mapped[dt.date | None] = mapped_column(Date)


class OtpChallenge(PkMixin, TimestampMixin, Base):
    """A pending phone-OTP login.

    The code itself is never stored — only an Argon2 hash — so a database disclosure
    does not hand over live login codes. Attempts are counted and the row is consumed
    on success.
    """

    __tablename__ = "otp_challenges"
    __table_args__ = (Index("ix_otp_phone_active", "phone", "expires_at"),)

    phone: Mapped[str] = mapped_column(String(16), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    consumed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    request_ip: Mapped[str | None] = mapped_column(INET)


class Session(PkMixin, TimestampMixin, Base):
    """A refresh-token session.

    Refresh tokens rotate on every use. `rotated_to` lets us detect reuse of a token
    that has already been exchanged, which indicates theft — the whole session family
    is then revoked.

    Guard sessions are bound to `device_id`: guard devices are society property and an
    admin must be able to revoke a specific handset.
    """

    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("refresh_token_hash", name="uq_session_refresh_hash"),
        Index("ix_session_person_active", "person_id", postgresql_where="revoked_at IS NULL"),
    )

    person_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("persons.id", ondelete="CASCADE"), nullable=False
    )
    refresh_token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    device_id: Mapped[str | None] = mapped_column(String(128))
    device_label: Mapped[str | None] = mapped_column(String(128))
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    rotated_to: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    last_used_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(INET)
