"""Helpdesk endpoints.

Upload flow for the two lift photos:

    1. POST /v1/tickets                          → ticket + ticket_number
    2. POST /v1/tickets/{id}/attachments/presign → { object_key, upload_url }  (x2)
    3. PUT  <upload_url>                         → phone sends bytes straight to R2
    4. POST /v1/tickets/{id}/attachments         → confirm each object_key

Bytes never pass through this API, which is what makes photo attachments affordable.
"""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.common import storage
from app.common.errors import NotFoundError
from app.modules.auth.deps import CurrentUser, TenantSession
from app.modules.auth.models import RoleCode
from app.modules.helpdesk import service
from app.modules.helpdesk.models import (
    Attachment,
    LocationType,
    Ticket,
    TicketCategory,
    TicketPriority,
    TicketStatus,
    Visibility,
)

router = APIRouter(prefix="/v1/tickets", tags=["helpdesk"])

STAFF_ROLES = {
    RoleCode.society_admin.value,
    RoleCode.mc_member.value,
    RoleCode.staff.value,
    RoleCode.accountant.value,
}


def _is_staff(user: CurrentUser) -> bool:
    return bool(set(user.roles) & STAFF_ROLES)


# --------------------------------------------------------------------- schemas


class CreateTicket(BaseModel):
    """*"Light is not working in lift"* → category Lift/Lighting, location tower B."""

    category_id: uuid.UUID
    title: str = Field(min_length=3, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    location_type: LocationType
    unit_id: uuid.UUID | None = None
    location_ref: uuid.UUID | None = None
    location_note: str | None = Field(default=None, max_length=200)
    priority: TicketPriority = TicketPriority.normal
    voice_transcript_language: str | None = Field(default=None, max_length=8)


class TicketOut(BaseModel):
    id: uuid.UUID
    ticket_number: str
    title: str
    description: str | None
    status: TicketStatus
    priority: TicketPriority
    location_type: LocationType
    unit_id: uuid.UUID | None
    category_id: uuid.UUID
    sla_due_at: dt.datetime
    escalation_due_at: dt.datetime
    escalated_at: dt.datetime | None
    resolved_at: dt.datetime | None
    rating: int | None
    reopen_count: int
    duplicate_of: uuid.UUID | None
    created_at: dt.datetime

    model_config = {"from_attributes": True}


class PresignRequest(BaseModel):
    content_type: str = Field(max_length=120)
    content_length: int = Field(gt=0)
    is_proof_of_fix: bool = False


class PresignResponse(BaseModel):
    object_key: str
    upload_url: str
    expires_in_seconds: int


class ConfirmAttachment(BaseModel):
    object_key: str = Field(max_length=500)
    content_type: str = Field(max_length=120)
    content_length: int = Field(gt=0)
    is_proof_of_fix: bool = False


class AttachmentOut(BaseModel):
    id: uuid.UUID
    kind: str
    content_type: str
    bytes: int
    is_proof_of_fix: bool
    download_url: str


class EventOut(BaseModel):
    id: uuid.UUID
    type: str
    body: str | None
    visibility: Visibility
    actor_id: uuid.UUID | None
    created_at: dt.datetime


class StatusChange(BaseModel):
    status: TicketStatus
    note: str | None = Field(default=None, max_length=1000)


class Comment(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    internal: bool = False


class Reopen(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


class Rating(BaseModel):
    stars: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=500)


class CategoryOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    sla_hours: int

    model_config = {"from_attributes": True}


# -------------------------------------------------------------------- endpoints


@router.get("/categories", response_model=list[CategoryOut])
async def list_categories(session: TenantSession) -> list[TicketCategory]:
    rows = await session.scalars(
        select(TicketCategory)
        .where(TicketCategory.is_active.is_(True))
        .order_by(TicketCategory.name)
    )
    return list(rows)


@router.post("", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
async def create_ticket(
    body: CreateTicket, session: TenantSession, user: CurrentUser
) -> Ticket:
    """Raise a complaint.

    If an open common-area complaint already covers the same problem, the existing
    ticket is returned with the caller subscribed rather than a duplicate created —
    three residents reporting one dark lift produce one ticket and three notifications.
    """
    assert user.society_id is not None  # guaranteed by TenantSession

    committee = await _committee_watchers(session, user.society_id)

    return await service.raise_complaint(
        session,
        user.society_id,
        service.RaiseComplaint(
            raised_by=user.person_id,
            category_id=body.category_id,
            title=body.title,
            description=body.description,
            location_type=body.location_type,
            unit_id=body.unit_id,
            location_ref=body.location_ref,
            location_note=body.location_note,
            priority=body.priority,
            voice_transcript_language=body.voice_transcript_language,
        ),
        committee_watchers=committee,
    )


@router.get("", response_model=list[TicketOut])
async def list_tickets(
    session: TenantSession,
    user: CurrentUser,
    status_filter: TicketStatus | None = None,
    mine_only: bool = False,
) -> list[Ticket]:
    """List complaints.

    Residents see their own plus every common-area complaint — that visibility is what
    stops a fourth person reporting the same lift.
    """
    stmt = select(Ticket)

    if mine_only or not _is_staff(user):
        stmt = stmt.where(
            (Ticket.raised_by == user.person_id)
            | (Ticket.location_type != LocationType.unit)
            if not mine_only
            else (Ticket.raised_by == user.person_id)
        )

    if status_filter is not None:
        stmt = stmt.where(Ticket.status == status_filter)

    rows = await session.scalars(stmt.order_by(Ticket.created_at.desc()).limit(200))
    return list(rows)


@router.get("/{ticket_id}", response_model=TicketOut)
async def get_ticket(ticket_id: uuid.UUID, session: TenantSession) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise NotFoundError("Complaint not found.")
    return ticket


@router.get("/{ticket_id}/events", response_model=list[EventOut])
async def get_events(
    ticket_id: uuid.UUID, session: TenantSession, user: CurrentUser
) -> list[EventOut]:
    assert user.society_id is not None
    events = await service.visible_events(
        session, user.society_id, ticket_id, viewer_is_staff=_is_staff(user)
    )
    return [
        EventOut(
            id=e.id,
            type=str(e.type),
            body=e.body,
            visibility=e.visibility,
            actor_id=e.actor_id,
            created_at=e.created_at,
        )
        for e in events
    ]


@router.post("/{ticket_id}/attachments/presign", response_model=PresignResponse)
async def presign_attachment(
    ticket_id: uuid.UUID, body: PresignRequest, session: TenantSession, user: CurrentUser
) -> PresignResponse:
    assert user.society_id is not None

    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise NotFoundError("Complaint not found.")

    key, url = storage.presign_upload(
        user.society_id, "ticket", ticket.id, body.content_type, body.content_length
    )
    return PresignResponse(
        object_key=key,
        upload_url=url,
        expires_in_seconds=int(storage.UPLOAD_URL_TTL.total_seconds()),
    )


@router.post("/{ticket_id}/attachments", response_model=AttachmentOut, status_code=201)
async def confirm_attachment(
    ticket_id: uuid.UUID, body: ConfirmAttachment, session: TenantSession, user: CurrentUser
) -> AttachmentOut:
    """Record a file the client has already uploaded to R2."""
    assert user.society_id is not None

    # A key from another society must not be attachable to this ticket.
    if not storage.key_belongs_to(body.object_key, user.society_id):
        raise NotFoundError("Complaint not found.")

    kind = storage.classify(body.content_type)
    attachment = await service.attach(
        session,
        user.society_id,
        ticket_id,
        r2_key=body.object_key,
        content_type=body.content_type,
        size_bytes=body.content_length,
        kind=kind,
        uploaded_by=user.person_id,
        is_proof_of_fix=body.is_proof_of_fix,
    )
    return AttachmentOut(
        id=attachment.id,
        kind=str(attachment.kind),
        content_type=attachment.content_type,
        bytes=attachment.bytes,
        is_proof_of_fix=attachment.is_proof_of_fix,
        download_url=storage.presign_download(attachment.r2_key, user.society_id),
    )


@router.get("/{ticket_id}/attachments", response_model=list[AttachmentOut])
async def list_attachments(
    ticket_id: uuid.UUID, session: TenantSession, user: CurrentUser
) -> list[AttachmentOut]:
    assert user.society_id is not None

    rows = await session.scalars(
        select(Attachment).where(
            Attachment.owner_type == "ticket", Attachment.owner_id == ticket_id
        )
    )
    return [
        AttachmentOut(
            id=a.id,
            kind=str(a.kind),
            content_type=a.content_type,
            bytes=a.bytes,
            is_proof_of_fix=a.is_proof_of_fix,
            download_url=storage.presign_download(a.r2_key, user.society_id),
        )
        for a in rows
    ]


@router.post("/{ticket_id}/comments", status_code=status.HTTP_201_CREATED)
async def add_comment(
    ticket_id: uuid.UUID, body: Comment, session: TenantSession, user: CurrentUser
) -> dict[str, str]:
    from app.modules.helpdesk.models import TicketEvent, TicketEventType

    assert user.society_id is not None

    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise NotFoundError("Complaint not found.")

    # Only staff may write an internal note; a resident asking for one gets a normal
    # comment rather than an error, since the distinction is not theirs to make.
    internal = body.internal and _is_staff(user)

    session.add(
        TicketEvent(
            id=uuid.uuid4(),
            society_id=user.society_id,
            ticket_id=ticket.id,
            actor_id=user.person_id,
            type=TicketEventType.internal_note if internal else TicketEventType.comment,
            body=body.body,
            visibility=Visibility.staff_only if internal else Visibility.public,
        )
    )
    await service.subscribe(
        session, user.society_id, ticket.id, user.person_id, reason="commenter"
    )
    return {"status": "added"}


@router.post("/{ticket_id}/status", response_model=TicketOut)
async def set_status(
    ticket_id: uuid.UUID, body: StatusChange, session: TenantSession, user: CurrentUser
) -> Ticket:
    """Change status. Resolving requires a proof-of-fix photo."""
    assert user.society_id is not None
    return await service.change_status(
        session,
        user.society_id,
        ticket_id,
        new_status=body.status,
        actor_id=user.person_id,
        note=body.note,
    )


@router.post("/{ticket_id}/reopen", response_model=TicketOut)
async def reopen_ticket(
    ticket_id: uuid.UUID, body: Reopen, session: TenantSession, user: CurrentUser
) -> Ticket:
    assert user.society_id is not None
    return await service.reopen(
        session, user.society_id, ticket_id, actor_id=user.person_id, reason=body.reason
    )


@router.post("/{ticket_id}/rating", response_model=TicketOut)
async def rate_ticket(
    ticket_id: uuid.UUID, body: Rating, session: TenantSession, user: CurrentUser
) -> Ticket:
    assert user.society_id is not None
    return await service.rate(
        session,
        user.society_id,
        ticket_id,
        actor_id=user.person_id,
        stars=body.stars,
        comment=body.comment,
    )


async def _committee_watchers(session: TenantSession, society_id: uuid.UUID) -> list[uuid.UUID]:
    """Committee members who watch every new complaint."""
    from app.modules.auth.models import Role, RoleAssignment

    rows = await session.scalars(
        select(RoleAssignment.person_id)
        .join(Role, Role.id == RoleAssignment.role_id)
        .where(
            RoleAssignment.valid_to.is_(None),
            Role.code.in_([RoleCode.mc_member, RoleCode.society_admin]),
        )
    )
    return list(rows)
