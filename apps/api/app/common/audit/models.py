"""Immutable audit log.

Required by DPDP and by any auditor looking at society books. The application role has
INSERT only — UPDATE and DELETE are revoked in the migration — so a compromised
application cannot rewrite history.

Partitioned monthly on `created_at`; see the migration for partition management.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import DateTime, Index, String, func
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.db import Base


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_society_created", "society_id", "created_at"),
        Index("ix_audit_entity", "entity_type", "entity_id"),
        Index("ix_audit_actor", "actor_person_id", "created_at"),
        {"postgresql_partition_by": "RANGE (created_at)"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), default=uuid.uuid4, primary_key=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, primary_key=True
    )

    #: Null for platform-level actions that belong to no single society.
    society_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    actor_person_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    action: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    #: Required for sensitive reads — credential access, CCTV, attachment downloads.
    reason: Mapped[str | None] = mapped_column(String(500))

    ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(400))
