"""Gate business logic: pass issuance and idempotent offline sync."""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.errors import ConflictError, NotFoundError, ValidationError
from app.common.models import uuid7
from app.modules.gate import passes
from app.modules.gate.models import (
    Approval,
    ApprovalState,
    Direction,
    GateEvent,
    PassStatus,
    SocietySigningKey,
    VisitorCategory,
    VisitorPass,
    Watchlist,
)

log = structlog.get_logger(__name__)

#: A guard device more than this far out of step has its timestamps flagged. Business
#: logic always uses server time, but a wildly wrong device clock is worth surfacing —
#: it usually means the handset has been factory reset or its battery died.
CLOCK_DRIFT_ALERT_SECONDS = 300

#: A visitor still inside after this long triggers an overstay alert.
DEFAULT_OVERSTAY_HOURS = 12


@dataclass(frozen=True)
class IssuePass:
    unit_id: uuid.UUID
    created_by: uuid.UUID
    visitor_name: str
    category: VisitorCategory
    valid_from: dt.datetime
    valid_to: dt.datetime
    visitor_phone: str | None = None
    vehicle_number: str | None = None
    max_uses: int = 1


@dataclass(frozen=True)
class SyncedEvent:
    """One gate event as reported by the guard app.

    `event_id` is generated on the device (UUIDv7). It is the idempotency key: the
    device may replay the whole outbox after a flaky sync, and every replay must
    produce exactly one row.
    """

    event_id: uuid.UUID
    direction: Direction
    category: VisitorCategory
    device_ts: dt.datetime
    unit_id: uuid.UUID | None = None
    pass_id: uuid.UUID | None = None
    gate_id: uuid.UUID | None = None
    visitor_name: str | None = None
    visitor_phone: str | None = None
    vehicle_number: str | None = None
    photo_key: str | None = None
    verified_offline: bool = False


async def active_signing_key(
    session: AsyncSession, society_id: uuid.UUID
) -> SocietySigningKey:
    key = await session.scalar(
        select(SocietySigningKey)
        .where(
            SocietySigningKey.society_id == society_id,
            SocietySigningKey.valid_to.is_(None),
        )
        .order_by(SocietySigningKey.key_version.desc())
        .limit(1)
    )
    if key is None:
        raise NotFoundError("This society has no active signing key. Contact support.")
    return key


async def public_keys_for_device(
    session: AsyncSession, society_id: uuid.UUID
) -> dict[int, str]:
    """Keys a guard device caches so it can verify passes with no network.

    Several versions are returned because a pass signed just before a rotation must
    still verify on a device that has not synced since.
    """
    rows = await session.scalars(
        select(SocietySigningKey)
        .where(SocietySigningKey.society_id == society_id)
        .order_by(SocietySigningKey.key_version.desc())
        .limit(passes.KEY_CACHE_DEPTH)
    )
    return {k.key_version: k.public_key for k in rows}


async def issue_pass(
    session: AsyncSession,
    society_id: uuid.UUID,
    draft: IssuePass,
    *,
    private_pem: str,
) -> VisitorPass:
    """Create a pre-approved visitor pass with an offline-verifiable QR."""
    if draft.valid_to <= draft.valid_from:
        raise ValidationError("The pass end time must be after its start time.")
    if draft.max_uses < 1:
        raise ValidationError("A pass must allow at least one entry.")

    if draft.visitor_phone:
        blocked = await session.scalar(
            select(Watchlist).where(
                Watchlist.society_id == society_id,
                Watchlist.phone == draft.visitor_phone,
                Watchlist.is_active.is_(True),
            )
        )
        if blocked is not None:
            raise ConflictError(
                "This visitor is on the society watchlist. Contact the committee."
            )

    key = await active_signing_key(session, society_id)
    pass_id = uuid.uuid4()
    salt = passes.new_salt()
    v_hash = passes.visitor_hash(draft.visitor_name, draft.visitor_phone or "", salt)

    qr_value = passes.sign_pass(
        passes.PassPayload(
            pass_id=pass_id,
            society_id=society_id,
            unit_id=draft.unit_id,
            valid_from=draft.valid_from,
            valid_to=draft.valid_to,
            max_uses=draft.max_uses,
            visitor_hash=v_hash,
            key_version=key.key_version,
        ),
        private_pem,
    )

    visitor_pass = VisitorPass(
        id=pass_id,
        society_id=society_id,
        unit_id=draft.unit_id,
        created_by=draft.created_by,
        visitor_name=draft.visitor_name.strip(),
        visitor_phone=draft.visitor_phone,
        visitor_hash=v_hash,
        visitor_salt=salt,
        category=draft.category,
        vehicle_number=draft.vehicle_number,
        valid_from=draft.valid_from,
        valid_to=draft.valid_to,
        max_uses=draft.max_uses,
        key_version=key.key_version,
        qr_value=qr_value,
        status=PassStatus.active,
    )
    session.add(visitor_pass)
    log.info("pass_issued", pass_id=str(pass_id), unit_id=str(draft.unit_id))
    return visitor_pass


async def sync_events(
    session: AsyncSession,
    society_id: uuid.UUID,
    guard_person_id: uuid.UUID,
    events: list[SyncedEvent],
) -> dict[str, int]:
    """Drain a guard device's offline outbox.

    Idempotent by construction: the device-generated `event_id` is the primary key, so
    a replayed batch inserts nothing new. This is what lets the guard app retry blindly
    on a flaky connection without inventing duplicate entries.

    Returns counts so the device knows what to clear from its outbox.
    """
    now = dt.datetime.now(dt.UTC)
    accepted = 0
    duplicates = 0
    drift_flags = 0

    if not events:
        return {"accepted": 0, "duplicates": 0, "clock_drift_flagged": 0}

    incoming_ids = [e.event_id for e in events]
    existing = set(
        (
            await session.scalars(
                select(GateEvent.id).where(
                    GateEvent.society_id == society_id, GateEvent.id.in_(incoming_ids)
                )
            )
        ).all()
    )

    for event in events:
        if event.event_id in existing:
            duplicates += 1
            continue

        drift = int((event.device_ts - now).total_seconds())
        if abs(drift) > CLOCK_DRIFT_ALERT_SECONDS:
            drift_flags += 1
            log.warning(
                "guard_clock_drift",
                event_id=str(event.event_id),
                drift_seconds=drift,
                guard=str(guard_person_id),
            )

        session.add(
            GateEvent(
                id=event.event_id,
                society_id=society_id,
                gate_id=event.gate_id,
                unit_id=event.unit_id,
                pass_id=event.pass_id,
                guard_person_id=guard_person_id,
                direction=event.direction,
                category=event.category,
                visitor_name=event.visitor_name,
                visitor_phone=event.visitor_phone,
                vehicle_number=event.vehicle_number,
                photo_key=event.photo_key,
                verified_offline=event.verified_offline,
                device_ts=event.device_ts,
                # Business logic uses server time. The device clock is recorded for the
                # audit trail but is never trusted.
                server_ts=now,
                clock_drift_seconds=drift,
                synced_at=now if event.verified_offline else None,
            )
        )
        accepted += 1

        if event.pass_id is not None:
            await _consume_pass_use(session, society_id, event.pass_id)

    log.info(
        "gate_sync",
        accepted=accepted,
        duplicates=duplicates,
        guard=str(guard_person_id),
    )
    return {
        "accepted": accepted,
        "duplicates": duplicates,
        "clock_drift_flagged": drift_flags,
    }


async def _consume_pass_use(
    session: AsyncSession, society_id: uuid.UUID, pass_id: uuid.UUID
) -> None:
    visitor_pass = await session.get(VisitorPass, pass_id)
    if visitor_pass is None or visitor_pass.society_id != society_id:
        return

    visitor_pass.uses += 1
    if visitor_pass.uses >= visitor_pass.max_uses:
        visitor_pass.status = PassStatus.used


async def request_approval(
    session: AsyncSession,
    society_id: uuid.UUID,
    *,
    unit_id: uuid.UUID,
    category: VisitorCategory,
    visitor_name: str | None,
    visitor_phone: str | None,
    photo_key: str | None,
    gate_event_id: uuid.UUID | None = None,
) -> Approval:
    """Create a pending approval for an ad-hoc visitor and start the ladder clock."""
    approval = Approval(
        id=uuid.uuid4(),
        society_id=society_id,
        unit_id=unit_id,
        gate_event_id=gate_event_id,
        state=ApprovalState.pending,
        requested_at=dt.datetime.now(dt.UTC),
        visitor_name=visitor_name,
        visitor_phone=visitor_phone,
        category=category,
        photo_key=photo_key,
    )
    session.add(approval)
    await session.flush()
    return approval


async def open_visits(
    session: AsyncSession, society_id: uuid.UUID, *, hours: int = DEFAULT_OVERSTAY_HOURS
) -> list[GateEvent]:
    """Visitors who entered and have not exited within `hours`.

    Pairs entries with exits by matching on the pass, falling back to phone number for
    ad-hoc visitors. Drives the overstay alert.
    """
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(hours=hours)

    entries = await session.scalars(
        select(GateEvent).where(
            GateEvent.society_id == society_id,
            GateEvent.direction == Direction.entry,
            GateEvent.server_ts <= cutoff,
            GateEvent.overstay_alerted_at.is_(None),
        )
    )
    entry_list = list(entries)
    if not entry_list:
        return []

    exits = await session.scalars(
        select(GateEvent).where(
            GateEvent.society_id == society_id,
            GateEvent.direction == Direction.exit,
            GateEvent.server_ts >= cutoff - dt.timedelta(hours=hours),
        )
    )
    exited_passes = {e.pass_id for e in exits if e.pass_id}
    exited_phones = {e.visitor_phone for e in exits if e.visitor_phone}

    return [
        entry
        for entry in entry_list
        if not (
            (entry.pass_id and entry.pass_id in exited_passes)
            or (entry.visitor_phone and entry.visitor_phone in exited_phones)
        )
    ]


def new_event_id() -> uuid.UUID:
    """UUIDv7 for a gate event. Time-ordered so replays stay diagnosable."""
    return uuid7()
