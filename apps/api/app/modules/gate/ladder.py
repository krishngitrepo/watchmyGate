"""The approval ladder.

The original brief asked for "gate entry approval under 2 seconds". That is physically
impossible — the round trip includes a human being picking up a phone and tapping a
button. So the target is split, and the case everybody actually complains about (the
resident does not answer) is a designed outcome rather than an edge case:

    t=0s   guard submits            → server ack, p95 < 800ms
    t=0s   high-priority push to every device on the unit
    t=20s  no answer                → IVR call + SMS
    t=45s  no answer                → apply the unit's standing rule
    t=90s  still nothing            → escalate to the on-duty committee contact

Each rung is a Cloud Tasks message scheduled at creation time and cancelled if the
resident responds first. Every rung that fires is written to `approval_rungs` and shown
back to the resident, so "I never got the notification" becomes checkable.

Without Google Cloud credentials the scheduling is logged instead of enqueued, so the
whole flow is exercisable locally.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.config import get_settings
from app.modules.gate.models import (
    Approval,
    ApprovalRung,
    ApprovalState,
    Rung,
    StandingAction,
    StandingRule,
    VisitorCategory,
)

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class LadderStep:
    rung: Rung
    delay_seconds: int


#: The ladder. Order and timings are product decisions, not tuning knobs — changing
#: them changes what a resident experiences at their gate.
LADDER: tuple[LadderStep, ...] = (
    LadderStep(Rung.push, 0),
    LadderStep(Rung.ivr, 20),
    LadderStep(Rung.standing_rule, 45),
    LadderStep(Rung.mc_escalation, 90),
)

#: Categories a standing rule may auto-approve. A guest is never auto-approved — an
#: unknown person at the gate always needs a human decision.
AUTO_APPROVABLE = frozenset(
    {VisitorCategory.delivery, VisitorCategory.courier, VisitorCategory.cab}
)


async def schedule_ladder(approval_id: uuid.UUID, society_id: uuid.UUID) -> None:
    """Enqueue one Cloud Task per rung, each at its own delay.

    Scheduled up front rather than chained, so a worker crash cannot strand a visitor
    at the gate: the later rungs are already queued independently.
    """
    settings = get_settings()

    if settings.tasks_are_stubbed:
        for step in LADDER[1:]:
            log.warning(
                "ladder_stub_scheduled",
                approval_id=str(approval_id),
                rung=str(step.rung),
                delay_seconds=step.delay_seconds,
                detail="Cloud Tasks not configured — rung logged, not enqueued.",
            )
        return

    from google.cloud import tasks_v2  # imported lazily: absent in local installs

    client = tasks_v2.CloudTasksAsyncClient()
    parent = client.queue_path(
        settings.gcp_project_id, settings.gcp_region, settings.cloud_tasks_queue
    )

    for step in LADDER[1:]:
        schedule_time = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=step.delay_seconds)
        await client.create_task(
            parent=parent,
            task={
                "name": f"{parent}/tasks/{approval_id}-{step.rung}",  # idempotent enqueue
                "schedule_time": schedule_time,
                "http_request": {
                    "http_method": tasks_v2.HttpMethod.POST,
                    "url": f"{settings.worker_base_url}/jobs/approval-rung",
                    "headers": {"Content-Type": "application/json"},
                    "body": (
                        f'{{"approval_id":"{approval_id}",'
                        f'"society_id":"{society_id}",'
                        f'"rung":"{step.rung}"}}'
                    ).encode(),
                    "oidc_token": {"service_account_email": settings.worker_service_account},
                },
            },
        )

    log.info("ladder_scheduled", approval_id=str(approval_id))


async def record_rung(
    session: AsyncSession,
    society_id: uuid.UUID,
    approval_id: uuid.UUID,
    rung: Rung,
    *,
    result: str,
) -> None:
    session.add(
        ApprovalRung(
            id=uuid.uuid4(),
            society_id=society_id,
            approval_id=approval_id,
            rung=rung,
            fired_at=dt.datetime.now(dt.UTC),
            channel_result=result,
        )
    )


async def resolve_standing_rule(
    session: AsyncSession,
    society_id: uuid.UUID,
    approval: Approval,
) -> StandingAction:
    """Decide what happens at t=45s when nobody has answered.

    Most specific rule wins: a matcher on the visitor name beats a category rule, which
    beats the unit default. With no rule at all the visitor is asked to wait — never
    auto-approved, because silence is not consent.
    """
    rules = await session.scalars(
        select(StandingRule).where(
            StandingRule.society_id == society_id,
            StandingRule.unit_id == approval.unit_id,
            StandingRule.is_active.is_(True),
        )
    )

    best: StandingRule | None = None
    best_score = -1

    for rule in rules:
        score = 0
        if rule.matcher:
            if not approval.visitor_name:
                continue
            if rule.matcher.lower() not in approval.visitor_name.lower():
                continue
            score += 2
        if rule.category is not None:
            if rule.category is not approval.category:
                continue
            score += 1
        if score > best_score:
            best, best_score = rule, score

    if best is None:
        return StandingAction.ask_to_wait

    # A rule cannot auto-approve a category that requires a human decision, even if a
    # resident configured it that way — an unknown guest is not a parcel.
    if best.action is StandingAction.auto_approve and approval.category not in AUTO_APPROVABLE:
        log.info(
            "standing_rule_downgraded",
            approval_id=str(approval.id),
            category=str(approval.category),
            detail="auto_approve not permitted for this visitor category",
        )
        return StandingAction.ask_to_wait

    return best.action


async def apply_rung(
    session: AsyncSession,
    society_id: uuid.UUID,
    approval_id: uuid.UUID,
    rung: Rung,
) -> Approval | None:
    """Execute one ladder rung. Called by the worker when a Cloud Task fires.

    Returns None when the approval was already resolved — the normal case, since most
    residents answer the first push and the later tasks still fire.
    """
    approval = await session.get(Approval, approval_id)
    if approval is None or approval.society_id != society_id:
        return None

    if approval.state is not ApprovalState.pending:
        log.info("ladder_rung_skipped", approval_id=str(approval_id), rung=str(rung))
        return None

    now = dt.datetime.now(dt.UTC)

    if rung is Rung.ivr:
        from app.modules.notify.voice import place_approval_call

        result = await place_approval_call(society_id, approval)
        await record_rung(session, society_id, approval_id, Rung.ivr, result=result)

    elif rung is Rung.standing_rule:
        action = await resolve_standing_rule(session, society_id, approval)
        await record_rung(
            session, society_id, approval_id, Rung.standing_rule, result=str(action)
        )

        if action is StandingAction.auto_approve:
            approval.state = ApprovalState.auto_approved
            approval.resolved_at = now
            approval.resolution_rung = Rung.standing_rule
        elif action is StandingAction.deny:
            approval.state = ApprovalState.denied
            approval.resolved_at = now
            approval.resolution_rung = Rung.standing_rule
        # ask_to_wait leaves it pending so the committee rung can still fire.

    elif rung is Rung.mc_escalation:
        await record_rung(
            session, society_id, approval_id, Rung.mc_escalation, result="notified committee"
        )
        if approval.state is ApprovalState.pending:
            approval.state = ApprovalState.escalated

    return approval


async def resolve(
    session: AsyncSession,
    society_id: uuid.UUID,
    approval_id: uuid.UUID,
    *,
    approved: bool,
    resolved_by: uuid.UUID,
) -> Approval | None:
    """Resident taps approve or deny.

    First response wins. A late tap on an already-escalated request is accepted as a
    correction, but the rung that resolved it is recorded either way.
    """
    approval = await session.get(Approval, approval_id)
    if approval is None or approval.society_id != society_id:
        return None

    if approval.state in (ApprovalState.approved, ApprovalState.denied):
        return approval  # idempotent — a double tap is not an error

    approval.state = ApprovalState.approved if approved else ApprovalState.denied
    approval.resolved_at = dt.datetime.now(dt.UTC)
    approval.resolved_by = resolved_by
    if approval.resolution_rung is None:
        approval.resolution_rung = Rung.push

    log.info("approval_resolved", approval_id=str(approval_id), state=str(approval.state))
    return approval
