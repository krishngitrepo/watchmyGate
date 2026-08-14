"""Razorpay adapter — both collection modes.

**The one rule that governs this entire module: money never enters a WatchMyGate
account.** Collecting funds on behalf of a society into our own account would require
an RBI Payment Aggregator licence we cannot obtain. Every function here creates orders
against somebody else's account.

Mode 1 — `route_linked`. The society is a Razorpay Route linked account. Funds settle
directly to the society's own bank. Smart Collect issues per-unit virtual account
numbers so NEFT/IMPS/UPI credits reconcile automatically.

Mode 2 — `direct_merchant`. The flat owner supplies their **own** merchant credentials,
so tenant rent lands in their bank with zero WatchMyGate commission. We orchestrate the
order and record the result; we are never in the money path.

Credentials for Mode 2 are the most sensitive data in the system. They are read from
Secret Manager into memory for a single request, never cached, never logged, and never
returned by any endpoint.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import uuid
from dataclasses import dataclass
from decimal import Decimal

import httpx
import structlog

from app.common.config import get_settings
from app.common.errors import ConflictError, ValidationError
from app.common.money import money
from app.modules.ledger.models import DestinationMode, PaymentDestination

log = structlog.get_logger(__name__)

RAZORPAY_API = "https://api.razorpay.com/v1"
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)

#: Approximate MDR the gateway deducts from the payee. Shown in the UI so an owner
#: enabling Mode 2 knows what each method costs them — "no WatchMyGate fee" is true,
#: "free" is not. UPI is genuinely 0% under RBI's zero-MDR mandate for P2M.
MDR_BY_METHOD: dict[str, str] = {
    "upi": "0%",
    "debit_card": "~0.4–0.9%",
    "credit_card": "~2% + GST",
    "netbanking": "~1.5–1.9% + GST",
}

#: Rent above this attracts 5% TDS under section 194-IB, deducted by the tenant.
TDS_RENT_THRESHOLD_MONTHLY = Decimal("50000")
TDS_RENT_RATE = Decimal("5")


@dataclass(frozen=True)
class OrderRequest:
    amount: Decimal
    reference: str
    description: str
    unit_id: uuid.UUID | None = None
    invoice_id: uuid.UUID | None = None


@dataclass(frozen=True)
class OrderResult:
    provider_order_id: str
    amount_paise: int
    key_id: str
    mode: DestinationMode
    is_stubbed: bool = False


def to_paise(amount: Decimal) -> int:
    """Razorpay works in paise. Convert only at the boundary.

    Rounding here rather than earlier keeps every internal calculation in Decimal, so
    the amount charged always equals the amount invoiced.
    """
    return int((money(amount) * 100).quantize(Decimal("1")))


def tds_note(monthly_rent: Decimal) -> str | None:
    """Surfaced on the rent payment screen when TDS applies.

    We neither deduct nor file — that is the tenant's statutory obligation — but a
    tenant who does not know about 194-IB gets a notice months later, so it is shown.
    """
    if monthly_rent <= TDS_RENT_THRESHOLD_MONTHLY:
        return None
    return (
        f"Rent above ₹{TDS_RENT_THRESHOLD_MONTHLY:,.0f}/month requires you to deduct "
        f"{TDS_RENT_RATE}% TDS (section 194-IB) and deposit it. WatchMyGate does not "
        "deduct or file this on your behalf."
    )


async def _credentials_for(destination: PaymentDestination) -> tuple[str, str]:
    """Resolve the key pair to create an order with.

    Mode 1 uses the platform's Route credentials with the society as linked account.
    Mode 2 reads the owner's own credentials from Secret Manager — in memory only, for
    the duration of this request.
    """
    settings = get_settings()

    if destination.mode is DestinationMode.route_linked:
        if settings.razorpay_key_id is None or settings.razorpay_key_secret is None:
            raise ValidationError("Payments are not configured for this environment.")
        return settings.razorpay_key_id, settings.razorpay_key_secret.get_secret_value()

    if destination.credentials_secret_ref is None:
        raise ConflictError(
            "This owner has not finished setting up direct payments. Ask them to add "
            "their payment account details."
        )

    from app.common.secrets import read_secret

    payload = await read_secret(destination.credentials_secret_ref)
    key_id, _, key_secret = payload.partition(":")
    if not key_id or not key_secret:
        raise ConflictError("The stored payment credentials are unreadable.")
    return key_id, key_secret


async def create_order(
    destination: PaymentDestination, request: OrderRequest
) -> OrderResult:
    """Create a payment order against the payee's account.

    In Mode 1 the `transfers` block tells Razorpay to settle the full amount to the
    society's linked account — we take nothing. In Mode 2 the order is created on the
    owner's own account, so the money was never ours to route.
    """
    settings = get_settings()

    if settings.payments_are_stubbed and destination.mode is DestinationMode.route_linked:
        log.warning(
            "payments_stub_order",
            reference=request.reference,
            amount=str(request.amount),
            detail="Razorpay not configured — order logged, not created.",
        )
        return OrderResult(
            provider_order_id=f"order_stub_{uuid.uuid4().hex[:14]}",
            amount_paise=to_paise(request.amount),
            key_id="stub",
            mode=destination.mode,
            is_stubbed=True,
        )

    key_id, key_secret = await _credentials_for(destination)
    amount_paise = to_paise(request.amount)

    payload: dict[str, object] = {
        "amount": amount_paise,
        "currency": "INR",
        "receipt": request.reference[:40],
        "notes": {
            "description": request.description[:200],
            "unit_id": str(request.unit_id) if request.unit_id else "",
            "invoice_id": str(request.invoice_id) if request.invoice_id else "",
        },
    }

    if destination.mode is DestinationMode.route_linked and destination.merchant_id:
        # Full amount to the society. No platform commission is taken here; our SaaS
        # fee is billed separately as an ordinary B2B invoice.
        payload["transfers"] = [
            {
                "account": destination.merchant_id,
                "amount": amount_paise,
                "currency": "INR",
                "on_hold": False,
            }
        ]

    auth = base64.b64encode(f"{key_id}:{key_secret}".encode()).decode()

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                f"{RAZORPAY_API}/orders",
                json=payload,
                headers={"Authorization": f"Basic {auth}"},
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        log.error(
            "razorpay_order_failed",
            status=exc.response.status_code,
            reference=request.reference,
        )
        raise ConflictError("The payment could not be started. Please try again.") from exc
    except httpx.HTTPError as exc:
        log.error("razorpay_unreachable", error=str(exc))
        raise ConflictError("The payment service is unreachable. Please try again.") from exc

    return OrderResult(
        provider_order_id=data["id"],
        amount_paise=amount_paise,
        key_id=key_id,
        mode=destination.mode,
    )


async def verify_credentials(key_id: str, key_secret: str) -> bool:
    """Prove a Mode 2 merchant account works before we rely on it.

    Fetches the account's payment list with a limit of 1 — a read-only call that
    confirms the credentials authenticate without creating anything.
    """
    auth = base64.b64encode(f"{key_id}:{key_secret}".encode()).decode()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.get(
                f"{RAZORPAY_API}/payments",
                params={"count": 1},
                headers={"Authorization": f"Basic {auth}"},
            )
            return response.status_code == 200
    except httpx.HTTPError as exc:
        log.warning("razorpay_verify_failed", error=str(exc))
        return False


def verify_webhook_signature(body: bytes, signature: str, secret: str) -> bool:
    """Validate an inbound webhook.

    Unsigned or mis-signed events are dropped and alerted — accepting one would let
    anyone mark any invoice paid.
    """
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


async def create_virtual_account(
    destination: PaymentDestination, *, unit_id: uuid.UUID, label: str
) -> tuple[str, str]:
    """Smart Collect virtual account for one flat.

    Gives each unit its own account number, so a resident paying by NEFT from their own
    bank reconciles automatically instead of landing as an unidentified credit that an
    accountant has to match by hand. This is the feature that removes most of the
    month-end reconciliation work.
    """
    settings = get_settings()

    if settings.payments_are_stubbed:
        log.warning("payments_stub_virtual_account", unit_id=str(unit_id))
        return f"VA{uuid.uuid4().hex[:12].upper()}", "RATN0VAAPIS"

    key_id, key_secret = await _credentials_for(destination)
    auth = base64.b64encode(f"{key_id}:{key_secret}".encode()).decode()

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                f"{RAZORPAY_API}/virtual_accounts",
                json={
                    "receivers": {"types": ["bank_account"]},
                    "description": label[:120],
                    "notes": {"unit_id": str(unit_id)},
                },
                headers={"Authorization": f"Basic {auth}"},
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as exc:
        log.error("razorpay_virtual_account_failed", error=str(exc))
        raise ConflictError("Could not create a virtual account for this flat.") from exc

    bank = data["receivers"][0]
    return bank["account_number"], bank["ifsc"]
