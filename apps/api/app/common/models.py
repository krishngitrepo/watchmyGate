"""Shared column mixins and enum helpers for ORM models."""

from __future__ import annotations

import datetime as dt
import uuid

import uuid_utils
from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column


def uuid7() -> uuid.UUID:
    """Time-ordered UUID.

    Used for anything the client may generate offline (gate events, sync outbox
    records). Sortability keeps b-tree inserts sequential, and the embedded timestamp
    makes replayed records diagnosable.
    """
    return uuid.UUID(str(uuid_utils.uuid7()))


class PkMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class TimestampMixin:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class TenantMixin:
    """Marks a table as tenant-scoped.

    Every table carrying this mixin gets a Row-Level Security policy in the migration.
    The column is non-nullable so a row can never exist outside a society.
    """

    society_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("societies.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
