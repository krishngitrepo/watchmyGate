"""JWT access tokens and rotating refresh tokens.

Refresh rotation with reuse detection
-------------------------------------
Every refresh exchanges the old token for a new one and records `rotated_to`. If a
token that has already been rotated is presented again, that means a copy leaked — the
legitimate client and an attacker both hold one. We then revoke the entire session
family rather than trying to guess which is which.

Access tokens carry the society and role set so ordinary requests need no database
lookup to authorise. They are short-lived (15 minutes) because that claim set goes
stale — a revoked committee member keeps their access until the token expires, which is
the accepted trade for not querying roles on every request.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from typing import Any

import structlog
from jose import JWTError, jwt
from sqlalchemy import select

from app.common.config import get_settings
from app.common.errors import AuthenticationError
from app.common.tenancy import unscoped_context
from app.modules.auth.models import Session

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int


@dataclass(frozen=True)
class AccessClaims:
    person_id: uuid.UUID
    society_id: uuid.UUID | None
    roles: tuple[str, ...]
    session_id: uuid.UUID


def _hash_refresh(token: str) -> str:
    """SHA-256 is correct here — the token is already 256 bits of entropy, so this is
    a lookup key, not a password needing a slow KDF."""
    return hashlib.sha256(token.encode()).hexdigest()


def issue_access_token(
    person_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    society_id: uuid.UUID | None,
    roles: tuple[str, ...],
) -> tuple[str, int]:
    settings = get_settings()
    ttl = dt.timedelta(minutes=settings.jwt_access_ttl_minutes)
    now = dt.datetime.now(dt.UTC)

    payload: dict[str, Any] = {
        "sub": str(person_id),
        "sid": str(session_id),
        "soc": str(society_id) if society_id else None,
        "roles": list(roles),
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    token = jwt.encode(
        payload, settings.jwt_secret.get_secret_value(), algorithm=settings.jwt_algorithm
    )
    return token, int(ttl.total_seconds())


def decode_access_token(token: str) -> AccessClaims:
    settings = get_settings()
    try:
        payload = jwt.decode(
            token, settings.jwt_secret.get_secret_value(), algorithms=[settings.jwt_algorithm]
        )
    except JWTError as exc:
        raise AuthenticationError("Session expired or invalid. Please sign in again.") from exc

    society = payload.get("soc")
    return AccessClaims(
        person_id=uuid.UUID(payload["sub"]),
        society_id=uuid.UUID(society) if society else None,
        roles=tuple(payload.get("roles", [])),
        session_id=uuid.UUID(payload["sid"]),
    )


async def create_session(
    person_id: uuid.UUID,
    *,
    device_id: str | None = None,
    device_label: str | None = None,
    ip: str | None = None,
    society_id: uuid.UUID | None = None,
    roles: tuple[str, ...] = (),
) -> TokenPair:
    settings = get_settings()
    refresh_token = secrets.token_urlsafe(48)
    session_id = uuid.uuid4()

    async with unscoped_context(reason="session_create") as session:
        session.add(
            Session(
                id=session_id,
                person_id=person_id,
                refresh_token_hash=_hash_refresh(refresh_token),
                device_id=device_id,
                device_label=device_label,
                ip=ip,
                expires_at=dt.datetime.now(dt.UTC)
                + dt.timedelta(days=settings.jwt_refresh_ttl_days),
            )
        )

    access_token, expires_in = issue_access_token(
        person_id, session_id, society_id=society_id, roles=roles
    )
    return TokenPair(access_token, refresh_token, expires_in)


async def rotate_session(
    refresh_token: str,
    *,
    society_id: uuid.UUID | None = None,
    roles: tuple[str, ...] = (),
) -> TokenPair:
    settings = get_settings()
    now = dt.datetime.now(dt.UTC)
    presented_hash = _hash_refresh(refresh_token)

    async with unscoped_context(reason="session_rotate") as session:
        record = await session.scalar(
            select(Session).where(Session.refresh_token_hash == presented_hash).with_for_update()
        )

        if record is None:
            raise AuthenticationError("Session expired or invalid. Please sign in again.")

        # Reuse of an already-rotated token means a copy leaked. Revoke the family.
        if record.rotated_to is not None:
            log.warning(
                "refresh_token_reuse_detected",
                person_id=str(record.person_id),
                session_id=str(record.id),
            )
            await _revoke_family(session, record.person_id, now)
            raise AuthenticationError("Session expired or invalid. Please sign in again.")

        if record.revoked_at is not None or record.expires_at <= now:
            raise AuthenticationError("Session expired or invalid. Please sign in again.")

        new_token = secrets.token_urlsafe(48)
        new_id = uuid.uuid4()

        session.add(
            Session(
                id=new_id,
                person_id=record.person_id,
                refresh_token_hash=_hash_refresh(new_token),
                device_id=record.device_id,
                device_label=record.device_label,
                ip=record.ip,
                expires_at=now + dt.timedelta(days=settings.jwt_refresh_ttl_days),
            )
        )
        record.rotated_to = new_id
        record.revoked_at = now
        record.last_used_at = now

        person_id = record.person_id

    access_token, expires_in = issue_access_token(
        person_id, new_id, society_id=society_id, roles=roles
    )
    return TokenPair(access_token, new_token, expires_in)


async def revoke_session(refresh_token: str) -> None:
    async with unscoped_context(reason="session_revoke") as session:
        record = await session.scalar(
            select(Session).where(Session.refresh_token_hash == _hash_refresh(refresh_token))
        )
        if record is not None and record.revoked_at is None:
            record.revoked_at = dt.datetime.now(dt.UTC)


async def _revoke_family(session: Any, person_id: uuid.UUID, now: dt.datetime) -> None:
    records = await session.scalars(
        select(Session).where(Session.person_id == person_id, Session.revoked_at.is_(None))
    )
    for record in records:
        record.revoked_at = now
