"""Gate: signing keys, visitor passes, gate events, approvals.

See design/ARCHITECTURE.md §4–5.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.db import Base
from app.common.models import PkMixin, TenantMixin, TimestampMixin


class VisitorCategory(enum.StrEnum):
    guest = "guest"
    delivery = "delivery"
    cab = "cab"
    courier = "courier"
    service = "service"
    staff = "staff"


class PassStatus(enum.StrEnum):
    active = "active"
    used = "used"
    expired = "expired"
    revoked = "revoked"


class Direction(enum.StrEnum):
    entry = "entry"
    exit = "exit"


class ApprovalState(enum.StrEnum):
    pending = "pending"
    approved = "approved"
    denied = "denied"
    auto_approved = "auto_approved"
    timed_out = "timed_out"
    escalated = "escalated"


class Rung(enum.StrEnum):
    """Steps of the approval ladder, in order."""

    push = "push"
    ivr = "ivr"
    sms = "sms"
    standing_rule = "standing_rule"
    mc_escalation = "mc_escalation"


class StandingAction(enum.StrEnum):
    auto_approve = "auto_approve"
    ask_to_wait = "ask_to_wait"
    deny = "deny"


class SosType(enum.StrEnum):
    medical = "medical"
    fire = "fire"
    gas = "gas"
    security = "security"


class SocietySigningKey(PkMixin, TenantMixin, TimestampMixin, Base):
    """Ed25519 keypair used to sign offline-verifiable passes.

    Only the *reference* to the private key is stored — the key itself lives in Google
    Secret Manager. The public key is distributed to guard devices, which cache the
    last few versions so a pass signed just before a rotation still verifies.
    """

    __tablename__ = "society_signing_keys"
    __table_args__ = (
        UniqueConstraint("society_id", "key_version", name="uq_signing_key_version"),
        Index("ix_signing_key_active", "society_id", "valid_to"),
    )

    key_version: Mapped[int] = mapped_column(Integer, nullable=False)
    public_key: Mapped[str] = mapped_column(String(120), nullable=False)
    private_key_ref: Mapped[str] = mapped_column(String(300), nullable=False)
    valid_from: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    valid_to: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class Gate(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "gates"
    __table_args__ = (UniqueConstraint("society_id", "name", name="uq_gate_society_name"),)

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class VisitorPass(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "visitor_passes"
    __table_args__ = (
        Index("ix_pass_unit", "society_id", "unit_id"),
        Index("ix_pass_active", "society_id", "status", "valid_to"),
    )

    unit_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False
    )

    visitor_name: Mapped[str] = mapped_column(String(120), nullable=False)
    visitor_phone: Mapped[str | None] = mapped_column(String(16))
    #: Salted, non-reversible. This is what goes in the QR — the QR is photographed and
    #: forwarded, so it must not disclose who is visiting whom.
    visitor_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    visitor_salt: Mapped[str] = mapped_column(String(32), nullable=False)

    category: Mapped[VisitorCategory] = mapped_column(
        Enum(VisitorCategory, name="visitor_category"), nullable=False
    )
    vehicle_number: Mapped[str | None] = mapped_column(String(20))

    valid_from: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    valid_to: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    max_uses: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    uses: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    key_version: Mapped[int] = mapped_column(Integer, nullable=False)
    qr_value: Mapped[str] = mapped_column(Text, nullable=False)

    status: Mapped[PassStatus] = mapped_column(
        Enum(PassStatus, name="pass_status"), nullable=False, default=PassStatus.active
    )
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class GateEvent(PkMixin, TenantMixin, TimestampMixin, Base):
    """An entry or exit. Append-only and conflict-free by construction.

    The id is a client-generated UUIDv7 so the guard app can create events offline and
    replay them idempotently — the primary key is the deduplication key. Replaying the
    same payload any number of times produces exactly one row.
    """

    __tablename__ = "gate_events"
    __table_args__ = (
        Index("ix_gate_event_unit", "society_id", "unit_id", "server_ts"),
        Index("ix_gate_event_recent", "society_id", "server_ts"),
        Index("ix_gate_event_open", "society_id", "direction", "server_ts"),
    )

    gate_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    unit_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    pass_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    guard_person_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    direction: Mapped[Direction] = mapped_column(
        Enum(Direction, name="gate_direction"), nullable=False
    )
    category: Mapped[VisitorCategory] = mapped_column(
        Enum(VisitorCategory, name="visitor_category", create_type=False), nullable=False
    )

    visitor_name: Mapped[str | None] = mapped_column(String(120))
    visitor_phone: Mapped[str | None] = mapped_column(String(16))
    vehicle_number: Mapped[str | None] = mapped_column(String(20))
    photo_key: Mapped[str | None] = mapped_column(String(500))

    #: True when the guard app verified the pass signature with no network.
    verified_offline: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    #: Guard device clocks are routinely wrong by hours. Both are stored; all business
    #: logic uses server_ts, and the audit trail shows the drift.
    device_ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    server_ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    clock_drift_seconds: Mapped[int | None] = mapped_column(Integer)

    #: Set when the guard app queued this offline and synced it later.
    synced_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    approval_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    exit_of_event_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    overstay_alerted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class Approval(PkMixin, TenantMixin, TimestampMixin, Base):
    """A resident decision on an ad-hoc visitor, driven by the approval ladder."""

    __tablename__ = "approvals"
    __table_args__ = (
        Index("ix_approval_pending", "society_id", "state", "requested_at"),
        Index("ix_approval_unit", "society_id", "unit_id"),
    )

    unit_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    gate_event_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    state: Mapped[ApprovalState] = mapped_column(
        Enum(ApprovalState, name="approval_state"), nullable=False, default=ApprovalState.pending
    )
    requested_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    resolution_rung: Mapped[Rung | None] = mapped_column(Enum(Rung, name="approval_rung"))

    visitor_name: Mapped[str | None] = mapped_column(String(120))
    visitor_phone: Mapped[str | None] = mapped_column(String(16))
    category: Mapped[VisitorCategory] = mapped_column(
        Enum(VisitorCategory, name="visitor_category", create_type=False), nullable=False
    )
    photo_key: Mapped[str | None] = mapped_column(String(500))
    standing_rule_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))


class ApprovalRung(PkMixin, TenantMixin, TimestampMixin, Base):
    """One row per ladder step actually fired.

    This is what lets a resident check "I never got the notification" — every rung,
    its time and its channel result are recorded and shown back to them.
    """

    __tablename__ = "approval_rungs"
    __table_args__ = (Index("ix_rung_approval", "society_id", "approval_id"),)

    approval_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("approvals.id", ondelete="CASCADE"), nullable=False
    )
    rung: Mapped[Rung] = mapped_column(Enum(Rung, name="approval_rung", create_type=False),
                                       nullable=False)
    fired_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    channel_result: Mapped[str | None] = mapped_column(String(200))


class StandingRule(PkMixin, TenantMixin, TimestampMixin, Base):
    """Per-unit default, applied when the resident does not answer.

    "Always let Amazon in", "never let salespeople in". Applied at the 45-second rung,
    which is what turns an unanswered call from a stuck visitor into a decision.
    """

    __tablename__ = "standing_rules"
    __table_args__ = (Index("ix_standing_rule_unit", "society_id", "unit_id"),)

    unit_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    category: Mapped[VisitorCategory | None] = mapped_column(
        Enum(VisitorCategory, name="visitor_category", create_type=False)
    )
    matcher: Mapped[str | None] = mapped_column(String(120))
    action: Mapped[StandingAction] = mapped_column(
        Enum(StandingAction, name="standing_action"), nullable=False
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class SosAlert(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "sos_alerts"
    __table_args__ = (Index("ix_sos_open", "society_id", "closed_at"),)

    person_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    unit_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    type: Mapped[SosType] = mapped_column(Enum(SosType, name="sos_type"), nullable=False)
    latitude: Mapped[str | None] = mapped_column(String(24))
    longitude: Mapped[str | None] = mapped_column(String(24))
    raised_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    acknowledged_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    acknowledged_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)


class Watchlist(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "watchlist"
    __table_args__ = (
        UniqueConstraint("society_id", "phone", name="uq_watchlist_society_phone"),
    )

    phone: Mapped[str] = mapped_column(String(16), nullable=False)
    name: Mapped[str | None] = mapped_column(String(120))
    reason: Mapped[str] = mapped_column(String(300), nullable=False)
    added_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
