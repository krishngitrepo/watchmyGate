"""Phone OTP login.

Design notes
------------
* The code is never stored — only an Argon2 hash. A database disclosure therefore does
  not hand an attacker live login codes.
* Codes are generated with ``secrets``, never ``random``.
* Attempts are counted per challenge and the challenge is consumed on success, so a
  code cannot be reused.
* Requesting an OTP for an unknown phone number behaves identically to a known one.
  Divergent behaviour would turn this endpoint into a "is this person a resident here"
  oracle.
* In stub mode (no MSG91 credentials) the code is written to the application log so
  local development needs no cloud account.
"""

from __future__ import annotations

import datetime as dt
import secrets
import uuid

import structlog
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select, update

from app.common.config import get_settings
from app.common.errors import RateLimitError, ValidationError
from app.common.tenancy import unscoped_context
from app.modules.auth.models import OtpChallenge, Person, PersonStatus
from app.modules.notify.sms import send_otp_sms

log = structlog.get_logger(__name__)
_hasher = PasswordHasher()

OTP_LENGTH = 6


def _generate_code() -> str:
    """Cryptographically secure numeric code, zero-padded."""
    upper = 10**OTP_LENGTH
    return str(secrets.randbelow(upper)).zfill(OTP_LENGTH)


async def request_otp(phone: str, *, request_ip: str | None = None) -> None:
    """Issue an OTP challenge for `phone`.

    Returns nothing regardless of whether the number is registered — see module notes.
    """
    settings = get_settings()
    now = dt.datetime.now(dt.UTC)

    async with unscoped_context(reason="otp_request") as session:
        # Cooldown: block rapid re-requests for the same number.
        cooldown_from = now - dt.timedelta(seconds=settings.otp_resend_cooldown_seconds)
        recent = await session.scalar(
            select(OtpChallenge)
            .where(
                OtpChallenge.phone == phone,
                OtpChallenge.created_at > cooldown_from,
                OtpChallenge.consumed_at.is_(None),
            )
            .limit(1)
        )
        if recent is not None:
            raise RateLimitError(
                f"An OTP was already sent. Try again in "
                f"{settings.otp_resend_cooldown_seconds} seconds."
            )

        code = _generate_code()
        challenge = OtpChallenge(
            id=uuid.uuid4(),
            phone=phone,
            code_hash=_hasher.hash(code),
            expires_at=now + dt.timedelta(seconds=settings.otp_ttl_seconds),
            request_ip=request_ip,
        )
        session.add(challenge)

    await send_otp_sms(phone, code)


async def verify_otp(phone: str, code: str) -> Person:
    """Verify a code and return the person, creating them on first login.

    A society admin must still grant a role before the account can see anything —
    verifying a phone number proves identity, not membership.
    """
    settings = get_settings()
    now = dt.datetime.now(dt.UTC)

    async with unscoped_context(reason="otp_verify") as session:
        challenge = await session.scalar(
            select(OtpChallenge)
            .where(
                OtpChallenge.phone == phone,
                OtpChallenge.consumed_at.is_(None),
                OtpChallenge.expires_at > now,
            )
            .order_by(OtpChallenge.created_at.desc())
            .limit(1)
            .with_for_update()
        )

        if challenge is None:
            raise ValidationError("That code has expired. Request a new one.")

        if challenge.attempts >= settings.otp_max_attempts:
            raise RateLimitError("Too many incorrect attempts. Request a new code.")

        challenge.attempts += 1

        try:
            _hasher.verify(challenge.code_hash, code)
        except VerifyMismatchError:
            log.info("otp_mismatch", phone=phone, attempts=challenge.attempts)
            raise ValidationError("Incorrect code.") from None

        challenge.consumed_at = now

        # Invalidate any other outstanding challenges for this number.
        await session.execute(
            update(OtpChallenge)
            .where(
                OtpChallenge.phone == phone,
                OtpChallenge.consumed_at.is_(None),
                OtpChallenge.id != challenge.id,
            )
            .values(consumed_at=now)
        )

        person = await session.scalar(select(Person).where(Person.phone == phone))
        if person is None:
            person = Person(id=uuid.uuid4(), phone=phone)
            session.add(person)
            await session.flush()
            log.info("person_created", person_id=str(person.id))

        if person.status is PersonStatus.deactivated:
            raise ValidationError("This account has been deactivated.")

        return person
