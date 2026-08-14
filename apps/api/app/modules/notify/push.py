"""Firebase Cloud Messaging — push to resident devices.

Approval requests are sent as **high-priority data messages**, not notification
messages: the app must wake and render its own approve/deny UI even when backgrounded,
and a data message is the only kind Android will deliver promptly in Doze.

The p95 target for delivery is 3 seconds. Anything slower and the ladder's 20-second
IVR rung fires while the push is still in flight, which annoys residents — so delivery
latency is measured, not assumed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import structlog

from app.common.config import get_settings

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class PushResult:
    sent: int
    failed: int
    detail: str


async def send_approval_request(
    society_id: uuid.UUID,
    device_tokens: list[str],
    *,
    approval_id: uuid.UUID,
    visitor_name: str | None,
    category: str,
    photo_url: str | None,
) -> PushResult:
    settings = get_settings()

    if settings.push_is_stubbed:
        log.warning(
            "push_stub_approval",
            approval_id=str(approval_id),
            devices=len(device_tokens),
            detail="FCM not configured — push logged, not sent.",
        )
        return PushResult(sent=0, failed=0, detail="stubbed")

    from firebase_admin import messaging  # lazy: absent in local installs

    message = messaging.MulticastMessage(
        tokens=device_tokens,
        data={
            "type": "approval_request",
            "approval_id": str(approval_id),
            "visitor_name": visitor_name or "Visitor",
            "category": category,
            "photo_url": photo_url or "",
        },
        android=messaging.AndroidConfig(priority="high"),
        apns=messaging.APNSConfig(
            headers={"apns-priority": "10"},
            payload=messaging.APNSPayload(
                aps=messaging.Aps(content_available=True, sound="default")
            ),
        ),
    )

    response = messaging.send_each_for_multicast(message)
    log.info(
        "push_approval_sent",
        approval_id=str(approval_id),
        sent=response.success_count,
        failed=response.failure_count,
    )
    return PushResult(
        sent=response.success_count, failed=response.failure_count, detail="sent"
    )


async def send_ticket_update(
    society_id: uuid.UUID,
    device_tokens: list[str],
    *,
    ticket_number: str,
    title: str,
    body: str,
) -> PushResult:
    """Notify complaint subscribers of a status change."""
    settings = get_settings()

    if settings.push_is_stubbed:
        log.warning("push_stub_ticket", ticket=ticket_number, devices=len(device_tokens))
        return PushResult(sent=0, failed=0, detail="stubbed")

    from firebase_admin import messaging

    message = messaging.MulticastMessage(
        tokens=device_tokens,
        notification=messaging.Notification(title=f"{ticket_number}: {title}", body=body),
        data={"type": "ticket_update", "ticket_number": ticket_number},
    )
    response = messaging.send_each_for_multicast(message)
    return PushResult(
        sent=response.success_count, failed=response.failure_count, detail="sent"
    )
