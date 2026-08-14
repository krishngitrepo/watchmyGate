"""Helpdesk business logic.

Every function here takes an already tenant-scoped `AsyncSession` from
`tenant_context`. Nothing in this module opens its own connection, so a complaint can
never be written into the wrong society.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from dataclasses import dataclass

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.errors import ConflictError, NotFoundError, ValidationError
from app.modules.helpdesk.models import (
    MAX_ATTACHMENTS_PER_TICKET,
    REOPEN_WINDOW,
    Attachment,
    LocationType,
    Ticket,
    TicketCategory,
    TicketEvent,
    TicketEventType,
    TicketPriority,
    TicketStatus,
    TicketSubscriber,
    Visibility,
)

log = structlog.get_logger(__name__)

#: Window in which a similar report on the same location is treated as the same issue.
DUPLICATE_WINDOW = dt.timedelta(hours=48)

_OPEN_STATES = (TicketStatus.open, TicketStatus.in_progress, TicketStatus.reopened)

_STOPWORDS = frozenset(
    {"the", "is", "are", "in", "on", "at", "a", "an", "of", "not", "no", "and", "to", "for", "my"}
)


@dataclass(frozen=True)
class RaiseComplaint:
    raised_by: uuid.UUID
    category_id: uuid.UUID
    title: str
    location_type: LocationType
    description: str | None = None
    unit_id: uuid.UUID | None = None
    location_ref: uuid.UUID | None = None
    location_note: str | None = None
    priority: TicketPriority = TicketPriority.normal
    voice_transcript_language: str | None = None


def _keywords(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in _STOPWORDS}


async def _next_ticket_number(session: AsyncSession, society_id: uuid.UUID) -> str:
    """Human-facing, per-society sequential number.

    Residents quote this on the phone, so it must be short and society-local rather
    than a UUID. Counted inside the caller's transaction; the unique constraint on
    (society_id, ticket_number) is what actually guarantees no collision under
    concurrency, and a retry on conflict is the correct handling.
    """
    year = dt.datetime.now(dt.UTC).year
    prefix = f"C{year}-"
    count = await session.scalar(
        select(func.count())
        .select_from(Ticket)
        .where(Ticket.society_id == society_id, Ticket.ticket_number.like(f"{prefix}%"))
    )
    return f"{prefix}{(count or 0) + 1:05d}"


async def find_duplicate(
    session: AsyncSession,
    society_id: uuid.UUID,
    draft: RaiseComplaint,
) -> Ticket | None:
    """Detect an existing open report of the same problem.

    Only common-area issues are merged. Two residents reporting "lift light is out" in
    the same tower is one fault; two residents reporting a leaking tap in their own
    flats is two faults, so unit-scoped tickets are never merged.
    """
    if draft.location_type is LocationType.unit:
        return None

    since = dt.datetime.now(dt.UTC) - DUPLICATE_WINDOW
    candidates = await session.scalars(
        select(Ticket).where(
            Ticket.society_id == society_id,
            Ticket.category_id == draft.category_id,
            Ticket.location_type == draft.location_type,
            Ticket.status.in_(_OPEN_STATES),
            Ticket.duplicate_of.is_(None),
            Ticket.created_at >= since,
            or_(
                Ticket.location_ref == draft.location_ref,
                Ticket.location_ref.is_(None) if draft.location_ref is None else False,
            ),
        )
    )

    incoming = _keywords(f"{draft.title} {draft.description or ''}")
    if not incoming:
        return None

    for candidate in candidates:
        existing = _keywords(f"{candidate.title} {candidate.description or ''}")
        if not existing:
            continue
        overlap = len(incoming & existing) / len(incoming | existing)
        if overlap >= 0.5:
            return candidate
    return None


async def raise_complaint(
    session: AsyncSession,
    society_id: uuid.UUID,
    draft: RaiseComplaint,
    *,
    committee_watchers: list[uuid.UUID] | None = None,
) -> Ticket:
    """Create a complaint, route it, start its SLA clock.

    Worked example: *"Light is not working in lift"*, category Common Area → Lift →
    Lighting, location_type=tower, location_ref=<Tower B>. Routes to the lift vendor
    mapped on that category, committee added as watchers, SLA starts immediately.
    """
    category = await session.get(TicketCategory, draft.category_id)
    if category is None or category.society_id != society_id:
        raise NotFoundError("That complaint category does not exist.")
    if not category.is_active:
        raise ValidationError("That complaint category is no longer in use.")

    if draft.location_type is LocationType.unit and draft.unit_id is None:
        raise ValidationError("Select which flat this complaint is about.")

    now = dt.datetime.now(dt.UTC)

    duplicate = await find_duplicate(session, society_id, draft)
    if duplicate is not None:
        # Do not create a second ticket. Subscribe the new reporter to the original so
        # they receive every update, and record that they also reported it.
        await subscribe(session, society_id, duplicate.id, draft.raised_by, reason="co_reporter")
        session.add(
            TicketEvent(
                id=uuid.uuid4(),
                society_id=society_id,
                ticket_id=duplicate.id,
                actor_id=draft.raised_by,
                type=TicketEventType.comment,
                body="Also reported by another resident.",
                visibility=Visibility.public,
            )
        )
        log.info("ticket_duplicate_merged", ticket_id=str(duplicate.id))
        return duplicate

    ticket = Ticket(
        id=uuid.uuid4(),
        society_id=society_id,
        ticket_number=await _next_ticket_number(session, society_id),
        raised_by=draft.raised_by,
        unit_id=draft.unit_id,
        location_type=draft.location_type,
        location_ref=draft.location_ref,
        location_note=draft.location_note,
        category_id=draft.category_id,
        title=draft.title.strip(),
        description=(draft.description or "").strip() or None,
        voice_transcript_language=draft.voice_transcript_language,
        status=TicketStatus.open,
        priority=draft.priority,
        assignee_id=category.default_assignee_id,
        vendor_id=category.default_vendor_id,
        sla_due_at=now + dt.timedelta(hours=category.sla_hours),
        escalation_due_at=now + dt.timedelta(hours=category.escalation_hours),
    )
    session.add(ticket)
    await session.flush()

    await subscribe(session, society_id, ticket.id, draft.raised_by, reason="reporter")
    if category.default_assignee_id:
        await subscribe(
            session, society_id, ticket.id, category.default_assignee_id, reason="assignee"
        )
    for watcher in committee_watchers or []:
        await subscribe(session, society_id, ticket.id, watcher, reason="committee")

    log.info(
        "ticket_raised",
        ticket_id=str(ticket.id),
        number=ticket.ticket_number,
        category=category.name,
        sla_due=ticket.sla_due_at.isoformat(),
    )
    return ticket


async def subscribe(
    session: AsyncSession,
    society_id: uuid.UUID,
    ticket_id: uuid.UUID,
    person_id: uuid.UUID,
    *,
    reason: str,
) -> None:
    existing = await session.scalar(
        select(TicketSubscriber).where(
            TicketSubscriber.ticket_id == ticket_id,
            TicketSubscriber.person_id == person_id,
        )
    )
    if existing is not None:
        return
    session.add(
        TicketSubscriber(
            id=uuid.uuid4(),
            society_id=society_id,
            ticket_id=ticket_id,
            person_id=person_id,
            reason=reason,
        )
    )


async def attach(
    session: AsyncSession,
    society_id: uuid.UUID,
    ticket_id: uuid.UUID,
    *,
    r2_key: str,
    content_type: str,
    size_bytes: int,
    kind: str,
    uploaded_by: uuid.UUID,
    is_proof_of_fix: bool = False,
) -> Attachment:
    """Record an uploaded file against a ticket.

    Called after the client has PUT the bytes straight to R2 using a presigned URL —
    the two lift photos never pass through this API.
    """
    ticket = await _get_ticket(session, society_id, ticket_id)

    count = await session.scalar(
        select(func.count())
        .select_from(Attachment)
        .where(
            Attachment.society_id == society_id,
            Attachment.owner_type == "ticket",
            Attachment.owner_id == ticket.id,
            Attachment.is_proof_of_fix == is_proof_of_fix,
        )
    )
    if (count or 0) >= MAX_ATTACHMENTS_PER_TICKET:
        raise ValidationError(
            f"A complaint can carry at most {MAX_ATTACHMENTS_PER_TICKET} attachments."
        )

    attachment = Attachment(
        id=uuid.uuid4(),
        society_id=society_id,
        owner_type="ticket",
        owner_id=ticket.id,
        r2_key=r2_key,
        content_type=content_type,
        bytes=size_bytes,
        kind=kind,  # type: ignore[arg-type]
        uploaded_by=uploaded_by,
        is_proof_of_fix=is_proof_of_fix,
    )
    session.add(attachment)
    session.add(
        TicketEvent(
            id=uuid.uuid4(),
            society_id=society_id,
            ticket_id=ticket.id,
            actor_id=uploaded_by,
            type=TicketEventType.attachment,
            body=("Proof of fix attached." if is_proof_of_fix else "Attachment added."),
            visibility=Visibility.public,
        )
    )
    return attachment


async def change_status(
    session: AsyncSession,
    society_id: uuid.UUID,
    ticket_id: uuid.UUID,
    *,
    new_status: TicketStatus,
    actor_id: uuid.UUID,
    note: str | None = None,
) -> Ticket:
    """Move a ticket through its lifecycle, enforcing the rules that matter.

    Resolution requires a proof-of-fix attachment. Without it, "resolved" means only
    that somebody clicked a button — which is precisely the complaint residents have
    about every incumbent product.
    """
    ticket = await _get_ticket(session, society_id, ticket_id)
    now = dt.datetime.now(dt.UTC)

    if ticket.status is new_status:
        return ticket

    if new_status is TicketStatus.resolved:
        proof = await session.scalar(
            select(func.count())
            .select_from(Attachment)
            .where(
                Attachment.society_id == society_id,
                Attachment.owner_type == "ticket",
                Attachment.owner_id == ticket.id,
                Attachment.is_proof_of_fix.is_(True),
            )
        )
        if not proof:
            raise ValidationError(
                "Attach a photo showing the completed repair before marking this resolved."
            )
        ticket.resolved_at = now
        ticket.resolved_by = actor_id

    if new_status is TicketStatus.closed:
        ticket.closed_at = now

    previous = ticket.status
    ticket.status = new_status

    session.add(
        TicketEvent(
            id=uuid.uuid4(),
            society_id=society_id,
            ticket_id=ticket.id,
            actor_id=actor_id,
            type=TicketEventType.status_change,
            body=note or f"Status changed from {previous} to {new_status}.",
            visibility=Visibility.public,
        )
    )
    log.info("ticket_status_changed", ticket_id=str(ticket.id), to=str(new_status))
    return ticket


async def reopen(
    session: AsyncSession,
    society_id: uuid.UUID,
    ticket_id: uuid.UUID,
    *,
    actor_id: uuid.UUID,
    reason: str,
) -> Ticket:
    """Reopen within 7 days of resolution — the lift light is out again."""
    ticket = await _get_ticket(session, society_id, ticket_id)

    if ticket.status not in (TicketStatus.resolved, TicketStatus.closed):
        raise ConflictError("Only a resolved complaint can be reopened.")
    if ticket.resolved_at is None:
        raise ConflictError("Only a resolved complaint can be reopened.")

    if dt.datetime.now(dt.UTC) - ticket.resolved_at > REOPEN_WINDOW:
        raise ConflictError(
            "This complaint was resolved more than 7 days ago. Please raise a new one."
        )

    category = await session.get(TicketCategory, ticket.category_id)
    now = dt.datetime.now(dt.UTC)

    ticket.status = TicketStatus.reopened
    ticket.resolved_at = None
    ticket.resolved_by = None
    ticket.closed_at = None
    ticket.reopen_count += 1
    # SLA restarts: a reopened complaint is live work again, not historical.
    ticket.sla_due_at = now + dt.timedelta(hours=category.sla_hours if category else 24)
    ticket.escalation_due_at = now + dt.timedelta(
        hours=category.escalation_hours if category else 48
    )
    ticket.escalated_at = None

    session.add(
        TicketEvent(
            id=uuid.uuid4(),
            society_id=society_id,
            ticket_id=ticket.id,
            actor_id=actor_id,
            type=TicketEventType.reopen,
            body=reason,
            visibility=Visibility.public,
        )
    )
    return ticket


async def rate(
    session: AsyncSession,
    society_id: uuid.UUID,
    ticket_id: uuid.UUID,
    *,
    actor_id: uuid.UUID,
    stars: int,
    comment: str | None = None,
) -> Ticket:
    ticket = await _get_ticket(session, society_id, ticket_id)

    if ticket.status not in (TicketStatus.resolved, TicketStatus.closed):
        raise ConflictError("You can rate a complaint once it has been resolved.")
    if actor_id != ticket.raised_by:
        raise ConflictError("Only the resident who raised this complaint can rate it.")
    if not 1 <= stars <= 5:
        raise ValidationError("Rating must be between 1 and 5.")

    ticket.rating = stars
    ticket.rating_comment = comment
    session.add(
        TicketEvent(
            id=uuid.uuid4(),
            society_id=society_id,
            ticket_id=ticket.id,
            actor_id=actor_id,
            type=TicketEventType.rating,
            body=comment or f"Rated {stars}/5.",
            visibility=Visibility.public,
        )
    )
    return ticket


async def due_for_escalation(
    session: AsyncSession, society_id: uuid.UUID, *, now: dt.datetime | None = None
) -> list[Ticket]:
    """Open tickets past their escalation threshold, not yet escalated.

    Driven by the 15-minute Cloud Scheduler sweep.
    """
    moment = now or dt.datetime.now(dt.UTC)
    rows = await session.scalars(
        select(Ticket).where(
            Ticket.society_id == society_id,
            Ticket.status.in_(_OPEN_STATES),
            Ticket.escalation_due_at <= moment,
            Ticket.escalated_at.is_(None),
        )
    )
    return list(rows)


async def mark_escalated(
    session: AsyncSession, society_id: uuid.UUID, ticket: Ticket, *, to: str
) -> None:
    ticket.escalated_at = dt.datetime.now(dt.UTC)
    if ticket.priority is TicketPriority.normal:
        ticket.priority = TicketPriority.high
    session.add(
        TicketEvent(
            id=uuid.uuid4(),
            society_id=society_id,
            ticket_id=ticket.id,
            actor_id=None,
            type=TicketEventType.escalation,
            body=f"Escalated to {to} — not resolved within the agreed time.",
            visibility=Visibility.public,
        )
    )
    log.info("ticket_escalated", ticket_id=str(ticket.id), to=to)


async def visible_events(
    session: AsyncSession,
    society_id: uuid.UUID,
    ticket_id: uuid.UUID,
    *,
    viewer_is_staff: bool,
) -> list[TicketEvent]:
    """Thread as the viewer may see it.

    Staff-only notes are filtered here rather than in the router, so no endpoint can
    forget and leak an internal note to the resident it is about.
    """
    stmt = select(TicketEvent).where(
        TicketEvent.society_id == society_id,
        TicketEvent.ticket_id == ticket_id,
    )
    if not viewer_is_staff:
        stmt = stmt.where(TicketEvent.visibility == Visibility.public)

    rows = await session.scalars(stmt.order_by(TicketEvent.created_at))
    return list(rows)


async def _get_ticket(
    session: AsyncSession, society_id: uuid.UUID, ticket_id: uuid.UUID
) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    # RLS already prevents cross-society reads; the explicit check turns a
    # policy-filtered miss into a clean 404 rather than an AttributeError.
    if ticket is None or ticket.society_id != society_id:
        raise NotFoundError("Complaint not found.")
    return ticket
