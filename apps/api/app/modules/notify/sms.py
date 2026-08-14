"""SMS delivery via MSG91.

TRAI/DLT compliance
-------------------
Every commercial SMS in India requires a DLT-registered header and template. The
template *category* — transactional, service-explicit, service-implicit, promotional —
is part of the template registration, not a runtime flag, and it determines whether the
message may reach a number on the DND registry. Login OTP is transactional and may.
Dues reminders and notices are service-explicit and require prior consent.

Stub mode
---------
With no MSG91 credentials the code is written to the application log, so the whole
auth flow is testable locally without a cloud account. `get_settings()` refuses to
start in production without credentials, so this cannot ship by accident.
"""

from __future__ import annotations

import enum

import httpx
import structlog

from app.common.config import get_settings

log = structlog.get_logger(__name__)

MSG91_OTP_URL = "https://control.msg91.com/api/v5/otp"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


class TemplateCategory(enum.StrEnum):
    """DLT registration category. Determines DND eligibility."""

    transactional = "transactional"
    service_explicit = "service_explicit"
    service_implicit = "service_implicit"
    promotional = "promotional"


async def send_otp_sms(phone: str, code: str) -> None:
    """Send a login OTP. Transactional category — DND-eligible."""
    settings = get_settings()

    if settings.sms_is_stubbed:
        log.warning(
            "sms_stub_otp",
            phone=phone,
            code=code,
            detail="Stub mode — no SMS sent. Use this code to log in.",
        )
        return

    payload = {
        "template_id": settings.msg91_otp_template_id,
        "mobile": phone.lstrip("+"),
        "otp": code,
        "sender": settings.msg91_sender_id,
    }
    headers = {"authkey": settings.msg91_auth_key.get_secret_value()}  # type: ignore[union-attr]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(MSG91_OTP_URL, json=payload, headers=headers)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        # Do not leak the code into logs or into the client-facing error.
        log.error("sms_send_failed", phone=phone, error=str(exc))
        raise RuntimeError("Could not send the verification code. Please try again.") from exc

    log.info("sms_otp_sent", phone=phone)
