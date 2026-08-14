"""Exotel IVR — the 20-second rung of the approval ladder.

When a push goes unanswered the resident's phone rings. This is what makes the gate
work for the large fraction of residents who have notifications muted, an old handset,
or no data at that moment — and it is the single biggest complaint against incumbent
products.
"""

from __future__ import annotations

import uuid

import httpx
import structlog

from app.common.config import get_settings

log = structlog.get_logger(__name__)

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def place_approval_call(society_id: uuid.UUID, approval: object) -> str:
    """Ring the unit's primary resident. Returns a short result string for the audit.

    Never raises: a failed call must not break the ladder, because the committee
    escalation at t=90s still has to fire.
    """
    settings = get_settings()

    if settings.voice_is_stubbed:
        log.warning(
            "voice_stub_call",
            society_id=str(society_id),
            detail="Exotel not configured — IVR call logged, not placed.",
        )
        return "stubbed"

    url = (
        f"https://api.exotel.com/v1/Accounts/{settings.exotel_sid}"
        f"/Calls/connect.json"
    )
    auth = (settings.exotel_sid or "", settings.exotel_token.get_secret_value())  # type: ignore[union-attr]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                url,
                auth=auth,
                data={
                    "From": getattr(approval, "visitor_phone", None) or "",
                    "CallerId": settings.exotel_caller_id or "",
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        log.error("voice_call_failed", society_id=str(society_id), error=str(exc))
        return f"failed: {type(exc).__name__}"

    return "placed"
