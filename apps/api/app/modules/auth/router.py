"""Authentication endpoints."""

from __future__ import annotations

import uuid

import phonenumbers
from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.common.errors import ValidationError
from app.common.tenancy import unscoped_context
from app.modules.auth.deps import CurrentUser
from app.modules.auth.models import Role, RoleAssignment
from app.modules.auth.otp import request_otp, verify_otp
from app.modules.auth.tokens import create_session, revoke_session, rotate_session

router = APIRouter(prefix="/v1/auth", tags=["auth"])


def _normalise_phone(value: str) -> str:
    """Normalise to E.164, defaulting to India.

    Residents type numbers every possible way — with +91, with a leading 0, with
    spaces. Normalising at the boundary means the rest of the system has exactly one
    representation and lookups cannot miss.
    """
    try:
        parsed = phonenumbers.parse(value, "IN")
    except phonenumbers.NumberParseException as exc:
        raise ValidationError("That doesn't look like a valid phone number.") from exc
    if not phonenumbers.is_valid_number(parsed):
        raise ValidationError("That doesn't look like a valid phone number.")
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


class OtpRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=20)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return _normalise_phone(v)


class OtpVerify(BaseModel):
    phone: str
    code: str = Field(min_length=4, max_length=8)
    device_id: str | None = Field(default=None, max_length=128)
    device_label: str | None = Field(default=None, max_length=128)
    society_id: uuid.UUID | None = None

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return _normalise_phone(v)


class RefreshRequest(BaseModel):
    refresh_token: str
    society_id: uuid.UUID | None = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "Bearer"


class MembershipResponse(BaseModel):
    society_id: uuid.UUID
    roles: list[str]


async def _roles_for(person_id: uuid.UUID, society_id: uuid.UUID | None) -> tuple[str, ...]:
    """Active role codes for a person in one society.

    `role_assignments` is tenant-scoped, but this runs before a tenant context exists,
    so it reads with an explicit unscoped session filtered by both ids. Safe because
    both are supplied and matched exactly — this is authentication, not authorisation.
    """
    if society_id is None:
        return ()

    async with unscoped_context(reason="auth_role_lookup") as session:
        rows = await session.execute(
            select(Role.code)
            .join(RoleAssignment, RoleAssignment.role_id == Role.id)
            .where(
                RoleAssignment.person_id == person_id,
                RoleAssignment.society_id == society_id,
                RoleAssignment.valid_to.is_(None),
            )
        )
        return tuple(str(code.value if hasattr(code, "value") else code) for code in rows.scalars())


@router.post("/otp/request", status_code=status.HTTP_202_ACCEPTED)
async def post_otp_request(body: OtpRequest, request: Request) -> dict[str, str]:
    """Send a login code.

    Always returns 202, whether or not the number is registered — a different response
    would turn this into a "does this person live here" oracle.
    """
    client_ip = request.client.host if request.client else None
    await request_otp(body.phone, request_ip=client_ip)
    return {"status": "sent"}


@router.post("/otp/verify", response_model=TokenResponse)
async def post_otp_verify(body: OtpVerify, request: Request) -> TokenResponse:
    person = await verify_otp(body.phone, body.code)
    roles = await _roles_for(person.id, body.society_id)

    pair = await create_session(
        person.id,
        device_id=body.device_id,
        device_label=body.device_label,
        ip=request.client.host if request.client else None,
        society_id=body.society_id,
        roles=roles,
    )
    return TokenResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
    )


@router.post("/refresh", response_model=TokenResponse)
async def post_refresh(body: RefreshRequest) -> TokenResponse:
    pair = await rotate_session(body.refresh_token, society_id=body.society_id)
    return TokenResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def post_logout(body: RefreshRequest) -> None:
    await revoke_session(body.refresh_token)


@router.get("/me/memberships", response_model=list[MembershipResponse])
async def get_memberships(user: CurrentUser) -> list[MembershipResponse]:
    """Societies this person belongs to.

    Called after login so the app can show a society picker — one person may be a
    resident in one society and a committee member in another.
    """
    async with unscoped_context(reason="membership_list") as session:
        rows = await session.execute(
            select(RoleAssignment.society_id, Role.code)
            .join(Role, Role.id == RoleAssignment.role_id)
            .where(
                RoleAssignment.person_id == user.person_id,
                RoleAssignment.valid_to.is_(None),
            )
        )
        grouped: dict[uuid.UUID, list[str]] = {}
        for society_id, code in rows:
            value = code.value if hasattr(code, "value") else str(code)
            grouped.setdefault(society_id, []).append(value)

    return [MembershipResponse(society_id=sid, roles=roles) for sid, roles in grouped.items()]
