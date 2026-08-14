"""Offline-verifiable visitor passes.

The single most important property of this product: **a pre-approved visitor gets in
with no network at all.**

The server signs a compact payload with the society's Ed25519 private key. The guard
app caches the matching public key and verifies the signature locally. No lookup, no
round trip, no dependency on the barrier having signal — which is the normal condition
at an Indian apartment gate, not the exception.

Payload layout (pipe-delimited, then base64url with the signature appended):

    v1|pass_id|society_id|unit_id|valid_from_epoch|valid_to_epoch|max_uses|visitor_hash|key_version

Why a hash of the visitor rather than their name and number: the QR is photographed,
forwarded on WhatsApp and left lying around. It must not be a readable disclosure of
who is visiting whom. The guard app shows details fetched when it *does* have signal;
offline it shows only what the resident chose to display.

Key rotation is weekly. The guard app caches the last few public keys, so a pass signed
just before a rotation still verifies.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass

import structlog
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from app.common.errors import ValidationError

log = structlog.get_logger(__name__)

PASS_VERSION = "v1"

#: Rotation cadence. The guard app keeps this many previous keys so a pass issued
#: shortly before a rotation still verifies on a device that has not synced.
KEY_ROTATION_DAYS = 7
KEY_CACHE_DEPTH = 3


@dataclass(frozen=True)
class PassPayload:
    pass_id: uuid.UUID
    society_id: uuid.UUID
    unit_id: uuid.UUID
    valid_from: dt.datetime
    valid_to: dt.datetime
    max_uses: int
    visitor_hash: str
    key_version: int

    def canonical(self) -> bytes:
        """Byte form that gets signed.

        Field order and separator are frozen: the Dart verifier in the guard app
        reconstructs this exact string, so any change here is a breaking change that
        must bump PASS_VERSION.
        """
        return "|".join(
            [
                PASS_VERSION,
                str(self.pass_id),
                str(self.society_id),
                str(self.unit_id),
                str(int(self.valid_from.timestamp())),
                str(int(self.valid_to.timestamp())),
                str(self.max_uses),
                self.visitor_hash,
                str(self.key_version),
            ]
        ).encode()


def generate_keypair() -> tuple[str, str]:
    """Return `(private_pem, public_b64)` for a new society signing key.

    The private key goes to Google Secret Manager; only its reference is stored in
    Postgres. The public key is handed to guard devices.
    """
    private = Ed25519PrivateKey.generate()
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return private_pem, base64.urlsafe_b64encode(public_raw).decode().rstrip("=")


def visitor_hash(name: str, phone: str, salt: str) -> str:
    """Non-reversible visitor identifier embedded in the QR.

    Salted per pass so the same visitor produces a different hash each time — two QRs
    cannot be correlated to reveal that the same person visited twice.
    """
    digest = hashlib.sha256(f"{salt}|{name.strip().lower()}|{phone.strip()}".encode())
    return base64.urlsafe_b64encode(digest.digest()[:16]).decode().rstrip("=")


def sign_pass(payload: PassPayload, private_pem: str) -> str:
    """Produce the QR string: `<base64url(canonical)>.<base64url(signature)>`."""
    private = serialization.load_pem_private_key(private_pem.encode(), password=None)
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("Society signing key is not an Ed25519 private key.")

    canonical = payload.canonical()
    signature = private.sign(canonical)

    return "{}.{}".format(
        base64.urlsafe_b64encode(canonical).decode().rstrip("="),
        base64.urlsafe_b64encode(signature).decode().rstrip("="),
    )


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_pass(qr_value: str, public_keys: dict[int, str]) -> PassPayload:
    """Verify a scanned pass against cached public keys. **No network required.**

    This is the reference implementation. The Dart version in the guard app must
    produce identical results — `tests/test_gate_passes.py` holds the shared vectors
    that both implementations run against.

    Raises ValidationError for anything malformed, unsigned, or expired. The guard app
    surfaces the reason so a guard can tell "expired yesterday" from "not a valid pass".
    """
    try:
        encoded_payload, encoded_signature = qr_value.split(".", 1)
        canonical = _b64decode(encoded_payload)
        signature = _b64decode(encoded_signature)
    except (ValueError, TypeError) as exc:
        raise ValidationError("This QR code is not a valid entry pass.") from exc

    parts = canonical.decode(errors="replace").split("|")
    if len(parts) != 9 or parts[0] != PASS_VERSION:
        raise ValidationError("This entry pass is in an unsupported format.")

    try:
        payload = PassPayload(
            pass_id=uuid.UUID(parts[1]),
            society_id=uuid.UUID(parts[2]),
            unit_id=uuid.UUID(parts[3]),
            valid_from=dt.datetime.fromtimestamp(int(parts[4]), dt.UTC),
            valid_to=dt.datetime.fromtimestamp(int(parts[5]), dt.UTC),
            max_uses=int(parts[6]),
            visitor_hash=parts[7],
            key_version=int(parts[8]),
        )
    except (ValueError, OSError) as exc:
        raise ValidationError("This entry pass is damaged.") from exc

    public_b64 = public_keys.get(payload.key_version)
    if public_b64 is None:
        # Device has not synced recently enough to hold the signing key.
        raise ValidationError("This pass cannot be checked offline. Connect and try again.")

    public = Ed25519PublicKey.from_public_bytes(_b64decode(public_b64))
    try:
        public.verify(signature, canonical)
    except InvalidSignature as exc:
        raise ValidationError("This entry pass is not genuine.") from exc

    return payload


def check_validity(payload: PassPayload, *, at: dt.datetime) -> None:
    """Time-window check, separate from signature verification.

    Kept separate because the guard app must distinguish "forged" from "expired": one
    is a security event worth flagging to the committee, the other is a visitor who
    turned up on the wrong day.
    """
    if at < payload.valid_from:
        raise ValidationError(
            f"This pass is not valid until {payload.valid_from:%d %b, %I:%M %p}."
        )
    if at > payload.valid_to:
        raise ValidationError(f"This pass expired on {payload.valid_to:%d %b, %I:%M %p}.")


def new_salt() -> str:
    return secrets.token_urlsafe(12)


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)
