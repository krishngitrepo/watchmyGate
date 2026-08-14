"""Helpdesk — resident complaints.

The worked example this module is built around: a resident reports *"Light is not
working in the lift"* under Common Area → Lift → Lighting, attaches two photos, the
ticket routes to the mapped vendor with the committee watching, an SLA timer starts,
it escalates if nobody fixes it, resolution requires a proof-of-fix photo, and the
resident can rate it or reopen it within 7 days.

See design/DATA_MODEL.md §3.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    CheckConstraint,
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

#: A resident may reopen a resolved ticket within this window. After it, closing is
#: final and a new ticket must be raised — otherwise tickets never age out and SLA
#: reporting becomes meaningless.
REOPEN_WINDOW = dt.timedelta(days=7)

MAX_ATTACHMENTS_PER_TICKET = 5


class TicketStatus(enum.StrEnum):
    open = "open"
    in_progress = "in_progress"
    resolved = "resolved"
    closed = "closed"
    reopened = "reopened"


class TicketPriority(enum.StrEnum):
    low = "low"
    normal = "normal"
    high = "high"
    urgent = "urgent"


class LocationType(enum.StrEnum):
    """Where the problem is.

    A lift in Tower B routes differently from a leaking tap inside flat B-402, and
    common-area issues are visible society-wide so three residents do not file three
    tickets for the same dark lift.
    """

    unit = "unit"
    tower = "tower"
    floor = "floor"
    amenity = "amenity"
    common = "common"


class TicketEventType(enum.StrEnum):
    comment = "comment"
    status_change = "status_change"
    assignment = "assignment"
    internal_note = "internal_note"
    attachment = "attachment"
    rating = "rating"
    reopen = "reopen"
    escalation = "escalation"


class Visibility(enum.StrEnum):
    public = "public"
    staff_only = "staff_only"


class AttachmentKind(enum.StrEnum):
    photo = "photo"
    video = "video"
    voice = "voice"
    document = "document"


class TicketCategory(PkMixin, TenantMixin, TimestampMixin, Base):
    """Per-society category tree. Carries the routing target and the SLA."""

    __tablename__ = "ticket_categories"
    __table_args__ = (
        UniqueConstraint("society_id", "parent_id", "name", name="uq_category_society_parent_name"),
        Index("ix_category_society", "society_id"),
    )

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("ticket_categories.id", ondelete="RESTRICT")
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)

    #: Auto-routing target. Either may be set; assignee wins if both are.
    default_assignee_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    default_vendor_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    sla_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=24)
    escalation_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=48)
    is_active: Mapped[bool] = mapped_column(nullable=False, default=True)


class Ticket(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "tickets"
    __table_args__ = (
        UniqueConstraint("society_id", "ticket_number", name="uq_ticket_society_number"),
        # Drives the SLA sweep: open work past its due time, cheapest possible scan.
        Index(
            "ix_ticket_sla_due",
            "society_id",
            "sla_due_at",
            postgresql_where="status IN ('open', 'in_progress', 'reopened')",
        ),
        Index("ix_ticket_society_status", "society_id", "status"),
        Index("ix_ticket_raised_by", "society_id", "raised_by"),
        Index("ix_ticket_unit", "society_id", "unit_id"),
        CheckConstraint("rating IS NULL OR (rating >= 1 AND rating <= 5)", name="ck_ticket_rating"),
    )

    ticket_number: Mapped[str] = mapped_column(String(24), nullable=False)
    raised_by: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False
    )

    #: Null for common-area issues — the lift belongs to the tower, not to a flat.
    unit_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT")
    )
    location_type: Mapped[LocationType] = mapped_column(
        Enum(LocationType, name="ticket_location_type"), nullable=False
    )
    location_ref: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    location_note: Mapped[str | None] = mapped_column(String(200))

    category_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("ticket_categories.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)

    #: Set when the complaint was filed by voice and transcribed, so the original
    #: language is preserved for elderly and low-literacy residents.
    voice_transcript_language: Mapped[str | None] = mapped_column(String(8))

    status: Mapped[TicketStatus] = mapped_column(
        Enum(TicketStatus, name="ticket_status"), nullable=False, default=TicketStatus.open
    )
    priority: Mapped[TicketPriority] = mapped_column(
        Enum(TicketPriority, name="ticket_priority"), nullable=False, default=TicketPriority.normal
    )

    assignee_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    sla_due_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    escalation_due_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    escalated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    closed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    rating: Mapped[int | None] = mapped_column(Integer)
    rating_comment: Mapped[str | None] = mapped_column(String(500))

    #: Set when merged into an earlier report of the same problem. All reporters stay
    #: subscribed to the surviving ticket.
    duplicate_of: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("tickets.id", ondelete="RESTRICT")
    )

    reopen_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class TicketEvent(PkMixin, TenantMixin, TimestampMixin, Base):
    """Append-only thread: comments, status changes, internal notes, attachments."""

    __tablename__ = "ticket_events"
    __table_args__ = (
        Index("ix_ticket_event_ticket", "society_id", "ticket_id", "created_at"),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    type: Mapped[TicketEventType] = mapped_column(
        Enum(TicketEventType, name="ticket_event_type"), nullable=False
    )
    body: Mapped[str | None] = mapped_column(Text)

    #: staff_only notes are never returned to the resident who raised the ticket.
    visibility: Mapped[Visibility] = mapped_column(
        Enum(Visibility, name="ticket_event_visibility"),
        nullable=False,
        default=Visibility.public,
    )


class TicketSubscriber(PkMixin, TenantMixin, TimestampMixin, Base):
    """Everyone notified about a ticket.

    Populated with the reporter, the assignee and the committee watcher — and with
    every reporter of a merged duplicate, so three residents who reported the same
    dark lift all hear that it is fixed.
    """

    __tablename__ = "ticket_subscribers"
    __table_args__ = (
        UniqueConstraint("ticket_id", "person_id", name="uq_ticket_subscriber"),
        Index("ix_ticket_subscriber", "society_id", "ticket_id"),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("persons.id", ondelete="CASCADE"), nullable=False
    )
    reason: Mapped[str] = mapped_column(String(40), nullable=False, default="reporter")


class Attachment(PkMixin, TenantMixin, TimestampMixin, Base):
    """A file in R2. The row records the key; the bytes never pass through the API."""

    __tablename__ = "attachments"
    __table_args__ = (
        Index("ix_attachment_owner", "society_id", "owner_type", "owner_id"),
        UniqueConstraint("r2_key", name="uq_attachment_key"),
    )

    owner_type: Mapped[str] = mapped_column(String(32), nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    r2_key: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[AttachmentKind] = mapped_column(
        Enum(AttachmentKind, name="attachment_kind"), nullable=False
    )
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    #: Proof-of-fix photos are distinguished from the resident's original evidence, so
    #: "show me it was actually repaired" is a query rather than a guess.
    is_proof_of_fix: Mapped[bool] = mapped_column(nullable=False, default=False)
