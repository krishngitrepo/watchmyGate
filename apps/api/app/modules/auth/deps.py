"""Request dependencies: the authenticated caller and their tenant scope."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.errors import AuthenticationError, ForbiddenError
from app.common.tenancy import tenant_context
from app.modules.auth.models import ROLES_REQUIRING_2FA, RoleCode
from app.modules.auth.tokens import AccessClaims, decode_access_token


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> AccessClaims:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthenticationError("Sign in to continue.")
    return decode_access_token(authorization.split(" ", 1)[1].strip())


CurrentUser = Annotated[AccessClaims, Depends(get_current_user)]


async def get_tenant_session(
    request: Request,
    user: CurrentUser,
) -> AsyncIterator[AsyncSession]:
    """Yield a database session scoped to the caller's society.

    Every tenant-facing endpoint depends on this rather than opening its own session.
    A token with no society claim cannot reach tenant data at all — the caller must
    pick a society first, because one person may belong to several.
    """
    if user.society_id is None:
        raise ForbiddenError("Select a society before continuing.")

    async with tenant_context(user.society_id, actor_id=user.person_id) as session:
        request.state.society_id = user.society_id
        request.state.actor_id = user.person_id
        yield session


TenantSession = Annotated[AsyncSession, Depends(get_tenant_session)]


def require_roles(*allowed: RoleCode):
    """Restrict an endpoint to the given roles.

    Roles in `ROLES_REQUIRING_2FA` additionally need a verified TOTP factor; the claim
    is set at login and re-checked here so a privileged action cannot be performed on a
    session that never completed second-factor verification.
    """
    allowed_codes = {role.value for role in allowed}
    needs_2fa = {role.value for role in allowed if role in ROLES_REQUIRING_2FA}

    async def _check(user: CurrentUser) -> AccessClaims:
        held = set(user.roles)
        if not held & allowed_codes:
            # Deliberately vague: do not reveal what roles would have worked.
            raise ForbiddenError("You do not have access to this.")
        if held & needs_2fa and "2fa" not in held:
            raise ForbiddenError("Two-factor verification is required for this action.")
        return user

    return _check


def require_society(user: CurrentUser) -> uuid.UUID:
    if user.society_id is None:
        raise ForbiddenError("Select a society before continuing.")
    return user.society_id
