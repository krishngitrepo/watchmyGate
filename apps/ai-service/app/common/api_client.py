"""Client for the TypeScript API.

This service holds **no database connection**. Every read and write goes through
`apps/api` over HTTP with a service token.

That is the central architectural rule of the split, and it is worth stating why: if
this service could write to Postgres directly, the tenant-isolation plumbing and the
money-writing path would exist twice, in two languages, with two audit trails. One
writer for financial data is what keeps the ledger trustworthy. AI and hardware code
can crash, hang or be restarted freely without ever putting that at risk.

The service token is scoped to the handful of endpoints this service needs — it cannot
post a journal entry or issue an invoice.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import structlog

from app.common.config import get_settings
from app.common.errors import UpstreamError

log = structlog.get_logger(__name__)

_TIMEOUT = httpx.Timeout(30.0, connect=5.0)


class ApiClient:
    """Thin wrapper over the core API.

    Always passes `society_id` explicitly — this service has no session and no ambient
    tenant, so the tenant must be named on every call and the core API re-checks that
    the service token is allowed to act for it.
    """

    def __init__(self, society_id: uuid.UUID) -> None:
        settings = get_settings()
        if settings.core_api_url is None or settings.service_token is None:
            raise UpstreamError(
                "The core API is not configured for this environment."
            )
        self._base = settings.core_api_url.rstrip("/")
        self._token = settings.service_token.get_secret_value()
        self._society_id = society_id

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "X-Society-Id": str(self._society_id),
            "Content-Type": "application/json",
        }

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", path, json=payload)

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._request("GET", path, params=params)

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        url = f"{self._base}{path}"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                response = await client.request(
                    method, url, headers=self._headers(), **kwargs
                )
                response.raise_for_status()
                return response.json() if response.content else {}
        except httpx.HTTPStatusError as exc:
            log.error(
                "core_api_error",
                method=method,
                path=path,
                status=exc.response.status_code,
            )
            raise UpstreamError(
                f"The core service rejected this request ({exc.response.status_code})."
            ) from exc
        except httpx.HTTPError as exc:
            log.error("core_api_unreachable", method=method, path=path, error=str(exc))
            raise UpstreamError("The core service is unreachable.") from exc


# ---------------------------------------------------------------- typed helpers


async def submit_gate_event(
    society_id: uuid.UUID,
    *,
    event_id: uuid.UUID,
    gate_id: uuid.UUID | None,
    direction: str,
    category: str,
    vehicle_number: str | None,
    photo_key: str | None,
    device_ts: str,
    verified_offline: bool = False,
) -> dict[str, Any]:
    """Record an entry or exit detected by a camera or barrier controller.

    `event_id` is generated here as UUIDv7 and is the idempotency key — a barrier
    controller that retries a failed call produces one row, not two.
    """
    client = ApiClient(society_id)
    return await client.post(
        "/v1/gate/events",
        {
            "eventId": str(event_id),
            "gateId": str(gate_id) if gate_id else None,
            "direction": direction,
            "category": category,
            "vehicleNumber": vehicle_number,
            "photoKey": photo_key,
            "deviceTs": device_ts,
            "verifiedOffline": verified_offline,
            "source": "device",
        },
    )


async def submit_ocr_result(
    society_id: uuid.UUID,
    *,
    document_type: str,
    reference_id: uuid.UUID,
    extracted: dict[str, Any],
    confidence: float,
) -> dict[str, Any]:
    """Hand extracted data to the core API for review.

    Deliberately never posts financial entries directly. OCR output lands in a review
    queue and a human confirms it before anything reaches the ledger — an OCR misread
    on a bank statement would otherwise silently corrupt a society's accounts.
    """
    client = ApiClient(society_id)
    return await client.post(
        "/v1/ocr/results",
        {
            "documentType": document_type,
            "referenceId": str(reference_id),
            "extracted": extracted,
            "confidence": confidence,
            "requiresReview": True,
        },
    )


async def submit_voice_complaint(
    society_id: uuid.UUID,
    *,
    person_id: uuid.UUID,
    transcript: str,
    language: str,
    suggested_category_id: uuid.UUID | None,
    audio_key: str | None,
) -> dict[str, Any]:
    """Create a complaint from a spoken description.

    The transcript is passed as-is and the category is only a *suggestion* — the core
    API decides routing. Letting a model choose the routing outright would mean a
    mis-transcription sends a gas leak to the gardener.
    """
    client = ApiClient(society_id)
    return await client.post(
        "/v1/tickets/from-voice",
        {
            "personId": str(person_id),
            "transcript": transcript,
            "language": language,
            "suggestedCategoryId": str(suggested_category_id)
            if suggested_category_id
            else None,
            "audioKey": audio_key,
        },
    )
